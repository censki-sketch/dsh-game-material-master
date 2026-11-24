/** Local GPT/Codex transport for the existing game_material definition.
 * No provider calls, workflow implementation, or credentials in tool payloads.
 */
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './jsonio.js';
const PREFIX = '/dsh-game-material-master/_gpt';
const MAX_BODY = 1024 * 1024;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const safeId = (value) => typeof value === 'string' && /^[\w.:-]{1,128}$/.test(value) ? value : undefined;
function send(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(JSON.stringify(value));
}
function failure(res, status, code, message) {
    send(res, status, { error: { code, message } });
}
async function body(req) {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += buffer.length;
        if (length > MAX_BODY)
            throw new Error('BODY_LIMIT');
        chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/** Binds only an ephemeral loopback socket; discovery contains a local bearer. */
export async function startGptBridge(options) {
    await mkdir(options.dataDirectory, { recursive: true });
    const receipts = join(options.dataDirectory, 'gpt-requests');
    await mkdir(receipts, { recursive: true });
    const configPath = join(options.dataDirectory, 'gpt-bridge.json');
    const logPath = join(options.dataDirectory, 'gpt-operations.jsonl');
    const token = randomBytes(32).toString('hex');
    const expectedAuth = Buffer.from('Bearer ' + token);
    let stopped = false;
    let closing;
    let logQueue = Promise.resolve();
    const inFlight = new Map();
    const journal = (event) => {
        // A failed append blocks that operation, but must not poison future calls
        // after the user has fixed a transient filesystem problem.
        logQueue = logQueue.catch(() => undefined).then(() => appendFile(logPath, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 }));
        return logQueue;
    };
    let expectedHost = '';
    const server = createServer((req, res) => {
        void (async () => {
            if (stopped)
                return failure(res, 503, 'BRIDGE_STOPPED', 'The local bridge is stopping.');
            if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== expectedHost || req.headers.origin !== undefined)
                return failure(res, 403, 'LOCAL_ONLY', 'Only the local MCP transport may access this endpoint.');
            const auth = Buffer.from(req.headers.authorization ?? '');
            if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth))
                return failure(res, 401, 'UNAUTHORIZED', 'Local bridge authorization failed.');
            const url = new URL(req.url ?? '/', 'http://' + expectedHost);
            if (url.search)
                return failure(res, 400, 'INVALID_URL', 'Query parameters are not accepted.');
            if (req.method === 'GET' && url.pathname === PREFIX + '/tools') {
                const definitions = options.tools().filter(tool => tool.name === 'game_material');
                return send(res, 200, { tools: definitions.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) });
            }
            if (req.method === 'GET' && url.pathname === PREFIX + '/operations') {
                let lines = [];
                try {
                    lines = (await readFile(logPath, 'utf8')).trim().split('\n').slice(-100).filter(Boolean).map(line => JSON.parse(line));
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        throw error;
                }
                return send(res, 200, { operations: lines, durationScope: 'tool-call-only' });
            }
            if (req.method !== 'POST' || url.pathname !== PREFIX + '/call')
                return failure(res, 404, 'NOT_FOUND', 'Unknown bridge endpoint.');
            if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))
                return failure(res, 415, 'JSON_REQUIRED', 'Use application/json.');
            let input;
            try {
                input = await body(req);
            }
            catch (error) {
                return failure(res, error.message === 'BODY_LIMIT' ? 413 : 400, 'INVALID_BODY', 'Invalid or oversized JSON request.');
            }
            if (!isObject(input) || Object.keys(input).some(key => !['requestId', 'name', 'arguments'].includes(key)) ||
                !safeId(input.requestId) || input.name !== 'game_material' || !isObject(input.arguments))
                return failure(res, 400, 'INVALID_CALL', 'Provide requestId, game_material and an arguments object.');
            const tool = options.tools().find(item => item.name === input.name);
            if (!tool)
                return failure(res, 503, 'TOOL_NOT_READY', 'The DSH game_material tool is not ready.');
            const fingerprint = digest(JSON.stringify({ name: input.name, arguments: input.arguments }));
            const previous = inFlight.get(input.requestId);
            if (previous) {
                if (previous.fingerprint !== fingerprint)
                    return failure(res, 409, 'REQUEST_CONFLICT', 'This requestId belongs to different arguments.');
                const outcome = await previous.promise;
                return send(res, outcome.status, outcome.body);
            }
            if (inFlight.size >= 32)
                return failure(res, 429, 'TOO_MANY_CALLS', 'Wait for an existing operation to return.');
            const operationId = randomUUID();
            const started = Date.now();
            const metadata = { requestId: input.requestId, operationId,
                action: safeId(input.arguments.action), method: safeId(input.arguments.method),
                jobId: safeId(input.arguments.id) ?? safeId(input.arguments.payload?.jobId),
                roundId: safeId(input.arguments.payload?.roundId),
                at: new Date(started).toISOString(), durationScope: 'tool-call-only' };
            const receipt = join(receipts, digest(input.requestId) + '.json');
            // Install the in-memory entry before the first asynchronous persistence.
            const promise = (async () => {
                try {
                    await writeFile(receipt, JSON.stringify({ ...metadata, fingerprint, outcome: 'started' }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
                }
                catch (error) {
                    if (error.code === 'EEXIST')
                        return { status: 409, body: { error: {
                                    code: 'REQUEST_ALREADY_RECORDED', message: 'This request was previously recorded. Query its task/round; do not resubmit an uncertain paid operation.'
                                } } };
                    throw error;
                }
                await journal({ ...metadata, outcome: 'started' });
                try {
                    // Execute exactly the registered definition, including all original guards.
                    const result = await tool.execute(input.arguments, {});
                    const recordedAt = new Date().toISOString();
                    await journal({ ...metadata, at: recordedAt, outcome: 'returned', durationMs: Date.now() - started });
                    return { status: 200, body: { result: result ?? {}, operationId, recordedAt } };
                }
                catch {
                    await journal({ ...metadata, at: new Date().toISOString(), outcome: 'failed', durationMs: Date.now() - started });
                    // Provider errors can embed credentials or request bodies. Keep them in
                    // the existing task diagnostics, never copy raw exceptions to transport.
                    return { status: 422, body: { error: { code: 'TOOL_FAILED',
                                message: 'The operation failed. Read the existing DSH task/round status; operationId=' + operationId } } };
                }
            })();
            inFlight.set(input.requestId, { fingerprint, promise });
            try {
                const outcome = await promise;
                if (!res.destroyed)
                    send(res, outcome.status, outcome.body);
            }
            finally {
                inFlight.delete(input.requestId);
            }
        })().catch(() => { if (!res.destroyed && !res.headersSent)
            failure(res, 500, 'BRIDGE_ERROR', 'The local bridge could not complete the request. Check operation history before retrying.'); });
    });
    server.requestTimeout = 65_000;
    server.headersTimeout = 15_000;
    server.maxHeadersCount = 32;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    server.unref();
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('Bridge did not bind a local address');
    expectedHost = '127.0.0.1:' + address.port;
    const url = 'http://' + expectedHost + PREFIX;
    try {
        await writeJsonAtomic(configPath, { protocolVersion: 1, url, token, pid: process.pid });
        await chmod(configPath, 0o600);
    }
    catch (error) {
        server.close();
        throw error;
    }
    return { url, configPath, logPath,
        close() {
            return closing ??= (async () => {
                stopped = true;
                const closed = new Promise(resolve => server.close(() => resolve()));
                // Close the transport promptly on unload. Accepted tool work may still
                // finish; a disconnected caller must query its task, never resubmit it.
                server.closeAllConnections();
                await closed;
                await logQueue.catch(() => undefined);
                try {
                    const current = JSON.parse(await readFile(configPath, 'utf8'));
                    if (current.token === token)
                        await rm(configPath, { force: true });
                }
                catch { }
            })();
        }
    };
}

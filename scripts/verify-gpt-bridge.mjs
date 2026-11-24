/** Real loopback bridge + fake tool; no real DSH, home, keys or paid provider. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, rename, mkdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startGptBridge } from '../lib/gptbridge.js';

const folder = await mkdtemp(join(tmpdir(), 'gmm-gpt-bridge-'));
let calls = 0, release;
const tool = { name: 'game_material', description: 'fixture', parameters: { type: 'object' }, async execute(args) {
  calls++;
  if (args.hold) await new Promise(resolve => { release = resolve; });
  if (args.fail) throw new Error('Bearer provider-secret-fixture');
  return { ok: true, jobId: 'wfixture', echoedConfirm: args.confirm === true };
} };
let bridge, restarted;
let checks = 0;
function check(name, value) { assert.ok(value, name); checks++; console.log('✓ ' + name); }
try {
  bridge = await startGptBridge({ dataDirectory: folder, tools: () => [tool] });
  const config = JSON.parse(await readFile(bridge.configPath, 'utf8'));
  const headers = { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' };
  const get = (path, extra = {}) => fetch(config.url + path, { headers: { ...headers, ...extra } });
  const post = (requestId, args, extra = {}) => fetch(config.url + '/call', { method: 'POST', headers,
    body: JSON.stringify({ requestId, name: 'game_material', arguments: args, ...extra }) });
  check('bridge binds only loopback', new URL(config.url).hostname === '127.0.0.1');
  check('protocol and generated local token', config.protocolVersion === 1 && /^[a-f0-9]{64}$/.test(config.token));
  check('missing bearer rejected', (await fetch(config.url + '/tools')).status === 401);
  check('browser Origin rejected', (await get('/tools', { Origin: 'https://example.com' })).status === 403);
  // Node fetch may replace Host with the URL authority; send this probe on the wire.
  const rebindingStatus = await new Promise((resolve, reject) => {
    const req = request(config.url + '/tools', { headers: { ...headers, Host: 'example.com' }, agent: false }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end();
  });
  check('rebinding Host rejected', rebindingStatus === 403);
  check('tokens in query not accepted', (await get('/tools?token=not-supported')).status === 400);
  const listed = await (await get('/tools')).json();
  check('one original tool schema returned', listed.tools.length === 1 && listed.tools[0].name === 'game_material' && listed.tools[0].inputSchema.type === 'object');
  check('nonregistered tool rejected', (await post('other-tool', {}, { name: 'arbitrary_gateway' })).status === 400);
  const args = { action: 'call', method: 'fixture', payload: { jobId: 'wfixture' }, confirm: true, hold: true, secret: 'never-log-this' };
  const first = post('same-request', args);
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  const duplicate = post('same-request', args);
  const conflict = await post('same-request', { action: 'status' });
  check('same request with different arguments rejected', conflict.status === 409);
  release();
  const [one, two] = await Promise.all([first.then(r => r.json()), duplicate.then(r => r.json())]);
  check('concurrent duplicate uses one execution', calls === 1 && one.operationId === two.operationId);
  check('original tool result and confirm forwarded', one.result.ok && one.result.echoedConfirm === true && Boolean(one.recordedAt));
  const repeated = await post('same-request', args);
  check('finished request never reexecuted', repeated.status === 409 && calls === 1);
  const bad = await post('failed-request', { action: 'call', fail: true });
  const badText = await bad.text();
  check('raw provider errors never cross transport', bad.status === 422 && !badText.includes('provider-secret-fixture'));
  const log = await readFile(bridge.logPath, 'utf8');
  check('audit metadata does not include request arguments or credentials', !log.includes(config.token) && !log.includes('never-log-this') && !log.includes('provider-secret-fixture'));
  const operations = await (await get('/operations')).json();
  check('auditable phases and explicit timing scope', operations.operations.some(e => e.outcome === 'started') && operations.operations.some(e => e.outcome === 'returned' && e.durationMs >= 0) && operations.durationScope === 'tool-call-only');

  // Simulate and repair a local audit write error. No unlogged mutation may run,
  // and one failure must not poison subsequent unrelated requests forever.
  const beforeLogFailure = calls;
  await rename(bridge.logPath, bridge.logPath + '.saved');
  await mkdir(bridge.logPath);
  check('audit failure prevents tool execution', (await post('log-unwritable', { action: 'status' })).status === 500 && calls === beforeLogFailure);
  await rmdir(bridge.logPath);
  await rename(bridge.logPath + '.saved', bridge.logPath);
  check('repaired audit path accepts a fresh request', (await post('log-repaired', { action: 'status' })).status === 200 && calls === beforeLogFailure + 1);
  check('unlogged receipt still prevents replay', (await post('log-unwritable', { action: 'status' })).status === 409);
  const beforeRestart = calls;
  await bridge.close(); bridge = undefined;
  restarted = await startGptBridge({ dataDirectory: folder, tools: () => [tool] });
  const config2 = JSON.parse(await readFile(restarted.configPath, 'utf8'));
  const afterRestart = await fetch(config2.url + '/call', { method: 'POST', headers: { Authorization: 'Bearer ' + config2.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'same-request', name: 'game_material', arguments: args }) });
  check('restart retains uncertain/previous request barrier', afterRestart.status === 409 && calls === beforeRestart);
  check('new host instance rotates local transport credential', config2.token !== config.token);

  release = undefined;
  const pendingCall = fetch(config2.url + '/call', { method: 'POST', headers: { Authorization: 'Bearer ' + config2.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'close-during-call', name: 'game_material', arguments: { action: 'call', hold: true } }) })
    .then(response => response.status).catch(() => 'disconnected');
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  const closing = restarted.close();
  await closing;
  check('unload closes accepted HTTP connection', await pendingCall === 'disconnected');
  release();
  // Let the accepted fake tool settle and journal before removing its directory.
  const deadline = Date.now() + 2000;
  while (!(await readFile(restarted.logPath, 'utf8')).split('\n').some(line => line.includes('close-during-call') && line.includes('returned'))) {
    assert.ok(Date.now() < deadline, 'accepted fake work settles after disconnect');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  check('transport close does not imply cancellation of accepted tool work', calls === beforeRestart + 1);
  check('close is idempotent', restarted.close() === closing);
  console.log(`GPT bridge: ${checks} checks passed (local fake tool only).`);
} finally {
  if (bridge) await bridge.close();
  if (restarted) await restarted.close();
  assert.ok(folder.startsWith(join(tmpdir(), 'gmm-gpt-bridge-')));
  await rm(folder, { recursive: true, force: true });
}

#!/usr/bin/env node
/** Local MCP transport only. All material work stays in the DSH game_material tool. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { request as httpRequest } from "node:http";

export const TOOL_NAME = "game_material";
const BRIDGE_PATH = "/dsh-game-material-master/_gpt";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
const FALLBACK_PROTOCOL = "2025-06-18";
const BRIDGE_GUIDANCE = "请确认本机 DSH 已启动并加载 GPT 分支插件，再读取现有任务状态。";

class SafeError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "SafeError";
    this.code = code;
    this.resultUnknown = options.resultUnknown === true;
    this.requestId = options.requestId;
  }
}

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** Mirrors src/config.ts dshHome(); never reads the material provider configuration. */
export function bridgeConfigPath(env = process.env, home = homedir()) {
  const override = env.DSH_GPT_BRIDGE_CONFIG?.trim();
  if (override) return resolve(override);
  const dshHome = env.DSH_HOME?.trim() || join(home, ".dsh");
  return join(dshHome, "game-material-master", "gpt-bridge.json");
}

export async function loadBridgeConfig(path = bridgeConfigPath()) {
  let value;
  try {
    const bytes = await readFile(path);
    if (bytes.length > 16 * 1024) throw new Error("oversize");
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SafeError("BRIDGE_CONFIG_UNAVAILABLE", "本机素材桥配置尚未就绪。" + BRIDGE_GUIDANCE);
  }
  try {
    if (!isRecord(value) || value.protocolVersion !== 1 || typeof value.url !== "string" || typeof value.token !== "string") throw new Error();
    const url = new URL(value.url);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error();
    if (url.username || url.password || url.search || url.hash || url.port === "0") throw new Error();
    if (url.pathname.replace(/\/+$/, "") !== BRIDGE_PATH) throw new Error();
    if (value.token.length < 16 || value.token.length > 4096 || /[\r\n]/.test(value.token)) throw new Error();
    url.pathname = BRIDGE_PATH;
    return { url: url.toString().replace(/\/$/, ""), token: value.token, protocolVersion: 1 };
  } catch {
    throw new SafeError("BRIDGE_CONFIG_INVALID", "素材桥配置无效；仅支持本机 HTTP 桥及协议版本 1。" + BRIDGE_GUIDANCE);
  }
}

function redact(message, token) {
  let text = typeof message === "string" ? message : "素材桥返回错误。";
  if (token) text = text.split(token).join("[REDACTED]");
  return text.replace(/Bearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|authorization|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]")
    .slice(0, 1200);
}

async function readResponse(response) {
  const chunks = []; let size = 0;
  for await (const value of response) {
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) { response.destroy(); throw new Error("oversize"); }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function directLocalRequest(url, headers, payload) {
  return new Promise((resolveResponse, reject) => {
    // An explicit fresh Agent bypasses HTTP_PROXY / NODE_USE_ENV_PROXY. Bridge
    // credentials must travel directly to loopback, never through a user proxy.
    const request = httpRequest(url, { method: payload === undefined ? "GET" : "POST", headers, agent: false }, response => {
      void readResponse(response).then(body => resolveResponse({ status: response.statusCode, body })).catch(reject).finally(() => clearTimeout(timer));
    });
    const timer = setTimeout(() => request.destroy(new Error("timeout")), REQUEST_TIMEOUT_MS);
    request.on("error", error => { clearTimeout(timer); reject(error); });
    request.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
}

/** One HTTP attempt. Redirects and automatic POST retries are deliberately absent. */
async function bridgeRequest(suffix, payload, requestId) {
  const config = await loadBridgeConfig();
  const mutating = payload !== undefined;
  let response, body;
  try {
    response = await directLocalRequest(config.url + suffix,
      { Authorization: "Bearer " + config.token, Accept: "application/json", ...(mutating ? { "Content-Type": "application/json" } : {}) }, payload);
    body = response.body;
    if (response.status >= 300 && response.status < 400) throw new Error("redirect");
  } catch {
    throw new SafeError(mutating ? "BRIDGE_RESULT_UNKNOWN" : "BRIDGE_UNAVAILABLE",
      mutating ? "请求结果未知，未自动重试。请先查看 DSH 任务状态和操作记录，避免重复生成。" : "无法读取本机素材桥。" + BRIDGE_GUIDANCE,
      { resultUnknown: mutating, requestId });
  }
  if (response.status < 200 || response.status >= 300) {
    const resultUnknown = mutating && response.status >= 500;
    const hostMessage = isRecord(body?.error) ? body.error.message : undefined;
    throw new SafeError(resultUnknown ? "BRIDGE_RESULT_UNKNOWN" : "BRIDGE_REJECTED",
      redact(hostMessage || (response.status === 401 ? "素材桥认证未通过，请检查本机插件是否已重启。" : "素材桥拒绝了本次操作。"), config.token)
      + (resultUnknown ? " 请求结果可能未知，未自动重试；请先查看原任务和操作记录。" : ""),
      { resultUnknown, requestId });
  }
  return body;
}

async function listTools() {
  const result = await bridgeRequest("/tools");
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  const definition = tools.find(tool => tool?.name === TOOL_NAME);
  if (!definition || !isRecord(definition.inputSchema)) throw new SafeError("BRIDGE_PROTOCOL_INVALID", "素材桥没有返回可用的 game_material 定义，请核对 GPT 分支版本。");
  return { tools: [{ name: TOOL_NAME, description: typeof definition.description === "string" ? definition.description : "Use the local Game Material Master workflow.", inputSchema: definition.inputSchema }] };
}

function validateToolCall(params) {
  if (!isRecord(params) || params.name !== TOOL_NAME || !isRecord(params.arguments ?? {})) throw new SafeError("INVALID_TOOL_CALL", "仅支持 game_material 工具及对象参数。");
  const args = params.arguments ?? {};
  for (const key of ["url", "token", "bridgeUrl", "bridgeToken", "authorization", "configPath"])
    if (Object.hasOwn(args, key)) throw new SafeError("INVALID_TOOL_CALL", "连接配置只能来自本机素材桥，不能通过工具参数设置。");
  return args;
}

function toolError(error) {
  const safe = error instanceof SafeError ? error : new SafeError("LOCAL_TOOL_ERROR", "本机素材调用未完成。请先检查原任务状态，不要重复生成。");
  const detail = { ok: false, code: safe.code, resultUnknown: safe.resultUnknown, ...(safe.requestId ? { requestId: safe.requestId } : {}) };
  return { content: [{ type: "text", text: safe.message }], structuredContent: detail, isError: true };
}

/** Only the existing inline template preview is a vision attachment. Do not fetch
 * arbitrary URLs or read host paths while adapting a result for MCP clients. */
function resultContent(args, result) {
  const original = result.result;
  const uri = original?.value?.image;
  if (args.action === "call" && args.method === "getMotionTemplatePreview" &&
      original?.method === args.method && typeof uri === "string" && uri.length <= 6 * 1024 * 1024) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri);
    if (match && match[2].length % 4 === 0) {
      const bytes = Buffer.from(match[2], "base64"), mimeType = match[1];
      const recognized = mimeType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mimeType === "image/jpeg" ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
      if (recognized && bytes.length <= 4 * 1024 * 1024 && bytes.toString("base64") === match[2]) {
        const projected = { ...result, result: { ...original, value: { ...original.value, image: { contentIndex: 1, mimeType } } } };
        return { content: [{ type: "text", text: JSON.stringify(projected) }, { type: "image", mimeType, data: match[2] }], structuredContent: projected };
      }
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
}

export function createDispatcher() {
  const calls = new Map();
  async function callTool(params, id) {
    let args;
    try { args = validateToolCall(params); } catch (error) { return toolError(error); }
    const key = typeof id + ":" + String(id);
    const fingerprint = createHash("sha256").update(JSON.stringify({ name: TOOL_NAME, arguments: args })).digest("hex");
    const previous = calls.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return toolError(new SafeError("REQUEST_ID_REUSED", "同一请求编号不能改成另一项操作，请先查看原操作结果。"));
      return previous.promise;
    }
    const requestId = randomUUID();
    const promise = (async () => {
      try {
        const result = await bridgeRequest("/call", { requestId, name: TOOL_NAME, arguments: args }, requestId);
        if (!isRecord(result) || !Object.hasOwn(result, "result") || typeof result.operationId !== "string" || typeof result.recordedAt !== "string")
          throw new SafeError("BRIDGE_RESULT_UNKNOWN", "素材桥结果不完整，未自动重试。请按原任务与操作记录核对结果。", { resultUnknown: true, requestId });
        return { ...resultContent(args, result), isError: false };
      } catch (error) { return toolError(error); }
    })();
    calls.set(key, { fingerprint, promise, done: false });
    void promise.finally(() => {
      const entry = calls.get(key); if (entry) entry.done = true;
      if (calls.size > 1024) for (const [oldKey, old] of calls) { if (calls.size <= 1024) break; if (old.done) calls.delete(oldKey); }
    });
    return promise;
  }
  return async message => {
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" ||
      (Object.hasOwn(message, "id") && !(message.id === null || typeof message.id === "number" || typeof message.id === "string")))
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC request" } };
    if (!Object.hasOwn(message, "id")) return undefined;
    const { id, method } = message;
    try {
      let result;
      if (method === "initialize") {
        const requested = message.params?.protocolVersion;
        result = { protocolVersion: SUPPORTED_PROTOCOLS.has(requested) ? requested : FALLBACK_PROTOCOL,
          capabilities: { tools: {} }, serverInfo: { name: "game-material-master-gpt", version: "0.1.0" },
          instructions: "Use the single game_material tool. Read guide and existing task state before generation; keep original confirmations and operation records." };
      } else if (method === "ping") result = {};
      else if (method === "tools/list") result = await listTools();
      else if (method === "tools/call") result = await callTool(message.params, id);
      else return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      return { jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof SafeError ? error.message : "Local material bridge unavailable" } };
    }
  };
}

export function startStdio(input = process.stdin, output = process.stdout) {
  const dispatch = createDispatcher(), decoder = new StringDecoder("utf8"), pending = new Set();
  let buffer = "", oversized = false;
  const send = message => { if (message !== undefined) output.write(JSON.stringify(message) + "\n"); };
  const accept = line => {
    if (!line.trim()) return;
    let value;
    try { value = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    const task = dispatch(value).then(send).catch(() => send({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal transport error" } }));
    pending.add(task); void task.finally(() => pending.delete(task));
  };
  input.on("data", chunk => {
    if (oversized) return;
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (Buffer.byteLength(buffer, "utf8") > MAX_MESSAGE_BYTES) {
      oversized = true; buffer = "";
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "MCP message exceeds local transport limit" } });
      input.pause(); return;
    }
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); accept(line); }
  });
  input.on("end", () => { if (!oversized) { buffer += decoder.end(); if (buffer.trim()) accept(buffer); buffer = ""; } });
  return { dispatch, pending };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.on("uncaughtException", () => { process.stderr.write("Game Material Master MCP transport stopped.\n"); process.exitCode = 1; process.stdin.pause(); });
  startStdio();
}

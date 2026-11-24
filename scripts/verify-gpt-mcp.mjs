/** Real stdio + isolated bridge/tool integration; no real DSH account or provider. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { bridgeConfigPath, loadBridgeConfig } from "../gpt-plugin/server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "gmm-gpt-mcp-"));
const originalDshHome = process.env.DSH_HOME;
const originalFetch = globalThis.fetch;
let realBridge;
const toolDisposers = [];
const config = join(temporary, "gpt-bridge.json");
const token = "fake-local-bridge-token-for-zero-cost-tests";
const records = []; let redirected = 0, redirectTools = false;
let proxyRequests = 0;
const proxy = createServer((_request, response) => { proxyRequests++; response.writeHead(502); response.end("proxy must not receive local credentials"); });
proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
const definition = { name: "game_material", description: "Fake shared workflow tool", inputSchema: { type: "object", properties: { action: { type: "string" }, payload: { type: "object" } }, required: ["action"] } };
const bridge = createServer(async (request, response) => {
  if (request.url === "/sink") { redirected++; response.end("not allowed"); return; }
  if (request.headers.authorization !== "Bearer " + token) { response.writeHead(401); response.end("{}"); return; }
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/dsh-game-material-master/_gpt/tools") {
    if (redirectTools) { response.writeHead(302, { Location: "/sink" }); response.end(); return; }
    response.end(JSON.stringify({ tools: [definition, { name: "unrelated-tool", inputSchema: {} }] })); return;
  }
  if (request.method !== "POST" || request.url !== "/dsh-game-material-master/_gpt/call") { response.writeHead(404); response.end("{}"); return; }
  let raw = ""; for await (const chunk of request) raw += chunk;
  const value = JSON.parse(raw); records.push(value);
  const scenario = value.arguments.payload?.scenario;
  if (scenario === "disconnect") { request.socket.destroy(); return; }
  if (scenario === "redirect") { response.writeHead(307, { Location: "/sink" }); response.end(); return; }
  if (scenario === "secret-error") {
    response.writeHead(400); response.end(JSON.stringify({ error: { code: "bad_request", message: `Rejected token=${token}; Authorization: Bearer ${token}` } })); return;
  }
  if (scenario === "incomplete") { response.end(JSON.stringify({ result: { started: true } })); return; }
  response.end(JSON.stringify({ result: { ...value.arguments, openUrl: "http://127.0.0.1:1234/?dsh-gmm=1&module=sprite&job=wtest", confirmed: value.arguments.payload?.confirmed === true }, operationId: value.requestId, recordedAt: "2026-11-24T00:00:00.000Z" }));
});
bridge.listen(0, "127.0.0.1"); await once(bridge, "listening");
const url = `http://127.0.0.1:${bridge.address().port}/dsh-game-material-master/_gpt`;
const writeConfig = value => writeFile(config, JSON.stringify(value), "utf8");
await writeConfig({ url, token, protocolVersion: 1 });

const child = spawn(process.execPath, [join(root, "gpt-plugin/server.mjs")], {
  cwd: root, stdio: ["pipe", "pipe", "pipe"],
  env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: temporary, TMP: temporary, DSH_GPT_BRIDGE_CONFIG: config,
    NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: "" }
});
let stdout = "", stderr = "", buffer = "", unexpectedOutput;
const waiting = new Map();
child.stderr.on("data", chunk => { stderr += chunk; });
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => {
  stdout += chunk; buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    try {
      const message = JSON.parse(line);
      const queue = waiting.get(String(message.id));
      if (!queue?.length) unexpectedOutput = line;
      else queue.shift()(message);
    } catch { unexpectedOutput = line; }
  }
});
let assertions = 0;
function check(condition, message) { assert.ok(condition, message); assertions++; }
function responseFor(id) {
  return new Promise((resolveResponse, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP response timed out for " + id)), 6000);
    const queue = waiting.get(String(id)) ?? [];
    queue.push(value => { clearTimeout(timer); resolveResponse(value); }); waiting.set(String(id), queue);
  });
}
async function rpc(id, method, params) {
  const result = responseFor(id);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
  return result;
}

try {
  const manifest = JSON.parse(await readFile(join(root, ".codex-plugin/plugin.json"), "utf8"));
  const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
  check(manifest.mcpServers === "./.mcp.json", "Installable manifest references its MCP configuration");
  check(manifest.skills === "./gpt-plugin/skills/", "Skill directory is packaged at the declared location");
  check(mcp.mcpServers.game_material_master.args[0] === "${PLUGIN_ROOT}/gpt-plugin/server.mjs", "Portable launch path does not contain a development worktree");
  check(mcp.mcpServers.game_material_master.cwd === "${PLUGIN_ROOT}", "Portable working directory");
  check(bridgeConfigPath({}, temporary) === join(temporary, ".dsh/game-material-master/gpt-bridge.json"), "Default data-root matches DSH");
  check(bridgeConfigPath({ DSH_HOME: temporary }, "ignored") === join(temporary, "game-material-master/gpt-bridge.json"), "DSH_HOME shares original host storage");
  check(bridgeConfigPath({ DSH_GPT_BRIDGE_CONFIG: config }, "ignored") === config, "Explicit bridge discovery override");

  const initialized = await rpc(0, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-client", version: "1" } });
  check(initialized.result.protocolVersion === "2025-06-18", "MCP protocol handshake");
  check(initialized.result.capabilities.tools && initialized.result.serverInfo.name === "game-material-master-gpt", "Reports one tool surface, no provider-specific transport");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  check((await rpc(1, "ping")).result !== undefined, "Notifications require no response; ping works");
  const tools = (await rpc(2, "tools/list")).result.tools;
  check(tools.length === 1 && tools[0].name === "game_material", "Only original game_material is exposed");
  assert.deepEqual(tools[0].inputSchema, definition.inputSchema); assertions++;

  const args = { name: "game_material", arguments: { action: "call", payload: { confirmed: false, text: "乡野拳手 👊" } } };
  const result = await rpc(3, "tools/call", args);
  check(result.result.isError === false, "Original tool result returned");
  check(result.result.structuredContent.result.confirmed === false, "Adapter never grants a missing confirmation");
  check(result.result.structuredContent.result.payload.text === "乡野拳手 👊", "Unicode survives both transports");
  const first = records.at(-1);
  check(first.name === "game_material" && /^[0-9a-f-]{36}$/.test(first.requestId), "Host receives one original tool call and stable opaque request ID");
  check(result.result.structuredContent.operationId === first.requestId, "Operation ID remains available for UI reconciliation");
  assert.deepEqual(first.arguments, args.arguments); assertions++;
  const beforeDuplicate = records.length;
  await rpc(3, "tools/call", args);
  check(records.length === beforeDuplicate, "Same MCP request ID does not submit twice");
  check((await rpc(3, "tools/call", { ...args, arguments: { action: "different" } })).result.structuredContent.code === "REQUEST_ID_REUSED", "Changed parameters cannot reuse an operation ID");

  const beforeInvalid = records.length;
  check((await rpc(4, "tools/call", { name: "other", arguments: {} })).result.isError, "No arbitrary tool invocation");
  check((await rpc(5, "tools/call", { name: "game_material", arguments: { action: "status", url: "http://evil.invalid" } })).result.isError, "Model cannot inject connection URL");
  check((await rpc(6, "tools/call", { name: "game_material", arguments: { action: "status", token: "injected" } })).result.isError, "Model cannot inject credentials");
  check(records.length === beforeInvalid, "Invalid requests never reach the host");
  const badMethod = await rpc(7, "shell/execute", {});
  check(badMethod.error.code === -32601, "Adapter is not a generic command runner");
  const malformed = responseFor(null); child.stdin.write("not-json\n");
  check((await malformed).error.code === -32700, "Malformed JSON receives a protocol error only");

  const failed = await rpc(8, "tools/call", { name: "game_material", arguments: { action: "call", payload: { scenario: "secret-error" } } });
  check(failed.result.isError && !JSON.stringify(failed).includes(token), "Host errors redact bridge credentials");
  const countBeforeDisconnect = records.length;
  const unknown = await rpc(9, "tools/call", { name: "game_material", arguments: { action: "call", payload: { scenario: "disconnect" } } });
  check(unknown.result.structuredContent.resultUnknown === true && unknown.result.structuredContent.requestId, "Disconnect is an unknown result with reconciliation ID");
  check(records.length === countBeforeDisconnect + 1, "No automatic POST replay on network failure");
  const incomplete = await rpc(10, "tools/call", { name: "game_material", arguments: { action: "call", payload: { scenario: "incomplete" } } });
  check(incomplete.result.structuredContent.resultUnknown === true, "Incomplete successful HTTP result cannot be claimed as success");
  await rpc(11, "tools/call", { name: "game_material", arguments: { action: "call", payload: { scenario: "redirect" } } });
  redirectTools = true;
  check((await rpc(12, "tools/list")).error, "Redirected discovery fails closed");
  check(redirected === 0, "Authorization never follows an HTTP redirect"); redirectTools = false;

  for (const invalid of ["https://127.0.0.1:1/dsh-game-material-master/_gpt", "http://127.0.0.1.evil.invalid/dsh-game-material-master/_gpt", "http://192.168.1.1/dsh-game-material-master/_gpt", "http://user:password@localhost/dsh-game-material-master/_gpt", url + "?token=injected", url.replace("/_gpt", "/other")]) {
    await writeConfig({ url: invalid, token, protocolVersion: 1 });
    const answer = await rpc("invalid-" + assertions, "tools/list");
    check(answer.error && !JSON.stringify(answer).includes(token), "Reject nonlocal or nonbridge discovery without disclosing its secret");
  }
  for (const host of ["localhost", "[::1]"]) {
    await writeConfig({ url: `http://${host}:1234/dsh-game-material-master/_gpt/`, token, protocolVersion: 1 });
    check((await loadBridgeConfig(config)).url === `http://${host}:1234/dsh-game-material-master/_gpt`, "Accept canonical local host " + host);
  }
  await writeConfig({ url, token, protocolVersion: 2 });
  check((await rpc(20, "tools/list")).error, "Protocol mismatch fails before contacting original workflow");
  await writeFile(config, "not-json", "utf8");
  check((await rpc(21, "tools/list")).error, "Damaged discovery file yields a safe error");
  check(!stdout.includes(token) && !stderr.includes(token) && !stdout.includes("password@"), "Credentials are absent from stdout and stderr");
  check(stderr === "" && !unexpectedOutput, "stdout contains only MCP messages and stderr contains no raw exception");
  check(proxyRequests === 0, "Loopback bearer never passes through HTTP_PROXY, even with NODE_USE_ENV_PROXY enabled");

  // Acceptance fixture: the actual adapter speaks to the actual host transport,
  // which executes the actual registered game_material definition. Only the
  // gateway is replaced; DSH configuration and all writes stay under mkdtemp.
  process.env.DSH_HOME = join(temporary, "isolated-dsh-home");
  let externalRequests = 0;
  globalThis.fetch = () => { externalRequests++; throw new Error("Provider network is forbidden in MCP acceptance verification"); };
  const { registerStudioTools } = await import("../lib/tools.js");
  const { startGptBridge } = await import("../lib/gptbridge.js");
  const hostConfig = await import("../lib/config.js");
  await hostConfig.saveConfig({ hiddenModules: [] });
  const definitions = [], gatewayCalls = [];
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const gateway = new Proxy({}, { get: (_target, method) => async payload => {
    gatewayCalls.push({ method, payload: structuredClone(payload) });
    if (method === "getWorkflowConversation") return { jobId: payload.jobId, rounds: [{ id: "mock-round", childId: "wchild0000" }] };
    if (method === "runWorkflowRoundStep") {
      assert.equal(payload.planOnly, true, "Only a read-only workflow plan is allowed in this fixture");
      return { kind: "local-processing", steps: ["keyed"], requestCount: 0 };
    }
    if (method === "submitWorkflowRound") {
      if (payload.confirmed !== true) throw new Error("fake gateway requires explicit confirmation");
      return { roundId: "mock-round", childId: "wchild0000", mock: true };
    }
    if (method === "getMotionTemplatePreview") return {
      image: payload.direction === "left" ? "data:image/png;base64,bm90LWEtcG5n" : "data:image/png;base64," + png,
      width: 1, height: 1, columns: 1, frames: 1, frameDurationsMs: [100]
    };
    throw new Error("Unexpected fixture gateway method");
  } });
  toolDisposers.push(...registerStudioTools({ tools: { register: definition => { definitions.push(definition); return () => {}; } } }, gateway));
  check(definitions.length === 1 && definitions[0].name === "game_material", "Real host registers the one shared game_material definition");
  realBridge = await startGptBridge({ dataDirectory: hostConfig.dataRoot(), tools: () => definitions });
  const discovery = JSON.parse(await readFile(realBridge.configPath, "utf8"));
  await writeConfig(discovery);
  const realTools = (await rpc("real-schema", "tools/list")).result.tools;
  assert.deepEqual(realTools, [{ name: definitions[0].name, description: definitions[0].description, inputSchema: definitions[0].parameters }]); assertions++;
  const realCall = (id, argumentsValue) => rpc(id, "tools/call", { name: "game_material", arguments: argumentsValue });
  const guide = await realCall("real-guide", { action: "guide", topic: "motion" });
  check(!guide.result.isError && guide.result.structuredContent.result.text.includes("getWorkflowConversation"), "Actual guide reaches stdio through the real host and tool dispatcher");
  check(gatewayCalls.length === 0, "Reading the guide does not touch a provider or gateway");
  const conversation = await realCall("real-conversation", { action: "call", method: "getWorkflowConversation", payload: { module: "sprite", jobId: "wparent000" } });
  check(!conversation.result.isError && conversation.result.structuredContent.result.value.rounds[0].id === "mock-round", "Original workflow round data survives the complete chain");
  const receipt = conversation.result.structuredContent;
  check(/^[0-9a-f-]{36}$/.test(receipt.operationId) && !Number.isNaN(Date.parse(receipt.recordedAt)), "Real host operation ID and timestamp survive MCP");
  const open = new URL(receipt.result.openUrl);
  check(open.searchParams.get("job") === "wparent000" && open.searchParams.get("module") === "sprite", "Original parent-task UI deep link survives both transports");
  const planPayload = { module: "sprite", jobId: "wparent000", roundId: "mock-round", step: "process", planOnly: true, confirmed: false,
    targets: ["private-target-marker"], ranges: [{ action: "Run1", start: .1, end: 1.9, frameCount: 43, targetFps: 24 }], forceLocal: "keyed" };
  const plan = await realCall("real-plan", { action: "call", method: "runWorkflowRoundStep", payload: planPayload });
  check(!plan.result.isError && plan.result.structuredContent.result.value.requestCount === 0, "Read-only local processing plan remains non-generating");
  assert.deepEqual(gatewayCalls.at(-1).payload, planPayload); assertions++;
  const submitPayload = { module: "sprite", jobId: "wparent000", requestId: "business-intent-fixture", automatic: false, confirmed: false };
  const refused = await realCall("real-unconfirmed", { action: "call", method: "submitWorkflowRound", payload: submitPayload });
  check(refused.result.isError && gatewayCalls.at(-1).payload.confirmed === false, "Original confirmation rejection survives the full chain; adapter never auto-confirms");
  const confirmedArgs = { action: "call", method: "submitWorkflowRound", payload: { ...submitPayload, confirmed: true } };
  const submitted = await realCall("real-confirmed-mock", confirmedArgs);
  check(!submitted.result.isError && submitted.result.structuredContent.result.value.mock === true, "Explicit confirmation and business request ID reach only the mock workflow gateway");
  assert.deepEqual(gatewayCalls.at(-1).payload, confirmedArgs.payload); assertions++;
  const callsBeforeReplay = gatewayCalls.length;
  const replayed = await realCall("real-confirmed-mock", confirmedArgs);
  check(gatewayCalls.length === callsBeforeReplay && replayed.result.structuredContent.operationId === submitted.result.structuredContent.operationId, "Repeated stdio request has one original workflow call and one operation ID");
  const preview = await realCall("real-preview", { action: "call", method: "getMotionTemplatePreview", payload: { action: "Run1", direction: "right" } });
  const image = preview.result.content.find(block => block.type === "image");
  check(image?.mimeType === "image/png" && image.data === png, "Existing inline template preview becomes a native MCP vision image block");
  const previewMetadata = preview.result.structuredContent;
  check(!preview.result.content[0].text.includes(png) && !JSON.stringify(previewMetadata).includes(png) &&
    previewMetadata.result.value.image.contentIndex === 1 && previewMetadata.result.value.image.mimeType === "image/png" &&
    previewMetadata.result.value.width === 1 && previewMetadata.result.value.frames === 1 &&
    JSON.stringify(previewMetadata) === preview.result.content[0].text,
    "Text and structured metadata reference the image block without duplicating its bytes");
  const invalidPreview = await realCall("real-invalid-preview", { action: "call", method: "getMotionTemplatePreview", payload: { action: "Run1", direction: "left" } });
  check(!invalidPreview.result.content.some(block => block.type === "image"), "Invalid image bytes are never promoted to a vision attachment");
  const beforeUnknown = gatewayCalls.length;
  const arbitrary = await realCall("real-unknown-method", { action: "call", method: "inventedGatewayMethod", payload: {} });
  check(arbitrary.result.isError && gatewayCalls.length === beforeUnknown, "Real dispatcher still refuses arbitrary gateway methods");
  const auditText = await readFile(realBridge.logPath, "utf8");
  const audit = auditText.trim().split("\n").map(line => JSON.parse(line));
  check(audit.some(record => record.operationId === receipt.operationId && record.outcome === "returned"), "Actual host persisted the returned operation in its audit journal");
  check(audit.some(record => record.method === "submitWorkflowRound" && record.outcome === "failed"), "Confirmation failure is visible in the same operation history");
  check(audit.every(record => record.durationScope === "tool-call-only") && !auditText.includes("private-target-marker") && !auditText.includes(png) && !auditText.includes(discovery.token), "Audit stores timing scope and operation metadata, without arguments, image bytes or credentials");
  check(externalRequests === 0 && proxyRequests === 0, "Full-chain acceptance made zero external/provider or proxy requests");
  check(stderr === "" && !stdout.includes(discovery.token) && !unexpectedOutput, "Real-host path keeps stdio protocol-only and local bearer private");
  console.log(`verify-gpt-mcp: ${assertions} assertions passed; real stdio/host/tool chain, mock gateway only, no paid calls.`);
} finally {
  child.kill();
  if (realBridge) await realBridge.close();
  for (const dispose of toolDisposers.reverse()) dispose();
  globalThis.fetch = originalFetch;
  if (originalDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalDshHome;
  await new Promise(resolveClose => bridge.close(resolveClose));
  await new Promise(resolveClose => proxy.close(resolveClose));
  // This exact directory was created by mkdtemp above, never a user data root.
  assert.ok(temporary.startsWith(join(tmpdir(), "gmm-gpt-mcp-")));
  await rm(temporary, { recursive: true, force: true });
}

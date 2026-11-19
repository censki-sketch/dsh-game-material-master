/** Real gateway/wire, synthetic images and LLM. No network or real credentials. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const home = await mkdtemp(join(tmpdir(), "gmm-model-tests-")); process.env.DSH_HOME = home;
const { Context } = await import("@deepseek-ai/cordis");
const plugin = await import("../lib/index.js"), wire = await import("../lib/wire.js");
const { encodePng } = await import("../lib/png.js");
const { dataRoot } = await import("../lib/config.js");
const png = encodePng(Buffer.from([0, 100, 255, 255]), 1, 1);
let mode = "ready", release, requests = [];
globalThis.fetch = async (url, init = {}) => {
  const address = new URL(String(url)); assert.equal(address.hostname, "127.0.0.1", "external requests forbidden");
  requests.push({ path: address.pathname, method: init.method, body: init.body });
  if (mode === "hold") await new Promise((done, reject) => {
    release = done;
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  if (mode === "fail") return new Response("failed", { status: 502 });
  if (address.pathname === "/result.png") return new Response(png);
  const body = address.pathname.startsWith("/v1/") ? { id: "fake-task", status: "completed", result: { data: [{ url: "http://127.0.0.1/result.png" }] } } : { data: [{ b64_json: png.toString("base64") }] };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
};
const ctx = new Context(); for (const key of ["typert", "webServer", "tools"]) ctx.provide(key, { register: () => () => {} });
ctx.provide("systemPrompt", { section: () => () => {} }); plugin.apply(ctx);
const gateway = ctx.get("gameStudio"), invoke = async (method, payload) => {
  const spec = wire.METHODS.find(item => item.method === method);
  return spec.result.parse(await gateway[method](spec.payload?.parse(payload)));
};
let checks = 0; const check = (name, value) => { assert.ok(value, name); checks++; console.log("✓ " + name); };
const wait = async condition => { for (let i = 0; i < 150; i++) { if (await condition()) return; await new Promise(done => setTimeout(done, 20)); } throw Error("timed out"); };
try {
  await invoke("saveConfig", { imageProvider: "custom", customBaseUrl: "http://127.0.0.1/custom", customApiKey: "fake-custom-secret", customModel: "model-one", customSize: "1024x1024",
    arkBaseUrl: "http://127.0.0.1/ark", arkApiKey: "fake-ark-secret", arkModel: "ark-one", toapisBaseUrl: "http://127.0.0.1/v1", toapisApiKey: "fake-toapis-secret", toapisImageModel: "toapis-one" });
  let view = await invoke("getConfig"); check("configured keys do not count as passing tests", view.imageModelTests.every(model => model.testedAt === null) && requests.length === 0);
  check("all three configured image routes are available without tests or generation", view.imageModels.length === 3 && view.imageModels.every(model => model.blocker === null) && view.imageModels.some(model => model.provider === "custom" && model.model === "model-one") && requests.length === 0 && !JSON.stringify(view.imageModels).includes("fake-"));
  for (const [method, provider] of [["testArk", "ark"], ["testCustomImage", "custom"], ["testToapisImage", "toapis"]]) {
    await invoke(method, method === "testToapisImage" ? { confirmed: true } : undefined);
    view = await invoke("getConfig"); check(provider + ": actual test success is visible through config/wire", view.imageModelTests.find(model => model.provider === provider).testedAt > 0);
  }
  const beforeUnconfirmed = requests.length;
  await assert.rejects(invoke("testToapisImage", { confirmed: false }), /确认/);
  check("unconfirmed image test never dispatches", requests.length === beforeUnconfirmed);
  await invoke("saveConfig", { customModel: "model-two" });
  view = await invoke("getConfig"); check("changing one model invalidates only that route", !view.imageModelTests.find(model => model.provider === "custom").testedAt && view.imageModelTests.filter(model => model.provider !== "custom").every(model => model.testedAt));
  await invoke("testCustomImage");
  for (const patch of [{ customApiKey: "fake-new-secret" }, { customBaseUrl: "http://127.0.0.1/changed" }, { customProtocol: "comfyui", customWorkflow: "{}" }]) {
    await invoke("saveConfig", patch);
    check("credential, endpoint or protocol changes cannot inherit a pass", !(await invoke("getConfig")).imageModelTests.find(model => model.provider === "custom").testedAt);
    await invoke("saveConfig", { customApiKey: "fake-custom-secret", customBaseUrl: "http://127.0.0.1/custom", customProtocol: "openai", customWorkflow: "", customModel: "model-two" });
  }
  mode = "fail"; await assert.rejects(invoke("testCustomImage"));
  check("failed retest removes a previous pass without retry", !(await invoke("getConfig")).imageModelTests.find(model => model.provider === "custom").testedAt);
  mode = "hold"; const frozen = invoke("testCustomImage"); await wait(() => release);
  await assert.rejects(invoke("testCustomImage"), /正在测试/);
  await invoke("saveConfig", { customModel: "edited-during-test" }); release(); await frozen; mode = "ready";
  check("concurrent configuration edits never mark the new image route tested", !(await invoke("getConfig")).imageModelTests.find(model => model.provider === "custom").testedAt);
  await invoke("saveConfig", { customModel: "model-two" });
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", "const {loadConfig}=await import('./lib/config.js');const {imageModelTests}=await import('./lib/modeltests.js');console.log(JSON.stringify(await imageModelTests(await loadConfig())));"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr); check("image test evidence survives a new process", JSON.parse(child.stdout).every(model => model.testedAt));

  let profile = { baseURL: "https://mock.invalid", apiKey: "MOCK_MODEL_KEY" }, secret = "fake-llm-secret", llmMode = "ready", modelCalls = [];
  ctx.provide("settings", { describe: () => [{ ns: "mock-llm", value: { profiles: { local: profile } } }] });
  ctx.provide("credentials", { resolve: async () => ({ value: secret, source: "test" }) });
  ctx.provide("agentDefaultModel", { currentSelection: () => ({ provider: "local", model: "first" }) });
  ctx.provide("llm", {
    listConfigurableProviders: () => [{ provider: "local", settingsNs: "mock-llm", settingsPath: ["profiles", "local"] }],
    listProviders: () => [{ id: "local", name: "Local" }], listModels: async () => [{ id: "first", name: "First", inputModalities: ["text"] }, { id: "second", name: "Second" }],
    async *stream(options) {
      modelCalls.push(options); if (llmMode === "throw") throw Error("fake-llm-secret");
      if (llmMode === "hold") await new Promise(done => release = done);
      yield { type: "block-end", index: 0, block: { type: "text", text: "OK" } };
      yield { type: "finish", reason: { kind: llmMode === "incomplete" ? "max-tokens" : "stop" } };
    }
  });
  let catalog = await invoke("getPromptOptimizerModel");
  check("prompt catalog exposes configured models without a test or model call", catalog.models.length === 2 && catalog.configuredModels.length === 2 && catalog.models.every(model => model.testedAt === null) && modelCalls.length === 0 && !catalog.defaultTested);
  await assert.rejects(invoke("testPromptOptimizerModel", { provider: "local", model: "first", confirmed: false }), /确认/);
  check("unconfirmed prompt tests never dispatch", modelCalls.length === 0);
  await invoke("testPromptOptimizerModel", { provider: "local", model: "first", confirmed: true });
  catalog = await invoke("getPromptOptimizerModel");
  check("test evidence does not remove other configured prompt choices", catalog.models.length === 2 && catalog.models.filter(model => model.testedAt).length === 1 && catalog.defaultTested && modelCalls.length === 1);
  check("prompt tests use a bounded single call without tools", modelCalls[0].maxTokens === 128 && modelCalls[0].tools.length === 0 && modelCalls[0].signal instanceof AbortSignal);
  profile = { ...profile, baseURL: "https://changed.invalid" };
  check("prompt endpoint changes invalidate its pass", (await invoke("getPromptOptimizerModel")).models.every(model => model.testedAt === null));
  await invoke("testPromptOptimizerModel", { provider: "local", model: "first", confirmed: true }); secret = "fake-changed-llm-secret";
  check("resolved credential changes invalidate prompt evidence", (await invoke("getPromptOptimizerModel")).models.every(model => model.testedAt === null));
  llmMode = "incomplete"; await assert.rejects(invoke("testPromptOptimizerModel", { provider: "local", model: "second", confirmed: true }), /未自动重试/);
  check("incomplete output is not a successful test", (await invoke("getPromptOptimizerModel")).models.every(model => model.testedAt === null));
  llmMode = "ready"; await invoke("testPromptOptimizerModel", { provider: "local", model: "second", confirmed: true });
  llmMode = "throw"; await assert.rejects(invoke("testPromptOptimizerModel", { provider: "local", model: "second", confirmed: true }), error => !error.message.includes("fake-llm-secret"));
  check("failed prompt retests remove old passes and redact service errors", (await invoke("getPromptOptimizerModel")).models.every(model => model.testedAt === null));
  const records = await readdir(join(dataRoot(), "model-tests"));
  const stored = (await Promise.all(records.map(file => readFile(join(dataRoot(), "model-tests", file), "utf8")))).join("");
  check("test evidence never stores keys or prompt bodies", !/fake-|MOCK_MODEL_KEY|Reply with|baseURL/.test(stored) && records.every(file => /^[a-f0-9]{64}\.json$/.test(file)));

  const { jobId } = await invoke("createImageJob", { name: "send test" });
  await invoke("saveImageJob", { jobId, prompt: "message to submit", keying: { enabled: false } });
  mode = "hold"; release = undefined; const roundId = randomUUID();
  const submitted = await invoke("runImageJob", { jobId, roundId, consumePrompt: true }); await wait(() => release);
  let state = await invoke("getImageJob", { jobId });
  check("accepted send exposes text and stable round ID before image completion", submitted.roundId === roundId && state.rounds[0].id === roundId && state.rounds[0].request.prompt === "message to submit" && state.rounds[0].results[0].status === "running" && !state.rounds[0].completedAt);
  check("accepted send clears only the composer, preserving its request snapshot", state.prompt === "" && state.rounds[0].request.finalPrompt.includes("message to submit"));
  await invoke("saveImageJob", { jobId, prompt: "next message draft" });
  await invoke("cancelImageJob", { jobId });
  await wait(async () => !(await invoke("getImageJob", { jobId })).tasks.length);
  state = await invoke("getImageJob", { jobId });
  check("stop aborts the local request with billing uncertainty and preserves next draft", state.rounds[0].results[0].status === "error" && state.rounds[0].results[0].error.includes("可能仍会计费") && state.prompt === "next message draft");
  const beforeDuplicate = requests.length; await assert.rejects(invoke("runImageJob", { jobId, roundId, consumePrompt: true }), /已经提交/);
  check("duplicate message ID never reissues a paid call or clears a later draft", requests.length === beforeDuplicate && (await invoke("getImageJob", { jobId })).prompt === "next message draft");
  mode = "ready";
  const nextRoundId = randomUUID();
  await invoke("runImageJob", { jobId, roundId: nextRoundId, consumePrompt: true, submittedPrompt: "captured before the next draft" });
  state = await invoke("getImageJob", { jobId });
  check("a captured send cannot consume newer composer text", state.prompt === "next message draft" && state.rounds.at(-1).request.prompt === "captured before the next draft");
  await wait(async () => !(await invoke("getImageJob", { jobId })).tasks.length);
  console.log(`Passed ${checks} model verification and send lifecycle checks. No network or paid calls.`);
} finally {
  const target = resolve(home); assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith("gmm-model-tests-"));
  await rm(target, { recursive: true, force: true });
}

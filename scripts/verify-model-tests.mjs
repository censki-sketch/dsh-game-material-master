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
const { dataRoot, loadConfig, normalizeConfig, configPath } = await import("../lib/config.js");
const { generateImageWithProvider, imageTimeoutOf } = await import("../lib/imageprovider.js");
const png = encodePng(Buffer.from([0, 100, 255, 255]), 1, 1);
let mode = "ready", release, requests = [];
globalThis.fetch = async (url, init = {}) => {
  const address = new URL(String(url)); assert.equal(address.hostname, "127.0.0.1", "external requests forbidden");
  requests.push({ path: address.pathname, method: init.method, body: init.body, authorization: new Headers(init.headers).get("authorization") });
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
  const keysBeforeMask = await readFile(configPath(), "utf8"), maskConnectionId = view.activeCustomImageConnectionId;
  for (const key of ["arkApiKey", "toapisApiKey", "customApiKey", "minimaxApiKey", "musicApiKey", "sfxApiKey"]) {
    await assert.rejects(invoke("saveConfig", { [key]: "••••••••" }), /遮罩/);
    await assert.rejects(invoke("saveConfig", { [key]: "••••••edited" }), /遮罩/);
    check(key + ": full and partially edited masks cannot overwrite saved credentials", await readFile(configPath(), "utf8") === keysBeforeMask);
  }
  for (const op of ["create", "update", "duplicate"]) {
    await assert.rejects(invoke("saveConfig", { customConnection: { op, id: maskConnectionId, values: { customApiKey: "********" } } }), /遮罩/);
    check(op + ": connection operations reject masked keys without changing disk", await readFile(configPath(), "utf8") === keysBeforeMask);
  }
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
  assert.equal(child.status, 0, child.stderr); check("image test evidence survives a new process", JSON.parse(child.stdout).filter(model => model.provider !== "custom" || model.model === "model-two").every(model => model.testedAt) && JSON.parse(child.stdout).filter(model => model.provider === "custom" && model.model === "edited-during-test").every(model => !model.testedAt));

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
  const migrated = normalizeConfig({ imageProvider: "custom", customApiKey: "legacy-secret", customBaseUrl: "http://127.0.0.1/legacy", customModel: "legacy-model" });
  check("legacy configuration migrates without losing its key or model", migrated.customImageConnections.length === 1 && migrated.customImageConnections[0].customApiKey === "legacy-secret" && migrated.customModel === "legacy-model");
  const legacyWorkflow = normalizeConfig({ imageProvider: "custom", customProtocol: "comfyui", customBaseUrl: "http://127.0.0.1:8188", customModel: "", customWorkflow: '{"1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"old.safetensors"}}}' });
  check("legacy workflows without a model name retain a selectable default", legacyWorkflow.customModel === "default" && legacyWorkflow.customImageConnections[0].modelConfigs[0].enabled && JSON.parse(legacyWorkflow.customWorkflow)["1"].inputs.ckpt_name === "old.safetensors");
  view = await invoke("getConfig"); const originalId = view.activeCustomImageConnectionId;
  view = await invoke("saveConfig", { customConnection: { op: "create", values: { enabled: true, name: "Second", customBaseUrl: "http://127.0.0.1/second", customApiKey: " second-secret ", customModel: "shared", models: ["shared", "other"] } } });
  const secondId = view.customImageConnections.at(-1).id;
  check("creating a connection retains the active generation route", view.activeCustomImageConnectionId === originalId && view.customImageConnections.at(-1).models.length === 2);
  check("all connection credentials remain masked in ordinary responses", !JSON.stringify(view).includes("second-secret") && view.customImageConnections.at(-1).customApiKeySet);
  await invoke("saveConfig", { customConnection: { op: "update", id: secondId, values: { name: "Edited second", customSize: "512x512" } } });
  check("editing an inactive connection cannot change the current route", (await loadConfig()).activeCustomImageConnectionId === originalId && (await loadConfig()).customBaseUrl !== "http://127.0.0.1/second");
  check("explicit key reveal resolves the requested connection", (await invoke("revealConfigKey", { key: "customApiKey", connectionId: secondId })).value === "second-secret");
  const noTest = requests.length;
  await assert.rejects(invoke("testCustomImage", { connectionId: secondId, model: "other", confirmed: false }), /确认/);
  await assert.rejects(invoke("testCustomImage", { connectionId: secondId, model: "deleted", confirmed: true }), /移除/);
  check("unconfirmed or removed-model tests never dispatch", requests.length === noTest);
  await invoke("testCustomImage", { connectionId: secondId, model: "other", confirmed: true });
  const testRequest = requests.at(-1);
  check("model tests route the exact connection, credential and model", testRequest.path.startsWith("/second/") && testRequest.authorization === "Bearer second-secret" && JSON.parse(testRequest.body).model === "other");
  view = await invoke("getConfig");
  check("test evidence is isolated to the tested model", view.imageModelTests.find(r => r.connectionId === secondId && r.model === "other").testedAt && !view.imageModelTests.find(r => r.connectionId === secondId && r.model === "shared").testedAt && view.activeCustomImageConnectionId === originalId);
  await invoke("saveConfig", { customConnection: { op: "update", id: secondId, values: { enabled: false } } });
  view = await invoke("getConfig");
  check("disabled custom connections disappear from model catalogs while retaining settings", !view.imageModels.some(r => r.connectionId === secondId) && !view.imageModelTests.some(r => r.connectionId === secondId) && view.customImageConnections.find(r => r.id === secondId).customApiKeySet);
  await invoke("saveConfig", { imageProvider: "custom", activeCustomImageConnectionId: secondId, customModel: "other" });
  const beforeDisabled = requests.length;
  await assert.rejects(invoke("testCustomImage", { connectionId: secondId, model: "other", confirmed: true }), /停用/);
  await assert.rejects(generateImageWithProvider({ prompt: "must not dispatch", images: [], size: "512x512", watermark: false }), /停用/);
  check("a disabled active connection cannot generate, test or silently fall back", requests.length === beforeDisabled && (await loadConfig()).activeCustomImageConnectionId === secondId && (await loadConfig()).imageProvider === "custom");
  view = await invoke("saveConfig", { customConnection: { op: "update", id: secondId, values: { enabled: true } } });
  check("reenabling restores models and their matching test evidence", view.imageModelTests.find(r => r.connectionId === secondId && r.model === "other").testedAt && view.imageModels.some(r => r.connectionId === secondId && r.model === "shared"));
  await invoke("saveConfig", { imageProvider: "custom", activeCustomImageConnectionId: secondId, customModel: "other" });
  await invoke("testCustomImage");
  check("composer selection persists its connection and generation route", (await loadConfig()).customModel === "other" && requests.at(-1).path.startsWith("/second/"));
  view = await invoke("saveConfig", { customConnection: { op: "duplicate", id: secondId, values: { name: "Copy" } } });
  const copyId = view.customImageConnections.at(-1).id;
  check("duplicated connections need their own explicit model test", view.imageModelTests.filter(r => r.connectionId === copyId).every(r => !r.testedAt));
  await Promise.all([
    invoke("saveConfig", { customConnection: { op: "update", id: secondId, values: { name: "Concurrent", customApiKey: "new-second-secret" } } }),
    invoke("saveConfig", { customConnection: { op: "update", id: copyId, values: { customModel: "copy-model" } } })
  ]);
  const saved = await loadConfig();
  check("concurrent saves preserve updates to separate connections", saved.customImageConnections.find(r => r.id === secondId).name === "Concurrent" && saved.customImageConnections.find(r => r.id === copyId).customModel === "copy-model");
  check("duplicate credentials are independent from the original", saved.customImageConnections.find(r => r.id === copyId).customApiKey === "second-secret");
  check("changed credentials invalidate the tested connection", !(await invoke("getConfig")).imageModelTests.find(r => r.connectionId === secondId && r.model === "other").testedAt);
  for (const values of [{ customApiKey: 4 }, { customTimeoutMs: "bad" }, { models: [null] }, { customProtocol: "bad" }, { enabled: "false" }]) await assert.rejects(invoke("saveConfig", { customConnection: { op: "update", id: secondId, values } }));
  check("invalid connection field types are rejected without altering saved credentials", (await loadConfig()).customApiKey === "new-second-secret");
  const fresh = spawnSync(process.execPath, ["--input-type=module", "-e", "const {loadConfig}=await import('./lib/config.js');const c=await loadConfig();console.log(JSON.stringify({active:c.activeCustomImageConnectionId,model:c.customModel,count:c.customImageConnections.length}));"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr); check("multiple connections and model selection survive a process restart", JSON.parse(fresh.stdout).active === secondId && JSON.parse(fresh.stdout).model === "other" && JSON.parse(fresh.stdout).count === 3);
  const beforeModelEdits = requests.length;
  const edit = (provider, op, id, values, connectionId = undefined) => invoke("saveConfig", { imageModelEdit: { provider, op, id, values, connectionId } });
  await edit("custom", "create", undefined, { id: "portrait", name: "Portrait", enabled: true, params: { size: "768x1024", quality: "high" } }, secondId);
  await edit("custom", "create", undefined, { id: "icon", name: "Icon", enabled: true, params: { size: "512x512", quality: "low" } }, secondId);
  check("model CRUD only updates local configuration", requests.length === beforeModelEdits);
  for (const [id, size, quality] of [["portrait", "768x1024", "high"], ["icon", "512x512", "low"], ["portrait", "768x1024", "high"]]) {
    await invoke("saveConfig", { customModel: id });
    const selected = await loadConfig();
    await generateImageWithProvider({ prompt: "local model check", images: [], size: selected.customSize, watermark: false });
    const body = JSON.parse(requests.at(-1).body);
    check("selected model has independent size and quality: " + id, body.model === id && body.size === size && body.quality === quality && requests.at(-1).authorization === "Bearer new-second-secret");
  }
  await invoke("saveConfig", { customModel: "other" });
  await generateImageWithProvider({ prompt: "default quality", images: [], size: (await loadConfig()).customSize, watermark: false });
  check("a model without quality does not inherit another model's override", !("quality" in JSON.parse(requests.at(-1).body)));
  await invoke("saveConfig", { customModel: "portrait" });
  await invoke("testCustomImage", { connectionId: secondId, model: "portrait", confirmed: true });
  await edit("custom", "update", "portrait", { name: "Character portrait" }, secondId);
  check("renaming display text preserves model evidence and choice identity", (await invoke("getConfig")).imageModelTests.find(m => m.model === "portrait").testedAt);
  await edit("custom", "update", "portrait", { params: { size: "1024x1024", quality: "high" } }, secondId);
  check("model parameter changes invalidate only matching evidence", !(await invoke("getConfig")).imageModelTests.find(m => m.model === "portrait").testedAt);
  await edit("custom", "update", "portrait", { enabled: false }, secondId);
  const beforeBlockedModel = requests.length;
  await assert.rejects(generateImageWithProvider({ prompt: "disabled model", images: [], size: "1K", watermark: false }), /停用/);
  await assert.rejects(invoke("testCustomImage", { connectionId: secondId, model: "portrait", confirmed: true }), /停用/);
  check("disabled individual models cannot generate or test", requests.length === beforeBlockedModel && !(await invoke("getConfig")).imageModels.some(m => m.model === "portrait") && (await invoke("getConfig")).imageModels.some(m => m.model === "icon"));
  await edit("custom", "update", "portrait", { enabled: true, id: "character" }, secondId);
  check("renaming the selected model ID updates its selection", (await loadConfig()).customModel === "character" && !(await invoke("getConfig")).imageModels.some(m => m.model === "portrait"));
  const badEdits = [{ id: "icon" }, { enabled: "false" }, { params: { apiKey: "must-not-store" } }, { params: { timeoutMs: 1 } }, { params: { quality: "bad" } }, { params: { workflow: "{" } }];
  for (const values of badEdits) await assert.rejects(edit("custom", "update", "character", values, secondId));
  check("invalid and duplicate model definitions are rejected", !(JSON.stringify(await loadConfig())).includes("must-not-store"));
  await edit("custom", "delete", "character", undefined, secondId);
  await assert.rejects(generateImageWithProvider({ prompt: "deleted model", images: [], size: "1K", watermark: false }), /停用|移除/);
  check("deleting a selected model never silently selects another", (await loadConfig()).customModel === "character" && !(await invoke("getConfig")).imageModels.some(m => m.model === "character"));
  await edit("ark", "create", undefined, { id: "ark-two", name: "Second Ark", enabled: true, params: { size: "1024x1024" } });
  await edit("ark", "create", undefined, { id: "ark-three", name: "Third Ark", enabled: true, params: { size: "1536x1024" } });
  for (const [id, size] of [["ark-two", "1024x1024"], ["ark-three", "1536x1024"], ["ark-two", "1024x1024"]]) {
    await invoke("saveConfig", { imageProvider: "ark", arkModel: id });
    const selected = await loadConfig();
    await generateImageWithProvider({ prompt: "local ark check", images: [], size: selected.arkSize, watermark: false });
    check("built-in model switching retains its parameters: " + id, JSON.parse(requests.at(-1).body).size === size && JSON.parse(requests.at(-1).body).model === id);
  }
  await invoke("testArk", { model: "ark-three", confirmed: true });
  check("built-in model tests use the requested model without changing selection", JSON.parse(requests.at(-1).body).model === "ark-three" && (await loadConfig()).arkModel === "ark-two");
  await edit("ark", "update", "ark-three", { enabled: false });
  await assert.rejects(invoke("testArk", { model: "ark-three", confirmed: true }), /停用/);
  check("built-in per-model disable also filters the catalog", !(await invoke("getConfig")).imageModels.some(m => m.model === "ark-three"));
  const modelRestart = spawnSync(process.execPath, ["--input-type=module", "-e", "const {loadConfig}=await import('./lib/config.js');const c=await loadConfig();console.log(JSON.stringify({size:c.arkSize,disabled:c.arkImageModels.find(m=>m.id==='ark-three').enabled,deleted:c.customImageConnections.some(x=>x.modelConfigs.some(m=>m.id==='character'))}));"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(modelRestart.status, 0, modelRestart.stderr);
  check("model definitions, deletion and independent parameters survive restart", JSON.parse(modelRestart.stdout).size === "1024x1024" && JSON.parse(modelRestart.stdout).disabled === false && JSON.parse(modelRestart.stdout).deleted === false);
  const videoTimeout = (await loadConfig()).toapisTimeoutMs;
  await edit("toapis", "create", undefined, { id: "toapis-two", name: "Second ToAPIs", enabled: true, params: { size: "1024x1536", quality: "high", timeoutMs: 120000 } });
  await invoke("saveConfig", { imageProvider: "toapis", toapisImageModel: "toapis-two" });
  check("image model timeout does not modify the shared ToAPIs video timeout", (await loadConfig()).toapisTimeoutMs === videoTimeout && imageTimeoutOf(await loadConfig()) === 120000);
  await invoke("testToapisImage", { confirmed: true, model: "toapis-two" });
  const toapisBody = JSON.parse(requests.findLast(request => request.path === "/v1/images/generations" && request.method === "POST").body);
  check("ToAPIs tests use model-specific size and quality", toapisBody.model === "toapis-two" && toapisBody.size === "2:3" && toapisBody.resolution === "2K" && toapisBody.quality === "high");
  await edit("toapis", "update", "toapis-two", { enabled: false });
  const toapisBeforeDisabled = requests.length;
  await assert.rejects(generateImageWithProvider({ prompt: "disabled ToAPIs model", images: [], size: "1K", watermark: false }), /停用/);
  check("ToAPIs individual model disable blocks before networking", requests.length === toapisBeforeDisabled);
  await invoke("saveConfig", { arkImageEnabled: false, toapisImageEnabled: false });
  for (const entry of (await loadConfig()).customImageConnections) await invoke("saveConfig", { customConnection: { op: "update", id: entry.id, values: { enabled: false } } });
  view = await invoke("getConfig");
  check("all disabled image backends return an empty catalog without fallback entries", view.imageModels.length === 0 && view.imageModelTests.length === 0);
  const stoppedRequests = requests.length;
  await assert.rejects(invoke("testArk"), /停用/);
  await assert.rejects(invoke("testToapisImage", { confirmed: true }), /停用/);
  await assert.rejects(generateImageWithProvider({ prompt: "disabled ark", images: [], size: "1K", watermark: false }, undefined, { ...await loadConfig(), imageProvider: "ark" }), /停用/);
  await assert.rejects(generateImageWithProvider({ prompt: "disabled toapis", images: [], size: "1K", watermark: false }, undefined, { ...await loadConfig(), imageProvider: "toapis" }), /停用/);
  await assert.rejects(invoke("saveConfig", { arkImageEnabled: "false" }), /布尔/);
  check("disabled built-in backends reject generation and tests before requests", requests.length === stoppedRequests);
  const flags = spawnSync(process.execPath, ["--input-type=module", "-e", "const {loadConfig}=await import('./lib/config.js');const {imageModelRoutes}=await import('./lib/imageprovider.js');const c=await loadConfig();console.log(JSON.stringify({routes:imageModelRoutes(c).length,disabled:!c.arkImageEnabled&&!c.toapisImageEnabled&&c.customImageConnections.every(r=>!r.enabled)}));"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(flags.status, 0, flags.stderr); check("disabled flags survive a process restart", JSON.parse(flags.stdout).disabled && JSON.parse(flags.stdout).routes === 0);
  const createdWithId = await invoke("saveConfig", { customConnection: { op: "create", id: secondId, values: { name: "Fresh" } } });
  check("creation never inherits the active connection even if an id is supplied", !createdWithId.customImageConnections.at(-1).customApiKeySet && createdWithId.customImageConnections.at(-1).customBaseUrl === "https://api.openai.com/v1" && createdWithId.customImageConnections.at(-1).enabled === false);
  await invoke("saveConfig", { imageProvider: "custom", activeCustomImageConnectionId: secondId });
  for (const entry of (await loadConfig()).customImageConnections) await invoke("saveConfig", { customConnection: { op: "delete", id: entry.id } });
  const empty = await loadConfig(), disk = JSON.parse(await readFile(configPath(), "utf8"));
  check("deleting the last connection clears legacy credentials and selects a remaining provider", empty.customImageConnections.length === 0 && !empty.customApiKey && !disk.customApiKey && empty.imageProvider === "ark");
  await invoke("saveConfig", { customModel: "new-after-delete" });
  check("subsequent legacy edits cannot resurrect a deleted key", !(await loadConfig()).customApiKey && (await loadConfig()).customImageConnections.every(r => !r.customApiKey));
  console.log(`Passed ${checks} model verification and send lifecycle checks. No network or paid calls.`);
} finally {
  const target = resolve(home); assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith("gmm-model-tests-"));
  await rm(target, { recursive: true, force: true });
}

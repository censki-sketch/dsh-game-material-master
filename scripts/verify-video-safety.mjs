/** Billing protection: in-memory fetch and UI mocks only; never contacts a provider. */
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeConfig, maskConfig, saveConfig, loadConfig } from "../lib/config.js";
import { assertVideoBackendReady, assertVideoSubmissionConfirmed, submitVideoTask, queryVideoTask } from "../lib/videogen.js";
import { METHODS } from "../lib/wire.js";

let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
const locked = normalizeConfig({ minimaxApiKey: "mock-key", minimaxModel: "MiniMax-H3-Lite", minimaxBaseUrl: "http://127.0.0.1:1" });
check("old configuration stays locked even with a key", () => assert.equal(locked.allowPaidVideoGeneration, false));
check("only boolean true enables paid video", () => assert.equal(normalizeConfig({ allowPaidVideoGeneration: "true" }).allowPaidVideoGeneration, false));
check("masked configuration exposes lock without the key", () => { assert.equal(maskConfig(locked).allowPaidVideoGeneration, false); assert.equal(maskConfig(locked).minimaxApiKey, undefined); });
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; return new Response(JSON.stringify({ task: { id: "mock", status: "Processing" } }), { headers: { "content-type": "application/json" } }); };
try {
  for (const config of [locked, { ...locked, toapisVideo: true, toapisApiKey: "mock-key" }]) {
    await assert.rejects(() => submitVideoTask(config, { prompt: "must not submit", duration: 4, resolution: "480P" }), /已锁定/);
    checks++;
  }
  check("locked dispatchers make zero network calls", () => assert.equal(networkCalls, 0));
  check("enabled paid video requires per-request confirmation", () => assert.throws(() => assertVideoSubmissionConfirmed({ ...locked, allowPaidVideoGeneration: true }, false), /confirmed:true/));
  check("local ComfyUI remains available while paid video is locked", () => assert.doesNotThrow(() => assertVideoBackendReady({ ...locked, comfyVideo: true })));
  await queryVideoTask(locked, "minimax", "existing-task");
  check("locking does not block querying an existing task", () => assert.equal(networkCalls, 1));
  const previousHome = process.env.DSH_HOME;
  const testHome = await mkdtemp(join(tmpdir(), "dsh-video-safety-"));
  process.env.DSH_HOME = testHome;
  try {
    await saveConfig({ ...locked, allowPaidVideoGeneration:true });
    const snapshot = await loadConfig();
    await saveConfig({ allowPaidVideoGeneration:false });
    await assert.rejects(() => submitVideoTask(snapshot, { prompt:"queued direction", duration:4, resolution:"480P" }), /已锁定/);
    check("closing the lock blocks queued submissions using an older config snapshot", () => assert.equal(networkCalls, 1));
    await saveConfig({ allowPaidVideoGeneration:true });
    const submitted = await submitVideoTask(snapshot, { prompt:"mock only", duration:4, resolution:"480P" });
    check("explicitly enabled mock dispatch submits exactly once", () => { assert.equal(submitted.taskId, "mock"); assert.equal(networkCalls, 2); });
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    await rm(testHome, { recursive:true, force:true });
  }
} finally { globalThis.fetch = originalFetch; }

for (const [method, payload] of [
  ["runTurnVideo", { projectId: "p1", confirmed: true }],
  ["runVideos", { projectId: "p1", keys: ["front"], confirmed: true, regenerate: true }],
  ["runSequenceVideo", { jobId: "s1", confirmed: true }],
]) check(`${method} wire preserves confirmation`, () => assert.deepEqual(METHODS.find(item => item.method === method).payload.parse(payload), payload));

let registration;
let answer = false;
let dialogs = [];
const windowStub = { __ModuleLoader__: { load: value => { registration = value; } }, confirm: message => { dialogs.push(message); return answer; } };
const reactStub = { createElement: () => null };
const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
new Function("window", source)(windowStub);
const bundle = registration.factory(name => { assert.equal(name, "react"); return reactStub; });
let config = { ...locked, minimaxDuration: 4, minimaxResolution: "480P" };
const keys = ["front", "downLeft", "left", "upLeft", "back", "upRight", "right", "downRight"];
let project = { images: Object.fromEntries(keys.map(key => [key, { file: "mock.png" }])), videos: {} };
let submitted = [];
let reads = 0;
let hold;
const submit = bundle.__test.createVideoSubmitter(async (method, payload) => {
  if (method === "getConfig") { reads++; if (hold) await hold; return config; }
  if (method === "getProject") return project;
  if (method === "getSequenceJob") return { settings: { duration: 9, resolution: "unsupported" } };
  submitted.push({ method, payload }); return { started: true };
});
await assert.rejects(() => submit("runTurnVideo", { projectId: "p1" }), /已锁定/);
check("opening a locked submission makes no dialog or paid call", () => { assert.equal(dialogs.length, 0); assert.equal(submitted.length, 0); });
config = { ...config, allowPaidVideoGeneration: true };
await assert.rejects(() => submit("runVideos", { projectId: "p1" }), /已取消/);
check("cancel shows all eight paid requests and sends none", () => { assert.match(dialogs.at(-1), /8/); assert.match(dialogs.at(-1), /480P/); assert.equal(submitted.length, 0); });
answer = true;
await submit("runVideos", { projectId: "p1" });
check("confirmation forwards exactly one batch call with consent", () => { assert.equal(submitted.length, 1); assert.equal(submitted[0].payload.confirmed, true); });
project.videos = { front: { status: "ready" }, back: { status: "running", taskId: "running-task" } };
await submit("runVideos", { projectId: "p1" });
check("batch quote excludes ready and running directions", () => assert.match(dialogs.at(-1), /6/));
await submit("runMotionStep", { jobId: "w1", step: "video" });
check("white-model confirmation includes fixed output and reference input", () => { assert.match(dialogs.at(-1), /4秒 \/ 480P/); assert.match(dialogs.at(-1), /1段/); assert.match(dialogs.at(-1), /4秒参考视频/); });
config = { ...config, toapisVideo: true, toapisVideoModel: "mock-toapis", toapisVideoDuration: 8, toapisVideoResolution: "720P" };
await submit("runSequenceVideo", { jobId: "s1" });
check("ToAPIs quote uses its own actual settings", () => { assert.match(dialogs.at(-1), /mock-toapis/); assert.match(dialogs.at(-1), /8秒 \/ 720P/); });
config = { ...config, toapisVideo: false, minimaxCapabilities: { durations: [6, 10], durationMin: 6, durationMax: 10, resolutions: ["768P", "1080P"] } };
await submit("runSequenceVideo", { jobId: "s1" });
check("sequence quote matches host parameter normalization", () => assert.match(dialogs.at(-1), /10秒 \/ 768P/));
let release;
hold = new Promise(resolve => { release = resolve; });
const beforeReads = reads;
const first = submit("runTurnVideo", { projectId: "p1" });
await assert.rejects(() => submit("runTurnVideo", { projectId: "p1" }), /重复点击/);
release(); await first; hold = undefined;
check("double clicks cannot open two confirmations or submit twice", () => assert.equal(reads, beforeReads + 1));
windowStub.confirm = undefined;
await assert.rejects(() => submit("runTurnVideo", { projectId: "p1" }), /已取消/);
checks++;
console.log(`${checks} video safety checks passed. No external network, no real account or charges.`);

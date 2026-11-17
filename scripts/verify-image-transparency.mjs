/** Real image pipeline, synthetic pixels and a loopback-only image API. No real credentials or billing. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const home = await mkdtemp(join(tmpdir(), "gmm-image-transparency-"));
process.env.DSH_HOME = home;
const { saveConfig } = await import("../lib/config.js");
const imagegen = await import("../lib/imagegen.js");
const { IMAGE_PROMPT_TEMPLATES } = await import("../lib/imageprompts.js");
const { encodePng } = await import("../lib/png.js");
const { decodeToRgba } = await import("../lib/media.js");
const received = [];
let onRequest;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/images/generations");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    await onRequest?.();
    const rgba = Buffer.alloc(64 * 64 * 4);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const subject = x >= 24 && x < 40 && y >= 16 && y < 48;
      const pixel = (y * 64 + x) * 4;
      rgba[pixel] = subject ? 240 : 0;
      rgba[pixel + 1] = subject ? 100 : 0;
      rgba[pixel + 2] = subject ? 40 : 255;
      rgba[pixel + 3] = 255;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: encodePng(rgba, 64, 64).toString("base64") }] }));
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  assert.equal(new URL(url instanceof Request ? url.url : url).origin, origin, "Only the local fake API is allowed");
  return originalFetch(url, options);
};
let checks = 0;
const check = (name, value) => { assert.ok(value, name); checks++; console.log("✓ " + name); };
try {
  await saveConfig({ imageProvider: "custom", customProtocol: "openai", customBaseUrl: origin, customApiKey: "fake-local-key", customModel: "fake-image", keyColor: "#0000FF" });
  const job = await imagegen.createImageJob("transparent fixture");
  job.prompt = "白色衣服的角色，参考白色背景，保持动作";
  job.suffix = IMAGE_PROMPT_TEMPLATES[0].prompt.zh;
  const authored = { prompt: job.prompt, suffix: job.suffix };
  check("disabled mode leaves the outgoing prompt unchanged", imagegen.buildPrompt(job) === `${job.prompt}\n${job.suffix}`);
  job.keying.enabled = true;
  const outgoing = imagegen.buildPrompt(job);
  check("enabled mode includes the exact key color and background-only override", outgoing.includes("#0000FF") && outgoing.includes("覆盖主提示词") && outgoing.includes("仅作用于背景"));
  check("built-in white background is removed without changing white clothing", !outgoing.includes("未指定背景时使用均匀纯白背景") && outgoing.includes("白色衣服"));
  check("checkerboards and color spill are forbidden", outgoing.includes("透明棋盘格") && outgoing.includes("边缘染色"));
  check("authored input and saved template are not rewritten", job.prompt === authored.prompt && job.suffix === authored.suffix);
  check("legacy jobs use the supplied fallback color", imagegen.buildPrompt({ ...job, keying: { ...job.keying, keyColor: "" } }, "#FF00FF").includes("#FF00FF"));
  const english = imagegen.buildPrompt({ ...job, prompt: "character in white clothes", suffix: IMAGE_PROMPT_TEMPLATES[0].prompt.en, promptTemplateLang: "en" });
  check("English templates get matching background instructions", english.includes("#0000FF") && english.includes("Transparent PNG output") && !english.includes("uniform solid white background"));
  check("an empty main prompt still fails before generation", imagegen.buildPrompt({ ...job, prompt: " " }) === "");
  await imagegen.writeImageJob(job);
  // Simulate an unrelated settings edit while the API request is in flight.
  onRequest = async () => {
    const current = await imagegen.readImageJob(job.id);
    current.keying.keyColor = "#00FF00";
    await imagegen.writeImageJob(current);
    await saveConfig({ keyColor: "#FF00FF" });
  };
  await imagegen.generateImageItem(job.id, 0);
  const keyed = await imagegen.readImageJob(job.id);
  check("generation uses one fake request with the final background clause", received.length === 1 && received[0].prompt.endsWith(outgoing.split("\n\n").at(-1)));
  check("generation automatically writes a transparent PNG", keyed.items[0].status === "ready" && keyed.items[0].keyedFile?.endsWith(".png"));
  const decoded = await decodeToRgba(imagegen.imageAssetPath(job.id, keyed.items[0].keyedFile));
  const center = (32 * decoded.width + 32) * 4;
  check("background alpha is zero and the subject remains opaque", decoded.rgba[3] === 0 && decoded.rgba[center + 3] === 255);
  check("foreground colors survive keying", decoded.rgba[center] === 240 && decoded.rgba[center + 1] === 100 && decoded.rgba[center + 2] === 40);
  check("keying uses the submitted blue color despite later green/magenta settings", keyed.keying.keyColor === "#00FF00" && keyed.items[0].backgroundFraction > 0.8);
  check("generation preserves original prompt and template", keyed.prompt === authored.prompt && keyed.suffix === authored.suffix);
  keyed.keying.enabled = false;
  await imagegen.writeImageJob(keyed);
  onRequest = undefined;
  await imagegen.generateImageItem(job.id, 1);
  const unkeyed = await imagegen.readImageJob(job.id);
  check("turning transparency off skips automatic keying", unkeyed.items[1].status === "ready" && !unkeyed.items[1].keyedFile && !received[1].prompt.includes("透明 PNG 输出模式"));
  console.log(`Passed ${checks} image transparency checks. Synthetic pixels and loopback API only.`);
} finally {
  globalThis.fetch = originalFetch;
  await new Promise(resolve => server.close(resolve));
  assert.equal(dirname(resolve(home)), resolve(tmpdir()));
  assert.ok(basename(home).startsWith("gmm-image-transparency-"));
  await rm(home, { recursive: true, force: true });
}

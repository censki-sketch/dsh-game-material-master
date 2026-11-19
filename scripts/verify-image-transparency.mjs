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
const { keyGreen } = await import("../lib/chroma.js");
const received = [];
let onRequest;
const server = createServer(async (request, response) => {
  try {
    assert.ok(["/images/generations", "/images/edits"].includes(request.url));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const form = request.url === "/images/edits" ? await new Request("http://127.0.0.1/images/edits", { method: "POST", headers: { "Content-Type": request.headers["content-type"] }, body: bytes }).formData() : undefined;
    const images = form ? await Promise.all([...form.getAll("image"), ...form.getAll("image[]")].map(async file => Buffer.from(await file.arrayBuffer()).toString("base64"))) : [];
    // Multipart text fields normalize newlines to CRLF on the wire.
    const body = form ? { prompt: form.get("prompt").replace(/\r\n/g, "\n"), images } : JSON.parse(bytes.toString("utf8"));
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
  const edgeWidth = 32, edgeHeight = 32, edgeSource = Buffer.alloc(edgeWidth * edgeHeight * 4);
  const hair = [80, 44, 24], screen = [255, 0, 255];
  const put = (x, y, color, alpha = 255) => { const p = (y * edgeWidth + x) * 4; color.forEach((v, c) => edgeSource[p + c] = v); edgeSource[p + 3] = alpha; };
  for (let y = 0; y < edgeHeight; y++) for (let x = 0; x < edgeWidth; x++) put(x, y, screen);
  for (let y = 7; y < 25; y++) for (let x = 7; x < 25; x++) put(x, y, hair);
  for (let y = 8; y < 24; y++) put(6, y, hair.map((v, c) => Math.round((v + screen[c]) / 2)));
  // An intended purple detail inside the opaque subject, and clean pale/green/dark outlines.
  put(16, 16, [170, 35, 170]); put(24, 12, [238, 238, 238]); put(24, 13, [45, 150, 70]); put(24, 14, [20, 18, 15]);
  const edgeOptions = { keyColor: '#FF00FF', keyLow: 14, keyHigh: 80, despill: 0.65, edgeShrink: 0, bgTolerance: 40 };
  const legacyEdge = keyGreen(edgeSource, edgeWidth, edgeHeight, edgeOptions).rgba;
  const recoveredEdge = keyGreen(edgeSource, edgeWidth, edgeHeight, { ...edgeOptions, refineEdges: true }).rgba;
  const mixed = (12 * edgeWidth + 6) * 4;
  check('mixed magenta/brown edge reproduces the opaque purple-fringe defect', legacyEdge[mixed + 3] === 255 && legacyEdge[mixed + 2] - legacyEdge[mixed + 1] > 80);
  check('edge recovery restores foreground RGB and coverage without shrinking', Math.abs(recoveredEdge[mixed + 3] - 128) <= 2 && hair.every((v, c) => Math.abs(recoveredEdge[mixed + c] - v) <= 2));
  for (const bg of [20, 245]) {
    const alpha = recoveredEdge[mixed + 3] / 255;
    check('recovered edge composites cleanly on background ' + bg, hair.every((v, c) => Math.abs(recoveredEdge[mixed + c] * alpha + bg * (1 - alpha) - (v * 0.5 + bg * 0.5)) < 2));
  }
  check('interior purple detail and clean boundary colors remain unchanged', [[16, 16], [24, 12], [24, 13], [24, 14]].every(([x, y]) => { const p = (y * edgeWidth + x) * 4; return recoveredEdge.subarray(p, p + 4).equals(edgeSource.subarray(p, p + 4)); }));
  check('zero despill disables edge color recovery', keyGreen(edgeSource, edgeWidth, edgeHeight, { ...edgeOptions, despill: 0, refineEdges: true }).rgba.equals(keyGreen(edgeSource, edgeWidth, edgeHeight, { ...edgeOptions, despill: 0 }).rgba));
  put(6, 12, [130, 60, 130], 128);
  const transparentLegacy = keyGreen(edgeSource, edgeWidth, edgeHeight, edgeOptions).rgba;
  const transparentRefined = keyGreen(edgeSource, edgeWidth, edgeHeight, { ...edgeOptions, refineEdges: true }).rgba;
  check('already-transparent source edge is not refined a second time', transparentLegacy.subarray(mixed, mixed + 4).equals(transparentRefined.subarray(mixed, mixed + 4)));
  const detailWidth = 80, detailHeight = 64;
  const detailSource = Buffer.alloc(detailWidth * detailHeight * 4);
  const detailPut = (x, y, color) => { const p = (y * detailWidth + x) * 4; color.forEach((v, c) => detailSource[p + c] = v); detailSource[p + 3] = 255; };
  for (let y = 0; y < detailHeight; y++) for (let x = 0; x < detailWidth; x++) detailPut(x, y, screen);
  for (let y = 16; y < 55; y++) for (let x = 28; x < 72; x++) detailPut(x, y, hair);
  const hairMix = hair.map((v, c) => Math.round((v + screen[c]) / 2));
  for (let x = 12; x < 30; x++) detailPut(x, 5, hairMix);
  const detailResult = keyGreen(detailSource, detailWidth, detailHeight, { ...edgeOptions, refineEdges: true }).rgba;
  const tip = (5 * detailWidth + 12) * 4;
  check('thin hair with no clean reference within six pixels still recovers its color and coverage', Math.abs(detailResult[tip + 3] - 128) <= 2 && hair.every((v, c) => Math.abs(detailResult[tip + c] - v) <= 2));
  check('fine strand remains present rather than being removed by whole-image erosion', Array.from({ length: 18 }, (_, x) => detailResult[(5 * detailWidth + 12 + x) * 4 + 3]).every(alpha => alpha > 100));
  const isolatedSize = 96, isolatedSource = Buffer.alloc(isolatedSize * isolatedSize * 4);
  for (let p = 0; p < isolatedSource.length; p += 4) { screen.forEach((v, c) => isolatedSource[p + c] = v); isolatedSource[p + 3] = 255; }
  const isolatedTip = (48 * isolatedSize + 48) * 4;
  hairMix.forEach((v, c) => isolatedSource[isolatedTip + c] = v);
  const isolatedResult = keyGreen(isolatedSource, isolatedSize, isolatedSize, { ...edgeOptions, refineEdges: true }).rgba;
  check('isolated tinted strand with no opaque reference loses screen hue without becoming an opaque gray rim', isolatedResult[isolatedTip + 3] > 64 && isolatedResult[isolatedTip + 3] < 200 && Math.min(isolatedResult[isolatedTip], isolatedResult[isolatedTip + 2]) - isolatedResult[isolatedTip + 1] <= 2);
  for (let y = 6; y < 59; y++) for (let x = 6; x < 75; x++) detailPut(x, y, hair);
  for (let y = 6; y < 43; y++) detailPut(40, y, hairMix);
  for (let y = 39; y < 42; y++) for (let x = 39; x < 42; x++) detailPut(x, y, hairMix);
  const intentionalPurple = [170, 35, 170];
  detailPut(20, 40, intentionalPurple);
  const gap = (40 * detailWidth + 40) * 4, decoration = (40 * detailWidth + 20) * 4;
  const gapResult = keyGreen(detailSource, detailWidth, detailHeight, { ...edgeOptions, refineEdges: true }).rgba;
  check('screen-connected tinted gap deep inside the silhouette is cleaned without a four-pixel limit', Math.abs(gapResult[gap + 3] - 128) <= 2 && hair.every((v, c) => Math.abs(gapResult[gap + c] - v) <= 2));
  check('disconnected intentional purple decoration remains intact', gapResult.subarray(decoration, decoration + 4).equals(detailSource.subarray(decoration, decoration + 4)));
  for (let y = 0; y < detailHeight; y++) for (let x = 0; x < detailWidth; x++) detailPut(x, y, screen);
  for (let y = 10; y < 55; y++) for (let x = 20; x < 66; x++) detailPut(x, y, intentionalPurple);
  for (let y = 12; y < 53; y++) detailPut(19, y, intentionalPurple.map((v, c) => Math.round((v + screen[c]) / 2)));
  const purpleResult = keyGreen(detailSource, detailWidth, detailHeight, { ...edgeOptions, refineEdges: true }).rgba;
  const garment = (30 * detailWidth + 20) * 4, purpleEdge = (30 * detailWidth + 19) * 4;
  check('opaque purple garment sharing the screen hue remains opaque and keeps its original RGB', purpleResult.subarray(garment, garment + 4).equals(detailSource.subarray(garment, garment + 4)));
  check('purple garment antialiasing is recovered against its own foreground color', Math.abs(purpleResult[purpleEdge + 3] - 128) <= 3 && intentionalPurple.every((v, c) => Math.abs(purpleResult[purpleEdge + c] - v) <= 3));
  for (const [keyColor, color] of [['#00FF00', [0,255,0]], ['#0000FF', [0,0,255]], ['#FF0000', [255,0,0]], ['#FFFF00', [255,255,0]], ['#00FFFF', [0,255,255]]]) {
    for (let y = 0; y < detailHeight; y++) for (let x = 0; x < detailWidth; x++) detailPut(x, y, color);
    for (let y = 16; y < 55; y++) for (let x = 28; x < 72; x++) detailPut(x, y, hair);
    // Green's legacy high threshold removes a 50% screen mixture before refinement.
    // Use a surviving soft edge so this exercises recovery rather than that separate threshold.
    const fraction = keyColor === '#00FF00' ? 0.8 : 0.5;
    detailPut(26, 30, hair.map((v, c) => Math.round(v * fraction + color[c] * (1 - fraction))));
    const keyed = keyGreen(detailSource, detailWidth, detailHeight, { ...edgeOptions, keyColor, refineEdges: true }).rgba;
    const edge = (30 * detailWidth + 26) * 4, core = (30 * detailWidth + 50) * 4;
    check(keyColor + ' edge recovery supports its own channel combination and preserves the opaque core', Math.abs(keyed[edge + 3] - fraction * 255) <= 3 && hair.every((v, c) => Math.abs(keyed[edge + c] - v) <= 3 && keyed[core + c] === v) && keyed[core + 3] === 255);
  }
  await saveConfig({ imageProvider: "custom", customProtocol: "openai", customBaseUrl: origin, customApiKey: "fake-local-key", customModel: "fake-image", keyColor: "#0000FF" });
  put(6, 12, hair.map((v, c) => Math.round((v + screen[c]) / 2)));
  const edgeJob = await imagegen.createImageJob('uploaded edge fixture');
  edgeJob.keying = { ...edgeJob.keying, ...edgeOptions, enabled: true };
  await imagegen.writeImageJob(edgeJob);
  const edgeItem = await imagegen.addImageToJob(edgeJob.id, 'synthetic-edge.png', encodePng(edgeSource, edgeWidth, edgeHeight).toString('base64'));
  const uploadedEdge = await decodeToRgba(imagegen.imageAssetPath(edgeJob.id, edgeItem.keyedFile));
  check('real still-image upload/keying path applies edge recovery automatically without an API call', received.length === 0 && Math.abs(uploadedEdge.rgba[mixed + 3] - 128) <= 2 && hair.every((v, c) => Math.abs(uploadedEdge.rgba[mixed + c] - v) <= 2));
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
  const firstRef = encodePng(Buffer.from([240, 0, 0, 255]), 1, 1).toString("base64");
  const secondRef = encodePng(Buffer.from([0, 0, 240, 255]), 1, 1).toString("base64");
  await imagegen.addImageRef(job.id, "red.png", firstRef);
  await imagegen.addImageRef(job.id, "blue.png", secondRef);
  const referenced = await imagegen.readImageJob(job.id);
  referenced.prompt = "只参考@图片2的材质，生成冰晶剑，剑柄保留木质";
  referenced.suffix = "";
  await imagegen.writeImageJob(referenced);
  const selectedPreview = await imagegen.imagePromptContext(job.id, { prompt: referenced.prompt, suffix: "", keying: { enabled: false, keyColor: "#FF00FF" } });
  await imagegen.generateImageItem(job.id, 2);
  check("actual edit request sends only the mentioned reference bytes", received.at(-1).images.length === 1 && received.at(-1).images[0] === secondRef);
  assert.equal(received.at(-1).prompt, selectedPreview.prompt);
  check("free preview exactly matches the final prompt sent to the image API", selectedPreview.prompt === received.at(-1).prompt && received.at(-1).prompt.includes("第1张附图=@图片2"));
  referenced.prompt = "根据参考图生成一把剑";
  await imagegen.writeImageJob(referenced);
  await imagegen.generateImageItem(job.id, 3);
  check("without mentions the actual API receives all references in uploaded order", JSON.stringify(received.at(-1).images) === JSON.stringify([firstRef, secondRef]));
  referenced.prompt = "参考@图片99";
  await imagegen.writeImageJob(referenced);
  const beforeInvalid = received.length;
  await assert.rejects(imagegen.generateImageItem(job.id, 4), /不存在/);
  check("invalid references fail before any paid request or running item is written", received.length === beforeInvalid && !(await imagegen.readImageJob(job.id)).items[4]);
  console.log(`Passed ${checks} image transparency checks. Synthetic pixels and loopback API only.`);
} finally {
  globalThis.fetch = originalFetch;
  await new Promise(resolve => server.close(resolve));
  assert.equal(dirname(resolve(home)), resolve(tmpdir()));
  assert.ok(basename(home).startsWith("gmm-image-transparency-"));
  await rm(home, { recursive: true, force: true });
}

/** Local post-processing of 512px motion edits. Never calls an image provider. */
import { DEFAULT_KEY_OPTIONS, keyGreen, type KeyOptions } from "./chroma.js";

const EDGE = 512;
type Shape = { left: number; right: number; top: number; bottom: number; width: number; height: number; x: number; y: number };
export type MotionEdit = { rgba: Buffer; scale: number; translation: number[]; background: "alpha" | "keyed" };

function foreground(rgba: Buffer, options: Partial<KeyOptions>) {
  if (rgba.length !== EDGE * EDGE * 4) throw new Error("Invalid motion edit dimensions");
  let transparent = 0, border = 0, clearBorder = 0;
  for (let y = 0; y < EDGE; y++) for (let x = 0; x < EDGE; x++) {
    const clear = rgba[(y * EDGE + x) * 4 + 3] <= 8;
    if (clear) transparent++;
    if (x === 0 || y === 0 || x === EDGE - 1 || y === EDGE - 1) { border++; if (clear) clearBorder++; }
  }
  // A real alpha background has a substantial clear area and clear perimeter.
  // One transparent pixel (or a thin transparent frame) is not enough. In
  // particular, transparent black RGB must never become a color-key sample.
  const background = transparent >= EDGE * EDGE * .05 && clearBorder >= border * .9 ? "alpha" : "keyed";
  return { rgba: background === "alpha" ? Buffer.from(rgba) : keyGreen(rgba, EDGE, EDGE, { ...DEFAULT_KEY_OPTIONS, ...options, refineEdges: true }).rgba, background } as const;
}

function shape(rgba: Buffer): Shape {
  const rows = new Uint32Array(EDGE);
  let count = 0;
  for (let y = 0; y < EDGE; y++) for (let x = 0; x < EDGE; x++) if (rgba[(y * EDGE + x) * 4 + 3] > 127) { rows[y]++; count++; }
  if (count < 64) throw new Error("重绘未得到可用人物，请检查保留的原始回图");
  // Ignore isolated antialiasing/speckles when locating the upper-body anchor.
  const threshold = Math.max(2, Math.max(...rows) * .02);
  let top = 0, bottom = EDGE - 1;
  while (top < bottom && rows[top] < threshold) top++;
  while (bottom > top && rows[bottom] < threshold) bottom--;
  const columns = new Uint32Array(EDGE);
  let sx = 0, sy = 0, n = 0;
  for (let y = top; y < top + (bottom - top + 1) * .4; y++) for (let x = 0; x < EDGE; x++) if (rgba[(y * EDGE + x) * 4 + 3] > 127) { columns[x]++; sx += x; sy += y; n++; }
  const columnThreshold = Math.max(2, Math.max(...columns) * .02);
  let left = 0, right = EDGE - 1;
  while (left < right && columns[left] < columnThreshold) left++;
  while (right > left && columns[right] < columnThreshold) right--;
  if (!n || right - left < 3 || bottom - top < 3) throw new Error("重绘未得到可用人物，请检查保留的原始回图");
  return { left, right, top, bottom, width: right - left + 1, height: bottom - top + 1, x: sx / n, y: sy / n };
}
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };

/** All cells of ONE paid reply share a scale correction. The source pose and
 * upper-body anchor still vary per frame, preserving the original motion/bob.
 * Disagreement is rejected, rather than distorting a changed pose to fit a box. */
export function processMotionEdits(cells: Buffer[], originals: Buffer[], options: Partial<KeyOptions> = {}): MotionEdit[] {
  if (!cells.length || cells.length !== originals.length) throw new Error("Invalid motion edit group");
  const cleaned = cells.map(cell => foreground(cell, options));
  const targets = originals.map(cell => shape(foreground(cell, options).rgba));
  const generated = cleaned.map(cell => shape(cell.rgba));
  const ratios = generated.map((body, i) => ({ width: targets[i].width / body.width, height: targets[i].height / body.height }));
  const candidates = ratios.filter(r => Math.abs(Math.log(r.width / r.height)) <= .08);
  const scale = median((candidates.length ? candidates : ratios).map(r => r.width));
  if (candidates.length < Math.ceil(cells.length / 2) || scale < .75 || scale > 1.33 || ratios.some(r => Math.abs(Math.log(r.width / scale)) > .05 || Math.abs(Math.log(r.height / scale)) > .1))
    throw new Error("重绘人物比例或姿势变化过大，请检查保留的原始回图");
  // Leave small natural/model variation alone; don't fit every frame separately.
  const appliedScale = Math.abs(scale - 1) > .03 ? scale : 1;
  return cleaned.map((cell, i) => {
    const source = targets[i], body = generated[i];
    const dx = Math.round(source.x - body.x), dy = Math.round(source.y - body.y);
    if (Math.abs(dx) > 64 || Math.abs(dy) > 64) throw new Error("重绘人物位置变化过大，请检查保留的原始回图");
    let opaque = 0, clipped = 0;
    for (let y = 0; y < EDGE; y++) for (let x = 0; x < EDGE; x++) if (cell.rgba[(y * EDGE + x) * 4 + 3] > 127) {
      opaque++;
      const tx = Math.round((x - body.x) * appliedScale + body.x + dx), ty = Math.round((y - body.y) * appliedScale + body.y + dy);
      if (tx < 0 || tx >= EDGE || ty < 0 || ty >= EDGE) clipped++;
    }
    if (clipped > Math.max(16, opaque * .001)) throw new Error("重绘校正会裁掉人物，请检查保留的原始回图");
    const rgba = Buffer.alloc(cell.rgba.length);
    // Nearest-neighbor uniform scale keeps pixel-art colors and alpha intact.
    // Inverse mapping aligns the upper-body anchor to this exact source frame.
    for (let y = 0; y < EDGE; y++) for (let x = 0; x < EDGE; x++) {
      const sx = Math.round((x - (body.x + dx)) / appliedScale + body.x);
      const sy = Math.round((y - (body.y + dy)) / appliedScale + body.y);
      if (sx >= 0 && sx < EDGE && sy >= 0 && sy < EDGE) cell.rgba.copy(rgba, (y * EDGE + x) * 4, (sy * EDGE + sx) * 4, (sy * EDGE + sx) * 4 + 4);
    }
    return { rgba, scale: appliedScale, translation: [dx, dy], background: cell.background };
  });
}

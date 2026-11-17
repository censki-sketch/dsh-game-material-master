/** White-model workflow for the existing sprite module. No agent required. */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { dataRoot, loadConfig } from "./config.js";
import { readJson, writeJsonAtomic } from "./jsonio.js";
import {
  decodeToRgba,
  probeDuration,
  probeSize,
  runFfmpeg,
  sniffVideo,
  toDataUri,
  mimeOf,
} from "./media.js";
import { encodePng } from "./png.js";
import { sniffImage } from "./imagegen.js";
import { DEFAULT_KEY_OPTIONS, keyGreen, composeSheet } from "./chroma.js";
import { generateImageWithProvider } from "./imageprovider.js";
import {
  capabilityOf,
  normalizeDuration,
  normalizeResolution,
} from "./minimax.js";
import {
  assertVideoBackendReady,
  downloadVideoTask,
  queryVideoTask,
  submitVideoTask,
  videoBackendOf,
} from "./videogen.js";
import { assetPath, readProject, type VideoBackend } from "./store.js";
import { zipEntries, type ZipEntry } from "./zip.js";

export const MOTION_DIRS = new Set([
  "refs",
  "prepared",
  "videos",
  "frames",
  "redraw",
  "out",
]);
export const MOTION_ORDER = [
  "back",
  "upRight",
  "right",
  "downRight",
  "front",
  "downLeft",
  "left",
  "upLeft",
];
const TEMPLATE_DIR = fileURLToPath(
  new URL("../assets/motion-templates/", import.meta.url),
);
const ID = /^w[a-z0-9]{8,48}$/;
type Segment = {
  action: string;
  start: number;
  end: number;
  frameCount: number;
};
type Frame = {
  id: string;
  action: string;
  direction: string;
  index: number;
  time: number;
  target: string;
  keyed: string;
  redraw?: {
    status: string;
    file?: string;
    raw?: string;
    prompt?: string;
    error?: string;
    translation?: number[];
  };
};
interface MotionJob {
  id: string;
  name: string;
  updatedAt: number;
  revision: number;
  description: string;
  prompt: string;
  segments: Segment[];
  ranges: Segment[];
  rangesConfirmed: boolean;
  character?: string;
  directions?: string;
  prepared?: { video: string; first: string; signature: string };
  video?: {
    status: string;
    taskId?: string;
    backend?: VideoBackend;
    model: string;
    endpoint: string;
    file?: string;
    duration?: number;
    error?: string;
  };
  frames: Frame[];
  archive?: string;
  operation?: string;
  progress?: string;
  error?: string;
}
interface MotionSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
  videoRate: number;
  imageRate: number;
}
const active = new Set<string>();
const cancelled = new Set<string>();
const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
let disposed = false;
export function isMotionId(id: string): boolean {
  return ID.test(id);
}
const root = () => join(dataRoot(), "motion-jobs");
export function motionAssetPath(id: string, relative: string): string {
  if (!isMotionId(id)) throw new Error("Invalid motion job ID");
  const base = resolve(root(), id),
    target = resolve(base, relative);
  if (!target.startsWith(base + sep))
    throw new Error("Invalid motion asset path");
  return target;
}
const path = (id: string, relative: string) => motionAssetPath(id, relative);
const file = (id: string) => path(id, "job.json");
const save = async (job: MotionJob) => {
  job.updatedAt = Date.now();
  await writeJsonAtomic(file(job.id), job);
};
const token = () => `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const redact = (text: string, key: string) =>
  key ? text.replaceAll(key, "[redacted]") : text;
const imageUri = (id: string, relative: string) =>
  toDataUri(path(id, relative), mimeOf(relative));
function checkStopped(id: string): void {
  if (disposed || cancelled.has(id))
    throw new Error(
      "本地处理已停止；已提交的远端请求可能仍会计费，完成帧保留。",
    );
}
function number(value: unknown, low: number, high: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < low || n > high)
    throw new Error(`Expected number in ${low}..${high}`);
  return n;
}
export async function motionCatalog(): Promise<any> {
  return JSON.parse(await readFile(join(TEMPLATE_DIR, "catalog.json"), "utf8"));
}
export async function readMotion(id: string): Promise<MotionJob> {
  if (!isMotionId(id)) throw new Error("Invalid motion job ID");
  const job = await readJson<MotionJob>(file(id));
  if (!job) throw new Error("Motion job not found");
  return job;
}
export async function listMotionJobs(): Promise<any[]> {
  const entries = await readdir(root()).catch(() => [] as string[]);
  const jobs = await Promise.all(
    entries
      .filter(isMotionId)
      .map((id) => readMotion(id).catch(() => undefined)),
  );
  return jobs
    .filter(Boolean)
    .map((j) => ({
      id: j!.id,
      name: j!.name,
      updatedAt: j!.updatedAt,
      operation: j!.operation,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function createMotionJob(name = ""): Promise<MotionJob> {
  const id = `w${Date.now().toString(36)}${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  await mkdir(join(root(), id), { recursive: true });
  for (const sub of MOTION_DIRS)
    await mkdir(path(id, sub), { recursive: true });
  const segments = [
    { action: "walkfoward", start: 0, end: 2, frameCount: 12 },
    { action: "runforward", start: 2, end: 4, frameCount: 12 },
  ];
  const job: MotionJob = {
    id,
    name: name.trim().slice(0, 80) || "白模角色动画",
    updatedAt: Date.now(),
    revision: 1,
    description: "",
    prompt: "",
    segments,
    ranges: structuredClone(segments),
    rangesConfirmed: false,
    frames: [],
  };
  job.prompt = await defaultMotionPrompt(job);
  await save(job);
  return job;
}
async function validateSegments(
  values: Segment[],
  reference: boolean,
): Promise<Segment[]> {
  if (!Array.isArray(values) || values.length < 2 || values.length > 3)
    throw new Error("4秒视频只允许2或3种动作");
  const catalog = await motionCatalog();
  const keys = new Set<string>();
  const segments = values.map((value) => {
    if (
      !catalog.actions.some((a) => a.key === value.action) ||
      keys.has(value.action)
    )
      throw new Error("Unknown or duplicate motion template");
    keys.add(value.action);
    const start = number(value.start, 0, 120),
      end = number(value.end, 0, 120),
      frameCount = number(value.frameCount, 4, 24);
    if (end - start < 0.2 || !Number.isInteger(frameCount))
      throw new Error("Invalid action interval or frame count");
    return { action: value.action, start, end, frameCount };
  });
  for (let i = 1; i < segments.length; i++)
    if (segments[i].start < segments[i - 1].end - 1e-6)
      throw new Error("Action intervals overlap");
  if (
    reference &&
    (segments[0].start !== 0 ||
      Math.abs(segments.at(-1)!.end - 4) > 1e-6 ||
      segments.some(
        (s, i) => i > 0 && Math.abs(s.start - segments[i - 1].end) > 1e-6,
      ))
  )
    throw new Error(
      "Reference timeline must continuously cover exactly 4 seconds",
    );
  return segments;
}
async function exclusive<T>(
  id: string,
  run: (job: MotionJob) => Promise<T>,
): Promise<T> {
  if (disposed || active.has(id)) throw new Error("任务正在处理，请勿重复点击");
  active.add(id);
  try {
    return await run(await readMotion(id));
  } finally {
    active.delete(id);
  }
}
function assertEditable(job: MotionJob): void {
  if (
    job.video &&
    ["submitting", "unknown", "pending", "running"].includes(job.video.status)
  )
    throw new Error("视频任务未结束；请先查询状态或导入已有视频");
}
function invalidate(job: MotionJob, reference: boolean): void {
  if (reference) job.prepared = undefined;
  job.video = undefined;
  job.frames = [];
  job.archive = undefined;
  job.rangesConfirmed = false;
  job.revision++;
}
export async function saveMotionJob(id: string, input: any): Promise<void> {
  await exclusive(id, async (job) => {
    assertEditable(job);
    const oldDefault = await defaultMotionPrompt(job);
    let referenceChanged = false,
      videoChanged = false;
    if (input.name !== undefined)
      job.name = String(input.name).trim().slice(0, 80) || job.name;
    if (
      input.description !== undefined &&
      input.description !== job.description
    ) {
      job.description = String(input.description).slice(0, 8000);
      videoChanged = true;
    }
    if (input.segments !== undefined) {
      const next = await validateSegments(input.segments, true);
      if (JSON.stringify(next) !== JSON.stringify(job.segments)) {
        job.segments = next;
        job.ranges = structuredClone(next);
        referenceChanged = true;
      }
    }
    if (input.prompt !== undefined && input.prompt !== job.prompt) {
      job.prompt = String(input.prompt).slice(0, 20000);
      videoChanged = true;
    }
    if (referenceChanged || videoChanged) invalidate(job, referenceChanged);
    if ((referenceChanged || videoChanged) && job.prompt === oldDefault)
      job.prompt = await defaultMotionPrompt(job);
    if (input.ranges !== undefined) {
      const ranges = await validateSegments(input.ranges, false);
      if (
        ranges.some((s, i) => s.action !== job.segments[i]?.action) ||
        ranges.length !== job.segments.length
      )
        throw new Error("Extract ranges must match selected actions");
      if (
        job.video?.duration &&
        ranges.some((s) => s.end > job.video!.duration! + 0.001)
      )
        throw new Error("Range exceeds actual video duration");
      if (JSON.stringify(ranges) !== JSON.stringify(job.ranges)) {
        job.ranges = ranges;
        job.frames = [];
        job.archive = undefined;
        job.rangesConfirmed = false;
      }
    }
    if (input.rangesConfirmed !== undefined)
      job.rangesConfirmed = input.rangesConfirmed === true;
    await save(job);
  });
}
export async function uploadMotionAsset(
  id: string,
  kind: string,
  data: string,
): Promise<void> {
  await exclusive(id, async (job) => {
    if (kind === "project") {
      assertEditable(job);
      const source = await readProject(data);
      if (!source) throw new Error("八方向项目不存在");
      const config = await loadConfig(),
        rows: any[] = [];
      for (const direction of MOTION_ORDER) {
        const relative = source.images[direction]?.file;
        if (!relative) throw new Error("原项目八个方向图需要全部完成");
        const decoded = await decodeToRgba(assetPath(source.id, relative), 512);
        const square = Buffer.alloc(512 * 512 * 4),
          scale = Math.min(512 / decoded.width, 512 / decoded.height),
          w = Math.round(decoded.width * scale),
          h = Math.round(decoded.height * scale);
        blit(
          resize(decoded.rgba, decoded.width, decoded.height, w, h),
          w,
          h,
          square,
          512,
          512,
          Math.floor((512 - w) / 2),
          Math.floor((512 - h) / 2),
        );
        rows.push({
          key: direction,
          frames: [
            keyGreen(square, 512, 512, {
              ...DEFAULT_KEY_OPTIONS,
              keyColor: source.settings.keyColorOverride
                ? source.settings.keyColor
                : config.keyColor,
            }).rgba,
          ],
          width: 512,
          height: 512,
        });
      }
      const sheet = composeSheet(rows, {
        cellWidth: 216,
        cellHeight: 240,
        frameCount: 1,
        autoCrop: true,
        fillRatio: 0.85,
        pixelSize: 1,
        fitMode: "contain",
        bottomMargin: 16,
      });
      const grid = Buffer.alloc(864 * 480 * 4);
      for (let p = 0; p < grid.length; p += 4) {
        grid[p] = 255;
        grid[p + 2] = 255;
        grid[p + 3] = 255;
      }
      for (let d = 0; d < 8; d++)
        blit(
          crop(sheet.rgba, 216, 0, d * 240, 216, 240),
          216,
          240,
          grid,
          864,
          480,
          (d % 4) * 216,
          Math.floor(d / 4) * 240,
        );
      const suffix = token(),
        directions = `refs/${suffix}-directions.png`,
        character = `refs/${suffix}-character.png`;
      await writeFile(path(id, directions), encodePng(grid, 864, 480));
      const original = await decodeToRgba(
        assetPath(source.id, source.images.front.file!),
        1024,
      );
      await writeFile(
        path(id, character),
        encodePng(original.rgba, original.width, original.height),
      );
      job.character = character;
      job.directions = directions;
      invalidate(job, true);
      await save(job);
      return;
    }
    if (!["character", "directions", "video"].includes(kind))
      throw new Error("Invalid asset role");
    if (kind !== "video") assertEditable(job);
    const raw = data.replace(/^data:[^,]*,/, "");
    if (raw.length > 70 * 1024 * 1024) throw new Error("Asset exceeds 50MB");
    const bytes = Buffer.from(raw, "base64");
    const info = kind === "video" ? sniffVideo(raw) : sniffImage(raw);
    if (!info) throw new Error("Unsupported asset format");
    const relative = `${kind === "video" ? "videos" : "refs"}/${token()}.${info.ext}`;
    await writeFile(path(id, relative), bytes);
    if (kind === "video") {
      const size = await probeSize(path(id, relative));
      if (Math.abs(size.width / size.height - 1.8) > 0.04)
        throw new Error("需要四列两行的16:9八方向视频");
      const duration = await probeDuration(path(id, relative));
      job.video = {
        status: "ready",
        file: relative,
        model: "local-import",
        endpoint: "",
        duration,
      };
      job.frames = [];
      job.archive = undefined;
      job.rangesConfirmed = false;
    } else {
      job[kind] = relative;
      invalidate(job, true);
    }
    await save(job);
  });
}

const settingsFile = () => join(dataRoot(), "motion-settings.json");
async function settings(): Promise<MotionSettings> {
  return {
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "",
    apiKey: "",
    videoRate: 0.16,
    imageRate: 0,
    ...(await readJson<Partial<MotionSettings>>(settingsFile())),
  };
}
export async function motionSettings(input: any = {}): Promise<any> {
  const value = await settings();
  if (input.save === true) {
    if (input.baseUrl !== undefined) {
      const url = new URL(String(input.baseUrl).trim());
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Invalid API base URL");
      value.baseUrl = url.toString().replace(/\/$/, "");
    }
    if (input.model !== undefined)
      value.model = String(input.model).trim().slice(0, 200);
    if (input.apiKey !== undefined) value.apiKey = String(input.apiKey).trim();
    if (input.videoRate !== undefined)
      value.videoRate = number(input.videoRate, 0, 1000);
    if (input.imageRate !== undefined)
      value.imageRate = number(input.imageRate, 0, 1000);
    await writeJsonAtomic(settingsFile(), value);
  }
  const { apiKey, ...publicValue } = value;
  return { ...publicValue, apiKeySet: apiKey !== "" };
}
export async function motionView(id: string): Promise<any> {
  const job = await readMotion(id),
    config = await loadConfig(),
    prices = await settings();
  const pending = job.frames.filter((f) => f.redraw?.status !== "ready").length;
  return {
    ...job,
    templates: (await motionCatalog()).actions,
    costs: {
      video: prices.videoRate * 8,
      videoRate: prices.videoRate,
      imageRate: prices.imageRate,
      pendingImages: pending,
      redraw: prices.imageRate > 0 ? pending * prices.imageRate : null,
      estimateOnly: true,
    },
    videoBackend: videoBackendOf(config),
    imageProvider: config.imageProvider,
    imageModel:
      config.imageProvider === "custom" ? config.customModel : config.arkModel,
    active: active.has(id),
    duration: 4,
  };
}
async function defaultMotionPrompt(job: MotionJob): Promise<string> {
  const catalog = await motionCatalog();
  const timeline = job.segments
    .map(
      (s) =>
        `${s.start}–${s.end}秒：${catalog.actions.find((a) => a.key === s.action).name}`,
    )
    .join("；");
  return `将参考视频的灰白人物替换成参考图片中的同一个角色。参考视频只决定动作、时间顺序、八格布局和朝向；角色图片只决定外观、服装、配色和画风。\n时间顺序：${timeline}。严格跟随各段参考姿势，短动作按参考重复，不新增动作、不漏动作、不混合前后两段。\n四列两行：上排北、东北、东、东南；下排南、西南、西、西北。每格一个完整人物，全程保持各自朝向，禁止转身、串格、合并或消失。固定相机、人物大小和格内位置。角色完整露出头脚，不复制白模的拳套和短裤。\n角色说明：${job.description || "保持角色参考图的全部外观特征"}\n背景及格间空隙全程纯品红#FF00FF，无地面、阴影、边框、文字、特效、镜头切换或缩放。`;
}
function signature(job: MotionJob): string {
  return createHash("sha256")
    .update(JSON.stringify([job.segments, job.character, job.directions]))
    .digest("hex");
}
function blit(
  source: Buffer,
  sw: number,
  sh: number,
  target: Buffer,
  tw: number,
  th: number,
  x: number,
  y: number,
): void {
  for (let sy = 0; sy < sh; sy++) {
    const ty = sy + y;
    if (ty < 0 || ty >= th) continue;
    for (let sx = 0; sx < sw; sx++) {
      const tx = sx + x;
      if (tx < 0 || tx >= tw) continue;
      const a = (sy * sw + sx) * 4,
        b = (ty * tw + tx) * 4;
      if (source[a + 3] === 0) continue;
      source.copy(target, b, a, a + 4);
    }
  }
}
function resize(
  source: Buffer,
  sw: number,
  sh: number,
  w: number,
  h: number,
): Buffer {
  const target = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const a =
        (Math.min(sh - 1, Math.floor((y * sh) / h)) * sw +
          Math.min(sw - 1, Math.floor((x * sw) / w))) *
        4;
      source.copy(target, (y * w + x) * 4, a, a + 4);
    }
  return target;
}
function crop(
  source: Buffer,
  sw: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Buffer {
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++)
    source.copy(
      out,
      row * w * 4,
      ((y + row) * sw + x) * 4,
      ((y + row) * sw + x + w) * 4,
    );
  return out;
}
function matte(rgba: Buffer, w: number, h: number): Buffer {
  return keyGreen(rgba, w, h, {
    ...DEFAULT_KEY_OPTIONS,
    keyColor: "#FF00FF",
    edgeShrink: 0,
  }).rgba;
}
async function prepare(job: MotionJob): Promise<void> {
  if (!job.character || !job.directions)
    throw new Error("请上传角色细节图和四列两行八方向外观图");
  const size = await probeSize(path(job.id, job.directions));
  if (Math.abs(size.width / size.height - 1.8) > 0.04)
    throw new Error("八方向外观图需为四列两行16:9布局");
  const dir = `prepared/${token()}`;
  await mkdir(path(job.id, dir), { recursive: true });
  const catalog = await motionCatalog();
  const sources = new Map<string, { raw: Buffer; spec: any }>();
  for (const seg of job.segments) {
    const spec = catalog.actions.find((a) => a.key === seg.action);
    const raw = gunzipSync(
      await readFile(join(TEMPLATE_DIR, `${seg.action}.rgba.gz`)),
    );
    if (raw.length !== 126 * 132 * 4 * spec.frames * 8)
      throw new Error("Corrupt template data");
    sources.set(seg.action, { raw, spec });
  }
  // Fixed transform across all frames, directions and actions. Original canvas
  // center and baseline are preserved; no frame-specific recentering.
  const scale = 1.65,
    bw = Math.round(126 * scale),
    bh = Math.round(132 * scale),
    px = Math.round(108 - 63 * scale),
    py = 219 - bh;
  for (let i = 0; i < 96; i++) {
    checkStopped(job.id);
    const t = i / 24,
      seg = job.segments.find((s) => t >= s.start && t < s.end)!;
    const { raw, spec } = sources.get(seg.action)!;
    const cycle = Math.max(0.6, spec.durationMs / 1000),
      phase = ((t - seg.start) % cycle) / cycle;
    let index = 0,
      elapsed = 0;
    for (let j = 0; j < spec.frames; j++) {
      elapsed += spec.frameDurationsMs[j];
      if (phase * spec.durationMs < elapsed) {
        index = j;
        break;
      }
    }
    const canvas = Buffer.alloc(864 * 480 * 4);
    for (let p = 0; p < canvas.length; p += 4) {
      canvas[p] = 255;
      canvas[p + 2] = 255;
      canvas[p + 3] = 255;
    }
    for (let d = 0; d < 8; d++) {
      const start = (d * spec.frames + index) * 126 * 132 * 4;
      const body = Buffer.from(raw.subarray(start, start + 126 * 132 * 4));
      for (let p = 0; p < body.length; p += 4) {
        const gray = Math.round(
          70 +
            0.72 *
              (0.299 * body[p] + 0.587 * body[p + 1] + 0.114 * body[p + 2]),
        );
        body[p] = body[p + 1] = body[p + 2] = gray;
      }
      blit(
        resize(body, 126, 132, bw, bh),
        bw,
        bh,
        canvas,
        864,
        480,
        (d % 4) * 216 + px,
        Math.floor(d / 4) * 240 + py,
      );
    }
    await writeFile(
      path(job.id, `${dir}/f${String(i).padStart(3, "0")}.png`),
      encodePng(canvas, 864, 480),
    );
  }
  const video = `${dir}/reference.mp4`;
  await runFfmpeg([
    "-y",
    "-framerate",
    "24",
    "-i",
    path(job.id, `${dir}/f%03d.png`),
    "-frames:v",
    "96",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "16",
    "-movflags",
    "+faststart",
    path(job.id, video),
  ]);
  job.prepared = { video, first: `${dir}/f000.png`, signature: signature(job) };
  await save(job);
}
async function buildPrompt(job: MotionJob, useModel: boolean): Promise<void> {
  assertEditable(job);
  const base = await defaultMotionPrompt(job);
  if (!useModel) {
    job.prompt = base;
    invalidate(job, false);
    await save(job);
    return;
  }
  const cfg = await settings();
  if (!cfg.model) throw new Error("请先配置提示词文字模型");
  const response = await fetch(
    cfg.baseUrl.replace(/\/$/, "") + "/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          {
            role: "system",
            content:
              "将用户提供的游戏角色外观描述整理为简洁的生图角色约束。只描述已提供的外观、衣服、配色与画风，不新增装备，不描述动作、方向、时间、背景或镜头。不添加用户未提供的事实。仅输出整理后的描述。",
          },
          {
            role: "user",
            content: job.description || "保持角色参考图的外观，不臆测细节。",
          },
        ],
        max_tokens: 1000,
      }),
      signal: AbortSignal.timeout(90000),
    },
  );
  if (!response.ok)
    throw new Error(`提示词模型HTTP ${response.status}，未重试`);
  const payload: any = await response.json();
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim())
    throw new Error("文字模型未返回提示词");
  job.prompt = base + `\n角色约束补充：${text.trim().slice(0, 6000)}`;
  invalidate(job, false);
  await save(job);
}
async function submit(
  job: MotionJob,
  confirmed: boolean,
  regenerate: boolean,
): Promise<void> {
  if (!confirmed) throw new Error("请确认本次视频生成费用");
  if (
    job.video &&
    ["submitting", "unknown", "pending", "running"].includes(job.video.status)
  )
    throw new Error("已有任务或提交结果未知，禁止重复付费提交");
  if (job.video && !regenerate) throw new Error("已有视频，请显式选择重新生成");
  if (!job.prepared || job.prepared.signature !== signature(job))
    throw new Error("请先准备并查看白模参考视频");
  if (!job.prompt.trim()) throw new Error("请先查看并保存提示词");
  const config = await loadConfig();
  if (videoBackendOf(config) !== "minimax")
    throw new Error(
      "此白模流程需要支持参考视频的MiniMax后端；当前ComfyUI/ToAPIs工作流不能保证传入参考视频",
    );
  assertVideoBackendReady(config);
  if (
    capabilityOf(config.minimaxModel).protocol !== "v2" ||
    normalizeDuration(config.minimaxModel, 4) !== 4 ||
    normalizeResolution(config.minimaxModel, "480P") !== "480P"
  )
    throw new Error(
      "当前视频模型不支持本流程的4秒480P多模态参考，请在设置选择MiniMax-H3-Lite",
    );
  if (!config.minimaxApiKey.trim())
    throw new Error("请先在设置填写MiniMax API Key");
  const request = {
    prompt: job.prompt,
    referenceImages: [
      await imageUri(job.id, job.directions!),
      await imageUri(job.id, job.character!),
    ],
    referenceVideos: [
      await toDataUri(path(job.id, job.prepared.video), "video/mp4"),
    ],
    duration: 4,
    resolution: "480P",
    promptOptimizer: false,
    model: config.minimaxModel,
    ratio: "16:9",
  };
  job.video = {
    status: "submitting",
    model: config.minimaxModel,
    endpoint: config.minimaxBaseUrl,
  };
  job.frames = [];
  job.archive = undefined;
  job.rangesConfirmed = false;
  await save(job);
  try {
    const result = await submitVideoTask(config, request);
    job.video = {
      ...job.video,
      status: "pending",
      taskId: result.taskId,
      backend: result.backend,
    };
    await save(job);
  } catch (error) {
    job.video.status = "unknown";
    job.video.error =
      "提交未确认，可能已计费；不可自动重试。" +
      redact(
        String(error instanceof Error ? error.message : error),
        config.minimaxApiKey,
      );
    await save(job);
    throw new Error(job.video.error);
  }
}
async function poll(job: MotionJob): Promise<void> {
  if (!job.video?.taskId || job.video.status === "ready") return;
  const config = await loadConfig();
  config.minimaxBaseUrl = job.video.endpoint;
  const result = await queryVideoTask(
    config,
    job.video.backend ?? "minimax",
    job.video.taskId,
    { model: job.video.model },
  );
  if (result.status === "succeeded") {
    const relative = `videos/${token()}.mp4`;
    const bytes = await downloadVideoTask(
      config,
      job.video.backend ?? "minimax",
      result.url!,
    );
    await writeFile(path(job.id, relative), bytes);
    job.video.file = relative;
    try {
      const size = await probeSize(path(job.id, relative));
      if (Math.abs(size.width / size.height - 1.8) > 0.04)
        throw new Error(
          "视频画幅不符合四列两行布局，请检查原视频；不会自动重新生成",
        );
      job.video.duration = await probeDuration(path(job.id, relative));
      job.video.status = "ready";
    } catch (error) {
      job.video.status = "failed";
      job.video.error = String(error instanceof Error ? error.message : error);
    }
  } else if (result.status === "failed") {
    job.video.status = "failed";
    job.video.error = redact(
      result.error || "Video generation failed",
      config.minimaxApiKey,
    );
  } else job.video.status = result.status;
  await save(job);
}
function schedulePoll(id: string): void {
  if (disposed || pollTimers.has(id)) return;
  const timer = setTimeout(async () => {
    pollTimers.delete(id);
    if (disposed) return;
    if (active.has(id)) {
      schedulePoll(id);
      return;
    }
    await exclusive(id, async (job) => {
      if (
        job.video?.taskId &&
        ["pending", "running", "succeeded"].includes(job.video.status)
      )
        await poll(job);
    }).catch(() => {});
    const job = await readMotion(id).catch(() => undefined);
    if (
      job?.video?.taskId &&
      ["pending", "running", "succeeded"].includes(job.video.status)
    )
      schedulePoll(id);
  }, 5000);
  timer.unref();
  pollTimers.set(id, timer);
}
async function extract(job: MotionJob): Promise<void> {
  if (job.video?.status !== "ready" || !job.video.file)
    throw new Error("请先生成或导入视频");
  if (!job.rangesConfirmed)
    throw new Error("请观看视频、调整动作分段后确认抽帧范围");
  const duration = await probeDuration(path(job.id, job.video.file));
  const dir = `frames/${token()}`;
  await mkdir(path(job.id, dir), { recursive: true });
  const frames: Frame[] = [];
  for (const seg of job.ranges) {
    checkStopped(job.id);
    if (seg.end > duration + 0.001) throw new Error("抽帧范围超出实际视频时长");
    const n = seg.frameCount;
    const { stdout } = await runFfmpeg([
      "-ss",
      String(seg.start),
      "-i",
      path(job.id, job.video.file),
      "-t",
      String(seg.end - seg.start),
      "-vf",
      `scale=864:480:flags=lanczos,fps=${n / (seg.end - seg.start)},format=rgba`,
      "-frames:v",
      String(n),
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-",
    ]);
    if (stdout.length !== n * 864 * 480 * 4)
      throw new Error("抽帧数量不完整，请调整动作范围");
    for (let i = 0; i < n; i++)
      for (let d = 0; d < 8; d++) {
        const raw = crop(
          stdout.subarray(i * 864 * 480 * 4, (i + 1) * 864 * 480 * 4),
          864,
          (d % 4) * 216,
          Math.floor(d / 4) * 240,
          216,
          240,
        );
        const cell = resize(raw, 216, 240, 432, 480),
          canvas = Buffer.alloc(512 * 512 * 4);
        for (let p = 0; p < canvas.length; p += 4) {
          canvas[p] = 255;
          canvas[p + 2] = 255;
          canvas[p + 3] = 255;
        }
        blit(cell, 432, 480, canvas, 512, 512, 40, 16);
        const key = `${seg.action}-${MOTION_ORDER[d]}-${i}`,
          target = `${dir}/${key}-target.png`,
          keyed = `${dir}/${key}.png`;
        await writeFile(path(job.id, target), encodePng(canvas, 512, 512));
        await writeFile(
          path(job.id, keyed),
          encodePng(matte(canvas, 512, 512), 512, 512),
        );
        frames.push({
          id: key,
          action: seg.action,
          direction: MOTION_ORDER[d],
          index: i,
          time: seg.start + ((i + 0.5) * (seg.end - seg.start)) / n,
          target,
          keyed,
        });
      }
  }
  job.frames = frames;
  job.archive = undefined;
  await save(job);
}
function head(rgba: Buffer): number[] {
  let top = 512,
    bottom = 0;
  for (let y = 0; y < 512; y++)
    for (let x = 0; x < 512; x++)
      if (rgba[(y * 512 + x) * 4 + 3] > 127) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  let sx = 0,
    sy = 0,
    n = 0;
  for (let y = top; y < top + (bottom - top) * 0.4; y++)
    for (let x = 0; x < 512; x++)
      if (rgba[(y * 512 + x) * 4 + 3] > 127) {
        sx += x;
        sy += y;
        n++;
      }
  return n ? [sx / n, sy / n] : [256, 128];
}
async function redraw(
  job: MotionJob,
  targets: string[],
  confirmed: boolean,
  regenerate: boolean,
): Promise<void> {
  if (!confirmed) throw new Error("请确认高清重绘的图片调用数量和费用");
  if (
    !targets?.length ||
    targets.length > 576 ||
    new Set(targets).size !== targets.length
  )
    throw new Error("请选择需要重绘的帧");
  const selected = targets.map((id) => job.frames.find((f) => f.id === id));
  if (selected.some((f) => !f)) throw new Error("Unknown frame selection");
  const config = await loadConfig();
  if (config.imageProvider !== "custom" || config.customProtocol !== "openai")
    throw new Error(
      "本轮验证的高清重绘需要自定义OpenAI兼容images/edits后端，请先在设置配置",
    );
  if (!job.character) throw new Error("请上传角色细节图");
  if (
    selected.some((f) => f!.redraw?.status && f!.redraw.status !== "ready") &&
    !regenerate
  )
    throw new Error("存在结果未知的图片请求，请检查后显式重新生成选中帧");
  const dir = `redraw/${token()}`;
  await mkdir(path(job.id, dir), { recursive: true });
  for (const f of selected as Frame[]) {
    checkStopped(job.id);
    if (f.redraw?.status === "ready" && !regenerate) continue;
    job.progress = `${(selected as Frame[]).indexOf(f) + 1}/${selected.length} · ${f.id}`;
    await save(job);
    const decoded = await decodeToRgba(path(job.id, f.target));
    const rgba = resize(
      decoded.rgba,
      decoded.width,
      decoded.height,
      1024,
      1024,
    );
    const src = await decodeToRgba(path(job.id, f.keyed));
    let alpha = Uint8Array.from({ length: 512 * 512 }, (_, i) =>
      src.rgba[i * 4 + 3] > 127 ? 1 : 0,
    );
    for (let step = 0; step < 3; step++) {
      const out = new Uint8Array(alpha.length);
      for (let y = 1; y < 511; y++)
        for (let x = 1; x < 511; x++) {
          const p = y * 512 + x;
          out[p] =
            alpha[p] &
            alpha[p - 1] &
            alpha[p + 1] &
            alpha[p - 512] &
            alpha[p + 512];
        }
      alpha = out;
    }
    const mask = Buffer.alloc(512 * 512 * 4, 255);
    for (let p = 0; p < alpha.length; p++) mask[p * 4 + 3] = alpha[p] ? 0 : 255;
    const prompt = `高清重绘图片1中的单个人物，保持图片1的朝向、身体姿势、手脚位置、人物大小与构图。图片2只提供角色身份、服装、配色与画风，不复制站立姿势。只补清晰细节，动作保持优先。${job.description}\n保持原轮廓附近的位置，不添加装备、阴影、地面、文字或特效，背景纯品红#FF00FF。`;
    const promptFile = `${dir}/${f.id}-prompt.txt`;
    await writeFile(path(job.id, promptFile), prompt);
    const input = `${dir}/${f.id}-input.png`,
      maskFile = `${dir}/${f.id}-mask.png`;
    await writeFile(path(job.id, input), encodePng(rgba, 1024, 1024));
    await writeFile(
      path(job.id, maskFile),
      encodePng(resize(mask, 512, 512, 1024, 1024), 1024, 1024),
    );
    f.redraw = { status: "attempted", prompt: promptFile };
    job.archive = undefined;
    await save(job);
    try {
      const result = await generateImageWithProvider({
        prompt,
        images: [
          await imageUri(job.id, input),
          await imageUri(job.id, job.character),
        ],
        mask: await imageUri(job.id, maskFile),
        quality: "high",
        size: "1024x1024",
        watermark: false,
      });
      const raw = `${dir}/${f.id}-raw.${result.ext}`;
      await writeFile(path(job.id, raw), result.bytes);
      f.redraw.raw = raw;
      await save(job);
      const { stdout } = await runFfmpeg([
        "-i",
        path(job.id, raw),
        "-vf",
        "scale=512:512:flags=lanczos,format=rgba",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-",
      ]);
      if (stdout.length !== 512 * 512 * 4)
        throw new Error("Invalid generated image");
      const clean = matte(stdout, 512, 512);
      let opaque = 0;
      for (let p = 3; p < clean.length; p += 4) if (clean[p] > 127) opaque++;
      if (opaque < 64)
        throw new Error("重绘未得到可用人物，请检查保留的原始回图");
      const a = head(src.rgba),
        b = head(clean),
        dx = Math.round(a[0] - b[0]),
        dy = Math.round(a[1] - b[1]);
      const aligned = Buffer.alloc(clean.length),
        small = Math.abs(dx) <= 20 && Math.abs(dy) <= 20;
      blit(clean, 512, 512, aligned, 512, 512, small ? dx : 0, small ? dy : 0);
      const output = `${dir}/${f.id}.png`;
      await writeFile(path(job.id, output), encodePng(aligned, 512, 512));
      f.redraw = {
        status: "ready",
        file: output,
        raw,
        prompt: promptFile,
        translation: small ? [dx, dy] : [0, 0],
      };
      await save(job);
    } catch (error) {
      f.redraw = {
        ...f.redraw,
        status: "unknown",
        error:
          "请求可能已计费；未自动重试。" +
          redact(
            String(error instanceof Error ? error.message : error),
            config.customApiKey,
          ),
      };
      await save(job);
      throw new Error(f.redraw.error);
    }
  }
}
async function exportJob(job: MotionJob, useRedraw: boolean): Promise<void> {
  if (!job.frames.length) throw new Error("请先抽帧");
  if (useRedraw && job.frames.some((f) => f.redraw?.status !== "ready"))
    throw new Error("高清版本还有未完成帧，请补齐或选择原视频帧导出");
  const entries: ZipEntry[] = [],
    metadata: any = {
      version: 1,
      directionOrder: MOTION_ORDER,
      cellWidth: 512,
      cellHeight: 512,
      mode: useRedraw ? "redrawn" : "video-crops",
      actions: [],
      pixelDetail: useRedraw
        ? "AI redrawn; temporal consistency requires review"
        : "480P crops enlarged locally; not native 512px detail",
      source: "Hormelz CC0",
      sourceUrl: "https://hormelz.itch.io/8-directional-melee-character",
    };
  const dir = `out/${token()}`;
  await mkdir(path(job.id, dir), { recursive: true });
  for (const seg of job.ranges) {
    checkStopped(job.id);
    const sheet = Buffer.alloc(512 * seg.frameCount * 512 * 8 * 4);
    for (const frame of job.frames.filter((f) => f.action === seg.action)) {
      const selected = useRedraw ? frame.redraw!.file! : frame.keyed;
      const bytes = await readFile(path(job.id, selected));
      entries.push({
        path: `${seg.action}/${frame.direction}/f${String(frame.index).padStart(2, "0")}.png`,
        data: bytes,
      });
      const decoded = await decodeToRgba(path(job.id, selected));
      blit(
        decoded.rgba,
        512,
        512,
        sheet,
        512 * seg.frameCount,
        512 * 8,
        frame.index * 512,
        MOTION_ORDER.indexOf(frame.direction) * 512,
      );
    }
    const png = encodePng(sheet, 512 * seg.frameCount, 512 * 8),
      name = `${seg.action}-sheet.png`;
    await writeFile(path(job.id, `${dir}/${name}`), png);
    entries.push({ path: name, data: png });
    metadata.actions.push({
      ...seg,
      frameDurationMs: ((seg.end - seg.start) * 1000) / seg.frameCount,
      sheet: name,
      rows: 8,
      columns: seg.frameCount,
      loopVerified: false,
    });
  }
  entries.push(
    {
      path: "animation.json",
      data: Buffer.from(JSON.stringify(metadata, null, 2)),
    },
    { path: "video-prompt.txt", data: Buffer.from(job.prompt) },
    {
      path: "source-license.txt",
      data: await readFile(join(TEMPLATE_DIR, "LICENSE.txt")),
    },
  );
  await writeFile(
    path(job.id, `${dir}/animation.json`),
    Buffer.from(JSON.stringify(metadata, null, 2)),
  );
  job.archive = `${dir}/sprites.zip`;
  await writeFile(path(job.id, job.archive), zipEntries(entries));
  await save(job);
}
export async function runMotionStep(
  id: string,
  input: any,
): Promise<{ started: true }> {
  if (!isMotionId(id)) throw new Error("Invalid motion job ID");
  if (input.step === "cancel") {
    if (active.has(id)) cancelled.add(id);
    return { started: true };
  }
  if (
    ![
      "prepare",
      "prompt",
      "video",
      "poll",
      "extract",
      "redraw",
      "export",
    ].includes(input.step)
  )
    throw new Error("Unknown workflow step");
  if (disposed || active.has(id)) throw new Error("任务正在处理，请勿重复点击");
  // Acquire the same lock before starting the background operation, including
  // before the first file read. Repeated button/RPC clicks cannot queue bills.
  active.add(id);
  cancelled.delete(id);
  const run = async () => {
    let job: MotionJob | undefined;
    try {
      job = await readMotion(id);
      job.operation = input.step;
      job.error = undefined;
      job.progress = "";
      await save(job);
      if (input.step === "prepare") {
        assertEditable(job);
        await prepare(job);
      } else if (input.step === "prompt")
        await buildPrompt(job, input.useModel === true);
      else if (input.step === "video")
        await submit(job, input.confirmed === true, input.regenerate === true);
      else if (input.step === "poll") await poll(job);
      else if (input.step === "extract") await extract(job);
      else if (input.step === "redraw")
        await redraw(
          job,
          input.targets,
          input.confirmed === true,
          input.regenerate === true,
        );
      else await exportJob(job, input.useRedraw === true);
    } catch (error) {
      if (job) {
        let message = error instanceof Error ? error.message : String(error);
        const config = await loadConfig().catch(() => undefined);
        const privateSettings = await settings().catch(() => undefined);
        for (const key of [
          config?.minimaxApiKey,
          config?.customApiKey,
          config?.arkApiKey,
          privateSettings?.apiKey,
        ]) {
          if (key) message = redact(message, key);
        }
        job.error = message;
      }
    } finally {
      try {
        if (job) {
          job.operation = undefined;
          job.progress = undefined;
          await save(job);
        }
      } finally {
        active.delete(id);
        cancelled.delete(id);
        if (
          job?.video?.taskId &&
          ["pending", "running"].includes(job.video.status)
        )
          schedulePoll(id);
      }
    }
  };
  void run().catch(() => {
    active.delete(id);
    cancelled.delete(id);
  });
  return { started: true };
}
export function activateMotion(): void {
  disposed = false;
}
export function disposeMotion(): void {
  disposed = true;
  for (const timer of pollTimers.values()) clearTimeout(timer);
  pollTimers.clear();
}
export async function resumeMotionJobs(): Promise<void> {
  for (const item of await listMotionJobs()) {
    if (active.has(item.id)) continue;
    await exclusive(item.id, async (job) => {
      if (job.operation) {
        job.error = "上次本地处理被中断；已完成产物保留，不自动重新计费。";
        job.operation = undefined;
      }
      if (job.video?.status === "submitting") job.video.status = "unknown";
      await save(job);
      if (
        job.video?.taskId &&
        ["pending", "running"].includes(job.video.status)
      )
        await poll(job).catch(() => {});
      if (
        job.video?.taskId &&
        ["pending", "running"].includes(job.video.status)
      )
        schedulePoll(job.id);
    });
  }
}

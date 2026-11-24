/** White-model workflow for the existing sprite module. No agent required. */
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { customConnectionConfig, dataRoot, loadConfig, MINIMAX_MODEL_PRESETS, motionRedrawModel, motionRedrawRoutes, saveConfig, type Config, type MotionRedrawSelection } from "./config.js";
import { readJson, writeJsonAtomic } from "./jsonio.js";
import {
  decodeToRgba,
  probeDuration,
  probeSize,
  probeVideoFrameTimeline,
  runFfmpeg,
  sniffVideo,
  toDataUri,
  mimeOf,
} from "./media.js";
import { encodePng } from "./png.js";
import { sniffImage } from "./imagegen.js";
import { DEFAULT_KEY_OPTIONS, keyGreen, composeSheet } from "./chroma.js";
import { assertMaskedImageEditProvider, generateImageWithProvider } from "./imageprovider.js";
import {
  capabilityOf,
  normalizeDuration,
  gatewayOf,
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
import { MOTION_PROMPT_TEMPLATES, validateMotionTemplates, motionRedrawPrompt } from "./motionprompts.js";
import type { ImagePromptTemplate } from "./imageprompts.js";
import { templatesOfType } from "./prompttemplates.js";
import { processMotionEdits } from "./motionimage.js";
import { cleanMotionKeySpill, supportsMotionKeySpillCleanup } from "./motionmatte.js";

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
  targetFps?: number;
};
const importedActionKeys = ["video", "video-2", "video-3"];
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
    scale?: number;
    background?: "alpha" | "keyed";
    scheme?: "frame" | "sheet" | "sheet8";
    batchId?: string;
    image1k?: boolean;
    imageModel?: MotionRedrawSelection;
  };
};
type ValidFrameRange = { start: number; end: number };
export type MotionPhaseTiming = { step: string; startedAt: number; endedAt: number; elapsedMs?: number };
type MotionActiveTiming = { step: string; startedAt: number; elapsedMs?: number; completed?: number; total?: number };
type MotionProcessingTiming = { operation: string; active?: MotionActiveTiming; completed: MotionPhaseTiming[] };
interface MotionJob {
  reviewMode?: "auto" | "manual";
  videoModel?: string;
  videoGeneration?: { model: string; endpoint: string; resolution: string };
  composerVersion?: number;
  inputMode?: "generate" | "video";
  sourceVideo?: { file: string; duration: number };
  videoRange?: { start: number; end: number; frameCount: number; targetFps?: number };
  promptTemplate?: { id: string; lang: "zh" | "en"; content: string };
  processing?: MotionProcessing;
  /** Signatures of successfully produced local artifacts; null marks an interrupted stage. */
  localArtifacts?: { raw?: string | null; keyed?: string | null; archive?: string | null };
  workflowParent?: string;
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
  /** Per action/direction inclusive frame ranges kept for preview and paid redraws. */
  validFrameRanges?: Record<string, ValidFrameRange>;
  localUpscale?: { files: Record<string, string>; elapsedMs: number; report: string; sourceKind?: "keyed" | "redraw" };
  localUpscaleCancelled?: boolean;
  redrawTargets?: string[];
  archive?: string;
  archiveKind?: "raw" | "keyed" | "redraw";
  operation?: string;
  progress?: string;
  processingTiming?: MotionProcessingTiming;
  error?: string;
}
export function motionFrameRangeKey(frame: Pick<Frame, "action" | "direction">): string {
  return `${frame.action}::${frame.direction}`;
}
export function motionFrameIsValid(job: Pick<MotionJob, "validFrameRanges">, frame: Pick<Frame, "action" | "direction" | "index">): boolean {
  const range = job.validFrameRanges?.[motionFrameRangeKey(frame)];
  return !range || frame.index >= range.start && frame.index <= range.end;
}
export function motionValidFrames(job: Pick<MotionJob, "frames" | "validFrameRanges">): Frame[] {
  return job.frames.filter(frame => motionFrameIsValid(job, frame));
}
/** Share the actual four-second/reference-video constraints with the composer. */
export function motionVideoModels() {
  return MINIMAX_MODEL_PRESETS.flatMap(preset => {
    const caps = capabilityOf(preset.id);
    if (caps.protocol !== "v2" || normalizeDuration(preset.id, 4) !== 4) return [];
    const resolution = caps.resolutions.includes("480P") ? "480P" : caps.resolutions.includes("768P") ? "768P" : null;
    return resolution ? [{ id: preset.id, label: preset.id, resolution }] : [];
  });
}
export function motionVideoSelection(job: Pick<MotionJob, "videoModel">, config: Config) {
  if (!job.videoModel && videoBackendOf(config) !== "minimax") throw new Error("此流程需要支持参考视频的 MiniMax 模型，请在输入栏选择视频模型");
  const model = job.videoModel || config.minimaxModel;
  const option = motionVideoModels().find(item => item.id === model);
  if (!option) throw new Error("当前模型不支持4秒参考视频，请在输入栏选择兼容的视频模型");
  return { model, endpoint: gatewayOf(model, config.minimaxBaseUrl), resolution: option.resolution };
}
export function motionVideoConfig(job: MotionJob, config: Config): Config {
  const selection = job.workflowParent && job.videoGeneration || motionVideoSelection(job, config);
  return { ...config, comfyVideo: false, toapisVideo: false, minimaxModel: selection.model, minimaxBaseUrl: selection.endpoint, minimaxResolution: selection.resolution };
}
interface MotionSettings {
  templates?: ImagePromptTemplate[];
  baseUrl: string;
  model: string;
  apiKey: string;
  videoRate: number;
  imageRate: number;
}
export interface MotionProcessing {
  extract: boolean; key: boolean; sheet: boolean;
  keyColor: string; keyLow: number; keyHigh: number; despill: number; edgeShrink: number; bgTolerance: number;
  cropInset: number; cellWidth: number; cellHeight: number;
}
export function motionProcessing(input: any = {}): MotionProcessing {
  const result = { extract: input.extract !== false, key: input.key !== false, sheet: input.sheet !== false,
    keyColor: input.keyColor ?? "#FF00FF", keyLow: number(input.keyLow ?? 14, 0, 255), keyHigh: number(input.keyHigh ?? 80, 1, 255),
    despill: number(input.despill ?? .65, 0, 1), edgeShrink: number(input.edgeShrink ?? 0, 0, 8), bgTolerance: number(input.bgTolerance ?? 40, 0, 255),
    cropInset: number(input.cropInset ?? 0, 0, .2), cellWidth: number(input.cellWidth ?? 512, 16, 1024), cellHeight: number(input.cellHeight ?? 512, 16, 1024) };
  if (!/^#[0-9a-fA-F]{6}$/.test(result.keyColor) || result.keyHigh <= result.keyLow || !Number.isInteger(result.cellWidth) || !Number.isInteger(result.cellHeight)) throw new Error("Invalid motion processing settings");
  return result;
}
const localHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const localRawSignature = (job: MotionJob, ranges = job.ranges, processing = motionProcessing(job.processing)) => localHash([job.video?.file, ranges.map(r => [r.action, r.start, r.end, motionSampling(r).frameCount, r.targetFps ?? null]), processing.cropInset]);
const localKeySignature = (job: MotionJob, processing = motionProcessing(job.processing)) => localHash([job.frames.map(f => f.target), processing.keyColor.toUpperCase(), processing.keyLow, processing.keyHigh, processing.despill, processing.edgeShrink, processing.bgTolerance]);
const localArchiveSignature = (job: MotionJob, processing = motionProcessing(job.processing)) => localHash([job.ranges, job.frames.map(f => processing.key ? f.keyed : f.target), processing.key, processing.cellWidth, processing.cellHeight]);
function rememberLocalArtifacts(job: MotionJob) {
  if (job.localArtifacts || !job.frames.length) return;
  const processing = motionProcessing(job.processing);
  job.localArtifacts = { raw: localRawSignature(job), keyed: processing.key ? localKeySignature(job) : null, archive: job.archive && job.archiveKind !== "redraw" ? localArchiveSignature(job) : null };
}
async function localRanges(job: MotionJob, input: Segment[]) {
  const imported = job.inputMode === "video" || job.video?.model === "local-import";
  const clips = imported && Array.isArray(input) && input.some(value => importedActionKeys.includes(value?.action));
  let ranges: Segment[];
  if (clips) {
    if (input.length > importedActionKeys.length || input.some((value, i) => value?.action !== importedActionKeys[i])) {
      throw new Error("导入视频须按顺序选择一至三段动作");
    }
    ranges = input.map(value => ({ action: value.action, ...motionVideoRange(job, value) }));
    assertRangeOrder(ranges);
  } else {
    ranges = await validateSegments(input, false, true);
    if (ranges.length !== job.segments.length || ranges.some((r, i) => r.action !== job.segments[i]?.action)) {
      throw new Error("Extract ranges must match selected actions");
    }
  }
  const duration = job.video?.duration ?? (imported ? job.sourceVideo?.duration : undefined);
  if (duration && ranges.some(r => r.end > duration + .001)) throw new Error("Range exceeds actual video duration");
  return ranges;
}
/** Shared by the read-only preview and execution; never plans a paid step. */
export async function motionLocalProcessingPlan(job: MotionJob, input: any) {
  if (job.video?.status !== "ready" || !job.video.file) throw new Error("请先生成或导入视频");
  const ranges = await localRanges(job, input.ranges || job.ranges), processing = motionProcessing({ ...job.processing, ...input.processing, extract: true });
  const baseline = structuredClone(job); rememberLocalArtifacts(baseline);
  const rawChanged = !job.frames.length || baseline.localArtifacts?.raw !== localRawSignature(job, ranges, processing);
  const keyChanged = processing.key && baseline.localArtifacts?.keyed !== localKeySignature(job, processing);
  const sheetChanged = processing.sheet && (!job.archive || job.archiveKind === "redraw" || baseline.localArtifacts?.archive !== localArchiveSignature({ ...job, ranges }, processing));
  const force = input.forceLocal;
  const steps: string[] = rawChanged ? ["extract"] : keyChanged || force === "keyed" ? ["keyed"] : [];
  if (processing.sheet && (steps.length || sheetChanged || force === "export")) steps.push("export");
  return { kind: "local-processing", steps, ranges, processing, changed: JSON.stringify(processing) !== JSON.stringify(motionProcessing(job.processing)), actions: ranges.map(r => r.action), frameCount: ranges.reduce((count, r) => count + r.frameCount * 8, 0) };
}
const active = new Set<string>();
const cancelled = new Set<string>();
const processingTimings = new Map<string, MotionProcessingTiming>();
const timedOperations = new Set(["extract", "keyed", "export", "upscale"]);

function finishMotionPhase(timing: MotionProcessingTiming, now: number) {
  const phase = timing.active;
  if (!phase) return;
  const elapsedMs = (phase.elapsedMs ?? 0) + Math.max(0, now - phase.startedAt);
  const previous = timing.completed.find(item => item.step === phase.step);
  if (previous) {
    previous.endedAt = now;
    previous.elapsedMs = elapsedMs;
  } else timing.completed.push({ step: phase.step, startedAt: phase.startedAt, endedAt: now, elapsedMs });
  timing.active = undefined;
}

/** Extract interleaves decode, source PNG writes and keying. Sum only the
 * slices when each phase was active, rather than its first-to-last wall span. */
function beginMotionPhase(id: string, step: string, total?: number, completed?: number) {
  const timing = processingTimings.get(id);
  if (!timing) return;
  if (timing.active?.step === step) return;
  const now = Date.now();
  finishMotionPhase(timing, now);
  const elapsedMs = timing.completed.find(item => item.step === step)?.elapsedMs ?? 0;
  timing.active = { step, startedAt: now, elapsedMs, completed, total };
}

function motionPhaseProgress(id: string, completed: number) {
  const phase = processingTimings.get(id)?.active;
  if (phase) phase.completed = completed;
}

type UpscaleProgress = { phase: "prepare" | "enhance" | "finish"; completed: number; total: number };
type UpscaleRun = {
  progress: UpscaleProgress;
  progressFile: string;
  cancelFile: string;
  frameCount: number;
  stopWorker?: () => Promise<void>;
  committing?: boolean;
};
const upscaleRuns = new Map<string, UpscaleRun>();
class LocalUpscaleCancelled extends Error {}
function checkUpscaleStopped(id: string) {
  if (disposed || cancelled.has(id)) throw new LocalUpscaleCancelled();
}
async function upscaleProgressOf(id: string): Promise<UpscaleProgress | undefined> {
  const run = upscaleRuns.get(id);
  if (!run) return undefined;
  if (run.stopWorker) {
    const report = await readJson<UpscaleProgress>(run.progressFile);
    if (upscaleRuns.get(id) !== run) return undefined;
    if (run.stopWorker && report && (report.phase === "finish" || report.phase === "enhance" && run.progress.phase !== "finish") &&
      Number.isSafeInteger(report.total) && Number.isSafeInteger(report.completed) &&
      report.total > 0 && report.total <= run.frameCount && report.completed >= 0 && report.completed <= report.total &&
      (report.phase !== "finish" || report.total === run.frameCount) &&
      (report.phase !== run.progress.phase || report.completed >= run.progress.completed)) {
      const { phase, completed, total } = report;
      run.progress = { phase, completed, total };
    }
  }
  return { ...run.progress };
}
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
const videoTimelines = new Map<string, Promise<{ times: number[]; duration: number }>>();
export async function motionVideoTimeline(id: string) {
  const job = await readMotion(id);
  if (!job.video?.file) throw new Error("请先生成或导入视频");
  const file = path(id, job.video.file), info = await stat(file), key = `${file}:${info.size}:${info.mtimeMs}`;
  let timeline = videoTimelines.get(key);
  if (!timeline) {
    timeline = probeVideoFrameTimeline(file).catch(error => { videoTimelines.delete(key); throw error; });
    videoTimelines.set(key, timeline);
    if (videoTimelines.size > 8) videoTimelines.delete(videoTimelines.keys().next().value!);
  }
  return { file: job.video.file, ...await timeline };
}
const videoPreviewPages = new Map<string, Promise<any>>();
/** Small contact sheets of consecutive source frames, independent of extraction or AI results. */
export async function motionVideoFramePreviews(id: string, page: number) {
  if (!Number.isInteger(page) || page < 0) throw new Error("Invalid frame preview page");
  const timeline = await motionVideoTimeline(id), firstFrame = page * 12;
  if (firstFrame >= timeline.times.length) throw new Error("Frame preview page out of range");
  const source = path(id, timeline.file), info = await stat(source);
  const signature = createHash("sha256").update(`${source}:${info.size}:${info.mtimeMs}:192x108-v1`).digest("hex").slice(0, 24);
  const key = `${source}:${signature}:${page}`;
  let pending = videoPreviewPages.get(key);
  if (!pending) {
    pending = (async () => {
      const count = Math.min(12, timeline.times.length - firstFrame), columns = Math.min(6, count), rows = Math.ceil(count / columns);
      const sheet = `out/video-frame-previews/${signature}-${page}.png`, target = path(id, sheet);
      if (!await stat(target).then(value => value.size > 0, () => false)) {
        // Select by decoder frame index, never resample by FPS: VFR thumbnails
        // must represent the exact same source frame as the timeline and player.
        const { stdout } = await runFfmpeg(["-v", "error", "-i", source, "-map", "0:v:0", "-an", "-sn", "-vf",
          `select='between(n,${firstFrame},${firstFrame + count - 1})',scale=192:108:force_original_aspect_ratio=decrease,pad=192:108:(ow-iw)/2:(oh-ih)/2,tile=${columns}x${rows}:nb_frames=${count}`,
          "-frames:v", "1", "-fps_mode", "vfr", "-c:v", "png", "-f", "image2pipe", "pipe:1"], 60000);
        if (!stdout.length) throw new Error("无法生成帧预览");
        await mkdir(path(id, "out/video-frame-previews"), { recursive: true });
        const temporary = `${target}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, stdout); await rename(temporary, target); }
        finally { await rm(temporary, { force: true }).catch(() => {}); }
      }
      return { kind: "video-frame-previews", file: timeline.file, page, firstFrame, count, columns, rows, sheet, width: 192, height: 108 };
    })().catch(error => { videoPreviewPages.delete(key); throw error; });
    videoPreviewPages.set(key, pending);
    if (videoPreviewPages.size > 16) videoPreviewPages.delete(videoPreviewPages.keys().next().value!);
  }
  return pending;
}
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
const templatePreviews = new Map<string, any>();
/** Read-only, local previews use the exact frames/timing used by prepare(). */
export async function motionTemplatePreview(action: string, direction: string): Promise<any> {
  if ((await loadConfig()).hiddenModules.includes("sprite")) throw new Error("Module disabled");
  const catalog = await motionCatalog();
  const spec = catalog.actions.find(item => item.key === action);
  const directionIndex = catalog.directions.indexOf(direction);
  if (!spec || directionIndex < 0) throw new Error("Unknown motion template or direction");
  const key = action + ":" + direction;
  if (templatePreviews.has(key)) return templatePreviews.get(key);
  const raw = gunzipSync(await readFile(join(TEMPLATE_DIR, spec.key + ".rgba.gz")));
  const { width, height } = catalog, frameBytes = width * height * 4;
  if (raw.length !== frameBytes * spec.frames * catalog.directions.length) throw new Error("Corrupt template data");
  const columns = Math.min(8, spec.frames), rows = Math.ceil(spec.frames / columns);
  const atlas = Buffer.alloc(columns * width * rows * height * 4);
  for (let frame = 0; frame < spec.frames; frame++) {
    const start = (directionIndex * spec.frames + frame) * frameBytes;
    const body = Buffer.from(raw.subarray(start, start + frameBytes));
    for (let p = 0; p < body.length; p += 4) {
      const gray = Math.round(70 + 0.72 * (0.299 * body[p] + 0.587 * body[p + 1] + 0.114 * body[p + 2]));
      body[p] = body[p + 1] = body[p + 2] = gray;
    }
    blit(body, width, height, atlas, columns * width, rows * height, (frame % columns) * width, Math.floor(frame / columns) * height);
  }
  const result = { image: "data:image/png;base64," + encodePng(atlas, columns * width, rows * height).toString("base64"), width, height, columns, frames: spec.frames, frameDurationsMs: spec.frameDurationsMs };
  if (templatePreviews.size >= 16) templatePreviews.delete(templatePreviews.keys().next().value);
  templatePreviews.set(key, result);
  return result;
}
export async function readMotion(id: string): Promise<MotionJob> {
  if (!isMotionId(id)) throw new Error("Invalid motion job ID");
  const job = await readJson<MotionJob>(file(id));
  if (!job) throw new Error("Motion job not found");
  return job;
}
export async function listMotionJobs(includeRounds = false): Promise<any[]> {
  const entries = await readdir(root()).catch(() => [] as string[]);
  const jobs = await Promise.all(
    entries
      .filter(isMotionId)
      .map((id) => readMotion(id).catch(() => undefined)),
  );
  return jobs
    .filter(j => j && (includeRounds || !j.workflowParent))
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
    { action: "", start: 0, end: 2, frameCount: 48, targetFps: 24 },
    { action: "", start: 2, end: 4, frameCount: 48, targetFps: 24 },
  ];
  const job: MotionJob = {
    id,
    composerVersion: 1, inputMode: "generate", reviewMode: "auto", processing: motionProcessing(),
    promptTemplate: { id: "motion-video", lang: "zh", content: (await settings()).templates!.find(t => t.id === "motion-video")!.prompt.zh },
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
  await save(job);
  return job;
}
async function validateSegments(
  values: Segment[],
  reference: boolean,
  allowBlank = false,
): Promise<Segment[]> {
  if (!Array.isArray(values) || values.length < 2 || values.length > 3)
    throw new Error("4秒视频只允许2或3种动作");
  const catalog = await motionCatalog();
  const keys = new Set<string>();
  const segments = values.map((value) => {
    if (
      !(allowBlank && value.action === "") && (!catalog.actions.some((a) => a.key === value.action) || keys.has(value.action))
    )
      throw new Error("Unknown or duplicate motion template");
    if (value.action) keys.add(value.action);
    const start = number(value.start, 0, 120),
      end = number(value.end, 0, 120),
      sampling = motionSampling({ ...value, start, end });
    return { action: value.action, start, end, ...sampling };
  });
  assertRangeOrder(segments);
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
function assertRangeOrder(ranges: Segment[]) {
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start < ranges[i - 1].end - 1e-6) throw new Error("Action intervals overlap");
  }
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
  job.frames = []; job.validFrameRanges = undefined; job.redrawTargets = undefined;
  job.localUpscale = undefined;
  job.archive = undefined;
  job.rangesConfirmed = false;
  job.revision++;
}
export async function saveMotionJob(id: string, input: any): Promise<void> {
  await exclusive(id, async (job) => {
    rememberLocalArtifacts(job);
    assertEditable(job);
    if (input.reviewMode !== undefined) {
      if (!["auto", "manual"].includes(input.reviewMode)) throw new Error("Invalid review mode");
      job.reviewMode = input.reviewMode;
    }
    if (input.videoModel !== undefined) {
      if (input.videoModel !== "" && !motionVideoModels().some(item => item.id === input.videoModel)) throw new Error("当前模型不支持4秒参考视频");
      job.videoModel = input.videoModel;
    }
    const oldDefault = await defaultMotionPrompt(job);
    if (input.composerVersion === 1) job.composerVersion = 1;
    if (input.inputMode !== undefined) {
      if (!["generate", "video"].includes(input.inputMode)) throw new Error("Invalid input mode");
      job.inputMode = input.inputMode;
    }
    if (input.processing !== undefined) {
      const next = motionProcessing(input.processing);
      if (next.keyColor !== motionProcessing(job.processing).keyColor) job.prepared = undefined;
      job.processing = next;
    }
    if (input.promptTemplate !== undefined) {
      if (typeof input.promptTemplate.content !== "string" || input.promptTemplate.content.length > 6000) throw new Error("Invalid prompt template");
      job.promptTemplate = { id: String(input.promptTemplate.id).slice(0, 64), lang: input.promptTemplate.lang === "en" ? "en" : "zh", content: input.promptTemplate.content };
    }
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
      const next = await validateSegments(input.segments, true, true);
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
    if (!job.composerVersion && (referenceChanged || videoChanged) && job.prompt === oldDefault)
      job.prompt = await defaultMotionPrompt(job);
    if (input.ranges !== undefined) {
      const ranges = await localRanges(job, input.ranges);
      if (JSON.stringify(ranges) !== JSON.stringify(job.ranges)) {
        job.ranges = ranges;
        job.frames = []; job.validFrameRanges = undefined; job.redrawTargets = undefined;
        job.localUpscale = undefined;
        job.archive = undefined;
        job.rangesConfirmed = false;
      }
    }
    if (input.rangesConfirmed !== undefined)
      job.rangesConfirmed = input.rangesConfirmed === true;
    if (input.videoRange !== undefined) job.videoRange = motionVideoRange(job, input.videoRange);
    if (input.validFrameRanges !== undefined) {
      if (!input.validFrameRanges || typeof input.validFrameRanges !== "object" || Array.isArray(input.validFrameRanges)) throw new Error("Invalid frame ranges");
      const groups = new Map<string, Frame[]>();
      for (const frame of job.frames) {
        const key = motionFrameRangeKey(frame);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(frame);
      }
      const next: Record<string, ValidFrameRange> = {};
      for (const [key, raw] of Object.entries(input.validFrameRanges).slice(0, 256)) {
        const frames = groups.get(key);
        if (!frames?.length || !raw || typeof raw !== "object") continue;
        const values = raw as any;
        const start = Number(values.start), end = Number(values.end);
        if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
        const min = Math.min(...frames.map(frame => frame.index)), max = Math.max(...frames.map(frame => frame.index));
        next[key] = { start: Math.max(min, Math.min(max, Math.min(start, end))), end: Math.max(min, Math.min(max, Math.max(start, end))) };
      }
      job.validFrameRanges = Object.keys(next).length ? next : undefined;
    }
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
    if (["remove-character", "remove-directions", "remove-video"].includes(kind)) {
      assertEditable(job);
      if (kind === "remove-video") { job.sourceVideo = undefined; job.videoRange = undefined; job.inputMode = "generate"; invalidate(job, false); }
      else { job[kind.slice(7)] = undefined; invalidate(job, true); }
      await save(job); return;
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
      job.sourceVideo = { file: relative, duration }; job.inputMode = "video";
      job.videoRange = { start: 0, end: duration, frameCount: Math.max(1, Math.round(duration * 24)), targetFps: 24 };
      job.video = {
        status: "ready",
        file: relative,
        model: "local-import",
        endpoint: "",
        duration,
      };
      job.frames = []; job.validFrameRanges = undefined; job.redrawTargets = undefined;
      job.localUpscale = undefined;
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
  const value = {
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "",
    apiKey: "",
    videoRate: 0.16,
    imageRate: 0,
    ...(await readJson<Partial<MotionSettings>>(settingsFile())),
  };
  return { ...value, templates: templatesOfType((await loadConfig()).promptTemplates, "video") };
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
    if (input.templates !== undefined) {
      const saved = await saveConfig({ promptTemplateEdit: { type: "video", templates: validateMotionTemplates(input.templates) } });
      value.templates = templatesOfType(saved.promptTemplates, "video");
    } else await saveConfig({}); // Persist migrated templates before removing the legacy copy.
    const { templates: _, ...modelSettings } = value;
    await writeJsonAtomic(settingsFile(), modelSettings);
  }
  const { apiKey, ...publicValue } = value;
  return { ...publicValue, templateDefaults: MOTION_PROMPT_TEMPLATES, apiKeySet: apiKey !== "" };
}
export async function motionView(id: string): Promise<any> {
  // The operation can finish while the job/config files are being read. Keep
  // the busy snapshot until a fresh read can include its final saved result.
  const wasActive = active.has(id);
  const job = await readMotion(id),
    config = await loadConfig(),
    prices = await settings();
  const pending = motionValidFrames(job).filter((f) => f.redraw?.status !== "ready").length;
  const upscaleProgress = await upscaleProgressOf(id);
  const timing = processingTimings.get(id);
  const phase = timing?.active;
  const livePhase = phase && upscaleProgress && phase.step === "upscale-" + upscaleProgress.phase
    ? { ...phase, completed: upscaleProgress.completed, total: upscaleProgress.total }
    : phase;
  return {
    ...job,
    localUpscaleAvailable: motionLocalUpscaleAvailable(),
    upscaleProgress,
    processingTiming: timing ? {
      operation: timing.operation,
      active: livePhase ? { ...livePhase } : undefined,
      completed: timing.completed.filter(item => item.step !== livePhase?.step).map(item => ({ ...item })),
    } : job.processingTiming,
    processing: motionProcessing(job.processing), finalPrompt: await composeMotionPrompt(job),
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
    videoModels: motionVideoModels(),
    videoConfig: (() => { try { return job.workflowParent && job.videoGeneration || motionVideoSelection(job, config); } catch (error) { return { model: job.videoModel || config.minimaxModel, blocker: (error as Error).message }; } })(),
    imageProvider: config.imageProvider,
    imageModel:
      config.imageProvider === "custom" ? config.customModel : config.arkModel,
    active: wasActive || active.has(id),
    duration: 4,
  };
}
async function defaultMotionPrompt(job: MotionJob): Promise<string> {
  const catalog = await motionCatalog();
  const timeline = job.segments
    .map(
      (s) =>
        `${s.start}–${s.end}秒：${catalog.actions.find((a) => a.key === s.action)?.name || "请选择动作"}`,
    )
    .join("；");
  return `将参考视频的灰白人物替换成参考图片中的同一个角色。参考视频只决定动作、时间顺序、八格布局和朝向；角色图片只决定外观、服装、配色和画风。\n时间顺序：${timeline}。严格跟随各段参考姿势，短动作按参考重复，不新增动作、不漏动作、不混合前后两段。\n四列两行：上排北、东北、东、东南；下排南、西南、西、西北。每格一个完整人物，全程保持各自朝向，禁止转身、串格、合并或消失。固定相机、人物大小和格内位置。角色完整露出头脚，不复制白模的拳套和短裤。\n角色说明：${job.description || "保持角色参考图的全部外观特征"}\n背景及格间空隙全程纯品红#FF00FF，无地面、阴影、边框、文字、特效、镜头切换或缩放。`;
}
export async function composeMotionPrompt(job: MotionJob): Promise<string> {
  if (!job.composerVersion) return job.prompt;
  const catalog = await motionCatalog();
  const values = { timeline: job.segments.map(s => `${s.start}–${s.end}s: ${catalog.actions.find(a => a.key === s.action)?.name || "…"}`).join("; "),
    description: job.description || (job.promptTemplate?.lang === "en" ? "Keep the appearance in the reference images" : "保持角色参考图的全部外观特征"), keyColor: motionProcessing(job.processing).keyColor };
  const body = job.promptTemplate?.content ?? MOTION_PROMPT_TEMPLATES[0].prompt.zh;
  return [body.replace(/\{\{(timeline|description|keyColor)\}\}/g, (_, key) => values[key]), job.prompt.trim()].filter(Boolean).join("\n\n");
}
/** Read-only draft preview, using the same assembly as video submission. Never saves or prepares media. */
export async function motionPromptContext(id: string, input: any): Promise<any> {
  const job = structuredClone(await readMotion(id));
  if (typeof input.prompt !== "string" || input.prompt.length > 12000) throw new Error("Invalid motion prompt");
  job.prompt = input.prompt;
  if (input.description !== undefined) job.description = String(input.description).slice(0, 8000);
  if (input.segments !== undefined) job.segments = await validateSegments(input.segments, true, true);
  if (input.processing !== undefined) job.processing = motionProcessing(input.processing);
  if (input.promptTemplate !== undefined) {
    if (typeof input.promptTemplate.content !== "string" || input.promptTemplate.content.length > 6000) throw new Error("Invalid prompt template");
    job.promptTemplate = { id: String(input.promptTemplate.id).slice(0, 64), lang: input.promptTemplate.lang === "en" ? "en" : "zh", content: input.promptTemplate.content };
  }
  if (input.composerVersion === 1) job.composerVersion = 1;
  const en = job.promptTemplate?.lang === "en";
  const references = [[job.character, en ? "Character details" : "角色细节参考图"], [job.directions, en ? "Eight-direction appearance (4×2)" : "八方向外观图（四列两行）"]]
    .filter(([file]) => !!file).map(([file, name], i) => ({ file, name, label: `@图片${i + 1}` }));
  const labels = [...job.prompt.matchAll(/@图片\d+/g)].map(match => match[0]);
  if (labels.some(label => !references.some(ref => ref.label === label))) throw new Error("引用的图片不存在，请重新选择参考图。");
  const finalPrompt = await composeMotionPrompt(job);
  const suffix = await composeMotionPrompt({ ...job, prompt: "" });
  return { prompt: finalPrompt, suffix, references, background: { enabled: motionProcessing(job.processing).key, keyColor: motionProcessing(job.processing).keyColor,
    instruction: "The template supplies the exact uniform background; do not alter it." },
    context: { description: job.description, segments: job.segments, duration: 4, layout: "4 columns × 2 rows: N, NE, E, SE / S, SW, W, NW", keyColor: motionProcessing(job.processing).keyColor } };
}
export function motionSampling(value: { start: number; end: number; frameCount: number; targetFps?: number }) {
  const duration = value.end - value.start;
  if (!Number.isFinite(duration) || duration < .2) throw new Error("Invalid action interval or frame count");
  if (value.targetFps !== undefined && (!Number.isInteger(value.targetFps) || value.targetFps < 1 || value.targetFps > 60)) throw new Error("目标帧率必须为1–60 FPS");
  const frameCount = value.targetFps === undefined ? value.frameCount : Math.max(1, Math.round(duration * value.targetFps));
  if (!Number.isInteger(frameCount) || frameCount < 1) throw new Error("Invalid action interval or frame count");
  if (frameCount > 720) throw new Error("单段最多720帧，请缩短范围或降低目标帧率。");
  return { frameCount, ...(value.targetFps === undefined ? {} : { targetFps: value.targetFps }) };
}
export function motionVideoRange(job: MotionJob, value = job.videoRange) {
  const duration = job.sourceVideo?.duration ?? job.video?.duration ?? 0;
  const range = value || { start: 0, end: duration, frameCount: 24 };
  if (!Number.isFinite(duration) || duration < .2 || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end - range.start < .2 || range.end > duration + .001 || !Number.isInteger(range.frameCount) || range.frameCount < 1) throw new Error("Invalid video range or frame count");
  return { start: range.start, end: range.end, ...motionSampling(range) };
}
export async function validateMotionSubmission(job: MotionJob, localOnly: boolean): Promise<void> {
  if (localOnly) {
    if (!job.sourceVideo?.file && !job.video?.file) throw new Error("请先导入视频");
    motionVideoRange(job);
  } else {
    await validateSegments(job.segments, true);
    if (!job.character || !job.directions) throw new Error("请先提供角色图和八方向外观图");
  }
}
function signature(job: MotionJob): string {
  return createHash("sha256")
    .update(JSON.stringify([job.segments, job.character, job.directions, motionProcessing(job.processing).keyColor]))
    .digest("hex");
}
export function motionPreparedCurrent(job: MotionJob): boolean {
  return !!job.prepared && job.prepared.signature === signature(job);
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
async function renderMotionReference(job: MotionJob): Promise<NonNullable<MotionJob["prepared"]>> {
  await validateSegments(job.segments, true);
  const dir = `prepared/${token()}`;
  const background = motionProcessing(job.processing).keyColor.match(/[a-f0-9]{2}/gi)!.map(v => parseInt(v, 16));
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
      canvas[p] = background[0]; canvas[p + 1] = background[1]; canvas[p + 2] = background[2];
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
  return { video, first: `${dir}/f000.png`, signature: signature(job) };
}
/** Preview only the unsaved action draft; never changes the job or submits to a provider. */
export async function previewMotionReference(id: string, input: { segments: Segment[]; keyColor: string }) {
  if ((await loadConfig()).hiddenModules.includes("sprite")) throw new Error("Module disabled");
  return exclusive(id, async saved => {
    const job = structuredClone(saved);
    job.segments = await validateSegments(input.segments, true);
    job.processing = motionProcessing({ ...job.processing, keyColor: input.keyColor });
    return { ...await renderMotionReference(job), duration: 4, width: 864, height: 480 };
  });
}
async function prepare(job: MotionJob): Promise<void> {
  await validateSegments(job.segments, true);
  if (!job.character || !job.directions)
    throw new Error("请上传角色细节图和四列两行八方向外观图");
  // Reference images describe appearance; four columns/two rows do not imply
  // a particular image aspect ratio. Only the rendered/output video has a
  // fixed canvas. Keep the uploaded reference intact instead of stretching it.
  await probeSize(path(job.id, job.directions));
  job.prepared = await renderMotionReference(job);
  await save(job);
}
async function buildPrompt(job: MotionJob, useModel: boolean): Promise<void> {
  assertEditable(job);
  const base = await defaultMotionPrompt(job);
  if (!useModel) {
    if (!job.composerVersion) job.prompt = base;
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
  if (job.composerVersion) job.description = text.trim().slice(0, 6000);
  else job.prompt = base + `\n角色约束补充：${text.trim().slice(0, 6000)}`;
  invalidate(job, false);
  await save(job);
}
async function submit(
  job: MotionJob,
  confirmed: boolean,
  regenerate: boolean,
): Promise<void> {
  await validateMotionSubmission(job, false);
  if (!confirmed) throw new Error("请确认本次视频生成费用");
  if (
    job.video &&
    ["submitting", "unknown", "pending", "running"].includes(job.video.status)
  )
    throw new Error("已有任务或提交结果未知，禁止重复付费提交");
  if (job.video && !regenerate) throw new Error("已有视频，请显式选择重新生成");
  if (!job.prepared || job.prepared.signature !== signature(job))
    throw new Error("请先准备并查看白模参考视频");
  const finalPrompt = await composeMotionPrompt(job);
  if (!finalPrompt.trim()) throw new Error("请先查看并保存提示词");
  const config = motionVideoConfig(job, await loadConfig());
  assertVideoBackendReady(config);
  if (!config.minimaxApiKey.trim())
    throw new Error("请先在设置填写MiniMax API Key");
  const request = {
    prompt: finalPrompt,
    referenceImages: [
      await imageUri(job.id, job.character!),
      await imageUri(job.id, job.directions!),
    ],
    referenceVideos: [
      await toDataUri(path(job.id, job.prepared.video), "video/mp4"),
    ],
    duration: 4,
    resolution: config.minimaxResolution,
    promptOptimizer: false,
    model: config.minimaxModel,
    ratio: "16:9",
  };
  job.video = {
    status: "submitting",
    model: config.minimaxModel,
    endpoint: config.minimaxBaseUrl,
  };
  job.frames = []; job.validFrameRanges = undefined; job.redrawTargets = undefined;
  job.localUpscale = undefined;
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
/** Sample the video's actual background, not the synthetic 512px canvas border. */
function keyMotionCanvas(canvas: Buffer, processing: MotionProcessing): Buffer {
  const cell = crop(canvas, 512, 40, 16, 432, 480);
  const keyed = keyGreen(cell, 432, 480, { ...DEFAULT_KEY_OPTIONS, ...processing, refineEdges: true }).rgba;
  if (processing.despill > 0) cleanMotionKeySpill(keyed, 432, 480, processing.keyColor, cell);
  const output = Buffer.alloc(512 * 512 * 4);
  blit(keyed, 432, 480, output, 512, 512, 40, 16);
  return output;
}
async function extract(job: MotionJob): Promise<void> {
  if (job.video?.status !== "ready" || !job.video.file)
    throw new Error("请先生成或导入视频");
  if (!job.rangesConfirmed)
    throw new Error("请观看视频、调整动作分段后确认抽帧范围");
  const totalSamples = job.ranges.reduce((count, segment) => count + segment.frameCount, 0);
  const totalFrames = totalSamples * MOTION_ORDER.length;
  let decodedSamples = 0;
  beginMotionPhase(job.id, "decode", totalSamples, decodedSamples);
  const duration = await probeDuration(path(job.id, job.video.file));
  const size = await probeSize(path(job.id, job.video.file));
  // Keep native per-cell detail up to the output content size. In particular,
  // 768P video must not be reduced to 480P before cutting its eight cells.
  const width = Math.min(1728, Math.max(4, Math.floor(size.width / 4) * 4));
  const height = Math.min(960, Math.max(2, Math.floor(size.height / 2) * 2));
  const cellWidth = width / 4, cellHeight = height / 2;
  const processing = motionProcessing(job.processing), color = processing.keyColor.match(/[a-f0-9]{2}/gi)!.map(v => parseInt(v, 16));
  const dir = `frames/${token()}`;
  await mkdir(path(job.id, dir), { recursive: true });
  const frames: Frame[] = [];
  for (const seg of job.ranges) {
    checkStopped(job.id);
    if (seg.end > duration + 0.001) throw new Error("抽帧范围超出实际视频时长");
    const n = seg.frameCount;
    // Limit raw-video memory even when a range contains hundreds of frames.
    // Keep one sampling origin: seeking anew at each batch changes fps rounding
    // when the source and target rates differ. Trim after fps, then scale only
    // the selected batch so its pixels match a single uninterrupted extraction.
    for (let batch = 0; batch < n; batch += 12) {
    checkStopped(job.id);
    beginMotionPhase(job.id, "decode", totalSamples, decodedSamples);
    const batchCount = Math.min(12, n - batch);
    const { stdout } = await runFfmpeg([
      "-ss",
      String(seg.start),
      "-i",
      path(job.id, job.video.file),
      "-t",
      String(batchCount * (seg.end - seg.start) / n),
      "-vf",
      `fps=${n / (seg.end - seg.start)},trim=start_frame=${batch}:end_frame=${batch + batchCount},setpts=PTS-STARTPTS,scale=${width}:${height}:flags=lanczos,format=rgba`,
      "-frames:v",
      String(batchCount),
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-",
    ]);
    if (stdout.length !== batchCount * width * height * 4)
      throw new Error("抽帧数量不完整，请调整动作范围");
    decodedSamples += batchCount;
    motionPhaseProgress(job.id, decodedSamples);
    for (let j = 0; j < batchCount; j++)
      for (let d = 0; d < 8; d++) {
        checkStopped(job.id);
        beginMotionPhase(job.id, "frames", totalFrames, frames.length);
        const i = batch + j;
        let raw = crop(
          stdout.subarray(j * width * height * 4, (j + 1) * width * height * 4),
          width,
          (d % 4) * cellWidth,
          Math.floor(d / 4) * cellHeight,
          cellWidth,
          cellHeight,
        );
        const inset = Math.round(processing.cropInset * cellWidth);
        if (inset) raw = resize(crop(raw, cellWidth, inset, inset, cellWidth - inset * 2, cellHeight - inset * 2), cellWidth - inset * 2, cellHeight - inset * 2, cellWidth, cellHeight);
        const cell = resize(raw, cellWidth, cellHeight, 432, 480),
          canvas = Buffer.alloc(512 * 512 * 4);
        for (let p = 0; p < canvas.length; p += 4) {
          canvas[p] = color[0]; canvas[p + 1] = color[1]; canvas[p + 2] = color[2];
          canvas[p + 3] = 255;
        }
        blit(cell, 432, 480, canvas, 512, 512, 40, 16);
        const key = `${seg.action}-${MOTION_ORDER[d]}-${i}`,
          target = `${dir}/${key}-target.png`,
          keyed = `${dir}/${key}.png`;
        await writeFile(path(job.id, target), encodePng(canvas, 512, 512));
        if (processing.key) {
          motionPhaseProgress(job.id, frames.length + 1);
          checkStopped(job.id);
          beginMotionPhase(job.id, "keyed", totalFrames, frames.length);
        }
        await writeFile(
          path(job.id, keyed),
          encodePng(processing.key ? keyMotionCanvas(canvas, processing) : canvas, 512, 512),
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
        motionPhaseProgress(job.id, frames.length);
      }
    }
  }
  job.frames = frames; job.validFrameRanges = undefined; job.redrawTargets = undefined;
  job.localUpscale = undefined;
  job.archive = undefined;
  job.localArtifacts = { raw: localRawSignature(job), keyed: processing.key ? localKeySignature(job, processing) : null, archive: null };
  await save(job);
}
async function rekey(job: MotionJob): Promise<void> {
  if (!job.frames.length) throw new Error("请先抽帧");
  beginMotionPhase(job.id, "keyed", job.frames.length, 0);
  const processing = motionProcessing(job.processing), dir = `frames/${token()}`;
  await mkdir(path(job.id, dir), { recursive: true });
  for (const [index, frame] of job.frames.entries()) {
    checkStopped(job.id);
    const decoded = await decodeToRgba(path(job.id, frame.target));
    const keyed = `${dir}/${frame.id}.png`;
    await writeFile(path(job.id, keyed), encodePng(keyMotionCanvas(decoded.rgba, processing), 512, 512));
    frame.keyed = keyed;
    motionPhaseProgress(job.id, index + 1);
  }
  job.processing = { ...processing, key: true }; job.archive = undefined;
  job.localUpscale = undefined;
  job.localArtifacts = { ...job.localArtifacts, keyed: localKeySignature(job, processing), archive: null }; await save(job);
}
function localUpscaleCommand() {
  const script = process.env.GMM_LOCAL_UPSCALE_SCRIPT;
  const python = process.env.GMM_LOCAL_UPSCALE_PYTHON;
  return script && python && isAbsolute(script) && isAbsolute(python) ? { script, python } : undefined;
}
export function motionLocalUpscaleAvailable(): boolean {
  return !!localUpscaleCommand();
}

/** Decode only a bounded batch of the plugin's 512px frame PNGs at a time. */
async function decodeUpscaleInputs(pattern: string, count: number): Promise<Buffer> {
  const { stdout } = await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-f", "image2", "-start_number", "0", "-i", pattern,
    "-frames:v", String(count), "-f", "rawvideo", "-pix_fmt", "rgba", "-",
  ], 30_000);
  if (stdout.length !== count * 512 * 512 * 4) throw new Error("本地清晰化的输入帧尺寸不完整。");
  return stdout;
}

async function stageUpscaleInputs(job: MotionJob, frames: Frame[], sources: string, staging: string, progress: UpscaleProgress) {
  const keyColor = motionProcessing(job.processing).keyColor;
  const cleanup = supportsMotionKeySpillCleanup(keyColor);
  const inputDir = path(job.id, `${staging}/input`);
  if (cleanup) await mkdir(inputDir, { recursive: true });
  const startedAt = Date.now();
  let changedFrames = 0, removedPixels = 0, correctedPixels = 0;
  const frameBytes = 512 * 512 * 4;
  const batchSize = 16;
  for (let start = 0; start < frames.length; start += batchSize) {
    checkUpscaleStopped(job.id);
    const batch = frames.slice(start, start + batchSize);
    if (!cleanup) {
      await Promise.all(batch.map(frame => copyFile(path(job.id, frame.keyed), join(sources, `${frame.id}.png`))));
      progress.completed += batch.length;
      continue;
    }
    await Promise.all(batch.flatMap((frame, index) => [
      copyFile(path(job.id, frame.target), join(inputDir, `raw-${index}.png`)),
      copyFile(path(job.id, frame.keyed), join(inputDir, `keyed-${index}.png`)),
    ]));
    const [raw, keyed] = await Promise.all([
      decodeUpscaleInputs(join(inputDir, "raw-%d.png"), batch.length),
      decodeUpscaleInputs(join(inputDir, "keyed-%d.png"), batch.length),
    ]);
    for (const [index, frame] of batch.entries()) {
      checkUpscaleStopped(job.id);
      const from = index * frameBytes, to = from + frameBytes;
      const rgba = keyed.subarray(from, to);
      const audit = cleanMotionKeySpill(rgba, 512, 512, keyColor, raw.subarray(from, to));
      const destination = join(sources, `${frame.id}.png`);
      if (audit.removedPixels || audit.correctedPixels) {
        changedFrames++;
        removedPixels += audit.removedPixels;
        correctedPixels += audit.correctedPixels;
        await writeFile(destination, encodePng(rgba, 512, 512));
      } else await copyFile(path(job.id, frame.keyed), destination);
      progress.completed++;
    }
  }
  return { enabled: cleanup, changedFrames, removedPixels, correctedPixels, elapsedMs: Date.now() - startedAt };
}

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
function isMotionRgbaPng(contents: Buffer | undefined, size: number): contents is Buffer {
  return !!contents && contents.length >= 33 && contents.subarray(0, 8).equals(PNG_SIGNATURE) &&
    contents.toString("ascii", 12, 16) === "IHDR" && contents.readUInt32BE(16) === size &&
    contents.readUInt32BE(20) === size && contents[24] === 8 && contents[25] === 6;
}

function upscaleRedrawFrames(job: MotionJob, targets: string[] | undefined): Frame[] {
  const selection = targets ?? job.redrawTargets;
  if (!selection?.length || new Set(selection).size !== selection.length) throw new Error("请选择有效的 1K 重绘帧。");
  const ids = new Set(selection);
  const frames = job.frames.filter(frame => ids.has(frame.id));
  if (frames.length !== ids.size || frames.some(frame => !motionFrameIsValid(job, frame) ||
    frame.redraw?.status !== "ready" || frame.redraw.image1k !== true || !frame.redraw.file ||
    !frame.redraw.file.startsWith("redraw/") || [frame.target, frame.keyed].includes(frame.redraw.file))) {
    throw new Error("所选帧必须全部是有效且已完成的 1K 图片 API 重绘帧。");
  }
  return frames;
}

function runLocalUpscaleWorker(id: string, run: UpscaleRun, executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  checkUpscaleStopped(id);
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: "ignore", detached: !windows });
    let settled = false, timedOut = false, grace: ReturnType<typeof setTimeout> | undefined;
    let signal: Promise<void> | undefined;
    const stop = () => {
      if (settled) return Promise.resolve();
      if (signal) return signal;
      // Let Python reap its Vulkan worker before falling back to the owned process tree.
      signal = writeFile(run.cancelFile, "", { flag: "wx" }).catch(() => {});
      grace = setTimeout(() => {
        const pid = child.pid;
        if (settled || !pid || child.exitCode !== null || child.signalCode !== null) return;
        if (windows) execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
        else {
          try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
        }
      }, 3000);
      grace.unref();
      return signal;
    };
    run.stopWorker = stop;
    const deadline = setTimeout(() => { timedOut = true; void stop(); }, 180_000);
    deadline.unref();
    function finish(code: number | string | null) {
      if (settled) return;
      settled = true;
      run.stopWorker = undefined;
      clearTimeout(deadline);
      if (grace) clearTimeout(grace);
      try {
        checkUpscaleStopped(id);
        if (timedOut) throw new Error("本地清晰化超时。");
        if (code !== 0) throw new Error(`本地清晰化未完成（${code ?? "运行错误"}）。请检查 Python、Pillow 与 RealESRGAN 本机环境。`);
        resolve();
      } catch (error) { reject(error); }
    }
    child.once("error", (error: NodeJS.ErrnoException) => finish(error.code ?? null));
    child.once("close", finish);
  });
}

/** Run the configured batch engine against staged transparent frames. Publish
 * only a complete output bank. Interrupted staging never replaces a version. */
async function upscaleMotion(job: MotionJob, useRedraw: boolean, targets?: string[]): Promise<void> {
  checkUpscaleStopped(job.id);
  beginMotionPhase(job.id, "upscale-prepare");
  const command = localUpscaleCommand();
  if (!command) throw new Error("请先配置本地清晰化的 Python 和处理脚本路径。");
  for (const item of [command.python, command.script]) {
    const info = await stat(item).catch(() => undefined);
    checkUpscaleStopped(job.id);
    if (!info?.isFile()) throw new Error("找不到本地清晰化的 Python 或处理脚本。");
  }
  const frames = useRedraw ? upscaleRedrawFrames(job, targets) : motionValidFrames(job);
  if (!useRedraw && (!motionProcessing(job.processing).key || !frames.length || frames.some(frame => frame.keyed === frame.target))) {
    throw new Error("请先生成透明抠图帧，再运行本地清晰化。");
  }
  if (new Set(frames.map(frame => frame.id)).size !== frames.length || frames.some(frame => !/^[a-zA-Z0-9_-]{1,120}$/.test(frame.id))) {
    throw new Error("本地清晰化的帧标识无效。");
  }
  const startedAt = Date.now();
  const batch = token();
  const staging = `.local-upscale/${batch}`;
  const result = `frames/${batch}-upscaled`;
  const sources = path(job.id, `${staging}/source`);
  const output = path(job.id, `${staging}/output`);
  const run: UpscaleRun = {
    progress: { phase: "prepare", completed: 0, total: frames.length },
    progressFile: path(job.id, `${staging}/progress.json`),
    cancelFile: path(job.id, `${staging}/cancel`),
    frameCount: frames.length,
  };
  upscaleRuns.set(job.id, run);
  const sourceKind = useRedraw ? "redraw" : "keyed";
  let moved = false, published = false;
  const previous = job.localUpscale;
  try {
    await mkdir(sources, { recursive: true });
    let cleanup: Awaited<ReturnType<typeof stageUpscaleInputs>>;
    if (useRedraw) {
      const inputStartedAt = Date.now();
      for (const frame of frames) {
        checkUpscaleStopped(job.id);
        const contents = await readFile(path(job.id, frame.redraw!.file!)).catch(() => undefined);
        if (!isMotionRgbaPng(contents, 512)) throw new Error(`缺少有效的 512×512 透明重绘帧：${frame.id}`);
        await writeFile(join(sources, `${frame.id}.png`), contents);
        run.progress.completed++;
      }
      cleanup = { enabled: false, changedFrames: 0, removedPixels: 0, correctedPixels: 0, elapsedMs: Date.now() - inputStartedAt };
    } else cleanup = await stageUpscaleInputs(job, frames, sources, staging, run.progress);
    const inferenceStartedAt = Date.now();
    // Only pass the environment needed by the Python and Vulkan runtimes.
    const env = Object.fromEntries(Object.entries(process.env).filter(
      ([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|USERPROFILE|HOME)$/i.test(key),
    ));
    run.progress = { phase: "enhance", completed: 0, total: frames.length };
    beginMotionPhase(job.id, "upscale-enhance");
    await runLocalUpscaleWorker(job.id, run, command.python, [
      command.script, "--source", sources, "--output", output, "--work", path(job.id, `${staging}/work`),
      "--progress-file", run.progressFile, "--cancel-file", run.cancelFile,
    ], path(job.id, staging), env);
    checkUpscaleStopped(job.id);
    beginMotionPhase(job.id, "upscale-finish", frames.length, 0);
    const workerProgress = upscaleRuns.get(job.id)?.progress;
    if (workerProgress?.phase !== "finish") run.progress = { phase: "finish", completed: 0, total: frames.length };
    const files: Record<string, string> = {};
    let verifiedFrames = 0;
    for (const frame of frames) {
      checkUpscaleStopped(job.id);
      const name = `${frame.id}.png`;
      const contents = await readFile(join(output, name)).catch(() => undefined);
      if (!isMotionRgbaPng(contents, 1024)) throw new Error(`本地清晰化缺少有效的 1024×1024 透明帧：${frame.id}`);
      files[frame.id] = `${result}/${name}`;
      run.progress.completed = Math.max(run.progress.completed, ++verifiedFrames);
      motionPhaseProgress(job.id, verifiedFrames);
    }
    const report = await readJson<{ frame_count: number; native_scale: number }>(join(output, "sr-report.json"));
    if (report?.frame_count !== frames.length || report.native_scale !== 2) throw new Error("本地清晰化报告与实际帧数或倍率不匹配。");
    await writeJsonAtomic(join(output, "sr-report.json"), { ...report, sourceKind, cleanup, batchEngineElapsedMs: Date.now() - inferenceStartedAt });
    checkUpscaleStopped(job.id);
    await rename(output, path(job.id, result));
    moved = true;
    checkUpscaleStopped(job.id);
    run.committing = true;
    job.localUpscale = { files, elapsedMs: Date.now() - startedAt, report: `${result}/sr-report.json`, sourceKind };
    await save(job);
    published = true;
  } finally {
    upscaleRuns.delete(job.id);
    if (!published) {
      job.localUpscale = previous;
      await rm(path(job.id, staging), { recursive: true, force: true }).catch(() => {});
      if (moved) await rm(path(job.id, result), { recursive: true, force: true }).catch(() => {});
    }
  }
}
/** Read-only request plan, also used by execution. Sampled frames are ordered
 * within each action/direction; a group never mixes actions or directions. */
export function motionRedrawPlan(job: Pick<MotionJob, "frames" | "validFrameRanges">, targets: string[], scheme: "frame" | "sheet" | "sheet8" = "frame", regenerate = false, image1k = false) {
  if (!["frame", "sheet", "sheet8"].includes(scheme)) throw new Error("Unknown redraw scheme");
  if (image1k && scheme === "sheet8") throw new Error("1K 图片 API 每次最多重绘 4 帧。");
  if (!targets?.length || targets.length > 17280 || new Set(targets).size !== targets.length) throw new Error("请选择需要重绘的帧");
  const frames = new Map(job.frames.map(f => [f.id, f]));
  const selected = targets.map(id => frames.get(id));
  if (selected.some(f => !f)) throw new Error("Unknown frame selection");
  const validSelected = (selected as Frame[]).filter(frame => motionFrameIsValid(job, frame));
  if (!validSelected.length) throw new Error("请选择至少一张有效帧");
  const pending = validSelected.filter(f => regenerate || f.redraw?.status !== "ready" || !f.redraw.file || image1k && f.redraw.image1k !== true);
  const buckets = new Map<string, Frame[]>();
  for (const frame of pending) {
    const key = JSON.stringify([frame.action, frame.direction]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(frame);
  }
  const groups: string[][] = [];
  for (const values of buckets.values()) {
    values.sort((a, b) => a.index - b.index);
    let group: Frame[] = [];
    for (const frame of values) {
      if (group.length === (scheme === "sheet8" ? 8 : scheme === "sheet" ? 4 : 1)) { groups.push(group.map(f => f.id)); group = []; }
      group.push(frame);
    }
    if (group.length) groups.push(group.map(f => f.id));
  }
  return { scheme, targets: validSelected.map(frame => frame.id), selectionCount: validSelected.length, frameCount: pending.length, requestCount: groups.length, groups,
    ...(image1k ? { image1k: true, requestedSize: "1024x1024" } : {}),
    unknownCount: regenerate ? 0 : pending.filter(f => !!f.redraw?.status && (f.redraw.status !== "ready" || !f.redraw.file)).length };
}
export function motionImage1kReadiness(job: MotionJob, targets: string[], config: Config, expected?: MotionRedrawSelection) {
  const routes = motionRedrawRoutes(config);
  const modelSelection = motionRedrawModel(config, routes);
  if (!modelSelection) return { modelSelection, blocker: routes.length ? "请选择 1K 重绘模型。" : "请先在设置的「生图连接」中配置 OpenAI 兼容图片编辑模型。" };
  if (expected && (expected.connectionId !== modelSelection.connectionId || expected.model !== modelSelection.model)) {
    return { modelSelection, blocker: "1K 重绘模型已变更，请重新确认。" };
  }
  if (!job.character) return { modelSelection, blocker: "请先提供角色参考图，再进行 1K 重绘。" };
  const selected = new Set(targets);
  if (!motionProcessing(job.processing).key || job.frames.some(frame => selected.has(frame.id) && (!frame.keyed || frame.keyed === frame.target))) {
    return { modelSelection, blocker: "请先生成透明抠图帧，再运行 1K 图片 API 重绘。" };
  }
  return { modelSelection, blocker: null };
}

function redrawMask(src: Buffer): Buffer {
  let alpha = Uint8Array.from({ length: 512 * 512 }, (_, i) => src[i * 4 + 3] > 127 ? 1 : 0);
  for (let step = 0; step < 3; step++) {
    const out = new Uint8Array(alpha.length);
    for (let y = 1; y < 511; y++) for (let x = 1; x < 511; x++) {
      const p = y * 512 + x;
      out[p] = alpha[p] & alpha[p - 1] & alpha[p + 1] & alpha[p - 512] & alpha[p + 512];
    }
    alpha = out;
  }
  const mask = Buffer.alloc(512 * 512 * 4, 255);
  for (let p = 0; p < alpha.length; p++) mask[p * 4 + 3] = alpha[p] ? 0 : 255;
  return mask;
}
async function redraw(job: MotionJob, targets: string[], confirmed: boolean, regenerate: boolean, scheme: "frame" | "sheet" | "sheet8" = "frame", image1k = false, expectedImageModel?: MotionRedrawSelection): Promise<void> {
  if (!confirmed) throw new Error("请确认高清重绘的图片调用数量和费用");
  const plan = motionRedrawPlan(job, targets, scheme, regenerate, image1k);
  if (plan.unknownCount) throw new Error("存在结果未知的图片请求，请检查后显式重新生成选中帧");
  const processing = motionProcessing(job.processing), frames = new Map(job.frames.map(f => [f.id, f]));
  if (!plan.requestCount) { job.redrawTargets = [...plan.targets]; await save(job); return; }
  const current = await loadConfig();
  const readiness = image1k ? motionImage1kReadiness(job, plan.targets, current, expectedImageModel) : null;
  if (readiness?.blocker) throw new Error(readiness.blocker);
  const selection = readiness?.modelSelection;
  const imageConfig = selection ? customConnectionConfig(current, selection.connectionId, selection.model) : current;
  assertMaskedImageEditProvider(imageConfig);
  if (!job.character) throw new Error("请上传角色细节图");
  job.redrawTargets = [...plan.targets];
  const modelRecord = selection ? { image1k: true, imageModel: { connectionId: selection.connectionId, model: selection.model } } : {};
  const dir = `redraw/${token()}`;
  await mkdir(path(job.id, dir), { recursive: true });
  const directionRefs = new Map<string, string>();
  if (job.directions) {
    const decoded = await decodeToRgba(path(job.id, job.directions));
    const width = Math.floor(decoded.width / 4), height = Math.floor(decoded.height / 2);
    for (const direction of new Set(plan.groups.map(ids => frames.get(ids[0])!.direction))) {
      const d = MOTION_ORDER.indexOf(direction), file = `${dir}/${direction}-reference.png`;
      await writeFile(path(job.id, file), encodePng(crop(decoded.rgba, decoded.width, (d % 4) * width, Math.floor(d / 4) * height, width, height), width, height));
      directionRefs.set(direction, file);
    }
  }
  for (let groupIndex = 0; groupIndex < plan.groups.length; groupIndex++) {
    checkStopped(job.id);
    const group = plan.groups[groupIndex].map(id => frames.get(id)!), first = group[0], batchId = token();
    const columns = group.length > 4 ? 4 : group.length > 1 ? 2 : 1, rows = group.length > 1 ? 2 : 1;
    const cellSize = image1k && group.length > 1 ? 512 : 1024;
    const width = columns * cellSize, height = rows * cellSize;
    const rgba = Buffer.alloc(width * height * 4), mask = Buffer.alloc(rgba.length, 255);
    const background = processing.keyColor.match(/[a-f0-9]{2}/gi)!.map(v => parseInt(v, 16));
    rgba.fill(Buffer.from([...background, 255]));
    const originals: Buffer[] = [];
    job.progress = `${groupIndex + 1}/${plan.requestCount} · ${first.id}`; await save(job);
    for (let i = 0; i < group.length; i++) {
      checkStopped(job.id);
      const frame = group[i], decoded = await decodeToRgba(path(job.id, frame.target)), src = await decodeToRgba(path(job.id, frame.keyed));
      originals.push(src.rgba);
      blit(resize(decoded.rgba, decoded.width, decoded.height, cellSize, cellSize), cellSize, cellSize, rgba, width, height, (i % columns) * cellSize, Math.floor(i / columns) * cellSize);
      // Masks require copying transparent interior pixels too; blit intentionally
      // skips them and therefore cannot be used here.
      const cellMask = resize(redrawMask(src.rgba), 512, 512, cellSize, cellSize);
      for (let y = 0; y < cellSize; y++) cellMask.copy(mask, ((Math.floor(i / columns) * cellSize + y) * width + (i % columns) * cellSize) * 4, y * cellSize * 4, (y + 1) * cellSize * 4);
    }
    const name = group.length > 1 ? batchId : first.id;
    const prompt = motionRedrawPrompt({ direction: first.direction, description: job.description, instructions: job.prompt, keyColor: processing.keyColor, hasDirection: directionRefs.has(first.direction), frameCount: group.length });
    const promptFile = `${dir}/${name}-prompt.txt`, input = `${dir}/${name}-input.png`, maskFile = `${dir}/${name}-mask.png`;
    await writeFile(path(job.id, promptFile), prompt);
    await writeFile(path(job.id, input), encodePng(rgba, width, height));
    await writeFile(path(job.id, maskFile), encodePng(mask, width, height));
    // Persist ONE shared attempt across every frame in this image request.
    for (const frame of group) frame.redraw = { status: "attempted", prompt: promptFile, scheme, batchId, ...modelRecord };
    if (job.localUpscale?.sourceKind === "redraw" && group.some(frame => Object.hasOwn(job.localUpscale!.files, frame.id))) job.localUpscale = undefined;
    job.archive = undefined; job.archiveKind = undefined; await save(job);
    try {
      const result = await generateImageWithProvider({ prompt,
        images: [await imageUri(job.id, input), await imageUri(job.id, job.character), ...(directionRefs.has(first.direction) ? [await imageUri(job.id, directionRefs.get(first.direction)!)] : [])],
        mask: await imageUri(job.id, maskFile), quality: "high", size: `${width}x${height}`, watermark: false }, undefined, selection ? imageConfig : undefined);
      const raw = `${dir}/${name}-raw.${result.ext}`;
      await writeFile(path(job.id, raw), result.bytes);
      for (const frame of group) frame.redraw!.raw = raw;
      await save(job);
      if (group.length > 1) {
        const size = await probeSize(path(job.id, raw));
        if (Math.abs(size.width * rows - size.height * columns) > Math.max(columns, rows) || size.width < columns * 512 || size.height < rows * 512) throw new Error("分组重绘回图尺寸或布局不匹配，请检查原始回图");
      }
      const outputWidth = columns * 512, outputHeight = rows * 512;
      const { stdout } = await runFfmpeg(["-i", path(job.id, raw), "-vf", `scale=${outputWidth}:${outputHeight}:flags=lanczos,format=rgba`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
      if (stdout.length !== outputWidth * outputHeight * 4) throw new Error("Invalid generated image");
      const completed: NonNullable<Frame["redraw"]>[] = [];
      // Validate every cell before committing any of this shared request.
      const cells = group.map((_, i) => crop(stdout, outputWidth, (i % columns) * 512, Math.floor(i / columns) * 512, 512, 512));
      const processed = processMotionEdits(cells, originals, processing);
      for (let i = 0; i < group.length; i++) {
        const { rgba, scale, translation, background } = processed[i];
        const file = `${dir}/${group[i].id}.png`;
        await writeFile(path(job.id, file), encodePng(rgba, 512, 512));
        completed.push({ status: "ready", file, raw, prompt: promptFile, translation, scale, background, scheme, batchId, ...modelRecord });
      }
      group.forEach((frame, i) => { frame.redraw = completed[i]; }); await save(job);
    } catch (error) {
      const message = "请求可能已计费；未自动重试。" + redact(String(error instanceof Error ? error.message : error), imageConfig.customApiKey);
      for (const frame of group) frame.redraw = { ...frame.redraw, status: "unknown", error: message };
      await save(job); throw new Error(message);
    }
  }
}
export function motionRedrawFrames(job: Pick<MotionJob, "frames" | "redrawTargets" | "validFrameRanges">): Frame[] {
  if (!job.redrawTargets?.length) return motionValidFrames(job);
  const targets = new Set(job.redrawTargets), frames = job.frames.filter(f => targets.has(f.id));
  if (frames.length !== targets.size) throw new Error("重绘选帧已失效，请重新选择");
  return frames.filter(f => motionFrameIsValid(job, f));
}
async function exportJob(job: MotionJob, useRedraw: boolean): Promise<void> {
  if (!job.frames.length) throw new Error("请先抽帧");
  const selectedFrames = useRedraw ? motionRedrawFrames(job) : job.frames;
  if (useRedraw && selectedFrames.some((f) => f.redraw?.status !== "ready" || !f.redraw.file))
    throw new Error("高清版本还有未完成帧，请补齐或选择原视频帧导出");
  beginMotionPhase(job.id, "atlas", selectedFrames.length, 0);
  let composedFrames = 0;
  const processing = motionProcessing(job.processing), width = processing.cellWidth, height = processing.cellHeight;
  const sourceSize = await probeSize(path(job.id, job.video!.file!));
  const entries: ZipEntry[] = [],
    metadata: any = {
      version: 2,
      directionOrder: MOTION_ORDER,
      cellWidth: width,
      cellHeight: height,
      mode: useRedraw ? "redrawn" : "video-crops",
      actions: [],
      pixelDetail: useRedraw
        ? "AI redrawn; temporal consistency requires review"
        : `${sourceSize.width}x${sourceSize.height} video crops resized locally; not native 512px detail`,
      source: "Hormelz CC0",
      sourceUrl: "https://hormelz.itch.io/8-directional-melee-character",
    };
  const dir = `out/${token()}`;
  await mkdir(path(job.id, dir), { recursive: true });
  for (const seg of job.ranges) {
    checkStopped(job.id);
    const columns = Math.max(1, Math.floor(4096 / width)), rows = Math.max(1, Math.floor(4096 / height));
    const pages: any[] = [];
    const byDirection = new Map(MOTION_ORDER.map(direction => [direction, selectedFrames.filter(f => f.action === seg.action && f.direction === direction).sort((a, b) => a.index - b.index)]));
    const directions = useRedraw ? MOTION_ORDER.filter(d => byDirection.get(d)!.length) : MOTION_ORDER;
    if (!directions.length) continue;
    const frameCount = useRedraw ? Math.max(...directions.map(d => byDirection.get(d)!.length)) : seg.frameCount;
    for (let firstRow = 0; firstRow < directions.length; firstRow += rows) for (let firstFrame = 0; firstFrame < frameCount; firstFrame += columns) {
    checkStopped(job.id);
    const rowOrder = directions.slice(firstRow, firstRow + rows), count = Math.min(columns, frameCount - firstFrame);
    const sheet = Buffer.alloc(width * count * height * rowOrder.length * 4);
    for (const direction of rowOrder) for (let index = firstFrame; index < firstFrame + count; index++) {
      checkStopped(job.id);
      const frame = byDirection.get(direction)![index];
      if (!frame) { if (useRedraw) continue; throw new Error("序列帧不完整，请重新抽帧后导出。"); }
      if (!useRedraw && frame.index !== index) throw new Error("序列帧不完整，请重新抽帧后导出。");
      const selected = useRedraw ? frame.redraw!.file! : processing.key ? frame.keyed : frame.target;
      const decoded = await decodeToRgba(path(job.id, selected));
      const scaled = resize(decoded.rgba, decoded.width, decoded.height, width, height);
      const bytes = encodePng(scaled, width, height);
      entries.push({
        path: `${seg.action}/${frame.direction}/f${String(index).padStart(2, "0")}.png`,
        data: bytes,
      });
      blit(
        scaled,
        width,
        height,
        sheet,
        width * count,
        height * rowOrder.length,
        (index - firstFrame) * width,
        rowOrder.indexOf(frame.direction) * height,
      );
      motionPhaseProgress(job.id, ++composedFrames);
    }
    const singlePage = frameCount <= columns && rows >= directions.length;
    const png = encodePng(sheet, width * count, height * rowOrder.length),
      name = singlePage ? `${seg.action}-sheet.png` : `${seg.action}-sheet-${pages.length + 1}.png`;
    await writeFile(path(job.id, `${dir}/${name}`), png);
    entries.push({ path: name, data: png });
    pages.push({ file: name, firstFrame, frameCount: count, rowOrder, columns: count, rows: rowOrder.length });
    }
    metadata.actions.push({
      ...seg,
      frameCount,
      frameDurationMs: ((seg.end - seg.start) * 1000) / frameCount,
      fps: frameCount / (seg.end - seg.start),
      ...(useRedraw ? { sampled: true, sourceFrameCount: seg.frameCount, directionFrames: Object.fromEntries(directions.map(d => { const frames = byDirection.get(d)!; return [d, { frameCount: frames.length, fps: frames.length / (seg.end - seg.start), sourceIndices: frames.map(f => f.index), sourceTimes: frames.map(f => f.time) }]; })) } : {}),
      ...(pages.length === 1 ? { sheet: pages[0].file } : {}),
      sheets: pages,
      rows: directions.length,
      columns: frameCount,
      loopVerified: false,
    });
  }
  checkStopped(job.id);
  beginMotionPhase(job.id, "zip");
  entries.push(
    {
      path: "animation.json",
      data: Buffer.from(JSON.stringify(metadata, null, 2)),
    },
    { path: "video-prompt.txt", data: Buffer.from(await composeMotionPrompt(job)) },
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
  job.archiveKind = useRedraw ? "redraw" : processing.key ? "keyed" : "raw";
  job.localArtifacts = { ...job.localArtifacts, archive: useRedraw ? null : localArchiveSignature(job, processing) };
  await save(job);
}
export async function runMotionStep(
  id: string,
  input: any,
): Promise<{ started: true }> {
  if (!isMotionId(id)) throw new Error("Invalid motion job ID");
  if (input.step === "cancel") {
    const upscale = upscaleRuns.get(id);
    if (upscale?.committing) throw new Error("本地清晰化正在保存，无法取消。");
    if (active.has(id)) {
      cancelled.add(id);
      await upscale?.stopWorker?.();
    }
    return { started: true };
  }
  if (
    ![
      "prepare",
      "prompt",
      "video",
      "poll",
      "extract",
      "keyed",
      "upscale",
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
  const timing: MotionProcessingTiming | undefined = timedOperations.has(input.step) ? { operation: input.step, completed: [] } : undefined;
  if (timing) processingTimings.set(id, timing);
  const run = async () => {
    let job: MotionJob | undefined;
    try {
      job = await readMotion(id);
      job.operation = input.step;
      job.error = undefined;
      job.localUpscaleCancelled = undefined;
      job.progress = "";
      rememberLocalArtifacts(job);
      if (["extract", "keyed", "export"].includes(input.step)) {
        job.localArtifacts ||= {};
        job.localArtifacts.archive = null;
        if (input.step === "extract") job.localArtifacts.raw = null;
        if (input.step !== "export") job.localArtifacts.keyed = null;
      }
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
      else if (input.step === "keyed") await rekey(job);
      else if (input.step === "upscale") await upscaleMotion(job, input.useRedraw === true, input.targets);
      else if (input.step === "redraw")
        await redraw(
          job,
          input.targets,
          input.confirmed === true,
          input.regenerate === true,
          input.scheme || "frame",
          input.image1k === true,
          input.expectedImageModel,
        );
      else await exportJob(job, input.useRedraw === true);
    } catch (error) {
      if (job && error instanceof LocalUpscaleCancelled) {
        job.localUpscaleCancelled = true;
      } else if (job) {
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
          if (timing) {
            finishMotionPhase(timing, Date.now());
            job.processingTiming = timing;
          }
          await save(job);
        }
      } finally {
        active.delete(id);
        cancelled.delete(id);
        if (timing) processingTimings.delete(id);
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
  for (const [id, run] of upscaleRuns) {
    if (run.committing) continue;
    cancelled.add(id);
    void run.stopWorker?.();
  }
  for (const timer of pollTimers.values()) clearTimeout(timer);
  pollTimers.clear();
}
export async function resumeMotionJobs(): Promise<void> {
  for (const item of await listMotionJobs(true)) {
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

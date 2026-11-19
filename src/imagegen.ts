/**
 * 图片生成模块。
 *
 * 用火山方舟的 Seedream 系列按提示词生成图片，可选带参考图；生成后可以直接
 * 走一遍绿幕抠像导出透明 PNG。也支持把**已有的**图片传进来只做抠像——
 * 这样它同时也是一个通用的绿幕抠像工具。
 *
 * 目录结构：
 *   <DSH_HOME>/game-material-master/image-jobs/<任务 id>/
 *     job.json
 *     refs/    上传的参考图
 *     out/     生成的（或用户上传的）原图
 *     keyed/   抠完背景的透明 PNG
 */

import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, lstat, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { imageJobsRoot, loadConfig, type Config } from "./config.js";
import { generateImageWithProvider, imageModelOf, imageSizeOf, imageWatermarkOf, assertImageProviderReady } from "./imageprovider.js";
import { decodeToRgba, mimeOf, toDataUri } from "./media.js";
import { keyGreen, cleanImageRegions, type ImageCleanupPoint } from "./chroma.js";
import { encodePng } from "./png.js";
import { appendJobLog, messageOf, readJson, writeJsonAtomic, type JobLogEntry } from "./jsonio.js";
import { applyKeyColorToPrompt, backgroundClause, DEFAULT_KEY_COLOR, normalizeKeyColor } from "./keycolor.js";
import { IMAGE_PROMPT_TEMPLATES } from "./imageprompts.js";

export type ItemStatus = "empty" | "running" | "ready" | "error";

export interface ImageItem {
  versionId?: string;
  /** Stable conversation round; local processing keeps the originating round. */
  roundId?: string;
  index: number;
  status: ItemStatus;
  /** 原图（相对任务目录），可能是生成的，也可能是用户上传的。 */
  file?: string;
  /** 抠像结果。 */
  keyedFile?: string;
  /** 判定为背景的像素占比，用来判断抠像是否可信。 */
  backgroundFraction?: number;
  source: "generated" | "uploaded";
  /** 验收打标：用户（或 agent 按用户指示）确认这一张可用。 */
  approved?: boolean;
  error?: string;
  updatedAt?: number;
}

export interface KeyingSettings {
  enabled: boolean;
  /** 抠像底色（`#RRGGBB`）。 */
  keyColor: string;
  keyLow: number;
  keyHigh: number;
  despill: number;
  bgTolerance: number;
  edgeShrink: number;
}

export interface ImageJob {
  id: string;
  /** An editor draft is omitted from the project list until explicit generation/import. */
  draft?: boolean;
  name: string;
  createdAt: number;
  updatedAt: number;
  prompt: string;
  /** 统一附加提示词：非空时接在主提示词后面。 */
  suffix: string;
  /** Selected template + immutable prompt snapshot in suffix. Catalog edits require explicit sync. */
  promptTemplateId?: string;
  promptTemplateLang?: "zh" | "en";
  refs: Array<{ file: string; name: string }>;
  settings: {
    model: string;
    /**
     * 尺寸来源：
     * - `global`（默认）：跟随「设置 → 输出尺寸」，全局改了任务跟着改；
     * - `custom`：只这个任务用自己的 `size`，不跟全局漂移。
     *
     * 老任务没有这个字段时按 `global` 处理（0.11.1 的迁移口径）。
     */
    sizeMode: "global" | "custom";
    size: string;
    count: number;
    watermark: boolean;
  };
  keying: KeyingSettings;
  items: ImageItem[];
  history: ImageHistoryEntry[];
  /** Submitted generation rounds, including failures without an image. Never contains credentials. */
  rounds?: ImageRound[];
  /** 固定流程里问过用户的审核模式；没问过就是 undefined。 */
  reviewMode?: "auto" | "manual";
  log: JobLogEntry[];
}

/** Request snapshot deliberately excludes credentials and provider configuration. */
export interface ImageRequestSnapshot {
  prompt: string;
  suffix: string;
  promptTemplateId?: string;
  promptTemplateLang?: "zh" | "en";
  refs: ImageJob["refs"];
  referenceFiles: string[];
  settings: ImageJob["settings"];
  keying: KeyingSettings;
  finalPrompt: string;
  provider: string;
}

export interface ImageHistoryEntry {
  id: string;
  batchId: string;
  roundId?: string;
  createdAt: number;
  kind: "generated" | "uploaded" | "legacy" | "keyed";
  item: ImageItem;
  request?: ImageRequestSnapshot;
  /** Local re-key settings, separate from the original generation request. */
  keying?: KeyingSettings;
  sourceVersionId?: string;
  /** Explicit local cleanup; original generation snapshot and older PNGs stay intact. */
  cleanup?: { sourceVersionId: string; points: ImageCleanupPoint[] };
}

export interface ImageBatch {
  id: string;
  request: ImageRequestSnapshot;
  /** In-memory only, never serialized into job/history or returned to clients. */
  config: Config;
}

export interface ImageRound {
  id: string;
  createdAt: number;
  completedAt?: number;
  request: ImageRequestSnapshot;
  logs?: JobLogEntry[];
  results: Array<{ index: number; status: "running" | "ready" | "error"; versionId?: string; error?: string }>;
}

export interface ImageJobSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  saveDirectory: string;
  total: number;
  ready: number;
  keyed: number;
  /** Saved result versions, including history; current/history references are deduplicated. */
  imageCount: number;
  keyedCount: number;
  historyCount: number;
  dir: string;
}

const JOB_ID_PATTERN = /^i[a-z0-9]{4,40}$/;

function locationFile(id: string): string {
  return join(imageJobsRoot(), `${id}.location.json`);
}

export function imageJobDir(id: string): string {
  if (!isValidImageJobId(id)) throw new Error(`非法的图片任务 ID：${id}`);
  let raw: string | undefined;
  try { raw = readFileSync(locationFile(id), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (raw !== undefined) {
    const location = JSON.parse(raw);
    if (location?.id !== id || typeof location.directory !== "string" || !isAbsolute(location.directory) || basename(location.directory) !== id) {
      throw new Error(`图片任务的保存位置无效：${id}`);
    }
    return resolve(location.directory);
  }
  return join(imageJobsRoot(), id);
}

function jobFile(id: string): string {
  return join(imageJobDir(id), "job.json");
}

/** 任务内相对路径 → 绝对路径，并挡住目录穿越。 */
export function imageAssetPath(id: string, relative: string): string {
  const base = resolve(imageJobDir(id));
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(base + sep)) throw new Error(`非法的任务内路径：${relative}`);
  return target;
}

export function isValidImageJobId(id: string): boolean {
  return JOB_ID_PATTERN.test(id);
}

export async function ensureImageJobLayout(id: string): Promise<void> {
  for (const sub of ["refs", "out", "keyed"]) await mkdir(join(imageJobDir(id), sub), { recursive: true });
}

export async function createImageJob(name: string, suffix = "", saveDirectory?: string, draft = false): Promise<ImageJob> {
  const config = await loadConfig();
  const id = `i${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
  const now = Date.now();
  const job: ImageJob = {
    id,
    ...(draft ? { draft: true } : {}),
    name: name.trim() === "" ? "未命名图片任务" : name.trim().slice(0, 80),
    createdAt: now,
    updatedAt: now,
    prompt: "",
    suffix,
    refs: [],
    settings: {
      model: imageModelOf(config),
      sizeMode: "global",
      size: imageSizeOf(config),
      count: 1,
      watermark: imageWatermarkOf(config)
    },
    keying: {
      enabled: false,
      keyColor: config.keyColor,
      keyLow: config.keyLow,
      keyHigh: config.keyHigh,
      despill: config.despill,
      bgTolerance: config.bgTolerance,
      edgeShrink: config.edgeShrink
    },
    items: [],
    history: [],
    log: []
  };
  let directory = join(imageJobsRoot(), id);
  const custom = saveDirectory?.trim();
  if (custom) {
    if (!isAbsolute(custom)) throw new Error("请输入完整的保存文件夹路径。");
    const parent = await realpath(custom);
    if (!(await stat(parent)).isDirectory()) throw new Error("保存位置必须是文件夹。");
    directory = join(parent, id);
  }
  await mkdir(dirname(directory), { recursive: true });
  // Always create a fresh child: never adopt or overwrite the chosen folder itself.
  await mkdir(directory);
  try {
    for (const sub of ["refs", "out", "keyed"]) await mkdir(join(directory, sub));
    await writeJsonAtomic(join(directory, "job.json"), job);
    if (resolve(directory) !== resolve(join(imageJobsRoot(), id))) await writeJsonAtomic(locationFile(id), { id, directory });
  } catch (error) {
    // This directory was created exclusively above and contains only this new job.
    if (basename(directory) === id && resolve(directory) === resolve(join(dirname(directory), id))) await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return job;
}

const imageDraftOpens = new Map<string, Promise<ImageJob>>();

/** The sidebar composer resumes one unfinished editor per real save folder. */
export async function openImageDraft(name: string, saveDirectory?: string, template?: { id: string; lang: "zh" | "en"; prompt: string }): Promise<ImageJob> {
  const custom = saveDirectory?.trim();
  if (custom && !isAbsolute(custom)) throw new Error("请输入完整的保存文件夹路径。");
  if (!custom) await mkdir(imageJobsRoot(), { recursive: true });
  const parent = await realpath(custom || imageJobsRoot());
  if (!(await stat(parent)).isDirectory()) throw new Error("保存位置必须是文件夹。");
  const key = process.platform === "win32" ? parent.toLowerCase() : parent;
  const previous = imageDraftOpens.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(async () => {
    const drafts: ImageJob[] = [];
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isValidImageJobId(entry.name)) continue;
      const target = join(parent, entry.name);
      const raw = await readJson<ImageJob>(join(target, "job.json")).catch(() => undefined);
      if (raw?.id !== entry.name || raw.draft !== true || raw.items?.length || raw.history?.length) continue;
      const linked = await readImageJob(entry.name).catch(() => undefined);
      const hasPointer = await stat(locationFile(entry.name)).then(() => true, () => false);
      if (hasPointer && !linked) throw new Error(`项目索引已损坏，请先检查保存位置：${entry.name}`);
      if (linked && await realpath(imageJobDir(entry.name)) !== await realpath(target)) continue;
      const candidate = linked ?? normalizeImageJob(raw);
      if (candidate.draft && !candidate.items.length && !candidate.history.length) drafts.push(candidate);
    }
    // Older releases could leave many blank drafts. Prefer authored work, then the latest edit.
    drafts.sort((a, b) => Number(Boolean(b.prompt.trim() || b.refs.length)) - Number(Boolean(a.prompt.trim() || a.refs.length)) || b.updatedAt - a.updatedAt);
    if (drafts.length) {
      const job = drafts[0], target = join(parent, job.id);
      if (resolve(target) !== resolve(join(imageJobsRoot(), job.id))) await writeJsonAtomic(locationFile(job.id), { id: job.id, directory: target });
      return job;
    }
    const job = await createImageJob(name, template?.prompt ?? "", parent, true);
    if (template) { job.promptTemplateId = template.id; job.promptTemplateLang = template.lang; await writeImageJob(job); }
    return job;
  });
  imageDraftOpens.set(key, pending);
  try { return await pending; }
  finally { if (imageDraftOpens.get(key) === pending) imageDraftOpens.delete(key); }
}

export async function readImageJob(id: string): Promise<ImageJob | undefined> {
  if (!isValidImageJobId(id)) return undefined;
  const raw = await readJson<ImageJob>(jobFile(id));
  if (raw === undefined || raw.id !== id) return undefined;
  return normalizeImageJob(raw);
}

export async function writeImageJob(job: ImageJob): Promise<void> {
  job.updatedAt = Date.now();
  await writeJsonAtomic(jobFile(job.id), job);
}

const imageEdits = new Map<string, Promise<unknown>>();

/** Serialize read-modify-write phases; paid requests run outside this lock. */
export async function editImageJob<T>(id: string, change: (job: ImageJob) => T | Promise<T>, afterSave?: (job: ImageJob) => Promise<void>): Promise<T> {
  const previous = imageEdits.get(id) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(async () => {
    const job = await readImageJob(id);
    if (!job) throw new Error(`任务不存在：${id}`);
    const result = await change(job);
    await writeImageJob(job);
    if (afterSave) await afterSave(job);
    return result;
  });
  imageEdits.set(id, pending);
  try { return await pending; }
  finally { if (imageEdits.get(id) === pending) imageEdits.delete(id); }
}

export async function listImageJobs(): Promise<ImageJobSummary[]> {
  let entries: string[] = [];
  try {
    const dirents = await readdir(imageJobsRoot(), { withFileTypes: true });
    entries = [...new Set(dirents.flatMap(entry => {
      const id = entry.isDirectory() ? entry.name : entry.isFile() && entry.name.endsWith(".location.json") ? entry.name.slice(0, -14) : "";
      return isValidImageJobId(id) ? [id] : [];
    }))];
  } catch {
    return [];
  }
  const out: ImageJobSummary[] = [];
  for (const id of entries) {
    const job = await readImageJob(id).catch(() => undefined);
    if (job === undefined || job.draft) continue;
    out.push(summarizeImageJob(job));
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/** Register existing image projects from this folder only; never move or delete source files. */
export async function attachImageFolder(path: string) {
  if (!isAbsolute(path)) throw new Error("请输入完整的文件夹路径。");
  const directory = await realpath(path);
  const entries = await readdir(directory, { withFileTypes: true });
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidImageJobId(entry.name)) continue;
    const target = join(directory, entry.name);
    const raw = await readJson<ImageJob>(join(target, "job.json")).catch(() => undefined);
    if (raw?.id !== entry.name || raw.draft) continue;
    const previous = await readImageJob(entry.name).catch(() => undefined);
    const hasPointer = await stat(locationFile(entry.name)).then(() => true, () => false);
    if (hasPointer && !previous) throw new Error(`项目索引已损坏，请先检查保存位置：${entry.name}`);
    if (previous && resolve(imageJobDir(entry.name)) !== resolve(target)) throw new Error(`同名项目 ID 已在其他位置打开：${entry.name}`);
    if (resolve(target) !== resolve(join(imageJobsRoot(), entry.name))) await writeJsonAtomic(locationFile(entry.name), { id: entry.name, directory: target });
    ids.push(entry.name);
  }
  return { directory, ids };
}

export function summarizeImageJob(job: ImageJob): ImageJobSummary {
  const versions = new Map<string, ImageItem>();
  for (const item of [...(job.history ?? []).map(entry => entry.item), ...job.items]) {
    if (!item?.file && !item?.keyedFile) continue;
    // A restored version is still the same saved result. A new keyed PNG is a new version.
    versions.set(JSON.stringify([item.file || "", item.keyedFile || ""]), item);
  }
  return {
    id: job.id,
    name: job.name,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    saveDirectory: dirname(imageJobDir(job.id)),
    total: job.items.length,
    ready: job.items.filter((item) => item.status === "ready").length,
    keyed: job.items.filter((item) => item.keyedFile !== undefined).length,
    imageCount: versions.size,
    keyedCount: [...versions.values()].filter(item => item.keyedFile).length,
    historyCount: (job.history ?? []).filter(entry => entry.item?.file || entry.item?.keyedFile).length,
    dir: imageJobDir(job.id)
  };
}

export async function deleteImageJob(id: string): Promise<void> {
  const directory = resolve(imageJobDir(id));
  const job = await readImageJob(id);
  if (!job || job.id !== id || basename(directory) !== id || (await lstat(directory)).isSymbolicLink()) throw new Error("无法确认任务目录，未删除文件。");
  await rm(directory, { recursive: true, force: true });
  await rm(locationFile(id), { force: true });
}

function normalizeImageJob(raw: any): ImageJob {
  const suffix = typeof raw?.promptSuffix === "string" ? raw.promptSuffix : typeof raw?.suffix === "string" ? raw.suffix : "";
  // Early template UI only saved the text. Recognize exact built-ins without altering any saved text.
  const legacyTemplate = IMAGE_PROMPT_TEMPLATES.find(item => Object.values(item.prompt).includes(suffix));
  const items: ImageItem[] = Array.isArray(raw?.items)
    ? raw.items.map((item: any, index: number) => ({
        versionId: typeof item?.versionId === "string" ? item.versionId : !Array.isArray(raw?.history) && typeof item?.file === "string" ? `legacy-${index}` : undefined,
        roundId: typeof item?.roundId === "string" ? item.roundId : undefined,
        index: Number.isFinite(item?.index) ? item.index : index,
        status: (item?.status ?? "empty") as ItemStatus,
        file: typeof item?.file === "string" ? item.file : undefined,
        keyedFile: typeof item?.keyedFile === "string" ? item.keyedFile : undefined,
        backgroundFraction: typeof item?.backgroundFraction === "number" ? item.backgroundFraction : undefined,
        source: item?.source === "uploaded" ? "uploaded" : "generated",
        approved: item?.approved === true,
        error: typeof item?.error === "string" ? item.error : undefined,
        updatedAt: typeof item?.updatedAt === "number" ? item.updatedAt : undefined
      }))
    : [];
  const job: ImageJob = {
    id: String(raw?.id ?? ""),
    ...(raw?.draft === true ? { draft: true } : {}),
    name: typeof raw?.name === "string" && raw.name.trim() !== "" ? raw.name : "未命名图片任务",
    createdAt: Number(raw?.createdAt) || Date.now(),
    updatedAt: Number(raw?.updatedAt) || Date.now(),
    prompt: typeof raw?.prompt === "string" ? raw.prompt : "",
    suffix,
    promptTemplateId: typeof raw?.promptTemplateId === "string" ? raw.promptTemplateId : legacyTemplate?.id,
    promptTemplateLang: raw?.promptTemplateLang === "en" ? "en" : raw?.promptTemplateLang === "zh" ? "zh" : legacyTemplate ? (legacyTemplate.prompt.en === suffix ? "en" : "zh") : undefined,
    refs: Array.isArray(raw?.refs)
      ? raw.refs.filter((r: any) => typeof r?.file === "string").map((r: any) => ({ file: r.file, name: String(r.name ?? basename(r.file)) }))
      : [],
    settings: {
      model: typeof raw?.settings?.model === "string" ? raw.settings.model : "",
      sizeMode: raw?.settings?.sizeMode === "custom" ? "custom" : "global",
      size: typeof raw?.settings?.size === "string" ? raw.settings.size : "2K",
      count: Math.min(8, Math.max(1, Number(raw?.settings?.count) || 1)),
      watermark: raw?.settings?.watermark === true
    },
    keying: {
      enabled: raw?.keying?.enabled === true,
      // 老任务没有这个字段：留空，抠像时回落到当前全局配置。
      keyColor: typeof raw?.keying?.keyColor === "string" ? normalizeKeyColor(raw.keying.keyColor) : "",
      keyLow: num(raw?.keying?.keyLow, 14),
      keyHigh: num(raw?.keying?.keyHigh, 80),
      despill: num(raw?.keying?.despill, 0.65),
      bgTolerance: num(raw?.keying?.bgTolerance, 90),
      edgeShrink: num(raw?.keying?.edgeShrink, 0)
    },
    items,
    // Old files can be retained, but their original request cannot be inferred
    // from an editable job draft. Mark them explicitly as lacking a snapshot.
    history: Array.isArray(raw?.history) ? raw.history : items.filter(item => item.file).map(item => ({
      id: item.versionId!, batchId: "legacy", createdAt: item.updatedAt ?? raw.updatedAt ?? raw.createdAt ?? Date.now(),
      kind: "legacy" as const, item: { ...item, status: "ready" as const }
    })),
    rounds: Array.isArray(raw?.rounds) ? raw.rounds : [],
    reviewMode: raw?.reviewMode === "manual" ? "manual" : raw?.reviewMode === "auto" ? "auto" : undefined,
    log: Array.isArray(raw?.log) ? raw.log.slice(-200) : []
  };
  // Older versions only recorded processing batch IDs. Resolve ancestry before
  // rendering, independent of timestamps/order, including deleted parent entries.
  const versions = new Map(job.history.map(entry => [entry.id, entry]));
  const origins = new Map<string, string>();
  const roundByVersion = new Map<string, string>();
  for (const round of job.rounds ?? []) for (const result of round.results) if (result.versionId) roundByVersion.set(result.versionId, round.id);
  for (const entry of job.history) if (entry.kind !== "keyed" && entry.item.file) origins.set(entry.item.file, entry.roundId || entry.item.roundId || roundByVersion.get(entry.id) || entry.batchId || entry.id);
  const resolving = new Set<string>();
  const resolveRound = (entry: ImageHistoryEntry): string => {
    if (entry.roundId) { entry.item.roundId = entry.roundId; return entry.roundId; }
    if (resolving.has(entry.id)) return entry.batchId || entry.id;
    resolving.add(entry.id);
    const parentId = entry.sourceVersionId || entry.cleanup?.sourceVersionId;
    const parent = parentId ? versions.get(parentId) : undefined;
    const roundId = entry.item.roundId || roundByVersion.get(entry.id)
      || (entry.kind === "keyed" ? (parent && resolveRound(parent)) || (parentId && roundByVersion.get(parentId)) || (entry.item.file && origins.get(entry.item.file)) : undefined)
      || entry.batchId || entry.id;
    resolving.delete(entry.id);
    entry.roundId = roundId; entry.item.roundId = roundId;
    if (entry.item.file) origins.set(entry.item.file, roundId);
    return roundId;
  };
  for (const entry of job.history) resolveRound(entry);
  for (const item of job.items) item.roundId ||= (item.versionId && versions.get(item.versionId)?.roundId) || (item.versionId && roundByVersion.get(item.versionId)) || (item.file && origins.get(item.file)) || undefined;
  return job;
}

/** 归一化时没有配置可读；用默认绿，后续生成时仍会跟随配置。 */
function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

/** 从 base64 头部嗅探图片类型。 */
export function sniffImage(base64: string): { ext: string; mime: string } | undefined {
  let head: Buffer;
  try {
    head = Buffer.from(base64.slice(0, 64), "base64");
  } catch {
    return undefined;
  }
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50) return { ext: "png", mime: "image/png" };
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8) return { ext: "jpg", mime: "image/jpeg" };
  if (head.length >= 12 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") {
    return { ext: "webp", mime: "image/webp" };
  }
  if (head.length >= 2 && head.toString("ascii", 0, 2) === "BM") return { ext: "bmp", mime: "image/bmp" };
  return undefined;
}

export function safeName(input: string): string {
  const base = basename(input).replace(/[^\w.\-()\u4e00-\u9fa5]+/g, "_");
  return base === "" ? "file" : base.slice(0, 120);
}

/** Uploaded order is authoritative; explicit mentions narrow the attachments without renumbering labels. */
export function resolveImageReferences(prompt: string, refs: ImageJob["refs"]): Array<ImageJob["refs"][number] & { label: string }> {
  const mentioned = [...prompt.matchAll(/@图片(\d+)/g)].map(match => {
    const index = Number(match[1]) - 1;
    if (match[1] !== String(index + 1) || !refs[index]) throw new Error("引用的图片不存在，请重新选择参考图。");
    return index;
  });
  return refs.flatMap((ref, index) => mentioned.length === 0 || mentioned.includes(index) ? [{ ...ref, label: `@图片${index + 1}` }] : []);
}

export function imageBackgroundInstruction(keying: Pick<KeyingSettings, "enabled" | "keyColor">, lang: "zh" | "en"): string {
  if (!keying.enabled) return "";
  return lang === "en"
    ? "Transparent PNG output: the following rules override only background descriptions in the prompt, template and reference images. Generate the subject according to the requested changes; these background rules do not lock its appearance, clothing, pose or composition. " + backgroundClause(keying.keyColor, "en") + " Treat the background as a separate flat layer filled behind the finished subject; it must not illuminate or reflect onto the subject. Unless the user specifies lighting, use neutral white light and shadows within the subject's own color families. Preserve the requested intrinsic colors, including any intentional colors matching the background. No reflections, ambient color cast, rim light or color bleeding caused by the background color, whether in the subject interior or at its edges. No floor, cast shadow, halo, scenery or checkerboard transparency pattern. Do not recolor the subject to match the key color or tint its edges. Local processing will remove this exact color."
    : "透明 PNG 输出模式：以下背景要求覆盖主提示词、模板和参考图中其他背景描述，仅作用于背景。主体按用户要求修改，这些背景规则不锁定主体外观、服装、动作或构图。" + backgroundClause(keying.keyColor, "zh") + "背景视为主体绘制完成后填入的独立纯色底层，不参与主体照明或反射。未指定光照时使用中性白光，主体阴影沿用自身色系；保留用户要求的固有色，包括主体原本需要的与背景相近的颜色。不得出现背景色反射、环境染色、背景色轮廓光，背景色不得渗入主体内部或边缘。不要地面、投影、光晕、场景或透明棋盘格，不要将主体整体改成背景色或给边缘染色。生成后将按此颜色在本地抠像，输出透明 PNG。";
}

export interface ImagePromptDraft {
  prompt: string;
  suffix?: string;
  keying?: Pick<KeyingSettings, "enabled" | "keyColor">;
  lang?: "zh" | "en";
}

/** Free preview and optimization use exactly the same draft and attachment rules as generation. */
export async function imagePromptContext(jobId: string, input: ImagePromptDraft) {
  const job = await readImageJob(jobId);
  if (!job) throw new Error(`任务不存在：${jobId}`);
  const config = await loadConfig();
  const draft: ImageJob = { ...job, prompt: input.prompt, suffix: input.suffix ?? job.suffix,
    keying: { ...job.keying, ...input.keying, keyColor: normalizeKeyColor(input.keying?.keyColor ?? job.keying.keyColor, config.keyColor) },
    promptTemplateLang: input.suffix !== undefined ? input.lang : input.lang ?? job.promptTemplateLang };
  const references = resolveImageReferences(`${draft.prompt}\n${draft.suffix}`, draft.refs);
  const lang = draft.promptTemplateLang ?? (/[\u4e00-\u9fff]/u.test(draft.prompt + draft.suffix) ? "zh" : "en");
  return { draft, references, prompt: buildPrompt(draft), background: { enabled: draft.keying.enabled, keyColor: draft.keying.keyColor,
    instruction: imageBackgroundInstruction(draft.keying, lang) } };
}

export function buildPrompt(job: ImageJob, fallbackKeyColor = DEFAULT_KEY_COLOR): string {
  const base = job.prompt.trim();
  if (base === "") return "";
  let suffix = job.suffix.trim();
  const references = resolveImageReferences(`${base}\n${suffix}`, job.refs);
  const lang = job.promptTemplateLang ?? (/[\u4e00-\u9fff]/u.test(base + suffix) ? "zh" : "en");
  const referenceMap = references.length === 0 ? "" : lang === "en"
    ? `Attached image mapping: ${references.map((ref, index) => `attachment ${index + 1} = ${ref.label}`).join("; ")}. Follow the requested reference uses and changes; image labels keep their original numbers.`
    : `本次参考图对应关系：${references.map((ref, index) => `第${index + 1}张附图=${ref.label}`).join("；")}。参考用途和修改目标按主提示词执行，图片标签保留原编号。`;
  const append = (prompt: string) => referenceMap ? `${prompt}\n\n${referenceMap}` : prompt;
  if (!job.keying.enabled) return append(suffix === "" ? base : `${base}\n${suffix}`);
  const color = normalizeKeyColor(job.keying.keyColor, normalizeKeyColor(fallbackKeyColor));
  // Remove only the built-in template's default white-background clause, never character colors.
  // Work on the outgoing request; the authored prompt and template snapshot remain unchanged.
  suffix = suffix.replace("未指定背景时使用均匀纯白背景，", "")
    .replace("Unless a background is specified, use a uniform solid white background with ", "Use ");
  suffix = applyKeyColorToPrompt(applyKeyColorToPrompt(suffix, color, "zh"), color, "en");
  const prompt = suffix === "" ? base : `${base}\n${suffix}`;
  return `${append(prompt)}\n\n${imageBackgroundInstruction({ enabled: true, keyColor: color }, lang)}`;
}

/** Freeze one batch before submitting any paid requests. */
export async function prepareImageBatch(jobId: string, count?: number, index?: number): Promise<ImageBatch> {
  const config = await loadConfig();
  assertImageProviderReady(config);
  return editImageJob(jobId, job => {
    job.settings.model = imageModelOf(config);
    if (job.settings.sizeMode !== "custom") { job.settings.sizeMode = "global"; job.settings.size = imageSizeOf(config); }
    if (count !== undefined) job.settings.count = count;
    const keying = { ...job.keying, keyColor: normalizeKeyColor(job.keying.keyColor, config.keyColor) };
    const finalPrompt = buildPrompt({ ...job, keying });
    if (!finalPrompt) throw new Error("提示词为空，请先填写");
    const referenceFiles = resolveImageReferences(`${job.prompt}\n${job.suffix}`, job.refs).map(ref => ref.file);
    const batch: ImageBatch = { id: randomUUID(), config, request: {
      prompt: job.prompt, suffix: job.suffix, promptTemplateId: job.promptTemplateId, promptTemplateLang: job.promptTemplateLang,
      refs: job.refs.map(ref => ({ ...ref })), referenceFiles, settings: { ...job.settings, watermark: imageWatermarkOf(config) || job.settings.watermark },
      keying, finalPrompt, provider: config.imageProvider
    } };
    (job.rounds ??= []).push({ id: batch.id, createdAt: Date.now(), request: batch.request, logs: [],
      results: (index === undefined ? Array.from({ length: job.settings.count }, (_, i) => i) : [index]).map(i => ({ index: i, status: "running" })) });
    return batch;
  });
}

/** One image, one paid call. New bytes never overwrite a previous version. */
export async function generateImageItem(jobId: string, index: number, batch?: ImageBatch): Promise<void> {
  const prepared = batch ?? await prepareImageBatch(jobId, undefined, index);
  const request = prepared.request;
  await editImageJob(jobId, job => {
    const item = job.items[index] ?? { index, status: "empty", source: "generated" };
    job.items[index] = { ...item, status: "running", error: undefined };
    appendJobLog(job.log, "info", `开始生成第 ${index + 1} 张（尺寸 ${request.settings.size}）`);
    appendImageRoundLog(job, prepared.id, "info", `开始生成第 ${index + 1} 张（尺寸 ${request.settings.size}）`);
  });
  try {
    const refs = await Promise.all(request.referenceFiles.map(file => toDataUri(imageAssetPath(jobId, file), mimeOf(file))));
    const result = await generateImageWithProvider({
      prompt: request.finalPrompt,
      images: refs,
      size: request.settings.size,
      model: request.settings.model,
      watermark: request.settings.watermark
    }, undefined, prepared.config);
    const id = randomUUID();
    const relative = `out/img-${id}.${result.ext}`;
    await writeFile(imageAssetPath(jobId, relative), result.bytes);
    await editImageJob(jobId, async job => {
      const item: ImageItem = { versionId: id, roundId: prepared.id, index, status: "ready", source: "generated", file: relative, updatedAt: Date.now() };
      job.items[index] = item;
      appendJobLog(job.log, "info", `第 ${index + 1} 张生成完成（${(result.bytes.length / 1024).toFixed(0)} KB）`);
      appendImageRoundLog(job, prepared.id, "info", `第 ${index + 1} 张生成完成（${(result.bytes.length / 1024).toFixed(0)} KB）`);
      if (request.keying.enabled) {
        try { await keyItem(job, index, request.keying); appendImageRoundLog(job, prepared.id, "info", `第 ${index + 1} 张本地抠像完成`); }
        catch (error) { item.error = messageOf(error); appendJobLog(job.log, "error", `原图已保存，自动抠像失败：${item.error}`); appendImageRoundLog(job, prepared.id, "error", `原图已保存，自动抠像失败：${item.error}`); }
      }
      job.history.push({ id, batchId: prepared.id, roundId: prepared.id, createdAt: Date.now(), kind: "generated", item: { ...item }, request });
      completeImageRoundItem(job, prepared.id, index, { status: "ready", versionId: id, error: item.error });
    });
  } catch (error) {
    await editImageJob(jobId, job => {
      const target = job.items[index] ?? { index, source: "generated" as const };
      job.items[index] = { ...target, status: "error", error: messageOf(error), updatedAt: Date.now() };
      appendJobLog(job.log, "error", `第 ${index + 1} 张生成失败：${messageOf(error)}`);
      appendImageRoundLog(job, prepared.id, "error", `第 ${index + 1} 张生成失败：${messageOf(error)}`);
      completeImageRoundItem(job, prepared.id, index, { status: "error", error: messageOf(error) });
    });
    throw error;
  }
}

function appendImageRoundLog(job: ImageJob, batchId: string, level: "info" | "error", message: string) {
  const round = job.rounds?.find(value => value.id === batchId);
  if (round) appendJobLog(round.logs ??= [], level, message);
}

function completeImageRoundItem(job: ImageJob, batchId: string, index: number, patch: Partial<ImageRound["results"][number]>) {
  const round = job.rounds?.find(value => value.id === batchId), result = round?.results.find(value => value.index === index);
  if (!round || !result) return;
  Object.assign(result, patch);
  if (round.results.every(value => value.status !== "running")) round.completedAt = Date.now();
}

/** A restarted host must not silently resubmit a possibly billed request. */
export async function interruptImageRounds(jobId: string, isActive: () => boolean = () => false) {
  return editImageJob(jobId, job => {
    if (isActive()) return job;
    for (const round of job.rounds ?? []) for (const result of round.results) if (result.status === "running") {
      const error = "宿主已重启，本轮结果未知，可能已计费；未自动重试。";
      completeImageRoundItem(job, round.id, result.index, { status: "error", error });
      appendImageRoundLog(job, round.id, "error", `第 ${result.index + 1} 张：${error}`);
      if (job.items[result.index]?.status === "running") Object.assign(job.items[result.index], { status: "error", error });
    }
    return job;
  });
}

/** 对某一张跑绿幕抠像并写出透明 PNG。就地修改传入的 job（不落盘）。 */
export async function keyItem(job: ImageJob, index: number, keying = job.keying): Promise<void> {
  const item = job.items[index];
  if (item?.file === undefined) return;
  const config = await loadConfig();
  const decoded = await decodeToRgba(imageAssetPath(job.id, item.file), 2048);
  const result = keyGreen(decoded.rgba, decoded.width, decoded.height, {
    keyColor: keying.keyColor || config.keyColor,
    keyLow: keying.keyLow,
    keyHigh: keying.keyHigh,
    despill: keying.despill,
    edgeShrink: keying.edgeShrink,
    bgTolerance: keying.bgTolerance,
    refineEdges: true
  });
  const relative = `keyed/img-${randomUUID()}.png`;
  await writeFile(imageAssetPath(job.id, relative), encodePng(result.rgba, decoded.width, decoded.height));
  item.keyedFile = relative;
  item.backgroundFraction = result.backgroundFraction;
  item.updatedAt = Date.now();
}

/** 重新对全部已生成的图跑一遍抠像（改参数后调用）。 */
export async function rekeyImageJob(jobId: string): Promise<ImageJob> {
  return editImageJob(jobId, async job => {
    const config = await loadConfig();
    const keying = { ...job.keying, keyColor: normalizeKeyColor(job.keying.keyColor, config.keyColor) };
    const batchId = randomUUID();
    let count = 0;
    for (let i = 0; i < job.items.length; i++) {
      if (job.items[i]?.file === undefined) continue;
      try {
        await keyItem(job, i, keying);
        const previous = job.history.find(entry => entry.id === job.items[i].versionId);
        const id = randomUUID();
        job.items[i].versionId = id;
        job.items[i].status = "ready";
        job.items[i].error = undefined;
        job.history.push({ id, batchId, roundId: job.items[i].roundId, createdAt: Date.now(), kind: "keyed", item: { ...job.items[i] },
          request: previous?.request, sourceVersionId: previous?.id, keying: { ...keying } });
        if (job.items[i].roundId) appendImageRoundLog(job, job.items[i].roundId!, "info", `第 ${i + 1} 张已新增本地抠图版本`);
        count++;
      } catch (error) {
        job.items[i].error = messageOf(error);
        appendJobLog(job.log, "error", `第 ${i + 1} 张抠像失败：${job.items[i].error}`);
      }
    }
    appendJobLog(job.log, "info", `抠像完成：${count} 张（背景占比可在每张下方查看）`);
    return job;
  });
}

/** Preview is read-only. Save revalidates the version under the job edit lock. */
export async function cleanImageJobRegions(jobId: string, index: number, versionId: string, points: ImageCleanupPoint[], action: "preview" | "save") {
  if (action !== "preview" && action !== "save") throw new Error("未知的局部补抠操作。");
  const apply = async (job: ImageJob) => {
    if (job.items.some(item => item.status === "running")) throw new Error("图片任务正在处理，请完成后再补抠。");
    const item = job.items[index];
    if (!Number.isInteger(index) || !versionId || !item?.keyedFile || item.versionId !== versionId) throw new Error("当前图片版本已变化，请重新打开预览后补抠。");
    const decoded = await decodeToRgba(imageAssetPath(jobId, item.keyedFile), 2048);
    const cleaned = cleanImageRegions(decoded.rgba, decoded.width, decoded.height, points);
    const png = encodePng(cleaned.rgba, decoded.width, decoded.height);
    if (action === "preview") return { preview: `data:image/png;base64,${png.toString("base64")}`, changedPixels: cleaned.changedPixels };
    if (!cleaned.changedPixels) throw new Error("所选区域没有可清除的像素，请重新点选。");
    const previous = job.history.find(entry => entry.id === versionId), id = randomUUID();
    const relative = `keyed/img-${id}.png`;
    await writeFile(imageAssetPath(jobId, relative), png);
    let transparent = 0;
    for (let p = 3; p < cleaned.rgba.length; p += 4) if (!cleaned.rgba[p]) transparent++;
    job.items[index] = { ...item, versionId: id, keyedFile: relative, status: "ready", error: undefined, approved: false,
      backgroundFraction: transparent / (decoded.width * decoded.height), updatedAt: Date.now() };
    job.history.push({ id, batchId: id, roundId: item.roundId, createdAt: Date.now(), kind: "keyed", item: { ...job.items[index] },
      request: previous?.request, keying: previous?.keying, sourceVersionId: versionId, cleanup: { sourceVersionId: versionId, points: points.map(point => ({ ...point })) } });
    appendJobLog(job.log, "info", `局部补抠已保存：第 ${index + 1} 张，清除 ${cleaned.changedPixels} 像素，旧版本保留在历史中。`);
    if (item.roundId) appendImageRoundLog(job, item.roundId, "info", `第 ${index + 1} 张已保存局部补抠：清除 ${cleaned.changedPixels} 像素`);
    return { ok: true, versionId: id, changedPixels: cleaned.changedPixels };
  };
  if (action === "save") return editImageJob(jobId, apply);
  const job = await readImageJob(jobId);
  if (!job) throw new Error(`任务不存在：${jobId}`);
  return apply(job);
}

/** 上传一张已有图片作为生成结果（用于只做抠像的场景）。 */
export async function addImageToJob(jobId: string, name: string, base64: string): Promise<ImageItem> {
  const sniffed = sniffImage(base64);
  if (sniffed === undefined) throw new Error("无法识别的图片格式（支持 PNG / JPEG / WebP / BMP）");
  const bytes = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ""), "base64");
  if (bytes.length === 0) throw new Error("图片数据为空");
  if (bytes.length > 30 * 1024 * 1024) throw new Error("图片超过 30 MB");

  return editImageJob(jobId, async job => {
    const index = job.items.length;
    const id = randomUUID();
    const relative = `out/upload-${id}.${sniffed.ext}`;
    await mkdir(join(imageJobDir(jobId), "out"), { recursive: true });
    await writeFile(imageAssetPath(jobId, relative), bytes);

    const item: ImageItem = { versionId: id, roundId: id, index, status: "ready", file: relative, source: "uploaded", updatedAt: Date.now() };
    job.items.push(item);
    job.draft = false;
    appendJobLog(job.log, "info", `已上传图片：${safeName(name)}`);
    if (job.keying.enabled) {
      try {
        await keyItem(job, index);
      } catch (error) {
        appendJobLog(job.log, "error", `上传图片抠像失败：${messageOf(error)}`);
      }
    }
    job.history.push({ id, batchId: id, roundId: id, createdAt: Date.now(), kind: "uploaded", item: { ...item } });
    return job.items[index];
  });
}

/** 上传参考图。 */
export async function addImageRef(jobId: string, name: string, base64: string): Promise<void> {
  const sniffed = sniffImage(base64);
  if (sniffed === undefined) throw new Error("无法识别的图片格式（支持 PNG / JPEG / WebP / BMP）");
  return editImageJob(jobId, async job => {
    if (job.refs.length >= 10) throw new Error("参考图最多 10 张");

    const bytes = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ""), "base64");
    if (bytes.length === 0) throw new Error("图片数据为空");
    const stem = safeName(name).replace(/\.[^.]+$/, "") || "ref";
    const relative = `refs/${stem}-${randomUUID()}.${sniffed.ext}`;
    await mkdir(join(imageJobDir(jobId), "refs"), { recursive: true });
    await writeFile(imageAssetPath(jobId, relative), bytes);

    job.refs.push({ file: relative, name: safeName(name) });
    appendJobLog(job.log, "info", `已添加参考图：${safeName(name)}`);
  });
}

export async function removeImageRef(jobId: string, file: string): Promise<void> {
  await editImageJob(jobId, job => { job.refs = job.refs.filter(ref => ref.file !== file); });
}

export async function removeImageItem(jobId: string, index: number): Promise<void> {
  let removedFiles: Array<string | undefined> = [];
  await editImageJob(jobId, async job => {
    const item = job.items[index];
    job.items.splice(index, 1);
    job.items.forEach((entry, i) => {
      entry.index = i;
    });
    // Removing a current result must not delete its archived bytes.
    if (item) removedFiles = [item.file, item.keyedFile];
  }, job => removeUnusedImageFiles(job, removedFiles));
}

async function removeUnusedImageFiles(job: ImageJob, files: Array<string | undefined>): Promise<void> {
  const retained = new Set([...job.items, ...job.history.map(entry => entry.item)].flatMap(item => [item.file, item.keyedFile]));
  for (const request of [...(job.rounds ?? []).map(round => round.request), ...job.history.map(entry => entry.request)]) {
    for (const ref of request?.refs ?? []) retained.add(ref.file);
  }
  for (const file of new Set(files)) {
    if (file && !retained.has(file)) await rm(imageAssetPath(job.id, file), { force: true });
  }
}

/** Local history operations; never submit a generation request or change global credentials. */
export async function manageImageHistory(jobId: string, historyId: string, action: "restore" | "reuse" | "delete", mode: "all" | "prompt" | "parameters" = "all") {
  let removedFiles: Array<string | undefined> = [];
  return editImageJob(jobId, async job => {
    if (job.items.some(item => item.status === "running")) throw new Error("图片任务正在处理，请完成后再操作历史记录。");
    const entry = job.history.find(value => value.id === historyId);
    const round = job.rounds?.find(value => value.id === historyId);
    if (!entry && !(round && action === "reuse")) throw new Error("历史记录已不存在，请刷新后重试。");
    if (action === "restore") {
      await stat(imageAssetPath(jobId, entry!.item.file!));
      if (entry!.item.keyedFile) await stat(imageAssetPath(jobId, entry!.item.keyedFile));
      const index = Math.min(entry!.item.index, job.items.length);
      job.items[index] = { ...entry!.item, index, status: "ready", error: undefined, updatedAt: Date.now() };
      return { index };
    }
    if (action === "reuse") {
      const request = entry?.request ?? round?.request;
      if (!request) throw new Error("这条旧记录没有保存生成参数，无法复用。");
      if (mode !== "parameters") {
        for (const ref of request.refs) await stat(imageAssetPath(jobId, ref.file));
        job.prompt = request.prompt;
        // Preserve @ labels by restoring the matching reference order with the text.
        job.refs = request.refs.map(ref => ({ ...ref }));
      }
      // Pin the historical pixel dimensions, while the model/provider still
      // follow the user's global choice for the next explicitly paid request.
      if (mode !== "prompt") {
        job.suffix = request.suffix;
        job.promptTemplateId = request.promptTemplateId; job.promptTemplateLang = request.promptTemplateLang;
        job.settings = { ...request.settings, sizeMode: "custom" };
        job.keying = { ...(entry?.keying ?? request.keying) };
      }
      return { reused: true };
    }
    if (action !== "delete") throw new Error("未知的历史记录操作。");
    job.history = job.history.filter(value => value.id !== historyId);
    removedFiles = [entry!.item.file, entry!.item.keyedFile];
    return { deleted: true };
  }, job => removeUnusedImageFiles(job, removedFiles));
}

/** 任务目录是否真实存在。 */
export async function imageJobExists(id: string): Promise<boolean> {
  try {
    return (await stat(imageJobDir(id))).isDirectory();
  } catch {
    return false;
  }
}

export { readFile };

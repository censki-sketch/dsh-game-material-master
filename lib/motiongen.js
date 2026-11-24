/** White-model workflow for the existing sprite module. No agent required. */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { dataRoot, loadConfig, saveConfig, MINIMAX_MODEL_PRESETS } from "./config.js";
import { readJson, writeJsonAtomic } from "./jsonio.js";
import { decodeToRgba, probeDuration, probeSize, probeVideoFrameTimeline, runFfmpeg, sniffVideo, toDataUri, mimeOf, } from "./media.js";
import { encodePng } from "./png.js";
import { sniffImage } from "./imagegen.js";
import { DEFAULT_KEY_OPTIONS, keyGreen, composeSheet } from "./chroma.js";
import { generateImageWithProvider } from "./imageprovider.js";
import { capabilityOf, normalizeDuration, gatewayOf, } from "./minimax.js";
import { assertVideoBackendReady, downloadVideoTask, queryVideoTask, submitVideoTask, videoBackendOf, } from "./videogen.js";
import { assetPath, readProject } from "./store.js";
import { zipEntries } from "./zip.js";
import { MOTION_PROMPT_TEMPLATES, validateMotionTemplates, motionRedrawPrompt } from "./motionprompts.js";
import { templatesOfType } from "./prompttemplates.js";
import { processMotionEdits } from "./motionimage.js";
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
const TEMPLATE_DIR = fileURLToPath(new URL("../assets/motion-templates/", import.meta.url));
const ID = /^w[a-z0-9]{8,48}$/;
export function motionFrameRangeKey(frame) {
    return `${frame.action}::${frame.direction}`;
}
export function motionFrameIsValid(job, frame) {
    const range = job.validFrameRanges?.[motionFrameRangeKey(frame)];
    return !range || frame.index >= range.start && frame.index <= range.end;
}
export function motionValidFrames(job) {
    return job.frames.filter(frame => motionFrameIsValid(job, frame));
}
/** Share the actual four-second/reference-video constraints with the composer. */
export function motionVideoModels() {
    return MINIMAX_MODEL_PRESETS.flatMap(preset => {
        const caps = capabilityOf(preset.id);
        if (caps.protocol !== "v2" || normalizeDuration(preset.id, 4) !== 4)
            return [];
        const resolution = caps.resolutions.includes("480P") ? "480P" : caps.resolutions.includes("768P") ? "768P" : null;
        return resolution ? [{ id: preset.id, label: preset.id, resolution }] : [];
    });
}
export function motionVideoSelection(job, config) {
    if (!job.videoModel && videoBackendOf(config) !== "minimax")
        throw new Error("此流程需要支持参考视频的 MiniMax 模型，请在输入栏选择视频模型");
    const model = job.videoModel || config.minimaxModel;
    const option = motionVideoModels().find(item => item.id === model);
    if (!option)
        throw new Error("当前模型不支持4秒参考视频，请在输入栏选择兼容的视频模型");
    return { model, endpoint: gatewayOf(model, config.minimaxBaseUrl), resolution: option.resolution };
}
export function motionVideoConfig(job, config) {
    const selection = job.workflowParent && job.videoGeneration || motionVideoSelection(job, config);
    return { ...config, comfyVideo: false, toapisVideo: false, minimaxModel: selection.model, minimaxBaseUrl: selection.endpoint, minimaxResolution: selection.resolution };
}
export function motionProcessing(input = {}) {
    const result = { extract: input.extract !== false, key: input.key !== false, sheet: input.sheet !== false,
        keyColor: input.keyColor ?? "#FF00FF", keyLow: number(input.keyLow ?? 14, 0, 255), keyHigh: number(input.keyHigh ?? 80, 1, 255),
        despill: number(input.despill ?? .65, 0, 1), edgeShrink: number(input.edgeShrink ?? 0, 0, 8), bgTolerance: number(input.bgTolerance ?? 40, 0, 255),
        cropInset: number(input.cropInset ?? 0, 0, .2), cellWidth: number(input.cellWidth ?? 512, 16, 1024), cellHeight: number(input.cellHeight ?? 512, 16, 1024) };
    if (!/^#[0-9a-fA-F]{6}$/.test(result.keyColor) || result.keyHigh <= result.keyLow || !Number.isInteger(result.cellWidth) || !Number.isInteger(result.cellHeight))
        throw new Error("Invalid motion processing settings");
    return result;
}
const localHash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const localRawSignature = (job, ranges = job.ranges, processing = motionProcessing(job.processing)) => localHash([job.video?.file, ranges.map(r => [r.action, r.start, r.end, motionSampling(r).frameCount, r.targetFps ?? null]), processing.cropInset]);
const localKeySignature = (job, processing = motionProcessing(job.processing)) => localHash([job.frames.map(f => f.target), processing.keyColor.toUpperCase(), processing.keyLow, processing.keyHigh, processing.despill, processing.edgeShrink, processing.bgTolerance]);
const localArchiveSignature = (job, processing = motionProcessing(job.processing)) => localHash([job.ranges, job.frames.map(f => processing.key ? f.keyed : f.target), processing.key, processing.cellWidth, processing.cellHeight]);
function rememberLocalArtifacts(job) {
    if (job.localArtifacts || !job.frames.length)
        return;
    const processing = motionProcessing(job.processing);
    job.localArtifacts = { raw: localRawSignature(job), keyed: processing.key ? localKeySignature(job) : null, archive: job.archive && job.archiveKind !== "redraw" ? localArchiveSignature(job) : null };
}
async function localRanges(job, input) {
    const clip = job.inputMode === "video" && input.length === 1 && input[0]?.action === "video";
    const ranges = clip ? [{ action: "video", ...motionVideoRange(job, input[0]) }] : await validateSegments(input, false, true);
    if (!clip && (ranges.length !== job.segments.length || ranges.some((r, i) => r.action !== job.segments[i]?.action)))
        throw new Error("Extract ranges must match selected actions");
    if (ranges.some(r => r.end > (job.video?.duration || job.sourceVideo?.duration || 120) + .001))
        throw new Error("Range exceeds actual video duration");
    return ranges;
}
/** Shared by the read-only preview and execution; never plans a paid step. */
export async function motionLocalProcessingPlan(job, input) {
    if (job.video?.status !== "ready" || !job.video.file)
        throw new Error("请先生成或导入视频");
    const ranges = await localRanges(job, input.ranges || job.ranges), processing = motionProcessing({ ...job.processing, ...input.processing, extract: true });
    const baseline = structuredClone(job);
    rememberLocalArtifacts(baseline);
    const rawChanged = !job.frames.length || baseline.localArtifacts?.raw !== localRawSignature(job, ranges, processing);
    const keyChanged = processing.key && baseline.localArtifacts?.keyed !== localKeySignature(job, processing);
    const sheetChanged = processing.sheet && (!job.archive || job.archiveKind === "redraw" || baseline.localArtifacts?.archive !== localArchiveSignature({ ...job, ranges }, processing));
    const force = input.forceLocal;
    const steps = rawChanged ? ["extract"] : keyChanged || force === "keyed" ? ["keyed"] : [];
    if (processing.sheet && (steps.length || sheetChanged || force === "export"))
        steps.push("export");
    return { kind: "local-processing", steps, ranges, processing, changed: JSON.stringify(processing) !== JSON.stringify(motionProcessing(job.processing)), actions: ranges.map(r => r.action), frameCount: ranges.reduce((count, r) => count + r.frameCount * 8, 0) };
}
const active = new Set();
const cancelled = new Set();
const pollTimers = new Map();
let disposed = false;
export function isMotionId(id) {
    return ID.test(id);
}
const root = () => join(dataRoot(), "motion-jobs");
export function motionAssetPath(id, relative) {
    if (!isMotionId(id))
        throw new Error("Invalid motion job ID");
    const base = resolve(root(), id), target = resolve(base, relative);
    if (!target.startsWith(base + sep))
        throw new Error("Invalid motion asset path");
    return target;
}
const path = (id, relative) => motionAssetPath(id, relative);
const videoTimelines = new Map();
export async function motionVideoTimeline(id) {
    const job = await readMotion(id);
    if (!job.video?.file)
        throw new Error("请先生成或导入视频");
    const file = path(id, job.video.file), info = await stat(file), key = `${file}:${info.size}:${info.mtimeMs}`;
    let timeline = videoTimelines.get(key);
    if (!timeline) {
        timeline = probeVideoFrameTimeline(file).catch(error => { videoTimelines.delete(key); throw error; });
        videoTimelines.set(key, timeline);
        if (videoTimelines.size > 8)
            videoTimelines.delete(videoTimelines.keys().next().value);
    }
    return { file: job.video.file, ...await timeline };
}
const videoPreviewPages = new Map();
/** Small contact sheets of consecutive source frames, independent of extraction or AI results. */
export async function motionVideoFramePreviews(id, page) {
    if (!Number.isInteger(page) || page < 0)
        throw new Error("Invalid frame preview page");
    const timeline = await motionVideoTimeline(id), firstFrame = page * 12;
    if (firstFrame >= timeline.times.length)
        throw new Error("Frame preview page out of range");
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
                if (!stdout.length)
                    throw new Error("无法生成帧预览");
                await mkdir(path(id, "out/video-frame-previews"), { recursive: true });
                const temporary = `${target}.${randomUUID()}.tmp`;
                try {
                    await writeFile(temporary, stdout);
                    await rename(temporary, target);
                }
                finally {
                    await rm(temporary, { force: true }).catch(() => { });
                }
            }
            return { kind: "video-frame-previews", file: timeline.file, page, firstFrame, count, columns, rows, sheet, width: 192, height: 108 };
        })().catch(error => { videoPreviewPages.delete(key); throw error; });
        videoPreviewPages.set(key, pending);
        if (videoPreviewPages.size > 16)
            videoPreviewPages.delete(videoPreviewPages.keys().next().value);
    }
    return pending;
}
const file = (id) => path(id, "job.json");
const save = async (job) => {
    job.updatedAt = Date.now();
    await writeJsonAtomic(file(job.id), job);
};
const token = () => `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const redact = (text, key) => key ? text.replaceAll(key, "[redacted]") : text;
const imageUri = (id, relative) => toDataUri(path(id, relative), mimeOf(relative));
function checkStopped(id) {
    if (disposed || cancelled.has(id))
        throw new Error("本地处理已停止；已提交的远端请求可能仍会计费，完成帧保留。");
}
function number(value, low, high) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < low || n > high)
        throw new Error(`Expected number in ${low}..${high}`);
    return n;
}
export async function motionCatalog() {
    return JSON.parse(await readFile(join(TEMPLATE_DIR, "catalog.json"), "utf8"));
}
const templatePreviews = new Map();
/** Read-only, local previews use the exact frames/timing used by prepare(). */
export async function motionTemplatePreview(action, direction) {
    if ((await loadConfig()).hiddenModules.includes("sprite"))
        throw new Error("Module disabled");
    const catalog = await motionCatalog();
    const spec = catalog.actions.find(item => item.key === action);
    const directionIndex = catalog.directions.indexOf(direction);
    if (!spec || directionIndex < 0)
        throw new Error("Unknown motion template or direction");
    const key = action + ":" + direction;
    if (templatePreviews.has(key))
        return templatePreviews.get(key);
    const raw = gunzipSync(await readFile(join(TEMPLATE_DIR, spec.key + ".rgba.gz")));
    const { width, height } = catalog, frameBytes = width * height * 4;
    if (raw.length !== frameBytes * spec.frames * catalog.directions.length)
        throw new Error("Corrupt template data");
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
    if (templatePreviews.size >= 16)
        templatePreviews.delete(templatePreviews.keys().next().value);
    templatePreviews.set(key, result);
    return result;
}
export async function readMotion(id) {
    if (!isMotionId(id))
        throw new Error("Invalid motion job ID");
    const job = await readJson(file(id));
    if (!job)
        throw new Error("Motion job not found");
    return job;
}
export async function listMotionJobs(includeRounds = false) {
    const entries = await readdir(root()).catch(() => []);
    const jobs = await Promise.all(entries
        .filter(isMotionId)
        .map((id) => readMotion(id).catch(() => undefined)));
    return jobs
        .filter(j => j && (includeRounds || !j.workflowParent))
        .map((j) => ({
        id: j.id,
        name: j.name,
        updatedAt: j.updatedAt,
        operation: j.operation,
    }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function createMotionJob(name = "") {
    const id = `w${Date.now().toString(36)}${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await mkdir(join(root(), id), { recursive: true });
    for (const sub of MOTION_DIRS)
        await mkdir(path(id, sub), { recursive: true });
    const segments = [
        { action: "", start: 0, end: 2, frameCount: 48, targetFps: 24 },
        { action: "", start: 2, end: 4, frameCount: 48, targetFps: 24 },
    ];
    const job = {
        id,
        composerVersion: 1, inputMode: "generate", reviewMode: "auto", processing: motionProcessing(),
        promptTemplate: { id: "motion-video", lang: "zh", content: (await settings()).templates.find(t => t.id === "motion-video").prompt.zh },
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
async function validateSegments(values, reference, allowBlank = false) {
    if (!Array.isArray(values) || values.length < 2 || values.length > 3)
        throw new Error("4秒视频只允许2或3种动作");
    const catalog = await motionCatalog();
    const keys = new Set();
    const segments = values.map((value) => {
        if (!(allowBlank && value.action === "") && (!catalog.actions.some((a) => a.key === value.action) || keys.has(value.action)))
            throw new Error("Unknown or duplicate motion template");
        if (value.action)
            keys.add(value.action);
        const start = number(value.start, 0, 120), end = number(value.end, 0, 120), sampling = motionSampling({ ...value, start, end });
        return { action: value.action, start, end, ...sampling };
    });
    for (let i = 1; i < segments.length; i++)
        if (segments[i].start < segments[i - 1].end - 1e-6)
            throw new Error("Action intervals overlap");
    if (reference &&
        (segments[0].start !== 0 ||
            Math.abs(segments.at(-1).end - 4) > 1e-6 ||
            segments.some((s, i) => i > 0 && Math.abs(s.start - segments[i - 1].end) > 1e-6)))
        throw new Error("Reference timeline must continuously cover exactly 4 seconds");
    return segments;
}
async function exclusive(id, run) {
    if (disposed || active.has(id))
        throw new Error("任务正在处理，请勿重复点击");
    active.add(id);
    try {
        return await run(await readMotion(id));
    }
    finally {
        active.delete(id);
    }
}
function assertEditable(job) {
    if (job.video &&
        ["submitting", "unknown", "pending", "running"].includes(job.video.status))
        throw new Error("视频任务未结束；请先查询状态或导入已有视频");
}
function invalidate(job, reference) {
    if (reference)
        job.prepared = undefined;
    job.video = undefined;
    job.frames = [];
    job.validFrameRanges = undefined;
    job.redrawTargets = undefined;
    job.archive = undefined;
    job.rangesConfirmed = false;
    job.revision++;
}
export async function saveMotionJob(id, input) {
    await exclusive(id, async (job) => {
        rememberLocalArtifacts(job);
        assertEditable(job);
        if (input.reviewMode !== undefined) {
            if (!["auto", "manual"].includes(input.reviewMode))
                throw new Error("Invalid review mode");
            job.reviewMode = input.reviewMode;
        }
        if (input.videoModel !== undefined) {
            if (input.videoModel !== "" && !motionVideoModels().some(item => item.id === input.videoModel))
                throw new Error("当前模型不支持4秒参考视频");
            job.videoModel = input.videoModel;
        }
        const oldDefault = await defaultMotionPrompt(job);
        if (input.composerVersion === 1)
            job.composerVersion = 1;
        if (input.inputMode !== undefined) {
            if (!["generate", "video"].includes(input.inputMode))
                throw new Error("Invalid input mode");
            job.inputMode = input.inputMode;
        }
        if (input.processing !== undefined) {
            const next = motionProcessing(input.processing);
            if (next.keyColor !== motionProcessing(job.processing).keyColor)
                job.prepared = undefined;
            job.processing = next;
        }
        if (input.promptTemplate !== undefined) {
            if (typeof input.promptTemplate.content !== "string" || input.promptTemplate.content.length > 6000)
                throw new Error("Invalid prompt template");
            job.promptTemplate = { id: String(input.promptTemplate.id).slice(0, 64), lang: input.promptTemplate.lang === "en" ? "en" : "zh", content: input.promptTemplate.content };
        }
        let referenceChanged = false, videoChanged = false;
        if (input.name !== undefined)
            job.name = String(input.name).trim().slice(0, 80) || job.name;
        if (input.description !== undefined &&
            input.description !== job.description) {
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
        if (referenceChanged || videoChanged)
            invalidate(job, referenceChanged);
        if (!job.composerVersion && (referenceChanged || videoChanged) && job.prompt === oldDefault)
            job.prompt = await defaultMotionPrompt(job);
        if (input.ranges !== undefined) {
            const videoClip = job.inputMode === "video" && input.ranges.length === 1 && input.ranges[0]?.action === "video";
            const ranges = videoClip ? [{ action: "video", ...motionVideoRange(job, input.ranges[0]) }] : await validateSegments(input.ranges, false, true);
            if (!videoClip && (ranges.some((s, i) => s.action !== job.segments[i]?.action) ||
                ranges.length !== job.segments.length))
                throw new Error("Extract ranges must match selected actions");
            if ((job.inputMode === "video" ? job.sourceVideo?.duration || job.video?.duration : job.video?.duration) &&
                ranges.some((s) => s.end > (job.inputMode === "video" ? job.sourceVideo?.duration || job.video.duration : job.video.duration) + 0.001))
                throw new Error("Range exceeds actual video duration");
            if (JSON.stringify(ranges) !== JSON.stringify(job.ranges)) {
                job.ranges = ranges;
                job.frames = [];
                job.validFrameRanges = undefined;
                job.redrawTargets = undefined;
                job.archive = undefined;
                job.rangesConfirmed = false;
            }
        }
        if (input.rangesConfirmed !== undefined)
            job.rangesConfirmed = input.rangesConfirmed === true;
        if (input.videoRange !== undefined)
            job.videoRange = motionVideoRange(job, input.videoRange);
        if (input.validFrameRanges !== undefined) {
            if (!input.validFrameRanges || typeof input.validFrameRanges !== "object" || Array.isArray(input.validFrameRanges))
                throw new Error("Invalid frame ranges");
            const groups = new Map();
            for (const frame of job.frames) {
                const key = motionFrameRangeKey(frame);
                if (!groups.has(key))
                    groups.set(key, []);
                groups.get(key).push(frame);
            }
            const next = {};
            for (const [key, raw] of Object.entries(input.validFrameRanges).slice(0, 256)) {
                const frames = groups.get(key);
                if (!frames?.length || !raw || typeof raw !== "object")
                    continue;
                const values = raw;
                const start = Number(values.start), end = Number(values.end);
                if (!Number.isInteger(start) || !Number.isInteger(end))
                    continue;
                const min = Math.min(...frames.map(frame => frame.index)), max = Math.max(...frames.map(frame => frame.index));
                next[key] = { start: Math.max(min, Math.min(max, Math.min(start, end))), end: Math.max(min, Math.min(max, Math.max(start, end))) };
            }
            job.validFrameRanges = Object.keys(next).length ? next : undefined;
        }
        await save(job);
    });
}
export async function uploadMotionAsset(id, kind, data) {
    await exclusive(id, async (job) => {
        if (kind === "project") {
            assertEditable(job);
            const source = await readProject(data);
            if (!source)
                throw new Error("八方向项目不存在");
            const config = await loadConfig(), rows = [];
            for (const direction of MOTION_ORDER) {
                const relative = source.images[direction]?.file;
                if (!relative)
                    throw new Error("原项目八个方向图需要全部完成");
                const decoded = await decodeToRgba(assetPath(source.id, relative), 512);
                const square = Buffer.alloc(512 * 512 * 4), scale = Math.min(512 / decoded.width, 512 / decoded.height), w = Math.round(decoded.width * scale), h = Math.round(decoded.height * scale);
                blit(resize(decoded.rgba, decoded.width, decoded.height, w, h), w, h, square, 512, 512, Math.floor((512 - w) / 2), Math.floor((512 - h) / 2));
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
                blit(crop(sheet.rgba, 216, 0, d * 240, 216, 240), 216, 240, grid, 864, 480, (d % 4) * 216, Math.floor(d / 4) * 240);
            const suffix = token(), directions = `refs/${suffix}-directions.png`, character = `refs/${suffix}-character.png`;
            await writeFile(path(id, directions), encodePng(grid, 864, 480));
            const original = await decodeToRgba(assetPath(source.id, source.images.front.file), 1024);
            await writeFile(path(id, character), encodePng(original.rgba, original.width, original.height));
            job.character = character;
            job.directions = directions;
            invalidate(job, true);
            await save(job);
            return;
        }
        if (["remove-character", "remove-directions", "remove-video"].includes(kind)) {
            assertEditable(job);
            if (kind === "remove-video") {
                job.sourceVideo = undefined;
                job.videoRange = undefined;
                job.inputMode = "generate";
                invalidate(job, false);
            }
            else {
                job[kind.slice(7)] = undefined;
                invalidate(job, true);
            }
            await save(job);
            return;
        }
        if (!["character", "directions", "video"].includes(kind))
            throw new Error("Invalid asset role");
        if (kind !== "video")
            assertEditable(job);
        const raw = data.replace(/^data:[^,]*,/, "");
        if (raw.length > 70 * 1024 * 1024)
            throw new Error("Asset exceeds 50MB");
        const bytes = Buffer.from(raw, "base64");
        const info = kind === "video" ? sniffVideo(raw) : sniffImage(raw);
        if (!info)
            throw new Error("Unsupported asset format");
        const relative = `${kind === "video" ? "videos" : "refs"}/${token()}.${info.ext}`;
        await writeFile(path(id, relative), bytes);
        if (kind === "video") {
            const size = await probeSize(path(id, relative));
            if (Math.abs(size.width / size.height - 1.8) > 0.04)
                throw new Error("需要四列两行的16:9八方向视频");
            const duration = await probeDuration(path(id, relative));
            job.sourceVideo = { file: relative, duration };
            job.inputMode = "video";
            job.videoRange = { start: 0, end: duration, frameCount: Math.max(1, Math.round(duration * 24)), targetFps: 24 };
            job.video = {
                status: "ready",
                file: relative,
                model: "local-import",
                endpoint: "",
                duration,
            };
            job.frames = [];
            job.validFrameRanges = undefined;
            job.redrawTargets = undefined;
            job.archive = undefined;
            job.rangesConfirmed = false;
        }
        else {
            job[kind] = relative;
            invalidate(job, true);
        }
        await save(job);
    });
}
const settingsFile = () => join(dataRoot(), "motion-settings.json");
async function settings() {
    const value = {
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "",
        apiKey: "",
        videoRate: 0.16,
        imageRate: 0,
        ...(await readJson(settingsFile())),
    };
    return { ...value, templates: templatesOfType((await loadConfig()).promptTemplates, "video") };
}
export async function motionSettings(input = {}) {
    const value = await settings();
    if (input.save === true) {
        if (input.baseUrl !== undefined) {
            const url = new URL(String(input.baseUrl).trim());
            if (!["http:", "https:"].includes(url.protocol) ||
                url.username ||
                url.password ||
                url.search ||
                url.hash)
                throw new Error("Invalid API base URL");
            value.baseUrl = url.toString().replace(/\/$/, "");
        }
        if (input.model !== undefined)
            value.model = String(input.model).trim().slice(0, 200);
        if (input.apiKey !== undefined)
            value.apiKey = String(input.apiKey).trim();
        if (input.videoRate !== undefined)
            value.videoRate = number(input.videoRate, 0, 1000);
        if (input.imageRate !== undefined)
            value.imageRate = number(input.imageRate, 0, 1000);
        if (input.templates !== undefined) {
            const saved = await saveConfig({ promptTemplateEdit: { type: "video", templates: validateMotionTemplates(input.templates) } });
            value.templates = templatesOfType(saved.promptTemplates, "video");
        }
        else
            await saveConfig({}); // Persist migrated templates before removing the legacy copy.
        const { templates: _, ...modelSettings } = value;
        await writeJsonAtomic(settingsFile(), modelSettings);
    }
    const { apiKey, ...publicValue } = value;
    return { ...publicValue, templateDefaults: MOTION_PROMPT_TEMPLATES, apiKeySet: apiKey !== "" };
}
export async function motionView(id) {
    // The operation can finish while the job/config files are being read. Keep
    // the busy snapshot until a fresh read can include its final saved result.
    const wasActive = active.has(id);
    const job = await readMotion(id), config = await loadConfig(), prices = await settings();
    const pending = motionValidFrames(job).filter((f) => f.redraw?.status !== "ready").length;
    return {
        ...job,
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
        videoConfig: (() => { try {
            return job.workflowParent && job.videoGeneration || motionVideoSelection(job, config);
        }
        catch (error) {
            return { model: job.videoModel || config.minimaxModel, blocker: error.message };
        } })(),
        imageProvider: config.imageProvider,
        imageModel: config.imageProvider === "custom" ? config.customModel : config.arkModel,
        active: wasActive || active.has(id),
        duration: 4,
    };
}
async function defaultMotionPrompt(job) {
    const catalog = await motionCatalog();
    const timeline = job.segments
        .map((s) => `${s.start}–${s.end}秒：${catalog.actions.find((a) => a.key === s.action)?.name || "请选择动作"}`)
        .join("；");
    return `将参考视频的灰白人物替换成参考图片中的同一个角色。参考视频只决定动作、时间顺序、八格布局和朝向；角色图片只决定外观、服装、配色和画风。\n时间顺序：${timeline}。严格跟随各段参考姿势，短动作按参考重复，不新增动作、不漏动作、不混合前后两段。\n四列两行：上排北、东北、东、东南；下排南、西南、西、西北。每格一个完整人物，全程保持各自朝向，禁止转身、串格、合并或消失。固定相机、人物大小和格内位置。角色完整露出头脚，不复制白模的拳套和短裤。\n角色说明：${job.description || "保持角色参考图的全部外观特征"}\n背景及格间空隙全程纯品红#FF00FF，无地面、阴影、边框、文字、特效、镜头切换或缩放。`;
}
export async function composeMotionPrompt(job) {
    if (!job.composerVersion)
        return job.prompt;
    const catalog = await motionCatalog();
    const values = { timeline: job.segments.map(s => `${s.start}–${s.end}s: ${catalog.actions.find(a => a.key === s.action)?.name || "…"}`).join("; "),
        description: job.description || (job.promptTemplate?.lang === "en" ? "Keep the appearance in the reference images" : "保持角色参考图的全部外观特征"), keyColor: motionProcessing(job.processing).keyColor };
    const body = job.promptTemplate?.content ?? MOTION_PROMPT_TEMPLATES[0].prompt.zh;
    return [body.replace(/\{\{(timeline|description|keyColor)\}\}/g, (_, key) => values[key]), job.prompt.trim()].filter(Boolean).join("\n\n");
}
/** Read-only draft preview, using the same assembly as video submission. Never saves or prepares media. */
export async function motionPromptContext(id, input) {
    const job = structuredClone(await readMotion(id));
    if (typeof input.prompt !== "string" || input.prompt.length > 12000)
        throw new Error("Invalid motion prompt");
    job.prompt = input.prompt;
    if (input.description !== undefined)
        job.description = String(input.description).slice(0, 8000);
    if (input.segments !== undefined)
        job.segments = await validateSegments(input.segments, true, true);
    if (input.processing !== undefined)
        job.processing = motionProcessing(input.processing);
    if (input.promptTemplate !== undefined) {
        if (typeof input.promptTemplate.content !== "string" || input.promptTemplate.content.length > 6000)
            throw new Error("Invalid prompt template");
        job.promptTemplate = { id: String(input.promptTemplate.id).slice(0, 64), lang: input.promptTemplate.lang === "en" ? "en" : "zh", content: input.promptTemplate.content };
    }
    if (input.composerVersion === 1)
        job.composerVersion = 1;
    const en = job.promptTemplate?.lang === "en";
    const references = [[job.character, en ? "Character details" : "角色细节参考图"], [job.directions, en ? "Eight-direction appearance (4×2)" : "八方向外观图（四列两行）"]]
        .filter(([file]) => !!file).map(([file, name], i) => ({ file, name, label: `@图片${i + 1}` }));
    const labels = [...job.prompt.matchAll(/@图片\d+/g)].map(match => match[0]);
    if (labels.some(label => !references.some(ref => ref.label === label)))
        throw new Error("引用的图片不存在，请重新选择参考图。");
    const finalPrompt = await composeMotionPrompt(job);
    const suffix = await composeMotionPrompt({ ...job, prompt: "" });
    return { prompt: finalPrompt, suffix, references, background: { enabled: motionProcessing(job.processing).key, keyColor: motionProcessing(job.processing).keyColor,
            instruction: "The template supplies the exact uniform background; do not alter it." },
        context: { description: job.description, segments: job.segments, duration: 4, layout: "4 columns × 2 rows: N, NE, E, SE / S, SW, W, NW", keyColor: motionProcessing(job.processing).keyColor } };
}
export function motionSampling(value) {
    const duration = value.end - value.start;
    if (!Number.isFinite(duration) || duration < .2)
        throw new Error("Invalid action interval or frame count");
    if (value.targetFps !== undefined && (!Number.isInteger(value.targetFps) || value.targetFps < 1 || value.targetFps > 60))
        throw new Error("目标帧率必须为1–60 FPS");
    const frameCount = value.targetFps === undefined ? value.frameCount : Math.max(1, Math.round(duration * value.targetFps));
    if (!Number.isInteger(frameCount) || frameCount < 1)
        throw new Error("Invalid action interval or frame count");
    if (frameCount > 720)
        throw new Error("单段最多720帧，请缩短范围或降低目标帧率。");
    return { frameCount, ...(value.targetFps === undefined ? {} : { targetFps: value.targetFps }) };
}
export function motionVideoRange(job, value = job.videoRange) {
    const duration = job.sourceVideo?.duration ?? job.video?.duration ?? 0;
    const range = value || { start: 0, end: duration, frameCount: 24 };
    if (!Number.isFinite(duration) || duration < .2 || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end - range.start < .2 || range.end > duration + .001 || !Number.isInteger(range.frameCount) || range.frameCount < 1)
        throw new Error("Invalid video range or frame count");
    return { start: range.start, end: range.end, ...motionSampling(range) };
}
export async function validateMotionSubmission(job, localOnly) {
    if (localOnly) {
        if (!job.sourceVideo?.file && !job.video?.file)
            throw new Error("请先导入视频");
        motionVideoRange(job);
    }
    else {
        await validateSegments(job.segments, true);
        if (!job.character || !job.directions)
            throw new Error("请先提供角色图和八方向外观图");
    }
}
function signature(job) {
    return createHash("sha256")
        .update(JSON.stringify([job.segments, job.character, job.directions, motionProcessing(job.processing).keyColor]))
        .digest("hex");
}
export function motionPreparedCurrent(job) {
    return !!job.prepared && job.prepared.signature === signature(job);
}
function blit(source, sw, sh, target, tw, th, x, y) {
    for (let sy = 0; sy < sh; sy++) {
        const ty = sy + y;
        if (ty < 0 || ty >= th)
            continue;
        for (let sx = 0; sx < sw; sx++) {
            const tx = sx + x;
            if (tx < 0 || tx >= tw)
                continue;
            const a = (sy * sw + sx) * 4, b = (ty * tw + tx) * 4;
            if (source[a + 3] === 0)
                continue;
            source.copy(target, b, a, a + 4);
        }
    }
}
function resize(source, sw, sh, w, h) {
    const target = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const a = (Math.min(sh - 1, Math.floor((y * sh) / h)) * sw +
                Math.min(sw - 1, Math.floor((x * sw) / w))) *
                4;
            source.copy(target, (y * w + x) * 4, a, a + 4);
        }
    return target;
}
function crop(source, sw, x, y, w, h) {
    const out = Buffer.alloc(w * h * 4);
    for (let row = 0; row < h; row++)
        source.copy(out, row * w * 4, ((y + row) * sw + x) * 4, ((y + row) * sw + x + w) * 4);
    return out;
}
function matte(rgba, w, h) {
    return keyGreen(rgba, w, h, {
        ...DEFAULT_KEY_OPTIONS,
        keyColor: "#FF00FF",
        edgeShrink: 0,
    }).rgba;
}
async function renderMotionReference(job) {
    await validateSegments(job.segments, true);
    const dir = `prepared/${token()}`;
    const background = motionProcessing(job.processing).keyColor.match(/[a-f0-9]{2}/gi).map(v => parseInt(v, 16));
    await mkdir(path(job.id, dir), { recursive: true });
    const catalog = await motionCatalog();
    const sources = new Map();
    for (const seg of job.segments) {
        const spec = catalog.actions.find((a) => a.key === seg.action);
        const raw = gunzipSync(await readFile(join(TEMPLATE_DIR, `${seg.action}.rgba.gz`)));
        if (raw.length !== 126 * 132 * 4 * spec.frames * 8)
            throw new Error("Corrupt template data");
        sources.set(seg.action, { raw, spec });
    }
    // Fixed transform across all frames, directions and actions. Original canvas
    // center and baseline are preserved; no frame-specific recentering.
    const scale = 1.65, bw = Math.round(126 * scale), bh = Math.round(132 * scale), px = Math.round(108 - 63 * scale), py = 219 - bh;
    for (let i = 0; i < 96; i++) {
        checkStopped(job.id);
        const t = i / 24, seg = job.segments.find((s) => t >= s.start && t < s.end);
        const { raw, spec } = sources.get(seg.action);
        const cycle = Math.max(0.6, spec.durationMs / 1000), phase = ((t - seg.start) % cycle) / cycle;
        let index = 0, elapsed = 0;
        for (let j = 0; j < spec.frames; j++) {
            elapsed += spec.frameDurationsMs[j];
            if (phase * spec.durationMs < elapsed) {
                index = j;
                break;
            }
        }
        const canvas = Buffer.alloc(864 * 480 * 4);
        for (let p = 0; p < canvas.length; p += 4) {
            canvas[p] = background[0];
            canvas[p + 1] = background[1];
            canvas[p + 2] = background[2];
            canvas[p + 3] = 255;
        }
        for (let d = 0; d < 8; d++) {
            const start = (d * spec.frames + index) * 126 * 132 * 4;
            const body = Buffer.from(raw.subarray(start, start + 126 * 132 * 4));
            for (let p = 0; p < body.length; p += 4) {
                const gray = Math.round(70 +
                    0.72 *
                        (0.299 * body[p] + 0.587 * body[p + 1] + 0.114 * body[p + 2]));
                body[p] = body[p + 1] = body[p + 2] = gray;
            }
            blit(resize(body, 126, 132, bw, bh), bw, bh, canvas, 864, 480, (d % 4) * 216 + px, Math.floor(d / 4) * 240 + py);
        }
        await writeFile(path(job.id, `${dir}/f${String(i).padStart(3, "0")}.png`), encodePng(canvas, 864, 480));
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
export async function previewMotionReference(id, input) {
    if ((await loadConfig()).hiddenModules.includes("sprite"))
        throw new Error("Module disabled");
    return exclusive(id, async (saved) => {
        const job = structuredClone(saved);
        job.segments = await validateSegments(input.segments, true);
        job.processing = motionProcessing({ ...job.processing, keyColor: input.keyColor });
        return { ...await renderMotionReference(job), duration: 4, width: 864, height: 480 };
    });
}
async function prepare(job) {
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
async function buildPrompt(job, useModel) {
    assertEditable(job);
    const base = await defaultMotionPrompt(job);
    if (!useModel) {
        if (!job.composerVersion)
            job.prompt = base;
        invalidate(job, false);
        await save(job);
        return;
    }
    const cfg = await settings();
    if (!cfg.model)
        throw new Error("请先配置提示词文字模型");
    const response = await fetch(cfg.baseUrl.replace(/\/$/, "") + "/chat/completions", {
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
                    content: "将用户提供的游戏角色外观描述整理为简洁的生图角色约束。只描述已提供的外观、衣服、配色与画风，不新增装备，不描述动作、方向、时间、背景或镜头。不添加用户未提供的事实。仅输出整理后的描述。",
                },
                {
                    role: "user",
                    content: job.description || "保持角色参考图的外观，不臆测细节。",
                },
            ],
            max_tokens: 1000,
        }),
        signal: AbortSignal.timeout(90000),
    });
    if (!response.ok)
        throw new Error(`提示词模型HTTP ${response.status}，未重试`);
    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim())
        throw new Error("文字模型未返回提示词");
    if (job.composerVersion)
        job.description = text.trim().slice(0, 6000);
    else
        job.prompt = base + `\n角色约束补充：${text.trim().slice(0, 6000)}`;
    invalidate(job, false);
    await save(job);
}
async function submit(job, confirmed, regenerate) {
    await validateMotionSubmission(job, false);
    if (!confirmed)
        throw new Error("请确认本次视频生成费用");
    if (job.video &&
        ["submitting", "unknown", "pending", "running"].includes(job.video.status))
        throw new Error("已有任务或提交结果未知，禁止重复付费提交");
    if (job.video && !regenerate)
        throw new Error("已有视频，请显式选择重新生成");
    if (!job.prepared || job.prepared.signature !== signature(job))
        throw new Error("请先准备并查看白模参考视频");
    const finalPrompt = await composeMotionPrompt(job);
    if (!finalPrompt.trim())
        throw new Error("请先查看并保存提示词");
    const config = motionVideoConfig(job, await loadConfig());
    assertVideoBackendReady(config);
    if (!config.minimaxApiKey.trim())
        throw new Error("请先在设置填写MiniMax API Key");
    const request = {
        prompt: finalPrompt,
        referenceImages: [
            await imageUri(job.id, job.character),
            await imageUri(job.id, job.directions),
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
    job.frames = [];
    job.validFrameRanges = undefined;
    job.redrawTargets = undefined;
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
    }
    catch (error) {
        job.video.status = "unknown";
        job.video.error =
            "提交未确认，可能已计费；不可自动重试。" +
                redact(String(error instanceof Error ? error.message : error), config.minimaxApiKey);
        await save(job);
        throw new Error(job.video.error);
    }
}
async function poll(job) {
    if (!job.video?.taskId || job.video.status === "ready")
        return;
    const config = await loadConfig();
    config.minimaxBaseUrl = job.video.endpoint;
    const result = await queryVideoTask(config, job.video.backend ?? "minimax", job.video.taskId, { model: job.video.model });
    if (result.status === "succeeded") {
        const relative = `videos/${token()}.mp4`;
        const bytes = await downloadVideoTask(config, job.video.backend ?? "minimax", result.url);
        await writeFile(path(job.id, relative), bytes);
        job.video.file = relative;
        try {
            const size = await probeSize(path(job.id, relative));
            if (Math.abs(size.width / size.height - 1.8) > 0.04)
                throw new Error("视频画幅不符合四列两行布局，请检查原视频；不会自动重新生成");
            job.video.duration = await probeDuration(path(job.id, relative));
            job.video.status = "ready";
        }
        catch (error) {
            job.video.status = "failed";
            job.video.error = String(error instanceof Error ? error.message : error);
        }
    }
    else if (result.status === "failed") {
        job.video.status = "failed";
        job.video.error = redact(result.error || "Video generation failed", config.minimaxApiKey);
    }
    else
        job.video.status = result.status;
    await save(job);
}
function schedulePoll(id) {
    if (disposed || pollTimers.has(id))
        return;
    const timer = setTimeout(async () => {
        pollTimers.delete(id);
        if (disposed)
            return;
        if (active.has(id)) {
            schedulePoll(id);
            return;
        }
        await exclusive(id, async (job) => {
            if (job.video?.taskId &&
                ["pending", "running", "succeeded"].includes(job.video.status))
                await poll(job);
        }).catch(() => { });
        const job = await readMotion(id).catch(() => undefined);
        if (job?.video?.taskId &&
            ["pending", "running", "succeeded"].includes(job.video.status))
            schedulePoll(id);
    }, 5000);
    timer.unref();
    pollTimers.set(id, timer);
}
/** Sample the video's actual background, not the synthetic 512px canvas border. */
function keyMotionCanvas(canvas, processing) {
    const cell = crop(canvas, 512, 40, 16, 432, 480);
    const keyed = keyGreen(cell, 432, 480, { ...DEFAULT_KEY_OPTIONS, ...processing, refineEdges: true }).rgba;
    const output = Buffer.alloc(512 * 512 * 4);
    blit(keyed, 432, 480, output, 512, 512, 40, 16);
    return output;
}
async function extract(job) {
    if (job.video?.status !== "ready" || !job.video.file)
        throw new Error("请先生成或导入视频");
    if (!job.rangesConfirmed)
        throw new Error("请观看视频、调整动作分段后确认抽帧范围");
    const duration = await probeDuration(path(job.id, job.video.file));
    const size = await probeSize(path(job.id, job.video.file));
    // Keep native per-cell detail up to the output content size. In particular,
    // 768P video must not be reduced to 480P before cutting its eight cells.
    const width = Math.min(1728, Math.max(4, Math.floor(size.width / 4) * 4));
    const height = Math.min(960, Math.max(2, Math.floor(size.height / 2) * 2));
    const cellWidth = width / 4, cellHeight = height / 2;
    const processing = motionProcessing(job.processing), color = processing.keyColor.match(/[a-f0-9]{2}/gi).map(v => parseInt(v, 16));
    const dir = `frames/${token()}`;
    await mkdir(path(job.id, dir), { recursive: true });
    const frames = [];
    for (const seg of job.ranges) {
        checkStopped(job.id);
        if (seg.end > duration + 0.001)
            throw new Error("抽帧范围超出实际视频时长");
        const n = seg.frameCount;
        // Limit raw-video memory even when a range contains hundreds of frames.
        // Keep one sampling origin: seeking anew at each batch changes fps rounding
        // when the source and target rates differ. Trim after fps, then scale only
        // the selected batch so its pixels match a single uninterrupted extraction.
        for (let batch = 0; batch < n; batch += 12) {
            checkStopped(job.id);
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
            for (let j = 0; j < batchCount; j++)
                for (let d = 0; d < 8; d++) {
                    const i = batch + j;
                    let raw = crop(stdout.subarray(j * width * height * 4, (j + 1) * width * height * 4), width, (d % 4) * cellWidth, Math.floor(d / 4) * cellHeight, cellWidth, cellHeight);
                    const inset = Math.round(processing.cropInset * cellWidth);
                    if (inset)
                        raw = resize(crop(raw, cellWidth, inset, inset, cellWidth - inset * 2, cellHeight - inset * 2), cellWidth - inset * 2, cellHeight - inset * 2, cellWidth, cellHeight);
                    const cell = resize(raw, cellWidth, cellHeight, 432, 480), canvas = Buffer.alloc(512 * 512 * 4);
                    for (let p = 0; p < canvas.length; p += 4) {
                        canvas[p] = color[0];
                        canvas[p + 1] = color[1];
                        canvas[p + 2] = color[2];
                        canvas[p + 3] = 255;
                    }
                    blit(cell, 432, 480, canvas, 512, 512, 40, 16);
                    const key = `${seg.action}-${MOTION_ORDER[d]}-${i}`, target = `${dir}/${key}-target.png`, keyed = `${dir}/${key}.png`;
                    await writeFile(path(job.id, target), encodePng(canvas, 512, 512));
                    await writeFile(path(job.id, keyed), encodePng(processing.key ? keyMotionCanvas(canvas, processing) : canvas, 512, 512));
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
    }
    job.frames = frames;
    job.validFrameRanges = undefined;
    job.redrawTargets = undefined;
    job.archive = undefined;
    job.localArtifacts = { raw: localRawSignature(job), keyed: processing.key ? localKeySignature(job, processing) : null, archive: null };
    await save(job);
}
async function rekey(job) {
    if (!job.frames.length)
        throw new Error("请先抽帧");
    const processing = motionProcessing(job.processing), dir = `frames/${token()}`;
    await mkdir(path(job.id, dir), { recursive: true });
    for (const frame of job.frames) {
        checkStopped(job.id);
        const decoded = await decodeToRgba(path(job.id, frame.target));
        const keyed = `${dir}/${frame.id}.png`;
        await writeFile(path(job.id, keyed), encodePng(keyMotionCanvas(decoded.rgba, processing), 512, 512));
        frame.keyed = keyed;
    }
    job.processing = { ...processing, key: true };
    job.archive = undefined;
    job.localArtifacts = { ...job.localArtifacts, keyed: localKeySignature(job, processing), archive: null };
    await save(job);
}
/** Read-only request plan, also used by execution. Sampled frames are ordered
 * within each action/direction; a group never mixes actions or directions. */
export function motionRedrawPlan(job, targets, scheme = "frame", regenerate = false) {
    if (!["frame", "sheet", "sheet8"].includes(scheme))
        throw new Error("Unknown redraw scheme");
    if (!targets?.length || targets.length > 17280 || new Set(targets).size !== targets.length)
        throw new Error("请选择需要重绘的帧");
    const frames = new Map(job.frames.map(f => [f.id, f]));
    const selected = targets.map(id => frames.get(id));
    if (selected.some(f => !f))
        throw new Error("Unknown frame selection");
    const validSelected = selected.filter(frame => motionFrameIsValid(job, frame));
    if (!validSelected.length)
        throw new Error("请选择至少一张有效帧");
    const pending = validSelected.filter(f => regenerate || f.redraw?.status !== "ready" || !f.redraw.file);
    const buckets = new Map();
    for (const frame of pending) {
        const key = JSON.stringify([frame.action, frame.direction]);
        if (!buckets.has(key))
            buckets.set(key, []);
        buckets.get(key).push(frame);
    }
    const groups = [];
    for (const values of buckets.values()) {
        values.sort((a, b) => a.index - b.index);
        let group = [];
        for (const frame of values) {
            if (group.length === (scheme === "sheet8" ? 8 : scheme === "sheet" ? 4 : 1)) {
                groups.push(group.map(f => f.id));
                group = [];
            }
            group.push(frame);
        }
        if (group.length)
            groups.push(group.map(f => f.id));
    }
    return { scheme, targets: validSelected.map(frame => frame.id), selectionCount: validSelected.length, frameCount: pending.length, requestCount: groups.length, groups,
        unknownCount: regenerate ? 0 : pending.filter(f => !!f.redraw?.status).length };
}
function redrawMask(src) {
    let alpha = Uint8Array.from({ length: 512 * 512 }, (_, i) => src[i * 4 + 3] > 127 ? 1 : 0);
    for (let step = 0; step < 3; step++) {
        const out = new Uint8Array(alpha.length);
        for (let y = 1; y < 511; y++)
            for (let x = 1; x < 511; x++) {
                const p = y * 512 + x;
                out[p] = alpha[p] & alpha[p - 1] & alpha[p + 1] & alpha[p - 512] & alpha[p + 512];
            }
        alpha = out;
    }
    const mask = Buffer.alloc(512 * 512 * 4, 255);
    for (let p = 0; p < alpha.length; p++)
        mask[p * 4 + 3] = alpha[p] ? 0 : 255;
    return mask;
}
async function redraw(job, targets, confirmed, regenerate, scheme = "frame") {
    if (!confirmed)
        throw new Error("请确认高清重绘的图片调用数量和费用");
    const plan = motionRedrawPlan(job, targets, scheme, regenerate);
    if (plan.unknownCount)
        throw new Error("存在结果未知的图片请求，请检查后显式重新生成选中帧");
    job.redrawTargets = [...plan.targets];
    if (!plan.requestCount) {
        await save(job);
        return;
    }
    const config = await loadConfig();
    if (config.imageProvider !== "custom" || config.customProtocol !== "openai")
        throw new Error("高清重绘需要自定义OpenAI兼容images/edits后端，请先在设置配置");
    if (!job.character)
        throw new Error("请上传角色细节图");
    const dir = `redraw/${token()}`;
    await mkdir(path(job.id, dir), { recursive: true });
    const processing = motionProcessing(job.processing), frames = new Map(job.frames.map(f => [f.id, f]));
    const directionRefs = new Map();
    if (job.directions) {
        const decoded = await decodeToRgba(path(job.id, job.directions));
        const width = Math.floor(decoded.width / 4), height = Math.floor(decoded.height / 2);
        for (const direction of new Set(plan.groups.map(ids => frames.get(ids[0]).direction))) {
            const d = MOTION_ORDER.indexOf(direction), file = `${dir}/${direction}-reference.png`;
            await writeFile(path(job.id, file), encodePng(crop(decoded.rgba, decoded.width, (d % 4) * width, Math.floor(d / 4) * height, width, height), width, height));
            directionRefs.set(direction, file);
        }
    }
    for (let groupIndex = 0; groupIndex < plan.groups.length; groupIndex++) {
        checkStopped(job.id);
        const group = plan.groups[groupIndex].map(id => frames.get(id)), first = group[0], batchId = token();
        const columns = group.length > 4 ? 4 : group.length > 1 ? 2 : 1, rows = group.length > 1 ? 2 : 1;
        const width = columns * 1024, height = rows * 1024;
        const rgba = Buffer.alloc(width * height * 4), mask = Buffer.alloc(rgba.length, 255);
        const background = processing.keyColor.match(/[a-f0-9]{2}/gi).map(v => parseInt(v, 16));
        rgba.fill(Buffer.from([...background, 255]));
        const originals = [];
        job.progress = `${groupIndex + 1}/${plan.requestCount} · ${first.id}`;
        await save(job);
        for (let i = 0; i < group.length; i++) {
            checkStopped(job.id);
            const frame = group[i], decoded = await decodeToRgba(path(job.id, frame.target)), src = await decodeToRgba(path(job.id, frame.keyed));
            originals.push(src.rgba);
            blit(resize(decoded.rgba, decoded.width, decoded.height, 1024, 1024), 1024, 1024, rgba, width, height, (i % columns) * 1024, Math.floor(i / columns) * 1024);
            // Masks require copying transparent interior pixels too; blit intentionally
            // skips them and therefore cannot be used here.
            const cellMask = resize(redrawMask(src.rgba), 512, 512, 1024, 1024);
            for (let y = 0; y < 1024; y++)
                cellMask.copy(mask, ((Math.floor(i / columns) * 1024 + y) * width + (i % columns) * 1024) * 4, y * 1024 * 4, (y + 1) * 1024 * 4);
        }
        const name = group.length > 1 ? batchId : first.id;
        const prompt = motionRedrawPrompt({ direction: first.direction, description: job.description, instructions: job.prompt, keyColor: processing.keyColor, hasDirection: directionRefs.has(first.direction), frameCount: group.length });
        const promptFile = `${dir}/${name}-prompt.txt`, input = `${dir}/${name}-input.png`, maskFile = `${dir}/${name}-mask.png`;
        await writeFile(path(job.id, promptFile), prompt);
        await writeFile(path(job.id, input), encodePng(rgba, width, height));
        await writeFile(path(job.id, maskFile), encodePng(mask, width, height));
        // Persist ONE shared attempt across every frame in this image request.
        for (const frame of group)
            frame.redraw = { status: "attempted", prompt: promptFile, scheme, batchId };
        job.archive = undefined;
        job.archiveKind = undefined;
        await save(job);
        try {
            const result = await generateImageWithProvider({ prompt,
                images: [await imageUri(job.id, input), await imageUri(job.id, job.character), ...(directionRefs.has(first.direction) ? [await imageUri(job.id, directionRefs.get(first.direction))] : [])],
                mask: await imageUri(job.id, maskFile), quality: "high", size: `${width}x${height}`, watermark: false });
            const raw = `${dir}/${name}-raw.${result.ext}`;
            await writeFile(path(job.id, raw), result.bytes);
            for (const frame of group)
                frame.redraw.raw = raw;
            await save(job);
            if (group.length > 1) {
                const size = await probeSize(path(job.id, raw));
                if (Math.abs(size.width * rows - size.height * columns) > Math.max(columns, rows) || size.width < columns * 512 || size.height < rows * 512)
                    throw new Error("分组重绘回图尺寸或布局不匹配，请检查原始回图");
            }
            const outputWidth = columns * 512, outputHeight = rows * 512;
            const { stdout } = await runFfmpeg(["-i", path(job.id, raw), "-vf", `scale=${outputWidth}:${outputHeight}:flags=lanczos,format=rgba`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
            if (stdout.length !== outputWidth * outputHeight * 4)
                throw new Error("Invalid generated image");
            const completed = [];
            // Validate every cell before committing any of this shared request.
            const cells = group.map((_, i) => crop(stdout, outputWidth, (i % columns) * 512, Math.floor(i / columns) * 512, 512, 512));
            const processed = processMotionEdits(cells, originals, processing);
            for (let i = 0; i < group.length; i++) {
                const { rgba, scale, translation, background } = processed[i];
                const file = `${dir}/${group[i].id}.png`;
                await writeFile(path(job.id, file), encodePng(rgba, 512, 512));
                completed.push({ status: "ready", file, raw, prompt: promptFile, translation, scale, background, scheme, batchId });
            }
            group.forEach((frame, i) => { frame.redraw = completed[i]; });
            await save(job);
        }
        catch (error) {
            const message = "请求可能已计费；未自动重试。" + redact(String(error instanceof Error ? error.message : error), config.customApiKey);
            for (const frame of group)
                frame.redraw = { ...frame.redraw, status: "unknown", error: message };
            await save(job);
            throw new Error(message);
        }
    }
}
export function motionRedrawFrames(job) {
    if (!job.redrawTargets?.length)
        return motionValidFrames(job);
    const targets = new Set(job.redrawTargets), frames = job.frames.filter(f => targets.has(f.id));
    if (frames.length !== targets.size)
        throw new Error("重绘选帧已失效，请重新选择");
    return frames.filter(f => motionFrameIsValid(job, f));
}
async function exportJob(job, useRedraw) {
    if (!job.frames.length)
        throw new Error("请先抽帧");
    const selectedFrames = useRedraw ? motionRedrawFrames(job) : job.frames;
    if (useRedraw && selectedFrames.some((f) => f.redraw?.status !== "ready" || !f.redraw.file))
        throw new Error("高清版本还有未完成帧，请补齐或选择原视频帧导出");
    const processing = motionProcessing(job.processing), width = processing.cellWidth, height = processing.cellHeight;
    const sourceSize = await probeSize(path(job.id, job.video.file));
    const entries = [], metadata = {
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
        const pages = [];
        const byDirection = new Map(MOTION_ORDER.map(direction => [direction, selectedFrames.filter(f => f.action === seg.action && f.direction === direction).sort((a, b) => a.index - b.index)]));
        const directions = useRedraw ? MOTION_ORDER.filter(d => byDirection.get(d).length) : MOTION_ORDER;
        if (!directions.length)
            continue;
        const frameCount = useRedraw ? Math.max(...directions.map(d => byDirection.get(d).length)) : seg.frameCount;
        for (let firstRow = 0; firstRow < directions.length; firstRow += rows)
            for (let firstFrame = 0; firstFrame < frameCount; firstFrame += columns) {
                checkStopped(job.id);
                const rowOrder = directions.slice(firstRow, firstRow + rows), count = Math.min(columns, frameCount - firstFrame);
                const sheet = Buffer.alloc(width * count * height * rowOrder.length * 4);
                for (const direction of rowOrder)
                    for (let index = firstFrame; index < firstFrame + count; index++) {
                        const frame = byDirection.get(direction)[index];
                        if (!frame) {
                            if (useRedraw)
                                continue;
                            throw new Error("序列帧不完整，请重新抽帧后导出。");
                        }
                        if (!useRedraw && frame.index !== index)
                            throw new Error("序列帧不完整，请重新抽帧后导出。");
                        const selected = useRedraw ? frame.redraw.file : processing.key ? frame.keyed : frame.target;
                        const decoded = await decodeToRgba(path(job.id, selected));
                        const scaled = resize(decoded.rgba, decoded.width, decoded.height, width, height);
                        const bytes = encodePng(scaled, width, height);
                        entries.push({
                            path: `${seg.action}/${frame.direction}/f${String(index).padStart(2, "0")}.png`,
                            data: bytes,
                        });
                        blit(scaled, width, height, sheet, width * count, height * rowOrder.length, (index - firstFrame) * width, rowOrder.indexOf(frame.direction) * height);
                    }
                const singlePage = frameCount <= columns && rows >= directions.length;
                const png = encodePng(sheet, width * count, height * rowOrder.length), name = singlePage ? `${seg.action}-sheet.png` : `${seg.action}-sheet-${pages.length + 1}.png`;
                await writeFile(path(job.id, `${dir}/${name}`), png);
                entries.push({ path: name, data: png });
                pages.push({ file: name, firstFrame, frameCount: count, rowOrder, columns: count, rows: rowOrder.length });
            }
        metadata.actions.push({
            ...seg,
            frameCount,
            frameDurationMs: ((seg.end - seg.start) * 1000) / frameCount,
            fps: frameCount / (seg.end - seg.start),
            ...(useRedraw ? { sampled: true, sourceFrameCount: seg.frameCount, directionFrames: Object.fromEntries(directions.map(d => { const frames = byDirection.get(d); return [d, { frameCount: frames.length, fps: frames.length / (seg.end - seg.start), sourceIndices: frames.map(f => f.index), sourceTimes: frames.map(f => f.time) }]; })) } : {}),
            ...(pages.length === 1 ? { sheet: pages[0].file } : {}),
            sheets: pages,
            rows: directions.length,
            columns: frameCount,
            loopVerified: false,
        });
    }
    entries.push({
        path: "animation.json",
        data: Buffer.from(JSON.stringify(metadata, null, 2)),
    }, { path: "video-prompt.txt", data: Buffer.from(await composeMotionPrompt(job)) }, {
        path: "source-license.txt",
        data: await readFile(join(TEMPLATE_DIR, "LICENSE.txt")),
    });
    await writeFile(path(job.id, `${dir}/animation.json`), Buffer.from(JSON.stringify(metadata, null, 2)));
    job.archive = `${dir}/sprites.zip`;
    await writeFile(path(job.id, job.archive), zipEntries(entries));
    job.archiveKind = useRedraw ? "redraw" : processing.key ? "keyed" : "raw";
    job.localArtifacts = { ...job.localArtifacts, archive: useRedraw ? null : localArchiveSignature(job, processing) };
    await save(job);
}
export async function runMotionStep(id, input) {
    if (!isMotionId(id))
        throw new Error("Invalid motion job ID");
    if (input.step === "cancel") {
        if (active.has(id))
            cancelled.add(id);
        return { started: true };
    }
    if (![
        "prepare",
        "prompt",
        "video",
        "poll",
        "extract",
        "keyed",
        "redraw",
        "export",
    ].includes(input.step))
        throw new Error("Unknown workflow step");
    if (disposed || active.has(id))
        throw new Error("任务正在处理，请勿重复点击");
    // Acquire the same lock before starting the background operation, including
    // before the first file read. Repeated button/RPC clicks cannot queue bills.
    active.add(id);
    cancelled.delete(id);
    const run = async () => {
        let job;
        try {
            job = await readMotion(id);
            job.operation = input.step;
            job.error = undefined;
            job.progress = "";
            rememberLocalArtifacts(job);
            if (["extract", "keyed", "export"].includes(input.step)) {
                job.localArtifacts ||= {};
                job.localArtifacts.archive = null;
                if (input.step === "extract")
                    job.localArtifacts.raw = null;
                if (input.step !== "export")
                    job.localArtifacts.keyed = null;
            }
            await save(job);
            if (input.step === "prepare") {
                assertEditable(job);
                await prepare(job);
            }
            else if (input.step === "prompt")
                await buildPrompt(job, input.useModel === true);
            else if (input.step === "video")
                await submit(job, input.confirmed === true, input.regenerate === true);
            else if (input.step === "poll")
                await poll(job);
            else if (input.step === "extract")
                await extract(job);
            else if (input.step === "keyed")
                await rekey(job);
            else if (input.step === "redraw")
                await redraw(job, input.targets, input.confirmed === true, input.regenerate === true, input.scheme || "frame");
            else
                await exportJob(job, input.useRedraw === true);
        }
        catch (error) {
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
                    if (key)
                        message = redact(message, key);
                }
                job.error = message;
            }
        }
        finally {
            try {
                if (job) {
                    job.operation = undefined;
                    job.progress = undefined;
                    await save(job);
                }
            }
            finally {
                active.delete(id);
                cancelled.delete(id);
                if (job?.video?.taskId &&
                    ["pending", "running"].includes(job.video.status))
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
export function activateMotion() {
    disposed = false;
}
export function disposeMotion() {
    disposed = true;
    for (const timer of pollTimers.values())
        clearTimeout(timer);
    pollTimers.clear();
}
export async function resumeMotionJobs() {
    for (const item of await listMotionJobs(true)) {
        if (active.has(item.id))
            continue;
        await exclusive(item.id, async (job) => {
            if (job.operation) {
                job.error = "上次本地处理被中断；已完成产物保留，不自动重新计费。";
                job.operation = undefined;
            }
            if (job.video?.status === "submitting")
                job.video.status = "unknown";
            await save(job);
            if (job.video?.taskId &&
                ["pending", "running"].includes(job.video.status))
                await poll(job).catch(() => { });
            if (job.video?.taskId &&
                ["pending", "running"].includes(job.video.status))
                schedulePoll(job.id);
        });
    }
}

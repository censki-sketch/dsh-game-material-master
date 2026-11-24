/** Durable conversation rounds around the existing animation pipelines.
 * Each round owns a child job; local processing never re-submits paid work.
 */
import { cp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, basename, dirname, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { dataRoot, loadConfig } from "./config.js";
import { readJson, writeJsonAtomic } from "./jsonio.js";
import * as motion from "./motiongen.js";
import * as seq from "./seqgen.js";
import { assertVideoSubmissionConfirmed } from "./videogen.js";

type Module = "sprite" | "sequence";
type Version = { id: string; kind: string; files: string[]; createdAt: number; number?: number; frames?: any[]; ranges?: any[]; sourceKind?: string; elapsedMs?: number };
type RoundTiming = { step: string; startedAt: number; endedAt?: number; status: "running" | "ready" | "error" | "stopped"; details?: motion.MotionPhaseTiming[] };
type Round = { id: string; requestId: string; childId: string; createdAt: number; prompt: string; request?: any; automatic: boolean; localOnly: boolean; stage: string; status: string; error?: string; versions: Version[]; versionCounters?: Record<string, number>; localSteps?: string[]; image1k?: boolean; legacy?: boolean; timings?: RoundTiming[] };
type Conversation = { module: Module; jobId: string; rounds: Round[] };
const root = () => join(dataRoot(), "workflow-conversations");
const key = (module: Module, jobId: string) => {
  if (!(module === "sprite" ? motion.isMotionId(jobId) : module === "sequence" && seq.isValidSequenceJobId(jobId))) throw new Error("Invalid workflow ID");
  return module + "-" + jobId;
};
const location = (module: Module, id: string, file: string) => module === "sprite" ? motion.motionAssetPath(id, file) : seq.sequenceAssetPath(id, file);
const readJob = async (module: Module, id: string): Promise<any> => {
  const job = module === "sprite" ? await motion.readMotion(id) : await seq.readSequenceJob(id);
  if (!job) throw new Error("Workflow job not found");
  return job;
};
const writeJob = (module: Module, job: any) => writeJsonAtomic(location(module, job.id, "job.json"), job);
function numberVersions(r: Round) {
  r.versionCounters ||= {};
  const counts: Record<string, number> = {};
  for (const v of r.versions) {
    counts[v.kind] = Math.max(counts[v.kind] || 0, v.number || 0) + (v.number ? 0 : 1);
    v.number ||= counts[v.kind];
    r.versionCounters[v.kind] = Math.max(r.versionCounters[v.kind] || 0, v.number);
  }
}
/** Remove only quarantined snapshot directories; never the pipeline's sources or videos. */
async function cleanupDeletedVersions(module: Module, childId: string) {
  const base = await realpath(dirname(location(module, childId, "job.json")));
  const dir = location(module, childId, "out/versions");
  const actual = await realpath(dir).catch(() => "");
  if (actual !== join(base, "out", "versions")) return;
  for (const name of await readdir(dir)) {
    if (!/^\.deleted-[a-f0-9-]{36}-[a-f0-9-]{36}$/.test(name)) continue;
    const target = join(dir, name), resolved = await realpath(target).catch(() => "");
    if (resolved !== join(actual, name) || !resolved.startsWith(base + sep)) continue;
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}
async function read(module: Module, jobId: string): Promise<Conversation> {
  return await readJson<Conversation>(join(root(), key(module, jobId) + ".json")) || { module, jobId, rounds: [] };
}
async function save(c: Conversation) {
  await mkdir(root(), { recursive: true });
  await writeJsonAtomic(join(root(), key(c.module, c.jobId) + ".json"), c);
}
const locks = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let disposed = false;
const running = (r: Round) => r.status === "running";
function beginTiming(r: Round, step: string) {
  (r.timings ||= []).push({ step, startedAt: Date.now(), status: "running" });
}
function finishTiming(r: Round, status: Exclude<RoundTiming["status"], "running">, job?: any, snapshotStartedAt?: number, interrupted = false) {
  const timing = r.timings?.at(-1);
  if (timing?.status !== "running") return;
  timing.status = status;
  if (!interrupted) timing.endedAt = Math.max(timing.startedAt, Date.now());
  const details: motion.MotionPhaseTiming[] = job?.processingTiming?.operation === timing.step
    ? (job.processingTiming.completed || []).filter(detail => detail.startedAt >= timing.startedAt)
    : [];
  if (snapshotStartedAt !== undefined && timing.endedAt !== undefined) details.push({ step: "snapshot", startedAt: snapshotStartedAt, endedAt: timing.endedAt });
  if (details.length) timing.details = details;
}
const hasLegacyResults = (module: Module, job: any) => module === "sprite"
  ? job.frames?.length > 0 || !!job.video?.file && (!job.composerVersion || job.video.model !== "local-import")
  : !!job.video?.file || job.frames?.files?.length > 0;
async function nativeBusy(module: Module, id: string) {
  return module === "sprite" ? (await motion.motionView(id)).active : seq.listSequenceTasks(id).length > 0;
}
function schedule(c: Conversation) {
  const id = key(c.module, c.jobId);
  if (disposed || timers.has(id)) return;
  const timer = setTimeout(() => {
    timers.delete(id);
    void advance(c.module, c.jobId).catch(() => {});
  }, 1500);
  timer.unref?.(); timers.set(id, timer);
}
async function clone(module: Module, parent: any, includeResults = false): Promise<any> {
  const child: any = module === "sprite" ? await motion.createMotionJob(parent.name) : await seq.createSequenceJob(parent.name);
  const id = child.id;
  const job = { ...structuredClone(parent), id, workflowParent: parent.id, updatedAt: Date.now() };
  job.error = undefined; job.operation = undefined; job.processingTiming = undefined;
  await writeJob(module, { ...child, workflowParent: parent.id });
  for (const dir of includeResults ? (module === "sprite" ? [...motion.MOTION_DIRS] : ["refs", "video-refs", "videos", "frames", "keyed", "out"]) : (module === "sprite" ? ["refs", "prepared", "videos"] : ["refs", "video-refs"])) {
    await cp(location(module, parent.id, dir), location(module, id, dir), { recursive: true, force: true });
  }
  if (!includeResults) {
    if (module === "sprite") { job.video = undefined; job.frames = []; job.validFrameRanges = undefined; job.redrawTargets = undefined; job.localUpscale = undefined; job.archive = undefined; job.error = undefined; job.operation = undefined; job.rangesConfirmed = false; }
    else { job.video = { status: "empty" }; job.frames = { status: "empty", count: job.settings.frameCount, files: [], keyed: [] }; job.sheet = { status: "empty" }; job.log = []; }
  }
  await writeJob(module, job);
  return job;
}
async function snapshot(c: Conversation, r: Round, kind: string): Promise<void> {
  const job = await readJob(c.module, r.childId);
  if (c.module === "sprite" && kind === "keyed" && !motion.motionProcessing(job.processing).key) return;
  let frameMetadata = job.frames;
  if (c.module === "sprite" && kind === "redraw") {
    frameMetadata = motion.motionRedrawFrames(job).filter(f => f.redraw?.status === "ready" && f.redraw.file);
  } else if (c.module === "sprite" && kind === "upscale") {
    frameMetadata = motion.motionValidFrames(job).filter(f => Object.hasOwn(job.localUpscale?.files || {}, f.id));
    if (!frameMetadata.length) throw new Error("本地高清没有可预览的帧。");
  }
  const source: string[] = kind === "video" ? [job.video?.file].filter(Boolean) : c.module === "sprite"
    ? kind === "redraw" ? frameMetadata.map(f => f.redraw.file) : kind === "upscale" ? frameMetadata.map(f => job.localUpscale.files[f.id]) : kind === "export" ? [job.archive].filter(Boolean) : job.frames.map(f => kind === "raw" ? f.target : f.keyed)
    : kind === "raw" ? job.frames.files : kind === "keyed" ? job.frames.keyed : [job.sheet.file].filter(Boolean);
  if (!source.length) return;
  // Preserve completed frames from partial batches without duplicating a version
  // when a later request fails before producing any additional output.
  if (["redraw", "upscale"].includes(kind) && JSON.stringify(r.versions.filter(v => v.kind === kind).at(-1)?.frames?.map(f => f.sourceFile)) === JSON.stringify(source)) return;
  const id = randomUUID(), files: string[] = [];
  await mkdir(location(c.module, r.childId, "out/versions/" + id), { recursive: true });
  for (let i = 0; i < source.length; i++) {
    const file = `out/versions/${id}/${i}-${basename(source[i])}`;
    await writeFile(location(c.module, r.childId, file), await readFile(location(c.module, r.childId, source[i])));
    files.push(file);
  }
  numberVersions(r);
  const number = (r.versionCounters![kind] || 0) + 1;
  r.versionCounters![kind] = number;
  const version: Version = { id, kind, number, files, createdAt: Date.now() };
  if (c.module === "sprite") {
    if (kind === "export" && job.archiveKind) version.sourceKind = job.archiveKind;
    if (kind === "upscale") {
      version.elapsedMs = job.localUpscale.elapsedMs;
      version.sourceKind = job.localUpscale.sourceKind;
    }
    if (kind !== "export" && kind !== "video") {
      const sampled = kind === "redraw" || kind === "upscale" && job.localUpscale.sourceKind === "redraw";
      version.ranges = job.ranges.map(range => sampled ? { ...range, sampled: true } : { ...range });
      version.frames = frameMetadata.map((frame, i) => ({
        id: frame.id, action: frame.action, direction: frame.direction, index: frame.index, time: frame.time, file: files[i],
        ...(["redraw", "upscale"].includes(kind) ? { sourceFile: source[i] } : {}),
        ...(kind === "redraw" && frame.redraw.image1k ? { image1k: true } : {}),
      }));
    }
  }
  r.versions.push(version);
}
async function runLocal(c: Conversation, r: Round, step: string, extra: any = {}) {
  r.stage = step; r.status = "running"; r.error = undefined;
  beginTiming(r, step);
  await save(c);
  if (c.module === "sprite") {
    if (step === "extract") await motion.saveMotionJob(r.childId, { ranges: extra.ranges || (await motion.readMotion(r.childId)).ranges, rangesConfirmed: true });
    await motion.runMotionStep(r.childId, { ...extra, step });
  } else {
    if (step === "extract") await seq.extractSequenceFrames(r.childId);
    else if (step === "keyed") {
      await seq.keySequenceFrames(r.childId); await seq.composeSequenceSheet(r.childId);
      const job = await readJob(c.module, r.childId);
      job.frames.status = "ready"; job.frames.error = undefined;
      await writeJob(c.module, job);
    }
    else if (step === "sheet") await seq.composeSequenceSheet(r.childId);
    else throw new Error("Unsupported local step");
  }
}
async function finishLocal(c: Conversation, r: Round, job?: any) {
  const snapshotStartedAt = Date.now(), versionsBefore = r.versions.length;
  const finish = () => finishTiming(r, "ready", job, r.versions.length > versionsBefore ? snapshotStartedAt : undefined);
  if (r.stage === "extract") {
    await snapshot(c, r, "raw"); await snapshot(c, r, "keyed");
    if (c.module === "sequence") await snapshot(c, r, "sheet");
    finish();
    if (!r.localSteps && r.automatic && c.module === "sprite" && motion.motionProcessing((job || await readJob(c.module, r.childId)).processing).sheet) { await runLocal(c, r, "export"); return; }
  } else {
    await snapshot(c, r, r.stage);
    if (c.module === "sequence" && r.stage === "keyed") await snapshot(c, r, "sheet");
    finish();
    if (c.module === "sprite" && r.stage === "redraw" && !r.image1k) {
      // Export exactly the completed selection, never fill an HD package with
      // untouched video frames or generate extra paid frames automatically.
      const selected = motion.motionRedrawFrames(job || await readJob(c.module, r.childId));
      if (selected.length && selected.every(f => f.redraw?.status === "ready" && f.redraw.file)) {
        await runLocal(c, r, "export", { useRedraw: true }); return;
      }
    }
  }
  if (r.localSteps?.length) { const step = r.localSteps.shift()!; await runLocal(c, r, step); return; }
  r.localSteps = undefined; r.stage = "done"; r.status = "ready";
}
async function planRoundProcessing(r: Round, input: any) {
  const job = await motion.readMotion(r.childId);
  const plan = await motion.motionLocalProcessingPlan(job, input);
  const imported = r.localOnly && !r.legacy && (job.inputMode === "video" || job.video?.model === "local-import");
  if (!imported || input.forceLocal === "export") return plan;
  // An imported clip is inspected as frame versions before packaging.
  plan.steps = plan.steps.filter(step => step !== "export");
  if (input.autoUpscale !== true || input.forceLocal) return plan;
  if (!plan.processing.key) throw new Error("请先开启去除背景，再执行本地清晰化。");
  if (!motion.motionLocalUpscaleAvailable()) throw new Error("尚未配置本地清晰化工具。");

  const files = job.localUpscale?.files;
  const frames = motion.motionValidFrames(job);
  const alreadyUpscaled = job.localUpscale?.sourceKind === "keyed" && files &&
    Object.keys(files).length === frames.length && frames.every(frame => Object.hasOwn(files, frame.id)) &&
    r.versions.some(version => version.kind === "upscale" && version.frames?.length === frames.length &&
      version.frames.every(frame => files[frame.id] === frame.sourceFile));
  if (plan.steps.length || !alreadyUpscaled) plan.steps.push("upscale");
  return plan;
}
async function advance(module: Module, jobId: string) {
  const id = key(module, jobId);
  if (disposed || locks.has(id)) return;
  locks.add(id);
  let c: Conversation | undefined, r: Round | undefined, job: any;
  try {
    c = await read(module, jobId); r = c.rounds.find(running);
    if (!r) return;
    if (await nativeBusy(module, r.childId)) return;
    job = await readJob(module, r.childId);
    if (module === "sprite" && r.stage === "upscale" && job.localUpscaleCancelled) {
      finishTiming(r, "stopped", job);
      r.stage = "done"; r.status = "stopped"; r.error = undefined; r.localSteps = undefined;
      return;
    }
    if (job.error || job.frames?.status === "error" || job.video?.status === "error" || ["failed", "unknown"].includes(job.video?.status)) throw new Error(job.error || job.frames?.error || job.video?.error || "视频结果未知，请查询已有任务，不要重复提交。");
    if (r.stage === "queued") {
      if (r.localOnly) { beginTiming(r, "import"); if (!job.video?.file) throw new Error("请先导入视频"); r.stage = "video"; }
      else if (module === "sprite" && !motion.motionPreparedCurrent(job)) { await runLocal(c, r, "prepare"); return; }
      else r.stage = "submit";
    }
    if (r.stage === "prepare") { finishTiming(r, "ready", job); r.stage = "submit"; }
    if (r.stage === "submit") {
      // Persist the attempt BEFORE the paid operation. Recovery never replays this stage.
      r.stage = "video"; beginTiming(r, "video"); await save(c);
      if (module === "sprite") await motion.runMotionStep(r.childId, { step: "video", confirmed: true });
      else { const result = seq.startSequenceVideo(r.childId); if (!result.started) throw new Error(result.reason); }
      return;
    }
    if (r.stage === "video") {
      if (job.video?.status !== "ready") {
        if (module === "sequence" && job.video?.taskId) seq.ensureSequencePoller(r.childId);
        else if (module === "sprite" && job.video?.taskId) await motion.runMotionStep(r.childId, { step: "poll" });
        return;
      }
      const snapshotStartedAt = Date.now(), versionsBefore = r.versions.length;
      if (!r.versions.some(v => v.kind === "video")) await snapshot(c, r, "video");
      finishTiming(r, "ready", job, r.versions.length > versionsBefore ? snapshotStartedAt : undefined);
      if (r.request && module === "sequence") r.request.settings = structuredClone(job.settings);
      if (r.localOnly && module === "sprite") { r.status = "ready"; r.stage = "awaiting-ranges"; }
      else if (r.automatic && (module !== "sprite" || motion.motionProcessing(job.processing).extract)) { await runLocal(c, r, "extract"); if (module === "sequence") await finishLocal(c, r); }
      else { r.status = "ready"; r.stage = "done"; }
    } else await finishLocal(c, r, job);
  } catch (error) {
    if (c && r && module === "sprite" && r.stage === "redraw") await snapshot(c, r, "redraw");
    if (r) { finishTiming(r, "error", job); r.status = "error"; r.localSteps = undefined; r.error = error instanceof Error ? error.message : String(error); }
  } finally {
    try { if (c) { await save(c); if (c.rounds.some(running)) schedule(c); } }
    finally { locks.delete(id); }
  }
}
export async function submitWorkflowRound(input: { module: Module; jobId: string; requestId: string; automatic: boolean; confirmed?: boolean; localOnly?: boolean; expectedVideoModel?: string }): Promise<any> {
  const id = key(input.module, input.jobId);
  if (disposed || locks.has(id)) throw new Error("任务正在处理");
  locks.add(id);
  try {
    const c = await read(input.module, input.jobId);
    const existing = c.rounds.find(r => r.requestId === input.requestId);
    if (existing) return { roundId: existing.id, childId: existing.childId };
    if (c.rounds.some(running)) throw new Error("请等待当前轮次完成");
    const parent = await readJob(c.module, c.jobId);
    if (parent.workflowParent || await nativeBusy(c.module, c.jobId) || ["running", "pending", "submitting"].includes(parent.video?.status)) throw new Error("请等待当前任务完成");
    if (!input.localOnly && !parent.prompt?.trim()) throw new Error("请先填写提示词。");
    const config = await loadConfig();
    if (config.hiddenModules.includes(c.module)) throw new Error("Module disabled");
    let videoGeneration;
    if (!input.localOnly) {
      if (c.module === "sprite") {
        videoGeneration = motion.motionVideoSelection(parent, config);
        if (input.expectedVideoModel && input.expectedVideoModel !== videoGeneration.model) throw new Error("视频模型已变更，请重新确认后生成");
        assertVideoSubmissionConfirmed(motion.motionVideoConfig(parent, config), input.confirmed);
      } else assertVideoSubmissionConfirmed(config, input.confirmed);
    }
    if (c.module === "sprite") await motion.validateMotionSubmission(parent, input.localOnly === true);
    if (c.module === "sequence" && !input.localOnly && (parent.mode === "frames" ? !parent.refs.firstFrame : !parent.refs.referenceImages.length && !parent.refs.referenceVideos.length)) throw new Error("请先添加参考素材");
    if (input.localOnly && !(parent.sourceVideo?.file || parent.video?.file)) throw new Error("请先导入视频");
    if (!input.localOnly && !c.rounds.length && hasLegacyResults(c.module, parent)) {
      const old = await clone(c.module, parent, true);
      const legacy: Round = { id: randomUUID(), requestId: "legacy", childId: old.id, createdAt: parent.createdAt || parent.updatedAt, prompt: "", automatic: false, localOnly: true, stage: "done", status: "ready", legacy: true, versions: [] };
      c.rounds.push(legacy); await snapshot(c, legacy, "raw"); await snapshot(c, legacy, "keyed"); if (c.module === "sequence") await snapshot(c, legacy, "sheet");
    }
    const child = await clone(c.module, parent, input.localOnly === true);
    if (c.module === "sprite") child.reviewMode = input.automatic ? "auto" : "manual";
    if (c.module === "sprite" && videoGeneration) { child.videoGeneration = videoGeneration; await writeJob(c.module, child); }
    if (c.module === "sprite" && input.localOnly) {
      child.video = { status: "ready", model: "local-import", endpoint: "", ...(child.sourceVideo || { file: child.video.file, duration: child.video.duration }) };
      child.inputMode = "video";
      child.videoRange = motion.motionVideoRange(child);
      child.ranges = [{ action: "video", ...child.videoRange }];
      child.rangesConfirmed = false;
      child.frames = []; child.redrawTargets = undefined; child.localUpscale = undefined; child.archive = undefined; await writeJob(c.module, child);
    }
    const request = c.module === "sprite" ? { prompt: input.localOnly ? "" : child.prompt, finalPrompt: input.localOnly ? "" : await motion.composeMotionPrompt(child), composerVersion: child.composerVersion,
      promptTemplate: child.promptTemplate, processing: motion.motionProcessing(child.processing), inputMode: input.localOnly ? "video" : "generate", sourceVideo: child.sourceVideo,
      reviewMode: child.reviewMode, videoModel: child.videoModel || videoGeneration?.model, videoGeneration,
      videoRange: child.videoRange, description: child.description, segments: input.localOnly ? [] : child.segments, ranges: child.ranges, rangesConfirmed: child.rangesConfirmed, character: child.character, directions: child.directions } : { prompt: child.prompt, suffix: child.suffix, refs: child.refs, settings: child.settings, keying: child.keying, mode: child.mode };
    const r: Round = { id: randomUUID(), requestId: input.requestId, childId: child.id, createdAt: Date.now(), prompt: request.prompt, request: structuredClone(request), automatic: input.automatic, localOnly: input.localOnly === true, stage: "queued", status: "running", versions: [] };
    c.rounds.push(r); await save(c);
    // Consume only the submitted prompt; drafts and all input files remain on the parent.
    if (!(c.module === "sprite" && input.localOnly)) parent.prompt = "";
    await writeJob(c.module, parent);
    schedule(c);
    return { roundId: r.id, childId: child.id };
  } finally { locks.delete(id); }
}
export async function workflowConversation(module: Module, jobId: string): Promise<any> {
  const c = await read(module, jobId);
  const parent = await readJob(module, jobId);
  const rounds = await Promise.all(c.rounds.map(async r => ({ ...r, job: module === "sprite" ? await motion.motionView(r.childId) : await readJob(module, r.childId) })));
  if (!rounds.length && hasLegacyResults(module, parent)) rounds.push({ id: "legacy", childId: jobId, requestId: "legacy", createdAt: parent.createdAt || parent.updatedAt, prompt: "", automatic: false, localOnly: true, stage: "done", status: "ready", versions: [], legacy: true, job: parent });
  return { ...c, rounds };
}
export async function workflowSummary(module: Module, jobId: string): Promise<any> {
  const c = await read(module, jobId), latest = c.rounds.at(-1);
  if (!latest) return {};
  const job = await readJob(module, latest.childId);
  return { roundCount: c.rounds.length, updatedAt: Math.max(latest.createdAt, job.updatedAt || 0), operation: latest.status === "running" ? latest.stage : undefined,
    videoReady: job.video?.status === "ready", frameReady: module === "sprite" ? job.frames.length > 0 : job.frames?.status === "ready", sheetReady: module === "sprite" ? !!job.archive : job.sheet?.status === "ready" };
}
export async function reuseWorkflowRound(module: Module, jobId: string, roundId: string): Promise<any> {
  const id = key(module, jobId);
  if (locks.has(id)) throw new Error("任务正在处理"); locks.add(id);
  try {
    const c = await read(module, jobId), r = c.rounds.find(r => r.id === roundId);
    if (!r?.request || c.rounds.some(running) || await nativeBusy(module, jobId)) throw new Error("无法复用当前轮次");
    const parent = await readJob(module, jobId), child = await readJob(module, r.childId);
    for (const dir of module === "sprite" ? ["refs", "prepared", "videos"] : ["refs", "video-refs"]) await cp(location(module, child.id, dir), location(module, jobId, dir), { recursive: true, force: true });
    const request = structuredClone(r.request);
    if (module === "sprite" && r.localOnly && request.videoRange) {
      // Imported clips have no generation actions or prompt; keep that separate draft intact.
      for (const field of ["prompt", "finalPrompt", "promptTemplate", "segments", "ranges", "rangesConfirmed", "description", "character", "directions"]) delete request[field];
    }
    Object.assign(parent, request);
    if (module === "sprite") { parent.prepared = child.prepared; if (!(r.localOnly && request.videoRange)) { parent.ranges = structuredClone(r.request.ranges || parent.segments); parent.rangesConfirmed = r.request.rangesConfirmed === true; } parent.video = undefined; parent.frames = []; parent.validFrameRanges = undefined; parent.redrawTargets = undefined; parent.localUpscale = undefined; parent.archive = undefined; }
    else { parent.video = { status: "empty" }; parent.frames = { status: "empty", count: parent.settings.frameCount, files: [], keyed: [] }; parent.sheet = { status: "empty" }; }
    parent.updatedAt = Date.now(); await writeJob(module, parent); return { ok: true };
  } finally { locks.delete(id); }
}
export async function runWorkflowRoundStep(input: any): Promise<any> {
  const id = key(input.module, input.jobId);
  if (disposed) throw new Error("任务正在处理");
  if (input.step === "cancel") {
    const c = await read(input.module, input.jobId);
    const r = c.rounds.find(round => round.id === input.roundId);
    if (c.module !== "sprite" || !r || input.planOnly) throw new Error("无法停止此轮本地清晰化");
    // Polling may advance the manifest while a stop is requested. Stop signals
    // never write the manifest and are safe to repeat after the operation ends.
    if (running(r)) {
      if (r.stage !== "upscale") throw new Error("无法停止此轮本地清晰化");
      await motion.runMotionStep(r.childId, { step: "cancel" });
      schedule(c);
    }
    return { ok: true };
  }
  if (locks.has(id)) throw new Error("任务正在处理"); locks.add(id);
  let c: Conversation | undefined, started: Round | undefined;
  try {
    c = await read(input.module, input.jobId);
    if (c.rounds.some(running)) throw new Error("请等待当前轮次完成");
    const r = c.rounds.find(r => r.id === input.roundId);
    if (!r) throw new Error("Round not found");
    if (await nativeBusy(c.module, r.childId)) throw new Error("任务正在处理");
    if (input.planOnly) {
      if (c.module === "sprite" && input.step === "process") return planRoundProcessing(r, input);
      if (c.module !== "sprite" || input.step !== "redraw") throw new Error("Unsupported request plan");
      const child = await motion.readMotion(r.childId);
      const plan = motion.motionRedrawPlan(child, input.targets, input.scheme || "frame", input.regenerate === true, input.image1k === true);
      if (!input.image1k) return plan;
      return { ...plan, ...motion.motionImage1kReadiness(child, plan.targets, await loadConfig(), input.expectedImageModel) };
    }
    if (r.stage === "awaiting-ranges" && (input.step !== "process" || !input.ranges?.length)) {
      throw new Error("请先确认全部动作范围。");
    }
    if (input.step === "poll") {
      if (c.module === "sprite") await motion.runMotionStep(r.childId, { step: "poll" }); else await seq.pollSequenceOnce(r.childId);
      if (r.status === "error" && r.stage === "video") {
        r.status = "running"; r.error = undefined;
        beginTiming(r, "video");
        await save(c); schedule(c);
      }
      return { ok: true };
    }
    if (input.step === "process") {
      if (c.module !== "sprite") throw new Error("Unsupported local processing");
      const plan = await planRoundProcessing(r, input);
      // Validate the entire draft before persisting any setting or invalidating frames.
      await motion.saveMotionJob(r.childId, { processing: plan.processing, ...(plan.steps.includes("extract") ? { ranges: plan.ranges, rangesConfirmed: true } : {}) });
      if (!plan.steps.length) return { ok: true };
      r.automatic = false; r.localSteps = plan.steps.slice(1);
      started = r;
      await runLocal(c, r, plan.steps[0]); schedule(c); return { ok: true };
    }
    if (input.step === "upscale") {
      if (c.module !== "sprite") throw new Error("Unsupported local upscale");
      if (input.confirmed !== true) throw new Error("请先确认本地清晰化");
      r.automatic = false;
      r.localSteps = undefined;
      started = r;
      await runLocal(c, r, "upscale", { useRedraw: input.useRedraw === true, targets: input.targets });
      schedule(c);
      return { ok: true };
    }
    if (c.module === "sprite" && input.step === "sheet" || c.module === "sequence" && ["redraw", "export"].includes(input.step)) throw new Error("Unsupported workflow step");
    if (c.module === "sprite" && input.step === "redraw" && input.confirmed !== true) throw new Error("请确认重绘数量和费用");
    if (c.module === "sprite" && input.step === "redraw") {
      const child = await motion.readMotion(r.childId);
      const plan = motion.motionRedrawPlan(child, input.targets, input.scheme || "frame", input.regenerate === true, input.image1k === true);
      if (input.image1k && plan.requestCount) {
        const { blocker } = motion.motionImage1kReadiness(child, plan.targets, await loadConfig(), input.expectedImageModel);
        if (blocker) throw new Error(blocker);
      }
      r.image1k = input.image1k === true;
    }
    if (c.module === "sprite" && input.processing) await motion.saveMotionJob(r.childId, { processing: input.processing });
    if (c.module === "sequence" && (input.settings || input.keying)) {
      const child = await readJob(c.module, r.childId);
      child.settings = { ...child.settings, ...input.settings }; child.keying = { ...child.keying, ...input.keying };
      if (child.keying.keyHigh <= child.keying.keyLow) throw new Error("抠像上限必须大于下限");
      await writeJob(c.module, child);
    }
    // A manual step never replays a paid predecessor. Completed HD frames may
    // continue into local composition/export, without another paid request.
    r.automatic = false;
    r.localSteps = undefined;
    started = r;
    await runLocal(c, r, input.step, input);
    if (c.module === "sequence") { await finishLocal(c, r); await save(c); }
    schedule(c); return { ok: true };
  } catch (error) {
    if (c && started?.status === "running") {
      finishTiming(started, "error");
      started.status = "error"; started.error = error instanceof Error ? error.message : String(error);
      await save(c);
    }
    throw error;
  } finally { locks.delete(id); }
}
export async function deleteWorkflowVersion(input: { module: Module; jobId: string; roundId: string; versionId: string; confirmed: boolean }): Promise<any> {
  const id = key(input.module, input.jobId);
  if (input.confirmed !== true) throw new Error("请确认删除当前版本");
  if (disposed || locks.has(id)) throw new Error("任务正在处理");
  locks.add(id);
  try {
    const c = await read(input.module, input.jobId), r = c.rounds.find(r => r.id === input.roundId);
    if (!r) throw new Error("Round not found");
    if (c.rounds.some(running) || await nativeBusy(c.module, r.childId)) throw new Error("请等待当前轮次完成");
    const v = r.versions.find(v => v.id === input.versionId);
    if (!v) throw new Error("Version not found");
    if (!["raw", "keyed", "redraw", "upscale"].includes(v.kind)) throw new Error("只能删除抽帧、抠图和高清版本；视频不允许删除");
    const child = await readJob(c.module, r.childId);
    if (child.workflowParent !== c.jobId || r.childId === c.jobId) throw new Error("Invalid workflow child");
    // Every deletable snapshot has its own UUID directory. Refuse corrupted
    // manifests instead of following client paths or deleting shared/video files.
    if (!/^[a-f0-9-]{36}$/.test(v.id) || !v.files.length || v.files.some(file => !new RegExp(`^out/versions/${v.id}/[^/\\\\]+\\.png$`).test(file))) throw new Error("Invalid version files");
    const prefix = `out/versions/${v.id}/`;
    if (r.versions.some(other => other.id !== v.id && other.files.some(file => file.startsWith(prefix)))) throw new Error("Version files are shared");
    const workingFiles = c.module === "sprite" ? [...child.frames.flatMap(f => [f.target, f.keyed, f.redraw?.file]), ...Object.values(child.localUpscale?.files || {})] : [...child.frames.files, ...child.frames.keyed];
    if ([child.video?.file, child.sourceVideo?.file, child.prepared?.video, ...workingFiles].some(file => file?.startsWith(prefix))) throw new Error("Version files are still used by the pipeline");
    const base = await realpath(dirname(location(c.module, r.childId, "job.json")));
    const dir = location(c.module, r.childId, prefix.slice(0, -1));
    const actual = await realpath(dir).catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    if (actual && (actual !== join(base, "out", "versions", v.id) || !actual.startsWith(base + sep))) throw new Error("Invalid version directory");
    const staged = location(c.module, r.childId, `out/versions/.deleted-${v.id}-${randomUUID()}`);
    if (actual) await rename(dir, staged);
    numberVersions(r);
    r.versions = r.versions.filter(other => other.id !== v.id);
    try { await save(c); }
    catch (error) { if (actual) await rename(staged, dir); throw error; }
    // The committed manifest is authoritative. A Windows file lock may postpone
    // physical cleanup; retry quarantined directories at the next delete/startup.
    await cleanupDeletedVersions(c.module, r.childId).catch(() => {});
    return { ok: true };
  } finally { locks.delete(id); }
}
export async function workflowOwnsFile(module: string, jobId: string, file: string): Promise<boolean> {
  if (module !== "sprite" && module !== "sequence") return false;
  const child = await readJob(module, jobId);
  if (!child.workflowParent) return false;
  const c = await read(module, child.workflowParent);
  return c.rounds.some(r => r.childId === jobId && r.versions.some(v => v.files.includes(file)));
}
export async function deleteWorkflowChildren(module: Module, jobId: string): Promise<void> {
  const c = await read(module, jobId);
  if (c.rounds.some(running)) throw new Error("请先等待所有轮次完成");
  for (const r of c.rounds) await rm(dirname(location(module, r.childId, "job.json")), { recursive: true, force: true });
  await rm(join(root(), key(module, jobId) + ".json"), { force: true });
}
export function activateWorkflowChat() { disposed = false; }
export function disposeWorkflowChat() { disposed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); }
export async function resumeWorkflowChats() {
  for (const file of await readdir(root()).catch(() => [] as string[])) {
    if (!/^(sprite-w|sequence-s)[a-z0-9]+\.json$/.test(file)) continue;
    const c = await readJson<Conversation>(join(root(), file)); if (!c) continue;
    for (const r of c.rounds) await cleanupDeletedVersions(c.module, r.childId).catch(() => {});
    for (const r of c.rounds.filter(running)) {
      const job = await readJob(c.module, r.childId);
      if (r.stage === "video" && (job.video?.taskId || job.video?.file)) { if (c.module === "sequence" && job.video.taskId) seq.ensureSequencePoller(r.childId); }
      else if (!(c.module === "sprite" && r.localOnly && r.stage === "queued" && job.video?.file)) {
        if (c.module === "sprite" && r.stage === "redraw") await snapshot(c, r, "redraw");
        finishTiming(r, "error", job, undefined, true);
        r.status = "error"; r.error = "上次处理被中断；已完成产物保留，可单独继续本地处理。";
      }
    }
    await save(c); if (c.rounds.some(running)) schedule(c);
  }
}

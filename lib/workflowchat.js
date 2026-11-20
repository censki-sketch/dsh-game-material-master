/** Durable conversation rounds around the existing animation pipelines.
 * Each round owns a child job; local processing never re-submits paid work.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { dataRoot, loadConfig } from "./config.js";
import { readJson, writeJsonAtomic } from "./jsonio.js";
import * as motion from "./motiongen.js";
import * as seq from "./seqgen.js";
import { assertVideoSubmissionConfirmed } from "./videogen.js";
const root = () => join(dataRoot(), "workflow-conversations");
const key = (module, jobId) => {
    if (!(module === "sprite" ? motion.isMotionId(jobId) : module === "sequence" && seq.isValidSequenceJobId(jobId)))
        throw new Error("Invalid workflow ID");
    return module + "-" + jobId;
};
const location = (module, id, file) => module === "sprite" ? motion.motionAssetPath(id, file) : seq.sequenceAssetPath(id, file);
const readJob = async (module, id) => {
    const job = module === "sprite" ? await motion.readMotion(id) : await seq.readSequenceJob(id);
    if (!job)
        throw new Error("Workflow job not found");
    return job;
};
const writeJob = (module, job) => writeJsonAtomic(location(module, job.id, "job.json"), job);
async function read(module, jobId) {
    return await readJson(join(root(), key(module, jobId) + ".json")) || { module, jobId, rounds: [] };
}
async function save(c) {
    await mkdir(root(), { recursive: true });
    await writeJsonAtomic(join(root(), key(c.module, c.jobId) + ".json"), c);
}
const locks = new Set();
const timers = new Map();
let disposed = false;
const running = (r) => r.status === "running";
async function nativeBusy(module, id) {
    return module === "sprite" ? (await motion.motionView(id)).active : seq.listSequenceTasks(id).length > 0;
}
function schedule(c) {
    const id = key(c.module, c.jobId);
    if (disposed || timers.has(id))
        return;
    const timer = setTimeout(() => {
        timers.delete(id);
        void advance(c.module, c.jobId).catch(() => { });
    }, 1500);
    timer.unref?.();
    timers.set(id, timer);
}
async function clone(module, parent, includeResults = false) {
    const child = module === "sprite" ? await motion.createMotionJob(parent.name) : await seq.createSequenceJob(parent.name);
    const id = child.id;
    const job = { ...structuredClone(parent), id, workflowParent: parent.id, updatedAt: Date.now() };
    job.error = undefined;
    job.operation = undefined;
    await writeJob(module, { ...child, workflowParent: parent.id });
    for (const dir of includeResults ? (module === "sprite" ? [...motion.MOTION_DIRS] : ["refs", "video-refs", "videos", "frames", "keyed", "out"]) : (module === "sprite" ? ["refs", "prepared"] : ["refs", "video-refs"])) {
        await cp(location(module, parent.id, dir), location(module, id, dir), { recursive: true, force: true });
    }
    if (!includeResults) {
        if (module === "sprite") {
            job.video = undefined;
            job.frames = [];
            job.archive = undefined;
            job.error = undefined;
            job.operation = undefined;
            job.rangesConfirmed = false;
        }
        else {
            job.video = { status: "empty" };
            job.frames = { status: "empty", count: job.settings.frameCount, files: [], keyed: [] };
            job.sheet = { status: "empty" };
            job.log = [];
        }
    }
    await writeJob(module, job);
    return job;
}
async function snapshot(c, r, kind) {
    const job = await readJob(c.module, r.childId);
    const source = kind === "video" ? [job.video?.file].filter(Boolean) : c.module === "sprite"
        ? kind === "redraw" ? job.frames.map(f => f.redraw?.file).filter(Boolean) : kind === "export" ? [job.archive].filter(Boolean) : job.frames.map(f => kind === "raw" ? f.target : f.keyed)
        : kind === "raw" ? job.frames.files : kind === "keyed" ? job.frames.keyed : [job.sheet.file].filter(Boolean);
    if (!source.length)
        return;
    const id = randomUUID(), files = [];
    await mkdir(location(c.module, r.childId, "out/versions/" + id), { recursive: true });
    for (let i = 0; i < source.length; i++) {
        const file = `out/versions/${id}/${i}-${basename(source[i])}`;
        await writeFile(location(c.module, r.childId, file), await readFile(location(c.module, r.childId, source[i])));
        files.push(file);
    }
    const frameMetadata = kind === "redraw" ? job.frames.filter(f => f.redraw?.file) : job.frames;
    r.versions.push({ id, kind, files, createdAt: Date.now(), ...(c.module === "sprite" && !["export", "video"].includes(kind) ? { frames: frameMetadata.map((f, i) => ({ id: f.id, action: f.action, direction: f.direction, index: f.index, file: files[i] })) } : {}) });
}
async function runLocal(c, r, step, extra = {}) {
    r.stage = step;
    r.status = "running";
    r.error = undefined;
    await save(c);
    if (c.module === "sprite") {
        if (step === "extract")
            await motion.saveMotionJob(r.childId, { ranges: extra.ranges || (await motion.readMotion(r.childId)).ranges, rangesConfirmed: true });
        await motion.runMotionStep(r.childId, { ...extra, step });
    }
    else {
        if (step === "extract")
            await seq.extractSequenceFrames(r.childId);
        else if (step === "keyed") {
            await seq.keySequenceFrames(r.childId);
            await seq.composeSequenceSheet(r.childId);
            const job = await readJob(c.module, r.childId);
            job.frames.status = "ready";
            job.frames.error = undefined;
            await writeJob(c.module, job);
        }
        else if (step === "sheet")
            await seq.composeSequenceSheet(r.childId);
        else
            throw new Error("Unsupported local step");
    }
}
async function finishLocal(c, r) {
    if (r.stage === "extract") {
        await snapshot(c, r, "raw");
        await snapshot(c, r, "keyed");
        if (c.module === "sequence")
            await snapshot(c, r, "sheet");
        if (r.automatic && c.module === "sprite") {
            await runLocal(c, r, "export");
            return;
        }
    }
    else {
        await snapshot(c, r, r.stage);
        if (c.module === "sequence" && r.stage === "keyed")
            await snapshot(c, r, "sheet");
    }
    r.stage = "done";
    r.status = "ready";
}
async function advance(module, jobId) {
    const id = key(module, jobId);
    if (disposed || locks.has(id))
        return;
    locks.add(id);
    let c, r;
    try {
        c = await read(module, jobId);
        r = c.rounds.find(running);
        if (!r)
            return;
        if (await nativeBusy(module, r.childId))
            return;
        let job = await readJob(module, r.childId);
        if (job.error || job.frames?.status === "error" || job.video?.status === "error" || ["failed", "unknown"].includes(job.video?.status))
            throw new Error(job.error || job.frames?.error || job.video?.error || "视频结果未知，请查询已有任务，不要重复提交。");
        if (r.stage === "queued") {
            if (r.localOnly) {
                if (!job.video?.file)
                    throw new Error("请先导入视频");
                r.stage = "video";
            }
            else if (module === "sprite" && !job.prepared) {
                await runLocal(c, r, "prepare");
                return;
            }
            else
                r.stage = "submit";
        }
        if (r.stage === "prepare")
            r.stage = "submit";
        if (r.stage === "submit") {
            // Persist the attempt BEFORE the paid operation. Recovery never replays this stage.
            r.stage = "video";
            await save(c);
            if (module === "sprite")
                await motion.runMotionStep(r.childId, { step: "video", confirmed: true });
            else {
                const result = seq.startSequenceVideo(r.childId);
                if (!result.started)
                    throw new Error(result.reason);
            }
            return;
        }
        if (r.stage === "video") {
            if (job.video?.status !== "ready") {
                if (module === "sequence" && job.video?.taskId)
                    seq.ensureSequencePoller(r.childId);
                else if (module === "sprite" && job.video?.taskId)
                    await motion.runMotionStep(r.childId, { step: "poll" });
                return;
            }
            if (!r.versions.some(v => v.kind === "video"))
                await snapshot(c, r, "video");
            if (r.request && module === "sequence")
                r.request.settings = structuredClone(job.settings);
            if (r.automatic) {
                await runLocal(c, r, "extract");
                if (module === "sequence")
                    await finishLocal(c, r);
            }
            else {
                r.status = "ready";
                r.stage = "done";
            }
        }
        else
            await finishLocal(c, r);
    }
    catch (error) {
        if (r) {
            r.status = "error";
            r.error = error instanceof Error ? error.message : String(error);
        }
    }
    finally {
        try {
            if (c) {
                await save(c);
                if (c.rounds.some(running))
                    schedule(c);
            }
        }
        finally {
            locks.delete(id);
        }
    }
}
export async function submitWorkflowRound(input) {
    const id = key(input.module, input.jobId);
    if (disposed || locks.has(id))
        throw new Error("任务正在处理");
    locks.add(id);
    try {
        const c = await read(input.module, input.jobId);
        const existing = c.rounds.find(r => r.requestId === input.requestId);
        if (existing)
            return { roundId: existing.id, childId: existing.childId };
        if (c.rounds.some(running))
            throw new Error("请等待当前轮次完成");
        const parent = await readJob(c.module, c.jobId);
        if (parent.workflowParent || await nativeBusy(c.module, c.jobId) || ["running", "pending", "submitting"].includes(parent.video?.status))
            throw new Error("请等待当前任务完成");
        const config = await loadConfig();
        if (config.hiddenModules.includes(c.module))
            throw new Error("Module disabled");
        if (!input.localOnly)
            assertVideoSubmissionConfirmed(config, input.confirmed);
        if (c.module === "sprite" && (!parent.character || !parent.directions))
            throw new Error("请先提供角色图和八方向外观图");
        if (c.module === "sequence" && !input.localOnly && (parent.mode === "frames" ? !parent.refs.firstFrame : !parent.refs.referenceImages.length && !parent.refs.referenceVideos.length))
            throw new Error("请先添加参考素材");
        if (input.localOnly && !parent.video?.file)
            throw new Error("请先导入视频");
        if (!input.localOnly && !c.rounds.length && (parent.video?.file || parent.frames?.files?.length || Array.isArray(parent.frames) && parent.frames.length)) {
            const old = await clone(c.module, parent, true);
            const legacy = { id: randomUUID(), requestId: "legacy", childId: old.id, createdAt: parent.createdAt || parent.updatedAt, prompt: "", automatic: false, localOnly: true, stage: "done", status: "ready", legacy: true, versions: [] };
            c.rounds.push(legacy);
            await snapshot(c, legacy, "raw");
            await snapshot(c, legacy, "keyed");
            if (c.module === "sequence")
                await snapshot(c, legacy, "sheet");
        }
        const child = await clone(c.module, parent, input.localOnly === true);
        const request = c.module === "sprite" ? { prompt: child.prompt, description: child.description, segments: child.segments, character: child.character, directions: child.directions } : { prompt: child.prompt, suffix: child.suffix, refs: child.refs, settings: child.settings, keying: child.keying, mode: child.mode };
        const r = { id: randomUUID(), requestId: input.requestId, childId: child.id, createdAt: Date.now(), prompt: child.prompt, request: structuredClone(request), automatic: input.automatic, localOnly: input.localOnly === true, stage: "queued", status: "running", versions: [] };
        c.rounds.push(r);
        await save(c);
        // Consume only the submitted prompt; drafts and all input files remain on the parent.
        parent.prompt = "";
        await writeJob(c.module, parent);
        schedule(c);
        return { roundId: r.id, childId: child.id };
    }
    finally {
        locks.delete(id);
    }
}
export async function workflowConversation(module, jobId) {
    const c = await read(module, jobId);
    const parent = await readJob(module, jobId);
    const rounds = await Promise.all(c.rounds.map(async (r) => ({ ...r, job: module === "sprite" ? await motion.motionView(r.childId) : await readJob(module, r.childId) })));
    if (!rounds.length && (parent.video?.file || parent.frames?.files?.length || Array.isArray(parent.frames) && parent.frames.length))
        rounds.push({ id: "legacy", childId: jobId, requestId: "legacy", createdAt: parent.createdAt || parent.updatedAt, prompt: "", automatic: false, localOnly: true, stage: "done", status: "ready", versions: [], legacy: true, job: parent });
    return { ...c, rounds };
}
export async function workflowSummary(module, jobId) {
    const c = await read(module, jobId), latest = c.rounds.at(-1);
    if (!latest)
        return {};
    const job = await readJob(module, latest.childId);
    return { roundCount: c.rounds.length, updatedAt: Math.max(latest.createdAt, job.updatedAt || 0), operation: latest.status === "running" ? latest.stage : undefined,
        videoReady: job.video?.status === "ready", frameReady: module === "sprite" ? job.frames.length > 0 : job.frames?.status === "ready", sheetReady: module === "sprite" ? !!job.archive : job.sheet?.status === "ready" };
}
export async function reuseWorkflowRound(module, jobId, roundId) {
    const id = key(module, jobId);
    if (locks.has(id))
        throw new Error("任务正在处理");
    locks.add(id);
    try {
        const c = await read(module, jobId), r = c.rounds.find(r => r.id === roundId);
        if (!r?.request || c.rounds.some(running) || await nativeBusy(module, jobId))
            throw new Error("无法复用当前轮次");
        const parent = await readJob(module, jobId), child = await readJob(module, r.childId);
        for (const dir of module === "sprite" ? ["refs", "prepared"] : ["refs", "video-refs"])
            await cp(location(module, child.id, dir), location(module, jobId, dir), { recursive: true, force: true });
        Object.assign(parent, structuredClone(r.request));
        if (module === "sprite") {
            parent.prepared = child.prepared;
            parent.ranges = structuredClone(parent.segments);
            parent.rangesConfirmed = false;
            parent.video = undefined;
            parent.frames = [];
            parent.archive = undefined;
        }
        else {
            parent.video = { status: "empty" };
            parent.frames = { status: "empty", count: parent.settings.frameCount, files: [], keyed: [] };
            parent.sheet = { status: "empty" };
        }
        parent.updatedAt = Date.now();
        await writeJob(module, parent);
        return { ok: true };
    }
    finally {
        locks.delete(id);
    }
}
export async function runWorkflowRoundStep(input) {
    const id = key(input.module, input.jobId);
    if (locks.has(id))
        throw new Error("任务正在处理");
    locks.add(id);
    let c;
    try {
        c = await read(input.module, input.jobId);
        if (c.rounds.some(running))
            throw new Error("请等待当前轮次完成");
        const r = c.rounds.find(r => r.id === input.roundId);
        if (!r)
            throw new Error("Round not found");
        if (await nativeBusy(c.module, r.childId))
            throw new Error("任务正在处理");
        if (input.step === "poll") {
            if (c.module === "sprite")
                await motion.runMotionStep(r.childId, { step: "poll" });
            else
                await seq.pollSequenceOnce(r.childId);
            if (r.status === "error" && r.stage === "video") {
                r.status = "running";
                r.error = undefined;
                await save(c);
                schedule(c);
            }
            return { ok: true };
        }
        if (c.module === "sprite" && ["keyed", "sheet"].includes(input.step) || c.module === "sequence" && ["redraw", "export"].includes(input.step))
            throw new Error("Unsupported workflow step");
        if (c.module === "sprite" && input.step === "redraw" && input.confirmed !== true)
            throw new Error("请确认重绘数量和费用");
        if (c.module === "sequence" && (input.settings || input.keying)) {
            const child = await readJob(c.module, r.childId);
            child.settings = { ...child.settings, ...input.settings };
            child.keying = { ...child.keying, ...input.keying };
            if (child.keying.keyHigh <= child.keying.keyLow)
                throw new Error("抠像上限必须大于下限");
            await writeJob(c.module, child);
        }
        // A manual retry executes exactly this step, never a paid predecessor or the auto chain.
        r.automatic = false;
        await runLocal(c, r, input.step, input);
        if (c.module === "sequence") {
            await finishLocal(c, r);
            await save(c);
        }
        schedule(c);
        return { ok: true };
    }
    catch (error) {
        if (c) {
            const r = c.rounds.find(r => r.id === input.roundId);
            if (r?.status === "running") {
                r.status = "error";
                r.error = String(error instanceof Error ? error.message : error);
                await save(c);
            }
        }
        throw error;
    }
    finally {
        locks.delete(id);
    }
}
export async function workflowOwnsFile(module, jobId, file) {
    if (module !== "sprite" && module !== "sequence")
        return false;
    const child = await readJob(module, jobId);
    if (!child.workflowParent)
        return false;
    const c = await read(module, child.workflowParent);
    return c.rounds.some(r => r.childId === jobId && r.versions.some(v => v.files.includes(file)));
}
export async function deleteWorkflowChildren(module, jobId) {
    const c = await read(module, jobId);
    if (c.rounds.some(running))
        throw new Error("请先等待所有轮次完成");
    for (const r of c.rounds)
        await rm(dirname(location(module, r.childId, "job.json")), { recursive: true, force: true });
    await rm(join(root(), key(module, jobId) + ".json"), { force: true });
}
export function activateWorkflowChat() { disposed = false; }
export function disposeWorkflowChat() { disposed = true; for (const timer of timers.values())
    clearTimeout(timer); timers.clear(); }
export async function resumeWorkflowChats() {
    for (const file of await readdir(root()).catch(() => [])) {
        if (!/^(sprite-w|sequence-s)[a-z0-9]+\.json$/.test(file))
            continue;
        const c = await readJson(join(root(), file));
        if (!c)
            continue;
        for (const r of c.rounds.filter(running)) {
            const job = await readJob(c.module, r.childId);
            if (r.stage === "video" && (job.video?.taskId || job.video?.file)) {
                if (c.module === "sequence" && job.video.taskId)
                    seq.ensureSequencePoller(r.childId);
            }
            else {
                r.status = "error";
                r.error = "上次处理被中断；已完成产物保留，可单独继续本地处理。";
            }
        }
        await save(c);
        if (c.rounds.some(running))
            schedule(c);
    }
}

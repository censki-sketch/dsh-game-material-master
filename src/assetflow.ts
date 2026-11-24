/** Local, owned copies between modules. Never accepts a path or URL from the client. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataRoot, loadConfig } from "./config.js";
import { readJson, writeJsonAtomic } from "./jsonio.js";
import * as images from "./imagegen.js";
import * as motion from "./motiongen.js";
import * as sequence from "./seqgen.js";
import * as maps from "./mapgen.js";
import * as iso from "./isogen.js";
import { decodeToRgba, mimeOf } from "./media.js";

export type AssetSource = { module: "image" | "sprite" | "sequence"; jobId: string; file: string };
type Destination = "sprite" | "sequence" | "map" | "iso";
const root = () => join(dataRoot(), "asset-transfers");
const valid = (id: string) => /^t[a-f0-9]{32}$/.test(id);
export async function sourceImage(source: AssetSource): Promise<Buffer> {
  const { module, jobId, file } = source;
  if (!file || file.includes("..") || file.includes("\\") || file.startsWith("/")) throw new Error("Invalid asset");
  let allowed: (string | undefined)[] = [], path = "";
  if (module === "image") {
    const job = await images.readImageJob(jobId);
    if (!job) throw new Error("Image job not found");
    allowed = [...job.items, ...job.history.map(entry => entry.item)].flatMap(item => [item.file, item.keyedFile]);
    path = images.imageAssetPath(jobId, file);
  } else if (module === "sprite") {
    const job = await motion.readMotion(jobId);
    allowed = [job.character, job.directions, ...job.frames.flatMap(f => [f.target, f.keyed, f.redraw?.file])];
    path = motion.motionAssetPath(jobId, file);
  } else {
    const job = await sequence.readSequenceJob(jobId);
    if (!job) throw new Error("Sequence job not found");
    allowed = [...job.frames.files, ...job.frames.keyed, job.sheet.file];
    path = sequence.sequenceAssetPath(jobId, file);
  }
  // Conversation snapshots are host-created, under out/, and listed in the durable round manifest.
  if (!allowed.includes(file)) {
    const { workflowOwnsFile } = await import("./workflowchat.js");
    if (!await workflowOwnsFile(module, jobId, file)) throw new Error("Asset is not a saved result");
  }
  const bytes = await readFile(path);
  if (bytes.length > 20 * 1024 * 1024 || !images.sniffImage(bytes.toString("base64"))) throw new Error("Expected an image under 20 MB");
  return bytes;
}
export async function transferAsset(input: { source: AssetSource; target: Destination; targetId?: string; targetRole?: "character" | "directions"; name?: string }): Promise<any> {
  if (input.source.module === "sprite" && input.target !== "map" && input.target !== "iso") {
    throw new Error("八方向图只能流转到地图编辑器");
  }
  const config = await loadConfig();
  if (config.hiddenModules.includes(input.target) || config.hiddenModules.includes(input.source.module)) throw new Error("Module disabled");
  const bytes = await sourceImage(input.source), data = bytes.toString("base64");
  const name = (input.name || "素材流转").slice(0, 80);
  let jobId = input.targetId;
  if (input.target === "sprite") {
    if (!jobId) jobId = (await motion.createMotionJob(name)).id;
    await motion.uploadMotionAsset(jobId, input.targetRole || "character", data);
  } else if (input.target === "sequence") {
    if (!jobId) jobId = (await sequence.createSequenceJob(name)).id;
    if (sequence.listSequenceTasks(jobId).length) throw new Error("任务正在处理");
    const job = await sequence.readSequenceJob(jobId);
    if (!job) throw new Error("Sequence job not found");
    if (job.video.status === "running") throw new Error("任务正在处理");
    await sequence.uploadSequenceRef(jobId, "firstFrame", name + ".png", data);
    const fresh = (await sequence.readSequenceJob(jobId))!;
    fresh.mode = "frames";
    await sequence.writeSequenceJob(fresh);
  } else if (input.target === "map") {
    if (!jobId) jobId = (await maps.createMapProject(name)).id;
    if (!await maps.readMapProject(jobId)) throw new Error("Map not found");
  } else {
    if (!jobId) jobId = (await iso.createIsoProject(name)).id;
    if (!await iso.readIsoProject(jobId)) throw new Error("Map not found");
  }
  const id = "t" + randomUUID().replaceAll("-", "");
  await mkdir(root(), { recursive: true });
  await writeFile(join(root(), id + ".image"), bytes);
  const size = await decodeToRgba(join(root(), id + ".image"));
  await writeJsonAtomic(join(root(), id + ".json"), { id, source: input.source, target: input.target, ...(input.target === "sprite" ? { targetRole: input.targetRole || "character" } : {}), jobId, name, createdAt: Date.now(), width: size.width, height: size.height });
  return { transferId: id, module: input.target, jobId, dialog: ["map", "iso"].includes(input.target) ? "add" : undefined };
}
export async function getAssetTransfer(id: string, target: string, jobId: string): Promise<any> {
  if (!valid(id)) throw new Error("Invalid transfer ID");
  const record = await readJson<any>(join(root(), id + ".json"));
  if (!record || record.target !== target || record.jobId !== jobId) throw new Error("Transfer destination mismatch");
  const bytes = await readFile(join(root(), id + ".image"));
  return { ...record, data: bytes.toString("base64"), mime: mimeOf(record.source.file) };
}

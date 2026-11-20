/** Local evidence of explicit model tests. Never stores credentials or response content. */
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { builtinModelConfig, customConnectionConfig, dataRoot, type Config } from "./config.js";
import { imageModelRoutes } from "./imageprovider.js";
import { readJson, writeJsonAtomic } from "./jsonio.js";

function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
export function modelTestFingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function imageTestFingerprint(config: Config, provider: Config["imageProvider"]): string {
  const fields = provider === "ark" ? [config.arkBaseUrl, config.arkApiKey, config.arkModel]
    : provider === "toapis" ? [config.toapisBaseUrl, config.toapisApiKey, config.toapisImageModel]
    : [config.activeCustomImageConnectionId, config.customBaseUrl, config.customApiKey, config.customModel, config.customProtocol, config.customWorkflow];
  const definition = provider === "ark" ? config.arkImageModels.find(model => model.id === config.arkModel) : provider === "toapis" ? config.toapisImageModels.find(model => model.id === config.toapisImageModel) : config.customImageConnections.find(connection => connection.id === config.activeCustomImageConnectionId)?.modelConfigs.find(model => model.id === config.customModel);
  return modelTestFingerprint(["image-v1", provider, fields, ...(definition && Object.keys(definition.params).length ? [definition.params] : [])]);
}
export async function modelTestStatus(fingerprint: string): Promise<number | null> {
  const record = await readJson<{ state: string; at: number }>(join(dataRoot(), "model-tests", fingerprint + ".json"));
  return record?.state === "passed" && Number.isFinite(record.at) ? record.at : null;
}
export async function recordModelTest(fingerprint: string, state: "running" | "passed" | "failed"): Promise<void> {
  await writeJsonAtomic(join(dataRoot(), "model-tests", fingerprint + ".json"), { state, at: Date.now() });
}
const pendingTests = new Set<string>();
export async function runModelTest<T>(fingerprint: string, action: () => Promise<T>): Promise<T> {
  if (pendingTests.has(fingerprint)) throw new Error("该模型正在测试，请等待完成；未重复提交请求。");
  pendingTests.add(fingerprint);
  try {
    await recordModelTest(fingerprint, "running");
    const result = await action();
    await recordModelTest(fingerprint, "passed");
    return result;
  } catch (error) {
    await recordModelTest(fingerprint, "failed");
    throw error;
  } finally { pendingTests.delete(fingerprint); }
}
export async function imageModelTests(config: Config) {
  return Promise.all(imageModelRoutes(config).map(async route => {
    const selected = route.connectionId ? customConnectionConfig(config, route.connectionId, route.model) : builtinModelConfig(config, route.provider as "ark" | "toapis", route.model);
    const fingerprint = imageTestFingerprint(selected, route.provider);
    const record = await readJson<{ state: string; at: number }>(join(dataRoot(), "model-tests", fingerprint + ".json"));
    return { ...route, testedAt: record?.state === "passed" && Number.isFinite(record.at) ? record.at : null, testState: record?.state ?? "untested" };
  }));
}

/** Hash the owning DSH profile and its resolved credentials in memory, never on the wire. */
const sessionIds = new WeakMap<object, string>();
export async function promptTestFingerprint(ctx: any, provider: string, model: string): Promise<string> {
  const llm = ctx.get("llm"), settings = ctx.get("settings"), credentials = ctx.get("credentials");
  const directory = llm?.listConfigurableProviders?.() ?? [];
  const route = directory.find((entry: any) => entry.provider === provider);
  const descriptor = route && settings?.describe?.().find((entry: any) => entry.ns === route.settingsNs);
  let profile: any = descriptor?.value;
  for (const segment of route?.settingsPath ?? []) profile = profile?.[segment];
  const secrets: any[] = [];
  const visit = async (value: any, key = "") => {
    if (typeof value === "string" && /key|token|credential|auth/i.test(key) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      secrets.push([value, await credentials?.resolve?.(value), process.env[value] ?? null]);
    } else if (value && typeof value === "object") {
      for (const [name, item] of Object.entries(value)) await visit(item, name);
    }
  };
  await visit(profile);
  for (const ref of route?.nativeAuth?.env ?? []) secrets.push([ref, await credentials?.resolve?.(ref), process.env[ref] ?? null]);
  // Older hosts cannot expose route configuration. Do not reuse stale evidence across restarts.
  if (!sessionIds.has(llm)) sessionIds.set(llm, randomUUID());
  return modelTestFingerprint(["prompt-v1", provider, model, route ?? null, profile ?? null, secrets,
    descriptor ? null : sessionIds.get(llm)]);
}

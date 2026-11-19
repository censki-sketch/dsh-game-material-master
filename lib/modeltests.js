/** Local evidence of explicit model tests. Never stores credentials or response content. */
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { dataRoot } from "./config.js";
import { readJson, writeJsonAtomic } from "./jsonio.js";
function canonical(value) {
    if (Array.isArray(value))
        return "[" + value.map(canonical).join(",") + "]";
    if (value && typeof value === "object")
        return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
    return JSON.stringify(value) ?? "null";
}
export function modelTestFingerprint(value) {
    return createHash("sha256").update(canonical(value)).digest("hex");
}
export function imageTestFingerprint(config, provider) {
    const fields = provider === "ark" ? [config.arkBaseUrl, config.arkApiKey, config.arkModel]
        : provider === "toapis" ? [config.toapisBaseUrl, config.toapisApiKey, config.toapisImageModel]
            : [config.customBaseUrl, config.customApiKey, config.customModel, config.customProtocol, config.customWorkflow];
    return modelTestFingerprint(["image-v1", provider, fields]);
}
export async function modelTestStatus(fingerprint) {
    const record = await readJson(join(dataRoot(), "model-tests", fingerprint + ".json"));
    return record?.state === "passed" && Number.isFinite(record.at) ? record.at : null;
}
export async function recordModelTest(fingerprint, state) {
    await writeJsonAtomic(join(dataRoot(), "model-tests", fingerprint + ".json"), { state, at: Date.now() });
}
const pendingTests = new Set();
export async function runModelTest(fingerprint, action) {
    if (pendingTests.has(fingerprint))
        throw new Error("该模型正在测试，请等待完成；未重复提交请求。");
    pendingTests.add(fingerprint);
    try {
        await recordModelTest(fingerprint, "running");
        const result = await action();
        await recordModelTest(fingerprint, "passed");
        return result;
    }
    catch (error) {
        await recordModelTest(fingerprint, "failed");
        throw error;
    }
    finally {
        pendingTests.delete(fingerprint);
    }
}
export async function imageModelTests(config) {
    return Promise.all(["ark", "toapis", "custom"].map(async (provider) => ({ provider,
        model: provider === "ark" ? config.arkModel : provider === "toapis" ? config.toapisImageModel : config.customModel,
        testedAt: await modelTestStatus(imageTestFingerprint(config, provider)) })));
}
/** Hash the owning DSH profile and its resolved credentials in memory, never on the wire. */
const sessionIds = new WeakMap();
export async function promptTestFingerprint(ctx, provider, model) {
    const llm = ctx.get("llm"), settings = ctx.get("settings"), credentials = ctx.get("credentials");
    const directory = llm?.listConfigurableProviders?.() ?? [];
    const route = directory.find((entry) => entry.provider === provider);
    const descriptor = route && settings?.describe?.().find((entry) => entry.ns === route.settingsNs);
    let profile = descriptor?.value;
    for (const segment of route?.settingsPath ?? [])
        profile = profile?.[segment];
    const secrets = [];
    const visit = async (value, key = "") => {
        if (typeof value === "string" && /key|token|credential|auth/i.test(key) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
            secrets.push([value, await credentials?.resolve?.(value), process.env[value] ?? null]);
        }
        else if (value && typeof value === "object") {
            for (const [name, item] of Object.entries(value))
                await visit(item, name);
        }
    };
    await visit(profile);
    for (const ref of route?.nativeAuth?.env ?? [])
        secrets.push([ref, await credentials?.resolve?.(ref), process.env[ref] ?? null]);
    // Older hosts cannot expose route configuration. Do not reuse stale evidence across restarts.
    if (!sessionIds.has(llm))
        sessionIds.set(llm, randomUUID());
    return modelTestFingerprint(["prompt-v1", provider, model, route ?? null, profile ?? null, secrets,
        descriptor ? null : sessionIds.get(llm)]);
}

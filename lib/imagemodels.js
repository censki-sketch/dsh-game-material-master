export const IMAGE_MODEL_PARAMS = {
    size: "string", quality: "string", timeoutMs: "number", watermark: "boolean",
    negativePrompt: "string", steps: "number", cfgScale: "number", sampler: "string",
    denoising: "number", seed: "number", workflow: "string"
};
export function validateImageModel(value) {
    if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id.trim() || value.id.length > 300)
        throw new Error("模型 ID 不能为空且最多 300 字符");
    if (value.name !== undefined && (typeof value.name !== "string" || value.name.length > 80))
        throw new Error("模型名称最多 80 字符");
    if (value.enabled !== undefined && typeof value.enabled !== "boolean")
        throw new Error("启用状态必须是布尔值");
    const params = value.params ?? {};
    if (!params || typeof params !== "object" || Array.isArray(params))
        throw new Error("模型参数格式不正确");
    for (const [key, item] of Object.entries(params)) {
        if (!(key in IMAGE_MODEL_PARAMS) || typeof item !== IMAGE_MODEL_PARAMS[key] || (typeof item === "number" && !Number.isFinite(item)))
            throw new Error("模型参数格式不正确：" + key);
    }
    const limits = { timeoutMs: [10000, 3600000], steps: [1, 150], cfgScale: [0, 30], denoising: [0, 1], seed: [-1, 2147483647] };
    for (const [key, [min, max]] of Object.entries(limits))
        if (params[key] !== undefined && (params[key] < min || params[key] > max))
            throw new Error("模型参数超出范围：" + key);
    if (params.quality !== undefined && !["auto", "low", "medium", "high"].includes(params.quality))
        throw new Error("无效的图片质量");
    if (typeof params.workflow === "string" && params.workflow.trim()) {
        try {
            JSON.parse(params.workflow);
        }
        catch {
            throw new Error("工作流必须是有效 JSON");
        }
    }
    return { id: value.id.trim(), name: value.name?.trim() || value.id.trim(), enabled: value.enabled !== false, params: { ...params } };
}
export function normalizeImageModels(value, legacy) {
    const rows = Array.isArray(value) ? value : [...new Set(legacy.filter(id => typeof id === "string" && id.trim()))].map(id => ({ id }));
    const result = [];
    for (const row of rows.slice(0, 50)) {
        try {
            const item = validateImageModel(row);
            if (!result.some(entry => entry.id === item.id))
                result.push(item);
        }
        catch { /* Ignore malformed legacy entries. Save operations validate explicitly. */ }
    }
    return result;
}
export const CUSTOM_MODEL_PARAM_KEYS = { size: "customSize", quality: "customQuality", timeoutMs: "customTimeoutMs", negativePrompt: "customNegativePrompt", steps: "customSteps", cfgScale: "customCfgScale", sampler: "customSampler", denoising: "customDenoising", seed: "customSeed", workflow: "customWorkflow" };
export const ARK_MODEL_PARAM_KEYS = { size: "arkSize", timeoutMs: "arkTimeoutMs", watermark: "arkWatermark" };
export const TOAPIS_MODEL_PARAM_KEYS = { size: "toapisImageSize", quality: "toapisImageQuality", timeoutMs: "toapisTimeoutMs" };
export function applyModelParams(config, provider, model) {
    const mapping = provider === "ark" ? ARK_MODEL_PARAM_KEYS : provider === "toapis" ? TOAPIS_MODEL_PARAM_KEYS : CUSTOM_MODEL_PARAM_KEYS;
    for (const [param, key] of Object.entries(mapping))
        if (model?.params[param] !== undefined)
            config[key] = model.params[param];
}

/** One catalog for image and video prompts; legacy APIs expose filtered views. */
import { IMAGE_PROMPT_TEMPLATES, normalizeImagePromptTemplates, parseImagePromptTemplates, validateImagePromptTemplates } from "./imageprompts.js";
import { MOTION_PROMPT_TEMPLATES, motionTemplates, validateMotionTemplates } from "./motionprompts.js";
export const PROMPT_TEMPLATE_DEFAULTS = [
    ...IMAGE_PROMPT_TEMPLATES.map(item => ({ ...item, type: "image" })),
    ...MOTION_PROMPT_TEMPLATES.map(item => ({ ...item, type: "video" }))
];
export function templatesOfType(items, type) {
    return items.filter(item => item.type === type).map(({ type: _, ...item }) => item);
}
export function validatePromptTemplates(input) {
    const items = parseImagePromptTemplates(input, 48);
    if (input.some(item => item.type !== "image" && item.type !== "video"))
        throw new Error("Invalid prompt template type");
    const typed = items.map((item, i) => ({ ...item, type: input[i].type }));
    for (const builtin of PROMPT_TEMPLATE_DEFAULTS)
        if (!typed.some(item => item.id === builtin.id && item.type === builtin.type))
            throw new Error("内置提示词模板不能删除。");
    validateImagePromptTemplates(templatesOfType(typed, "image"));
    validateMotionTemplates(templatesOfType(typed, "video"));
    return typed;
}
/** Merge old separately stored catalogs without losing colliding custom IDs. */
export function mergePromptTemplates(images, videos) {
    const used = new Set(PROMPT_TEMPLATE_DEFAULTS.map(item => item.id));
    const unique = (id, type) => {
        const builtin = PROMPT_TEMPLATE_DEFAULTS.find(item => item.id === id && item.type === type);
        if (builtin)
            return id;
        let next = id, n = 1;
        while (used.has(next))
            next = `${type}-${id.slice(0, 45)}-${n++}`;
        used.add(next);
        return next;
    };
    return [
        ...normalizeImagePromptTemplates(images).map(item => ({ ...item, id: unique(item.id, "image"), type: "image" })),
        ...motionTemplates(videos).map(item => ({ ...item, id: unique(item.id, "video"), type: "video" }))
    ];
}
export function normalizePromptTemplates(input, legacyImages) {
    if (input === undefined)
        return mergePromptTemplates(legacyImages, undefined);
    try {
        const items = parseImagePromptTemplates(input, Infinity).map((item, i) => {
            const type = input[i].type;
            if (type !== "image" && type !== "video")
                throw new Error("Invalid prompt template type");
            return { ...item, type: type };
        });
        // Restore missing built-ins, retaining authored legacy overflow until explicit save.
        if (PROMPT_TEMPLATE_DEFAULTS.some(builtin => items.some(item => item.id === builtin.id && item.type !== builtin.type)))
            throw new Error("Invalid built-in type");
        return [...items, ...PROMPT_TEMPLATE_DEFAULTS.filter(builtin => !items.some(item => item.id === builtin.id))];
    }
    catch {
        return mergePromptTemplates(legacyImages, undefined);
    }
}

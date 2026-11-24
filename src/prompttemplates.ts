/** One catalog for image and video prompts; legacy APIs expose filtered views. */
import { IMAGE_PROMPT_TEMPLATES, normalizeImagePromptTemplates, parseImagePromptTemplates, validateImagePromptTemplates, type ImagePromptTemplate } from "./imageprompts.js";
import { MOTION_PROMPT_TEMPLATES, motionTemplates, validateMotionTemplates } from "./motionprompts.js";

export type PromptTemplateType = "image" | "video";
export interface PromptTemplate extends ImagePromptTemplate { type: PromptTemplateType }
export const PROMPT_TEMPLATE_DEFAULTS: PromptTemplate[] = [
  ...IMAGE_PROMPT_TEMPLATES.map(item => ({ ...item, type: "image" as const })),
  ...MOTION_PROMPT_TEMPLATES.map(item => ({ ...item, type: "video" as const }))
];
export function templatesOfType(items: PromptTemplate[], type: PromptTemplateType): ImagePromptTemplate[] {
  return items.filter(item => item.type === type).map(({ type: _, ...item }) => item);
}
export function validatePromptTemplates(input: unknown): PromptTemplate[] {
  const items = parseImagePromptTemplates(input, 48);
  if ((input as any[]).some(item => item.type !== "image" && item.type !== "video")) throw new Error("Invalid prompt template type");
  const typed = items.map((item, i) => ({ ...item, type: (input as any[])[i].type as PromptTemplateType }));
  for (const builtin of PROMPT_TEMPLATE_DEFAULTS) if (!typed.some(item => item.id === builtin.id && item.type === builtin.type)) throw new Error("内置提示词模板不能删除。");
  validateImagePromptTemplates(templatesOfType(typed, "image"));
  validateMotionTemplates(templatesOfType(typed, "video"));
  return typed;
}
/** Merge old separately stored catalogs without losing colliding custom IDs. */
export function mergePromptTemplates(images: unknown, videos: unknown): PromptTemplate[] {
  const used = new Set(PROMPT_TEMPLATE_DEFAULTS.map(item => item.id));
  const unique = (id: string, type: PromptTemplateType) => {
    const builtin = PROMPT_TEMPLATE_DEFAULTS.find(item => item.id === id && item.type === type);
    if (builtin) return id;
    let next = id, n = 1;
    while (used.has(next)) next = `${type}-${id.slice(0, 45)}-${n++}`;
    used.add(next); return next;
  };
  return [
    ...normalizeImagePromptTemplates(images).map(item => ({ ...item, id: unique(item.id, "image"), type: "image" as const })),
    ...motionTemplates(videos).map(item => ({ ...item, id: unique(item.id, "video"), type: "video" as const }))
  ];
}
export function normalizePromptTemplates(input: unknown, legacyImages?: unknown): PromptTemplate[] {
  if (input === undefined) return mergePromptTemplates(legacyImages, undefined);
  try {
    const items = parseImagePromptTemplates(input, Infinity).map((item, i) => {
      const type = (input as any[])[i].type;
      if (type !== "image" && type !== "video") throw new Error("Invalid prompt template type");
      return { ...item, type: type as PromptTemplateType };
    });
    // Restore missing built-ins, retaining authored legacy overflow until explicit save.
    if (PROMPT_TEMPLATE_DEFAULTS.some(builtin => items.some(item => item.id === builtin.id && item.type !== builtin.type))) throw new Error("Invalid built-in type");
    return [...items, ...PROMPT_TEMPLATE_DEFAULTS.filter(builtin => !items.some(item => item.id === builtin.id))];
  } catch { return mergePromptTemplates(legacyImages, undefined); }
}

/** Editable image suffix templates, shared by the UI and text optimizer. No model calls. */
const CHARACTER_ZH = "用途：可直接用于游戏的二维角色素材。用户主描述中明确的性别、年龄、配色、服装、画风、动作、视角、数量和背景优先；参考图只借鉴与文字一致的外观，不复制冲突的性别、姿态或背景。未指定构图时，单个角色全身入画，头发、手脚、装备完整不裁切，居中并留出安全边距，轮廓清楚，便于后续制作动作。未指定背景时使用均匀纯白背景，无地面、投影、场景、暗角、光晕、发光描边、粒子、文字或水印。采用清晰的二维游戏美术表达，配色稳定、色块干净，避免摄影质感、过度渐变和繁杂纹理；Q版不等于像素画，不擅自改变用户画风。不自行添加武器、饰品或额外人物。";
const CHARACTER_EN = "Purpose: a 2D character asset for direct use in a game. Explicit user requirements for gender, age, colors, clothing, art style, action, view, count and background take priority. Reference images supply only compatible appearance details; do not copy conflicting gender, poses or backgrounds. Unless composition is specified, show one centered full-body character with all hair, hands, feet and equipment inside safe margins, a readable silhouette, suitable for later animation. Unless a background is specified, use a uniform solid white background with no floor, cast shadow, scenery, vignette, halo, glowing outline, particles, text or watermark. Use clear 2D game art, stable colors and clean color shapes; avoid photographic rendering, excessive gradients and busy textures. Chibi does not imply pixel art; preserve the requested style. Do not invent weapons, accessories or extra characters.";

export const IMAGE_PROMPT_TEMPLATES = [
  { id: "character", name: { zh: "角色素材", en: "Character asset" }, prompt: { zh: CHARACTER_ZH, en: CHARACTER_EN } },
  { id: "pixel", name: { zh: "像素角色", en: "Pixel character" }, prompt: {
    zh: CHARACTER_ZH + "\n像素画要求：使用真正的低分辨率像素画语汇，像素网格和像素块大小一致，边缘硬朗、无抗锯齿、无模糊，有限且固定的调色板，使用明确的色阶而非连续渐变；不要把高清插画加马赛克滤镜冒充像素画。",
    en: CHARACTER_EN + "\nPixel art: use a true low-resolution pixel-art vocabulary, a consistent pixel grid and pixel size, crisp hard edges without antialiasing or blur, and a limited fixed palette with discrete color steps rather than smooth gradients. Do not simulate pixel art by applying a mosaic filter to an illustration."
  } },
  { id: "eight-direction", name: { zh: "八方向外观", en: "Eight-direction views" }, prompt: {
    zh: CHARACTER_ZH + "\n八方向排版要求（替代默认单角色构图）：同一个角色的八个朝向排列在一张四列两行的图中，上排从左到右为北（背面）、东北（右后）、东（右侧）、东南（右前），下排为南（正面）、西南（左前）、西（左侧）、西北（左后）。北朝画面上方，东朝画面右侧。每格只出现一个全身角色，采用相同的待机站姿、视角高度、角色比例、缩放和脚底基线；服装结构、发型、配色和装备始终一致，只改变朝向。格子留有间距，不画网格线或方向文字，不重叠、不裁切。这是八方向外观图，不是动作序列帧。",
    en: CHARACTER_EN + "\nEight-direction layout (replaces the default single-character composition): show eight views of the same character in one 4-column by 2-row sheet. Top row, left to right: north (back), northeast (back-right), east (right side), southeast (front-right). Bottom row: south (front), southwest (front-left), west (left side), northwest (back-left). North points toward the top of the image; east points right. One full-body character per cell, with the same idle stance, camera elevation, proportions, scale and foot baseline. Keep clothing structure, hairstyle, colors and equipment consistent, changing only facing direction. Leave gaps between cells, without grid lines, direction labels, overlap or cropping. This is a sheet of directional appearances, not an animation frame sequence."
  } }
] as const;

export interface ImagePromptTemplate {
  id: string;
  name: { zh: string; en: string };
  prompt: { zh: string; en: string };
}

/** Never silently truncate an authored prompt. One language may use the other as fallback. */
export function parseImagePromptTemplates(input: unknown, maxCount = 24): ImagePromptTemplate[] {
  if (!Array.isArray(input) || input.length > maxCount) throw new Error("提示词模板最多24个。");
  const ids = new Set<string>();
  return input.map(raw => {
    if (!raw || typeof raw.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(raw.id) || ids.has(raw.id)) throw new Error("提示词模板ID无效或重复。");
    ids.add(raw.id);
    const text = (value: any, max: number) => {
      const zh = typeof value?.zh === "string" ? value.zh.trim() : "";
      const en = typeof value?.en === "string" ? value.en.trim() : "";
      if (!(zh || en) || zh.length > max || en.length > max) throw new Error(`模板名称不能为空且最多60字，内容不能为空且最多6000字。`);
      return { zh: zh || en, en: en || zh };
    };
    return { id: raw.id, name: text(raw.name, 60), prompt: text(raw.prompt, 6000) };
  });
}

/** Built-in IDs are permanent; their names and content remain editable. */
export function validateImagePromptTemplates(input: unknown): ImagePromptTemplate[] {
  const templates = parseImagePromptTemplates(input);
  if (IMAGE_PROMPT_TEMPLATES.some(builtin => !templates.some(item => item.id === builtin.id))) throw new Error("内置提示词模板不能删除。");
  return templates;
}

export function normalizeImagePromptTemplates(input: unknown): ImagePromptTemplate[] {
  const defaults = IMAGE_PROMPT_TEMPLATES.map(item => ({ id: item.id, name: { ...item.name }, prompt: { ...item.prompt } }));
  try {
    // Retain legacy overflow after restoration; the next explicit save still enforces the limit.
    const templates = parseImagePromptTemplates(input, Infinity);
    // Older versions allowed deletion. Restore only missing built-ins without losing authored content.
    return [...templates, ...defaults.filter(builtin => !templates.some(item => item.id === builtin.id))];
  } catch { return defaults; }
}

/** Authored motion-video templates. Substitution is local and never calls a model. */
import { parseImagePromptTemplates } from "./imageprompts.js";
/** Stable rules; only job-specific context is substituted, never another LLM rewrite. */
export function motionRedrawPrompt(context) {
    const columns = (context.frameCount || 1) > 4 ? 4 : 2;
    const subject = (context.frameCount || 1) > 1
        ? `高清修复图片1中的${columns}列2行动作序列图，同一角色、同一动作、同一朝向、按时间顺序采样的${context.frameCount}帧。按从左到右、从上到下的顺序逐格修复，有效内容只在前${context.frameCount}格，其余空格保持纯背景。严格保持${columns}列2行的均分布局、每格边界与原顺序，每格人物独立完整，不串格、不合并、不换姿势，不添加边线、编号或文字。保持每格的原始人物位置、脚底位置和姿势差异；所有格统一服装细节、颜色、线条粗细和清晰度。`
        : "高清修复图片1中的单个人物动作帧，不重新设计人物。";
    return `${subject}图片1决定朝向、身体姿势、关节与手脚位置、轮廓、人物大小和构图；图片2提供角色身份、发型、服装、配色与画风，不复制其站立姿势。${context.hasDirection ? "图片3为当前方向的外观参考，只校对该方向的服装结构和细节，不复制其姿势。" : ""}
当前方向：${context.direction}。保持原动作和脚底位置，只补充清晰线条与细节；保持原有像素或二维画风，不平滑改成写实风格，不添加装备、阴影、地面、文字或特效。
角色说明：${context.description || "保持角色参考图的外观"}
本轮要求：${context.instructions || "保持本轮人物外观"}。本轮要求仅用于校对外观，时间顺序、循环和运动要求不改变各格的原动作帧。
背景统一为纯色${context.keyColor}，无渐变、投影、光晕和棋盘格；底色不参与主体照明或反射，不给边缘染色。优先保持动作、轮廓和跨帧外观一致，不凭空添加参考素材中看不到的细节。`;
}
export const MOTION_PROMPT_TEMPLATES = [{
        id: "motion-video", name: { zh: "八方向角色动作", en: "Eight-direction character motion" }, prompt: {
            zh: "将参考视频的灰白人物替换成参考图片中的同一个角色。参考视频决定动作、时间顺序、八格布局和朝向；角色图片决定外观、服装、配色和画风。\n时间顺序：{{timeline}}。严格跟随各段参考姿势，短动作按参考重复，不新增、遗漏或混合动作。\n四列两行：上排北、东北、东、东南；下排南、西南、西、西北。每格一个完整人物，全程保持各自朝向，不转身、串格、合并或消失。固定相机、人物大小和格内位置，完整露出头脚，不复制白模的拳套和短裤。\n角色说明：{{description}}\n背景及格间空隙全程纯色{{keyColor}}，无地面、阴影、边框、文字、特效、镜头切换或缩放。",
            en: "Replace the gray mannequin in the reference video with the same character from the reference images. The video defines motion, timing, eight-cell layout and facing; images define appearance, clothing, colors and art style.\nTimeline: {{timeline}}. Follow each reference pose; repeat short actions as shown, without adding, omitting or mixing actions.\nFour columns and two rows: N, NE, E, SE on top; S, SW, W, NW below. One full-body character per cell, keeping its facing without turning, crossing cells, merging or disappearing. Lock camera, scale and position; keep head and feet visible; do not copy mannequin gloves or shorts.\nCharacter: {{description}}\nUniform solid {{keyColor}} background and cell gaps, without floor, shadows, borders, text, effects, cuts or zoom."
        }
    }];
export function validateMotionTemplates(input) {
    const templates = parseImagePromptTemplates(input);
    if (!templates.some(item => item.id === "motion-video"))
        throw new Error("内置提示词模板不能删除。");
    for (const item of templates)
        for (const body of Object.values(item.prompt)) {
            if (/\{\{(?!timeline\}\}|description\}\}|keyColor\}\})/.test(body))
                throw new Error("模板仅支持 {{timeline}}、{{description}}、{{keyColor}}。");
        }
    return templates;
}
export function motionTemplates(input) {
    if (input === undefined)
        return structuredClone(MOTION_PROMPT_TEMPLATES);
    try {
        const templates = validateMotionTemplates([...parseImagePromptTemplates(input), ...MOTION_PROMPT_TEMPLATES.filter(item => !input.some(t => t.id === item.id))]);
        return templates;
    }
    catch {
        return structuredClone(MOTION_PROMPT_TEMPLATES);
    }
}

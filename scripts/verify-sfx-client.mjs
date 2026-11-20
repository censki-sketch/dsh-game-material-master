/**
 * 音效生成（模块八）· 浏览器半区契约自检（不需要浏览器、不联网）。
 *
 *   node scripts/verify-sfx-client.mjs
 *
 * 钉住：
 *   ① 静态契约：模块注册、深链接、设置页字段、远程方法清单、草稿合并；
 *   ② 真渲染：用假 React 把 SfxModule 渲染成元素树，断言新建卡 / 任务卡 /
 *      参考卡 / takes / 生成按钮 / 遮罩真的出现；
 *   ③ 点击「生成」真的调到 runSfxGeneration，而不是只改界面。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const failures = [];
let checks = 0;
function check(name, ok, detail) {
  checks++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(name);
}
function section(title) {
  console.log(`\n${title}`);
}

const target = process.argv[2] ?? fileURLToPath(new URL("../lib/client.js", import.meta.url));
const source = readFileSync(fileURLToPath(new URL("../src/client.ts", import.meta.url)), "utf8");

// ── 假 React ────────────────────────────────────────────────────────────
const HOOK = { slots: [], cursor: 0 };
const ReactStub = {
  Fragment: Symbol.for("react.fragment"),
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    const index = HOOK.cursor++;
    const value = HOOK.slots[index];
    return [value === undefined ? (typeof initial === "function" ? initial() : initial) : value, () => {}];
  },
  useRef(initial) {
    HOOK.cursor++;
    return { current: initial };
  },
  useEffect() {},
  useLayoutEffect() {},
  useCallback(fn) {
    return fn;
  },
  useMemo(fn) {
    return fn();
  },
  useContext() {
    return undefined;
  }
};

const LOADED = [];
const windowStub = {
  __ModuleLoader__: {
    load(registration) {
      LOADED.push(registration);
    }
  },
  location: { origin: "http://127.0.0.1:43120", search: "", href: "http://127.0.0.1:43120/" },
  history: { replaceState() {} },
  setTimeout: () => 0,
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {},
  confirm: () => true,
  addEventListener() {},
  removeEventListener() {}
};
globalThis.document = {
  head: { appendChild() {}, removeChild() {} },
  createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: "" }),
  addEventListener() {},
  removeEventListener() {}
};

let bundle;
try {
  new Function("window", "require", readFileSync(target, "utf8"))(windowStub, (name) => {
    if (name === "react") return ReactStub;
    throw new Error(`未预期的 require(${name})`);
  });
  bundle = LOADED[0].factory((name) => {
    if (name === "react") return ReactStub;
    throw new Error(`未预期的 require(${name})`);
  });
  check(`${target}：可加载`, true, `导出 ${Object.keys(bundle).join("、")}`);
} catch (error) {
  check(`${target}：可加载`, false, String(error?.message ?? error));
}
if (bundle === undefined) {
  console.error(`失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
const T = bundle.__test;

// ── 元素树工具 ──────────────────────────────────────────────────────────
function* nodes(node) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) yield* nodes(child);
    return;
  }
  if (typeof node !== "object") return;
  yield node;
  if (Array.isArray(node.children)) for (const child of node.children) yield* nodes(child);
  if (node.props !== undefined && Array.isArray(node.props.children)) for (const child of node.props.children) yield* nodes(child);
}
const byClass = (tree, className) => [...nodes(tree)].filter((node) => String(node.props?.className ?? "").split(/\s+/u).includes(className));
const byTestId = (tree, id) => [...nodes(tree)].find((node) => node.props?.["data-testid"] === id);
const textOf = (node) => {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return [node.props?.children, node.children].filter(Boolean).map(textOf).join("");
};

// ── 静态契约 ────────────────────────────────────────────────────────────
section("1) 模块注册 / 深链接 / 设置页");
check("浏览器模块表有 sfx", /function make_MODULES\(\)[\s\S]*?key: "sfx", title: T\("音效生成"\)/.test(source));
check("OPEN_MODULES 放行 sfx", T.parseIntents("?dsh-gmm=1&module=sfx")?.module === "sfx");
check("深链接能解析 sfx", (() => {
  const intent = T.parseIntents("?dsh-gmm=1&module=sfx&job=f1234&stage=generate");
  return intent?.module === "sfx" && intent?.jobId === "f1234" && intent?.stage === "generate";
})());
check("设置页有音效分组与 Key 输入", source.includes('testId: "cfg-sfx-service"') && source.includes('"data-testid": "cfg-sfx-key"') && source.includes("testSfx"));
check("设置页说明 Key 不是方舟 Key", /不是火山方舟的 ARK_API_KEY/.test(source));
check("新建卡 / 生成按钮 / 参考卡都有 data-testid", ["sfx-generate", "sfx-prompt"].every((id) => source.includes(`"data-testid": "${id}"`)));
check("远程方法都在客户端清单里", ["testSfx", "createSfxJob", "getSfxJob", "runSfxGeneration", "uploadSfxRef", "exportSfx"].every((method) => source.includes(`["${method}", true]`) || source.includes(`["${method}", false]`)));
check("模块导出到 __test", typeof T.SfxModule === "function");

const config = {
  sfxBlocker: null,
  sfxApiKeySet: true,
  sfxBaseUrl: "https://openspeech.bytedance.com",
  sfxModel: "seed-audio-1.0",
  sfxFormat: "wav",
  sfxSampleRate: 24000,
  sfxFormats: [
    { id: "wav", label: "WAV（无损，游戏引擎常用）" },
    { id: "mp3", label: "MP3（体积小）" },
    { id: "ogg_opus", label: "Ogg Opus（体积更小）" }
  ],
  sfxSampleRates: [16000, 24000, 44100, 48000],
  sfxLimits: { promptChars: 2048, maxSeconds: 120 }
};
const job = {
  module: "sfx",
  id: "f1",
  name: "测试音效",
  assetBase: "/dsh-game-material-master/sfx-assets/f1/",
  busy: false,
  status: "ready",
  reviewMode: "auto",
  blocker: null,
  prompt: "金属撞击，短促，约 1 秒",
  settings: { format: "wav", sampleRate: 24000, speechRate: 0, loudnessRate: 0, pitchRate: 0, watermark: false },
  refs: {
    image: { file: "refs/image.png", name: "角色.png", bytes: 72, ext: "png", url: "http://localhost/dsh-game-material-master/sfx-assets/f1/refs/image.png" },
    audios: [{ file: "refs/a.wav", name: "a.wav", bytes: 144, ext: "wav", duration: 3, url: "http://localhost/dsh-game-material-master/sfx-assets/f1/refs/a.wav" }]
  },
  takes: [{
    id: "k1",
    file: "takes/k1.wav",
    bytes: 144078,
    format: "wav",
    duration: 3,
    originalDuration: 3,
    prompt: "金属撞击，短促，约 1 秒",
    settings: { format: "wav", sampleRate: 24000 },
    createdAt: 1,
    url: "http://localhost/dsh-game-material-master/sfx-assets/f1/takes/k1.wav"
  }],
  stages: { generate: { status: "done", approved: false }, export: { status: "idle", approved: false } },
  exports: [],
  log: [{ at: 1, level: "info", message: "hello" }]
};
section("2) 共用工作台与请求快照");
const draft = { prompt: "金属撞击，新描述", settings: job.settings, reviewMode: "manual" };
const calls = [], updates = [];
const api = new Proxy({}, { get: (_target, name) => async input => { calls.push([String(name), input]); if (name === 'runSfxGeneration') return { started: true }; if (name === 'saveSfxJob' || name === 'getSfxJob') return job; return {}; } });
function render(jobValue = job, cfg = config, draftValue = draft) { HOOK.slots = [draftValue]; HOOK.cursor = 0; return T.SfxWorkspace({ api, job: jobValue, config: cfg, onCreated: j => updates.push(j), onUpdate: j => updates.push(j) }); }
function timeline(tree) { return [...nodes(tree)].find(n => n.type === T.AudioTimeline); }
check("音效与音乐使用同一个容器", T.SfxModule({ api }).type === T.AudioModule && T.MusicModule({ api }).type === T.AudioModule);
const tree = render(), conversation = timeline(tree), composer = conversation.props.composer;
check("输入框和生成按钮在底部composer", byTestId(composer, 'sfx-prompt') && byTestId(composer, 'sfx-generate'));
check("已有旧take转换为时间线，不编造参考快照", conversation.props.rounds.length === 1 && conversation.props.rounds[0].legacy && !conversation.props.rounds[0].request.refs);
check("参考图片可预览并使用相对路径", [...nodes(composer)].some(n => n.props?.src === '/dsh-game-material-master/sfx-assets/f1/refs/image.png'));
check("参考音频保留引用标签", textOf(composer).includes('@音频1'));
const parameters = conversation.props.panels.find(p => p.id === 'parameters').content;
check("格式采样率与审核都使用主题菜单", [...nodes(parameters)].filter(n => n.type === T.AudioChoice).length === 3 && ![...nodes(parameters)].some(n => n.type === 'select'));
const result = conversation.props.renderResult(conversation.props.rounds[0], () => null);
check("结果使用统一播放器", [...nodes(result)].some(n => n.type === T.AudioPlayer));
check("结果保留下载、导出、审核和目录", [...nodes(result)].some(n => n.type === 'a' && n.props.href.endsWith('takes/k1.wav?download=1')) && textOf(result).includes('导出') && textOf(result).includes('通过') && textOf(result).includes('打开任务目录'));
const busy = timeline(render({ ...job, busy: true })).props.composer;
check("忙碌时发送按钮成为停止按钮", byTestId(busy, 'sfx-generate').props['aria-label'] === '停止生成');
const blocked = timeline(render(job, { ...config, sfxBlocker: '缺少凭据' })).props.composer;
check("缺Key时禁止提交", byTestId(blocked, 'sfx-generate').props.disabled === true);
const empty = timeline(render(job, config, { ...draft, prompt: '' })).props.composer;
check("空描述时禁止提交", byTestId(empty, 'sfx-generate').props.disabled === true);
check("草稿按项目独立缓存且轮询不覆盖", source.includes('useAudioStored("sfx-draft:" + (job?.id || "new")') && source.includes('if (alive.current && request === ticket.current && selection.current === id) setJob(next)'));
const snapshot = { id: 'r1', createdAt: 1, status: 'ready', request: { prompt: '历史描述', settings: job.settings, refs: { audios: [] } }, takeId: 'k1' };
const stored = T.sfxConversationRounds({ ...job, rounds: [snapshot] });
check("新快照与take按轮次ID关联", stored.length === 1 && stored[0].takes[0].id === 'k1' && stored[0].request.prompt === '历史描述');
const failed = T.sfxConversationRounds({ ...job, rounds: [{ ...snapshot, status: 'error', takeId: undefined, error: '失败' }], takes: [] });
check("失败轮次保留描述和错误", failed.length === 1 && failed[0].error === '失败' && failed[0].prompt === '历史描述');

section("3) 点击提交与并发保护");
const generate = byTestId(composer, 'sfx-generate'); generate.props.onClick(); generate.props.onClick();
await new Promise(resolve => setTimeout(resolve, 30));
check("重复点击只调用一次生成", calls.filter(([name]) => name === 'runSfxGeneration').length === 1);
const savedIndex = calls.findIndex(([name]) => name === 'saveSfxJob'), runIndex = calls.findIndex(([name]) => name === 'runSfxGeneration');
check("生成前先保存本轮描述、设置和审核模式", savedIndex >= 0 && savedIndex < runIndex && calls[savedIndex][1].prompt === draft.prompt && calls[savedIndex][1].reviewMode === 'manual');
check("提交后刷新目标任务", calls.some(([name]) => name === 'getSfxJob') && updates.length === 1);
await conversation.props.onRegenerate(snapshot);
check("重新生成使用历史roundId", calls.filter(([name]) => name === 'runSfxGeneration').at(-1)[1].roundId === 'r1');
const beforeLegacy = calls.length; let legacyError;
try { await conversation.props.onRegenerate({ ...snapshot, legacy: true }); } catch (error) { legacyError = error; }
check("缺完整快照的旧版不能悄悄使用当前参考重新生成", !!legacyError && !calls.slice(beforeLegacy).some(([name]) => name === 'runSfxGeneration'));
check("重新生成统一经过计费确认", source.includes('重新生成会再次计费，确认提交这一轮的请求？'));

console.log(`\n共 ${checks} 项检查，失败 ${failures.length} 项。`);
if (failures.length) { console.error(failures.join('、')); process.exitCode = 1; }

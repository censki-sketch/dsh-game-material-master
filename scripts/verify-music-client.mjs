/**
 * 音乐生成编辑（模块七）· 浏览器半区契约自检（不需要浏览器、不联网）。
 *
 *   node scripts/verify-music-client.mjs
 *
 * 钉住三件事：
 *   ① 静态契约：模块注册、深链接、创建卡的 HTML 结构、设置页字段、提示词步骤；
 *   ② 真渲染：用假 React 把 MusicModule 渲染成元素树，断言歌曲卡 / 编辑器 /
 *      版本 / 导出 / 遮罩真的出现；
 *   ③ 新对话：假 sessions/uiWorkspace 断言「先 createMusicJob、再开不挂靠项目的
 *      对话、把带 jobId 的任务说明作为第一句话发出去」。
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
check("浏览器模块表有 music", /function make_MODULES\(\)[\s\S]*?key: "music", title: T\("音乐生成编辑"\)/.test(source));
check("OPEN_MODULES 放行 music", source.includes('const OPEN_MODULES = new Set(["sprite", "image", "sequence", "rig", "iso", "map", "music", "sfx"])'));
check("★ origin 上报失败会退避重试（宿主刚重启时不能永远停在 localhost）", source.includes("const send = (attempt)") && source.includes("attempt < 60") && source.includes('addEventListener("focus"') && source.includes("visibilitychange"));
check("解析 music 深链接", (() => {
  const intent = T.parseIntents("?dsh-gmm=1&module=music&job=a1234&stage=edit");
  return intent?.module === "music" && intent?.jobId === "a1234" && intent?.stage === "edit";
})());
check("深链接意图里含 music 的 jobId 字段", source.includes('const jobId = params.get("job")'));
check("设置页有音乐分组与 Key 输入", source.includes("音乐生成（谱乐 AI）") && source.includes('"data-testid": "cfg-music-key"') && source.includes("testMusic"));
check("设置页说明只支持谱乐 AI", /只支持谱乐 AI/.test(source));
check("创建卡有灵感/歌词两个页签", source.includes('label: T("输入方式")') && source.includes('value: draft.kind'));
check("创建卡提交按钮带 data-testid", source.includes('"data-testid": "music-submit"'));
check("编辑器有起止/音量/淡入淡出/标准化控件", ["music-edit-start", "music-edit-end", "music-edit-gain", "music-edit-fade-in", "music-edit-fade-out"].every((id) => source.includes(`testId: "${id}"`)) && source.includes('"data-testid": "music-edit-normalize"'));
check("波形有 data-testid", source.includes('"data-testid": "music-wave"'));
check("导出按钮有 data-testid", source.includes('"data-testid": "music-export"'));
check("模块级文案表加入 rebuilders", source.includes("MUSIC_ENGINES = make_MUSIC_ENGINES();") && source.includes("MUSIC_PHASES = make_MUSIC_PHASES();"));
check("music 的远程方法都在客户端清单里", ["getMusicGuide", "runMusicGeneration", "renderMusicEdit", "exportMusic"].every((method) => source.includes(`["${method}", true]`) || source.includes(`["${method}", false]`)));

// ── 提示词 / 对话桥 ─────────────────────────────────────────────────────
section("2) 新对话提示词");
const prompt = T.buildMusicRequestPrompt({
  jobId: "a1234",
  jobName: "Battle Loop",
  kind: "lyrics",
  prompt: "",
  lyrics: "[Verse]\nline one\nline two",
  note: "90 秒，不要人声",
  title: "Battle",
  tags: "8-bit",
  instrumental: true,
  preferredEngine: "suno",
  reviewMode: "manual",
  lang: "zh"
});
check("提示词含 jobId", prompt.includes("a1234"));
check("提示词含用户完整歌词", prompt.includes("[Verse]\nline one\nline two"));
check("提示词要求先读手册与指南", prompt.includes("action:'guide'") && prompt.includes("getMusicGuide"));
check("提示词要求提交与等待", prompt.includes("runMusicGeneration") && prompt.includes("action:'wait'"));
check("提示词要求后期与导出", prompt.includes("renderMusicEdit") && prompt.includes("exportMusic"));
check("提示词要求贴回链", prompt.includes("openUrl") && prompt.includes("Markdown"));
check("提示词强调 openUrl 是插件入口、music-assets 只是文件直链", prompt.includes("music-assets") && prompt.includes("插件入口"));
check("manual 模式要求停下等确认", /停下等我回复/.test(prompt));
check("不调用其它模块工具", /不要调用其它模块的工具/.test(prompt));

let created = null;
let prompted = null;
let opened = null;
const sessions = {
  create: async () => "s1",
  retain: () => ({
    ready: Promise.resolve(),
    binding: { session: { beginSubmission: () => ({ requestId: "r1", abandon() {} }), prompt: async (blocks, mode, _x, id) => { prompted = { blocks, mode, id }; return { ok: true }; } } },
    release() {}
  })
};
const workspace = { openSession: (id) => { opened = id; } };
const ctxBridge = {
  get: (name) => (name === "sessions" ? sessions : name === "uiWorkspace" ? workspace : undefined),
  inject: (_names, fn) => fn(ctxBridge)
};
T.attachSessionBridge(ctxBridge);
await T.openMusicChat(prompt);
check("新对话：不挂靠项目（sessions.create({})）并打开会话", opened === "s1");
check("新对话：首条消息就是任务说明", prompted?.mode === "queue" && prompted?.blocks?.[0]?.text?.startsWith("【游戏素材大师 · 音乐生成编辑】"));
check("新对话：带 requestId", prompted?.id === "r1");

const job = {
  module: "music",
  id: "a1",
  name: "测试音乐",
  assetBase: "/dsh-game-material-master/music-assets/a1/",
  busy: false,
  reviewMode: "auto",
  updatedAt: 1,
  songsReady: 1,
  songsTotal: 1,
  source: { kind: "prompt", prompt: "8-bit battle loop", lyrics: "", note: "90 秒", title: "Battle", tags: "8-bit", instrumental: true },
  settings: { engine: "suno", mode: "prompt", model: "chirp-v6" },
  stages: { generate: { status: "done" }, edit: { status: "idle" }, export: { status: "idle" } },
  songs: [{ id: "song1", status: "succeeded", title: "Battle Take", engine: "suno", modelName: "chirp-v6", duration: 3, tags: "8-bit", approved: false, localFile: "songs/song-song1.mp3", file: "songs/song-song1.mp3", url: "http://localhost/dsh-game-material-master/music-assets/a1/songs/song-song1.mp3", coverFile: "songs/cover-song1.jpg", coverUrl: "http://localhost/dsh-game-material-master/music-assets/a1/songs/cover-song1.jpg", wavUrl: null, lrcUrl: null, lyric: "[Verse]\nla la" }],
  versions: [{ id: "v1", songId: "song1", label: "裁剪", status: "ready", format: "mp3", duration: 2, size: 1234, preview: false, by: "human", createdAt: 1, file: "versions/v1.mp3", url: "http://localhost/dsh-game-material-master/music-assets/a1/versions/v1.mp3" }],
  tools: [{ id: "t1", kind: "style-analysis", status: "succeeded", result: { description: "bright", genres: ["chiptune"] }, files: [] }],
  exports: [],
  log: [{ at: 1, level: "info", message: "hello" }]
};
const config = { musicBlocker: null, musicApiKeySet: true };
const composeConfig = {
  ...config,
  musicApiKeySet: true,
  musicScoreStatus: {
    ok: true,
    renderer: "builtin",
    python: { ok: true, path: "/usr/bin/python3", version: "3.12.0" },
    scoremill: { ok: true, version: "0.5.0" },
    fluidsynth: { ok: false },
    soundfont: { ok: false },
    ffmpeg: { ok: true, path: "ffmpeg", version: "8.1.1" },
    blocker: null,
    warnings: ["没找到 FluidSynth：试听会用插件内置的简易音源。"],
    checkedAt: 1
  }
};
const composeJob = {
  module: "music",
  id: "a2",
  name: "战斗曲",
  assetBase: "/dsh-game-material-master/music-assets/a2/",
  busy: false,
  workflow: "compose",
  reviewMode: "auto",
  updatedAt: 1,
  songsReady: 0,
  songsTotal: 0,
  source: { kind: "prompt", prompt: "一首战斗曲", lyrics: "", note: "90 秒", title: "Battle", tags: "", instrumental: true },
  settings: { engine: "suno", mode: "custom", model: "chirp-v6" },
  scorePlan: {
    summary: "前 8 小节压抑，中段铜管主题，结尾 unresolved。",
    style: "chiptune",
    mood: "tense",
    key: "D minor",
    tempo: 150,
    timeSignature: "4/4",
    structure: [{ name: "INTRO", bars: 8, energy: "p" }, { name: "MAIN", bars: 16, energy: "f" }],
    instrumentation: [{ name: "lead" }, { name: "bass" }],
    instrumental: true
  },
  currentScoreId: "c1",
  compositions: [{
    id: "c1",
    label: "第 1 版",
    title: "Battle",
    plan: { summary: "前 8 小节压抑，中段铜管主题，结尾 unresolved。", style: "chiptune", tempo: 150, timeSignature: "4/4", structure: [{ name: "INTRO", bars: 8 }], instrumentation: [{ name: "lead" }], instrumental: true },
    script: "from scoremill import Song\n",
    scriptFile: "scores/c1/compose.py",
    midiFile: "scores/c1/score.mid",
    midiUrl: "http://localhost/dsh-game-material-master/music-assets/a2/scores/c1/score.mid",
    audioFile: "scores/c1/preview.mp3",
    audioUrl: "http://localhost/dsh-game-material-master/music-assets/a2/scores/c1/preview.mp3",
    audioRenderer: "builtin",
    midi: { duration: 32, bars: 24, tempo: 150, timeSignature: "4/4", tracks: 1, channels: 2, notes: 120 },
    status: "ready",
    approved: false,
    createdAt: 1,
    updatedAt: 1
  }],
  stages: { compose: { status: "done" }, generate: { status: "idle" }, edit: { status: "idle" }, export: { status: "idle" } },
  songs: [],
  versions: [],
  tools: [],
  exports: [],
  log: []
};
const composeIntent = T.parseIntents("?dsh-gmm=1&module=music&job=a1234&stage=compose&score=c123");
check("★ 深链接解析 score", composeIntent?.stage === "compose" && composeIntent?.score === "c123", JSON.stringify(composeIntent));

const composePrompt = T.buildComposeRequestPrompt({
  jobId: "a1234",
  jobName: "战斗曲",
  prompt: "一首战斗曲",
  lyrics: "",
  note: "90 秒",
  title: "Battle",
  instrumental: true,
  reviewMode: "manual",
  lang: "zh",
  scoreStatus: composeConfig.musicScoreStatus
});
check("★ 谱曲提示词要求先输出方案", composePrompt.includes("分析并输出方案") && composePrompt.includes("用用户的语言"));
check("★ 谱曲提示词要求保存方案", composePrompt.includes("saveMusicScorePlan"));
check("★ 谱曲提示词要求 local scoremill 脚本", composePrompt.includes("compose.py") && composePrompt.includes("runMusicScore") && composePrompt.includes("s.save('score.mid')"));
check("★ 谱曲提示词要求 manual 停下等确认", composePrompt.includes("停下"));
check("★ 谱曲提示词要求逐版修改且保留旧版", composePrompt.includes("basedOn") && composePrompt.includes("旧 MIDI"));
check("★ 谱曲提示词说明 Suno 计费且先上传试听音频", composePrompt.includes("submitMusicScoreToSuno") && composePrompt.includes("试听音频") && composePrompt.includes("cover") && composePrompt.includes("copyrightAudio") && composePrompt.includes("绝不自动提交"));

section("3) 共用侧栏与聊天工作台");
const draft = { workflow: "generate", kind: "prompt", prompt: "battle", lyrics: "", title: "", note: "", tags: "", instrumental: true, preferredEngine: "", reviewMode: "auto" };
const fakeApi = new Proxy({}, { get: () => async () => ({}) });
function render(fn, props, slots = []) { HOOK.slots = slots; HOOK.cursor = 0; return fn(props); }
const musicShell = T.MusicModule({ api: fakeApi }), sfxShell = T.SfxModule({ api: fakeApi });
check("音乐和音效使用同一个 AudioModule", musicShell.type === T.AudioModule && sfxShell.type === T.AudioModule);
check("AudioModule 复用已有 JobSidebar", source.includes('const sidebar = useAudioSidebar({ api, module, jobs') && source.includes('h(JobSidebar, { title: T("项目"), storageKey: module'));
const workspaceTree = render(T.MusicWorkspace, { api: fakeApi, job: null, config: {}, onCreated() {}, onUpdate() {} }, [draft]);
const timeline = [...nodes(workspaceTree)].find(n => n.type === T.AudioTimeline), composer = timeline.props.composer;
check("默认展示聊天时间线与固定输入框", !!timeline && byTestId(composer, "music-submit") && byTestId(composer, "music-prompt"));
const choices = [...nodes(composer)].filter(n => n.type === T.AudioChoice);
check("创作模式、输入方式、引擎与审核使用主题菜单", choices.length === 4 && ![...nodes(composer)].some(n => n.type === "select"));
check("没有打开弹窗时不会提前渲染编辑器", !byTestId(workspaceTree, "music-editor"));
check("提交ref锁在所有await之前", /if \(lock.current \|\| job\?\.busy\) return;[\s\S]{0,350}lock.current = true; setCreating\(true\)/.test(source));
check("音乐轮询使用固定间隔并保留编辑草稿", source.includes('module === "sfx" ? 2500 : 4000') && source.includes('if (id && selection.current === id) void loadJob(id, false)') && !source.includes('setPrompt(next.source'));
check("迟到项目响应通过selection与ticket校验", source.includes('request === ticket.current && selection.current === id'));
check("付费操作没有原生确认弹窗", !source.slice(source.indexOf('function MusicWorkspace'), source.indexOf('// ── 模块八')).includes('window.confirm'));
const sourceSnapshot = { ...draft, conversationId: "round-a" };
job.generations = [{ id: "g1", startedAt: 1, source: sourceSnapshot, status: "succeeded", songIds: ["song1"] }];
job.songs[0].generationId = "g1";
let rounds = T.musicConversationRounds(job);
check("歌曲和编辑版按conversationId归入一轮", rounds.length === 1 && rounds[0].id === "round-a" && rounds[0].files.includes('versions/v1.mp3'));
const songProps = { job, song: job.songs[0], favorite: () => null, onEdit() {}, onExport() {}, onSave() {}, onDelete() {}, onApprove() {} };
const songTree = render(T.MusicSongResult, songProps);
check("封面优先使用assetBase", [...nodes(songTree)].some(n => n.type === "img" && n.props.src === '/dsh-game-material-master/music-assets/a1/songs/cover-song1.jpg'));
const versionTree = render(T.MusicSongResult, songProps, ["v1"]);
check("编辑版下载使用相对资源地址", [...nodes(versionTree)].some(n => n.type === "a" && n.props.href === '/dsh-game-material-master/music-assets/a1/versions/v1.mp3?download=1'));
check("歌曲由统一播放器播放", [...nodes(songTree)].some(n => n.type === T.AudioPlayer));
const editTree = render(T.MusicWorkspace, { api: fakeApi, job, config: {}, onCreated() {}, onUpdate() {} }, [draft, null, false, "edit", null, "song1", { start: 0, end: 3, gainDb: 0, fadeIn: 0, fadeOut: 0, format: "mp3" }]);
check("编辑器按需打开并保留裁剪渲染功能", byTestId(editTree, "music-editor") && byTestId(editTree, "music-render"));
check("编辑器也没有原生audio controls或select", ![...nodes(editTree)].some(n => n.type === "select" || n.type === "audio" && n.props.controls));
const composeTree = render(T.MusicWorkspace, { api: fakeApi, job: null, config: composeConfig, onCreated() {}, onUpdate() {} }, [{ ...draft, workflow: "compose" }]);
const composeTimeline = [...nodes(composeTree)].find(n => n.type === T.AudioTimeline);
check("谱曲模式使用想法输入框", !!byTestId(composeTimeline.props.composer, "music-compose-prompt"));
check("谱曲提交仅检查本地依赖，不受musicBlocker影响", source.includes('compose ? cfg?.musicScoreStatus?.blocker') && source.includes(': cfg?.musicBlocker'));
composeJob.compositions[0].source = { ...sourceSnapshot, conversationId: "round-compose" };
composeJob.generations = [{ id: "cover-g", startedAt: 2, source: composeJob.compositions[0].source, status: "succeeded", songIds: [] }];
const composedWorkspace = render(T.MusicWorkspace, { api: fakeApi, job: composeJob, config: composeConfig, onCreated() {}, onUpdate() {} }, [{ ...draft, workflow: "compose" }]);
const composedTimeline = [...nodes(composedWorkspace)].find(n => n.type === T.AudioTimeline);
check("谱曲和其正式版按轮次合并", composedTimeline.props.rounds.length === 1 && composedTimeline.props.rounds[0].compositions.length === 1);
const olderScoreRounds = T.musicConversationRounds({ ...composeJob, source: { ...sourceSnapshot, conversationId: 'new-round' }, generations: [{ ...composeJob.generations[0], scoreId: composeJob.compositions[0].id, source: { ...sourceSnapshot, conversationId: 'new-round' } }] });
check("旧谱曲交Suno始终归回原轮，不跟随当前source", olderScoreRounds.length === 1 && olderScoreRounds[0].id === 'round-compose' && olderScoreRounds[0].request.conversationId === 'round-compose');
const scoreTree = composedTimeline.props.renderResult(composedTimeline.props.rounds[0], () => null);
check("谱曲保留MIDI、试听、Suno与乐谱包", textOf(scoreTree).includes('下载 MIDI') && textOf(scoreTree).includes('下载试听') && textOf(scoreTree).includes('交给 Suno') && textOf(scoreTree).includes('导出乐谱包'));
const scorePlayer = [...nodes(scoreTree)].find(n => n.type === T.AudioPlayer);
check("谱曲试听地址仍优先assetBase", scorePlayer?.props.src === '/dsh-game-material-master/music-assets/a2/scores/c1/preview.mp3');
const scoreDetail = render(T.MusicWorkspace, { api: fakeApi, job: composeJob, config: composeConfig, onCreated() {}, onUpdate() {} }, [{ ...draft, workflow: 'compose' }, null, false, 'c1']);
check("谱曲方案和脚本按需查看", textOf(scoreDetail).includes('前 8 小节压抑') && textOf(scoreDetail).includes('查看 compose.py'));
T.writeAudioState('music-submissions:a1', [{ id: 'pending-id', createdAt: 3, source: sourceSnapshot, sessionId: 's1' }]);
rounds = T.musicConversationRounds(job);
check("等待DSH的提交有描述和等待状态", rounds.some(r => r.id === 'pending-id' && r.status === 'waiting' && r.sessionId === 's1'));
check("旧版歌曲缺少快照时不伪造请求", T.musicConversationRounds({ ...job, id: 'legacy', generations: [] }).every(r => r.request === null));

// ── 功能管理 ────────────────────────────────────────────────────────────
section("5) 功能管理");
check("music 在可见模块里", T.visibleModulesOf([]).some((entry) => entry.key === "music"));
check("隐藏 music 后不在可见模块里", !T.visibleModulesOf(["music"]).some((entry) => entry.key === "music"));
check("normalizeHiddenKeys 保留 music", T.normalizeHiddenKeys(["music", "nope"]).includes("music"));

console.log("");
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
console.log(`共 ${checks} 项检查，全部通过。`);

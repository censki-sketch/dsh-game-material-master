/**
 * 「调用接口时的视觉反馈」真机自检：不需要浏览器、不联网。
 *
 *   node scripts/verify-feedback.mjs                # 默认加载 lib/client.js 真跑渲染
 *   node scripts/verify-feedback.mjs <bundle.js>    # 指定别的产物
 *
 * 为什么单独写一份：`verify-client.mjs` 只做**文本层面**的契约检查（调用点有没有
 * 传 key/label），证明不了「传了之后界面真的会长出遮罩」。这份脚本把产物真正加载
 * 起来，用假的 `window.__ModuleLoader__` 抓住插件体、用假的 React 抓住 Hook 槽位，
 * 再用桩数据渲染出元素树，逐个断言遮罩真的出现了：
 *
 *   - 点「重新生成」时那个方向的缩略图外面必须有 loading 遮罩，文案带方向名；
 *   - 批量生成时还没轮到的方向也要盖住（否则旧图看着像「没反应」）；
 *   - 宿主侧状态是 running（而不是本地 pending）时同样要有遮罩；
 *   - **没有任务在跑时一个遮罩都不能有**（否则界面永远糊着一层黑）。
 *
 * 这类 bug 实测很难靠肉眼发现：不盖遮罩时界面看起来完全正常，只是「点了没反应」，
 * 用户会以为按钮失效而反复点击——而每次点击都是一次真实计费的生图 / 生视频。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const failures = [];
let checks = 0;
/** Hook 槽位越界的证据，随渲染结果一起返回，而不是打日志。 */
let hookOverflow = false;
function check(name, ok, detail) {
  checks++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(name);
}
function section(title) {
  console.log(`\n${title}`);
}

const target = process.argv[2] ?? fileURLToPath(new URL("../lib/client.js", import.meta.url));
// 模块个数与 key 从**宿主清单**派生：写死 5 的话，加模块时这里必然漏（这些断言
// 原本就是硬编码的 `=== 5`，模块六接进来时当场变红）。
const linksForModules = await import("../lib/links.js");
const MODULE_COUNT = linksForModules.STUDIO_MODULES.length;
const MODULE_KEYS = [...linksForModules.STUDIO_MODULES];

// ── 假 React：createElement 产出纯对象，Hook 按槽位取值 ──────────────────
const HOOK = { slots: [], cursor: 0, overflow: false };

const ReactStub = {
  Fragment: Symbol.for("react.fragment"),
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  cloneElement(element, props) {
    return { ...element, props: { ...element.props, ...props } };
  },
  useState(initial) {
    const index = HOOK.cursor++;
    const value = HOOK.slots[index];
    return [value === undefined ? (typeof initial === "function" ? initial() : initial) : value, next => { if (HOOK.capture) HOOK.capture.push({ index, next }); }];
  },
  useRef(initial) {
    HOOK.cursor++;
    return { current: initial };
  },
  useEffect(fn, deps) { HOOK.effects?.push({ fn, deps }); },
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

// ── 加载产物 ─────────────────────────────────────────────────────────────
const source = readFileSync(target, "utf8");
const LOADED = [];
const CLIENT_EVENTS = [];
const windowStub = {
  dispatchEvent(event) { CLIENT_EVENTS.push(event); return true; },
  __ModuleLoader__: {
    load(registration) {
      LOADED.push(registration);
    }
  },
  // 深链接用到的最小 location/history 面（默认没有深链接参数）。
  location: { origin: "http://127.0.0.1:43120", search: "", href: "http://127.0.0.1:43120/" },
  history: {
    // 真浏览器的 replaceState 会同步地址栏；桩里手动把 Location 的两处一起改，
    // 否则「参数被清掉」这条断言永远测不到东西。
    replaceState(_state, _title, url) {
      const next = new URL(url, windowStub.location.href);
      windowStub.location.href = next.toString();
      windowStub.location.search = next.search;
    }
  },
  setTimeout: (fn) => {
    fn();
    return 0;
  }
};

/** 捕获 document 上的点击监听器（深链接拦截器就装在这里）。 */
const CLICK_LISTENERS = [];
globalThis.document = {
  head: { appendChild() {}, removeChild() {} },
  // 插件用 <style> 注入自己的 CSS；这里只要求它不炸，样式内容由 verify-client 检查。
  createElement: () => ({
    setAttribute() {},
    remove() {},
    style: {},
    textContent: ""
  }),
  addEventListener(type, listener) {
    if (type === "click") CLICK_LISTENERS.push(listener);
  },
  removeEventListener(type, listener) {
    const index = CLICK_LISTENERS.indexOf(listener);
    if (index >= 0) CLICK_LISTENERS.splice(index, 1);
  }
};

function report() {
  console.log("");
  if (failures.length > 0) {
    console.error(`失败 ${failures.length} 项：${failures.join("、")}`);
    process.exit(1);
  }
  console.log(`共 ${checks} 项检查，全部通过。`);
  process.exit(0);
}

try {
  // 经典脚本：顶层就是一次 __ModuleLoader__.load(...) 调用。
  new Function("window", "require", source)(windowStub, (name) => {
    if (name === "react") return ReactStub;
    throw new Error(`未预期的 require(${name})`);
  });
} catch (error) {
  check(`${target}：可加载`, false, String(error?.message ?? error));
  report();
}
check(`${target}：可加载`, true);
check("注册了唯一插件体", LOADED.length === 1, `${LOADED.length} 个 load()`);
if (LOADED.length !== 1) report();

let bundle;
try {
  bundle = LOADED[0].factory((name) => {
    if (name === "react") return ReactStub;
    throw new Error(`未预期的 require(${name})`);
  });
} catch (error) {
  check("factory 可执行", false, String(error?.message ?? error));
  report();
}
check("factory 可执行", true, `导出 ${Object.keys(bundle).join("、")}`);

// ── 抓住三个挂载点里的组件 ───────────────────────────────────────────────
const REGISTERED = {};
const SELECTED_PANELS = [];
const fakeCtx = {
  effect(fn) {
    return fn();
  },
  get(name) {
    if (name === "layout") {
      return {
        selectPanel(panelId) {
          SELECTED_PANELS.push(panelId);
        }
      };
    }
    return undefined;
  },
  slots: {
    inject(name, fn) {
      return fn();
    },
    register(options, component) {
      REGISTERED[options.name] = component;
      return () => {};
    }
  },
  remote: {
    $mount() {
      return Promise.resolve();
    }
  }
};

try {
  bundle.apply(fakeCtx);
} catch (error) {
  check("apply 可执行", false, String(error?.message ?? error));
  report();
}
check("apply 可执行", true, Object.keys(REGISTERED).join("、"));

const panel = REGISTERED.main;
check("挂上了 main 工作台组件", typeof panel === "function", typeof panel);

// ── 元素树工具 ───────────────────────────────────────────────────────────
/**
 * 深度遍历元素树。函数组件（MediaBox / LoadingOverlay / BusyBadge / BusyBtn…）
 * 在树里只是「type 是函数」的节点，必须**真的把它们渲染出来**才能看到里面的
 * `SPR_ovl` —— 这正是本测试要验证的东西，不能只看 props。
 *
 * 注意：`h(tag, props, ...children)` 的子节点在元素对象的 `children` 上，
 * 不在 `props.children` 上；只遍历 props 会一个 `SPR_node` 都找不到。
 */
function collect(node, predicate, out = [], seen = new Set()) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out, seen);
    return out;
  }
  if (seen.has(node)) return out;
  seen.add(node);
  if (predicate(node)) out.push(node);
  // `children` 正常情况下是数组；万一它是别的东西（例如被 memo 包了一层），
  // 就跳过而不是抛异常——测试要报告缺遮罩，不该被遍历本身打断。
  if (Array.isArray(node.children)) {
    for (const child of node.children) collect(child, predicate, out, seen);
  }
  for (const value of Object.values(node.props ?? {})) {
    if (value !== null && typeof value === "object") collect(value, predicate, out, seen);
  }
  if (typeof node.type === "function") {
    // 函数组件要按 React 语义渲染：children 通过 props 传进去，不在 props 里。
    // 只传 node.props 的话，`h(Btn, {...}, "通过")` 里的文字会整段丢掉——
    // 于是「按钮没有文案」这种界面问题在测试里反而看不出来。
    const children = Array.isArray(node.children) ? node.children.filter((child) => child !== null && child !== undefined) : [];
    const props = { ...(node.props ?? {}) };
    if (children.length === 1) props.children = children[0];
    else if (children.length > 1) props.children = children;
    collect(node.type(props), predicate, out, seen);
  }
  return out;
}
const byClass = (tree, className) =>
  collect(tree, (node) => node.props?.className === className);
const overlays = (tree) => byClass(tree, "SPR_ovl");
/** 按标签收元素（`<a download>` / `<input type=file>` 这些没有专属类名）。 */
const byTag = (tree, tag) => collect(tree, (node) => node.type === tag);
/** 所有「保存」链接：`<a download>` 才算（`<a>` 也可能是外链）。 */
const saveLinks = (tree) =>
  byTag(tree, "a").filter((node) => typeof node.props?.download === "string");
const saveNames = (tree) => saveLinks(tree).map((node) => String(node.props.download));
const saveHrefs = (tree) => saveLinks(tree).map((node) => String(node.props.href ?? ""));
/** 「选择本地视频」的槽位按钮：label 标签里包着一个隐藏的 file input。 */
const localPickers = (tree) =>
  byTag(tree, "label").filter(
    (node) => typeof node.props?.["data-testid"] === "string" && /local-video/.test(node.props["data-testid"])
  );
const fileInputsOf = (picker) => byTag(picker, "input").filter((node) => node.props?.type === "file");
const textOf = (node) => {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.children ?? []);
};
const overlayText = (tree) => overlays(tree).map(textOf).join(" | ");
/** 空态格子上的文案（「尚未抽帧」这类）：没产物时有没有被正确盖住，全看这里。 */
const emptyTexts = (tree) => byClass(tree, "SPR_thumbEmpty").map(textOf);

/** 验收控件：审核模式下拉（auto/manual）与「通过」按钮。 */
const modeOptions = (tree) => collect(tree, (node) => node.type === "option").map((node) => node.props?.value);
const approveLabels = (tree) =>
  collect(tree, (node) => node.props?.className === "SPR_btn")
    .map(textOf)
    .filter((text) => text === "通过" || text === "已通过");
const hasReviewModeSelect = (tree) => {
  const options = modeOptions(tree);
  return options.includes("auto") && options.includes("manual");
};

// ── 桩数据 ───────────────────────────────────────────────────────────────
const COMPASSES = ["front", "back", "downLeft", "downRight", "upLeft", "upRight", "left", "right"];

function makeProject(overrides = {}) {
  const images = {};
  const videos = {};
  const frames = {};
  for (const compass of COMPASSES) {
    images[compass] = { file: `images/${compass}.png`, status: "ready", updatedAt: 1 };
    videos[compass] = { file: `videos/${compass}.mp4`, status: "ready", updatedAt: 1, remoteStatus: "Success" };
    frames[compass] = { strip: `frames/${compass}.png`, status: "ready", updatedAt: 1, duration: 4, frames: ["a.png"] };
  }
  return {
    id: "p1",
    name: "角色",
    assetBase: "/dsh-game-material-master/assets/p1/",
    updatedAt: 1,
    source: { file: "source/hero.png", name: "hero.png" },
    images,
    videos,
    frames,
    sheet: {
      file: "out/sheet.png",
      status: "ready",
      approved: false,
      generatedAt: 1,
      width: 1024,
      height: 1024,
      rowOrder: null
    },
    prompts: { images: {}, video: "" },
    settings: {},
    log: [],
    jobs: [],
    ...overrides
  };
}

/** 伪 pending 表：activeKeys 里的 key 视为「正在调用接口」。 */
function makeTasks(activeKeys = []) {
  const labels = {};
  for (const key of activeKeys) labels[key] = `正在处理 ${key}…`;
  return {
    map: { ...labels },
    run: () => Promise.resolve(),
    has: (key) => labels[key] !== undefined,
    label: (key) => labels[key],
    any: (prefix) => Object.keys(labels).some((key) => key.startsWith(prefix)),
    keys: (prefix) => Object.keys(labels).filter((key) => key.startsWith(prefix)),
    active: Object.keys(labels).length > 0,
    firstLabel: Object.values(labels)[0]
  };
}

const noop = () => {};
const api = new Proxy(
  {},
  {
    get: () => () => Promise.resolve({})
  }
);

/**
 * 每个组件的「Hook 调用总数」（useState + useRef），顺序与数量都不能变。
 *
 * 为什么用确切数字而不是「不越界」：桩槽位是按顺序喂值的，顺序一挪，
 * 某个 useState 就会读到别人的值——界面上表现为莫名其妙的初始值，
 * 本地却什么都看不出来。数字变了就说明 Hook 顺序改了，必须同步这里的槽位。
 */
const EXPECTED_HOOKS = {
  StudioPanel: 26,
  ImageModule: 25,
  SequenceModule: 17
};

/**
 * 渲染 StudioPanel 的某个阶段。
 *
 * StudioPanel 的 Hook 顺序（**槽位下标**，顺序不能错；useRef 不读槽位，
 * 但同样占一个下标）：
 * 以下为原流程基准索引；实际第 5 槽是 spriteWorkflow，原第 5 槽起顺延一位。
 * renderStage 先填基准索引，再 splice 插入流程选择，便于维护旧阶段夹具。
 *   0 useLocaleTick / 1 projects / 2 projectId / 3 project / 4 stage / 5 module /
 *   6 notice / 7 loading / 8 promptDraft / 9 promptOpen / 10 videoPromptDraft /
 *   11 settingsDraft / 12 sourceBusy / 13 dropOver /
 *   14 fileInputRef(useRef) / 15 usePendingTasks 的 map / 16·17 usePendingTasks 内部两个 ref /
 *   18 useStudioIntent（深链接意图；null = 没有待处理的链接）/
 *   19 useHiddenModules（被隐藏的功能模块 key 数组；[] = 五个全可见）/
 *   20 loadedPrompts(useRef，上次从宿主读到的提示词；不读槽位)
 *
 * ⚠️ 槽位是**稀疏**的：下标 18 之前的几个 `undefined` 会让桩回落到 Hook 的初始值，
 * 所以新加的 Hook 必须显式写它的下标——顺手 append 到数组末尾会落到 ref 槽上，
 * 测试会「看起来没生效」。
 *
 * `hidden` 就是第 19 槽：传 `["rig"]` 之类就能测「隐藏后页签里不再出现」。
 */
function renderStage(project, stage, tasks, hidden = [], workflow = "classic", module = "sprite") {
  HOOK.slots = [];
  HOOK.slots[0] = 0;
  HOOK.slots[1] = ["p1"];
  HOOK.slots[2] = "p1";
  HOOK.slots[3] = project;
  HOOK.slots[4] = stage;
  HOOK.slots[5] = module;
  HOOK.slots[6] = null;
  HOOK.slots[7] = false;
  HOOK.slots[8] = {};
  HOOK.slots[9] = {};
  HOOK.slots[10] = "";
  HOOK.slots[11] = {};
  HOOK.slots[12] = false;
  HOOK.slots[13] = false;
  HOOK.slots[14] = undefined;
  HOOK.slots[15] = tasks.map;
  HOOK.slots[16] = null;
  HOOK.slots[19] = hidden;
  // The workflow selector follows stage; existing fixtures exercise classic sprites.
  HOOK.slots.splice(5, 0, workflow);
  HOOK.cursor = 0;
  hookOverflow = false;
  const tree = panel({ api });
  return { tree, overflow: false, hooks: HOOK.cursor };
}

if (typeof panel !== "function") report();
// 下方阶段夹具代表配置已加载；浏览器用例另行覆盖配置延迟。
bundle.__test.publishModuleOrder(undefined);

// ── 阶段①：用户点名的场景 ────────────────────────────────────────────────
section("阶段① 八方向绿幕图");
{
  const idle = renderStage(makeProject(), "images", makeTasks());
  check(
    "Hook 槽位与 StudioPanel 对齐",
    idle.hooks === EXPECTED_HOOKS.StudioPanel,
    `调用 ${idle.hooks} 个 Hook，期望 ${EXPECTED_HOOKS.StudioPanel}`
  );
  check("空闲时一个遮罩都没有", overlays(idle.tree).length === 0, `${overlays(idle.tree).length} 个`);
  // 固定流程的审核模式必须能在八方向图界面上看到 / 改。
  check("八方向图有审核模式下拉", hasReviewModeSelect(idle.tree), modeOptions(idle.tree).join("、"));

  const busy = renderStage(makeProject(), "images", makeTasks(["image:upLeft"]));
  check("单方向生成时出现 loading 遮罩", overlays(busy.tree).length >= 1, `${overlays(busy.tree).length} 个`);
  check("遮罩文案带方向", overlayText(busy.tree).includes("image:upLeft"), overlayText(busy.tree));
  check("网格里仍然是 8 个方向", byClass(busy.tree, "SPR_node").length === 8, `${byClass(busy.tree, "SPR_node").length} 个`);
  check(
    "正在生成的方向被标成忙碌",
    byClass(busy.tree, "SPR_node").some((node) => node.props["data-busy"] === "true")
  );
  check("按钮变成转圈（data-busy）", byClass(busy.tree, "SPR_btn").some((node) => node.props["data-busy"] === "true"));

  // 「一键生成全部（跳过已通过的）」＝ 每个方向都会重新出图 → 全部都要盖住
  const batch = renderStage(makeProject(), "images", makeTasks(["image:*all"]));
  check("批量生成时有遮罩", overlays(batch.tree).length >= 2, `${overlays(batch.tree).length} 个`);
  check("批量时出现忙碌徽章", byClass(batch.tree, "SPR_busyBadge").length >= 1);
  check(
    "批量期间重复提交被禁用",
    byClass(batch.tree, "SPR_btn").some((node) => node.props.disabled === true)
  );

  // 「全部重新生成」宿主只重做未通过的方向，所以提交阶段先给工具栏反馈，
  // 具体哪些方向要重做等宿主状态回来再逐个点亮——这里断言转圈与徽章。
  const regenerate = renderStage(makeProject(), "images", makeTasks(["image:*regenerate"]));
  check(
    "全部重新生成时按钮转圈",
    byClass(regenerate.tree, "SPR_btn").some((node) => node.props["data-busy"] === "true")
  );
  check("全部重新生成时出现忙碌徽章", byClass(regenerate.tree, "SPR_busyBadge").length >= 1);

  // 宿主侧那批生成还在跑（本地 pending 早就撤了）：被它覆盖的方向要盖着，
  // 没被覆盖的方向一个遮罩都不能多——覆盖面是按方向公布的，见 job.targets。
  const hostBatch = makeProject();
  hostBatch.images.upLeft = { status: "empty" };
  hostBatch.jobs = [{ key: "images:all", label: "批量生成八方向图", startedAt: 1, targets: ["upLeft", "upRight"] }];
  const hostTree = renderStage(hostBatch, "images", makeTasks()).tree;
  check("宿主批量生图：还没轮到的方向也被盖住", overlays(hostTree).length === 1, `${overlays(hostTree).length} 个`);
  check("宿主批量生图：还没出图的方向显示正在生成", emptyTexts(hostTree).includes("正在生成…"), emptyTexts(hostTree).join("、"));
  check("宿主批量生图期间出现忙碌徽章", byClass(hostTree, "SPR_busyBadge").length >= 1);
  check(
    "宿主批量生图期间重复提交被禁用",
    byClass(hostTree, "SPR_btn").some((node) => node.props.disabled === true)
  );
}

// ── 阶段①的另一条路：转圈截帧（默认）────────────────────────────────────
section("阶段① 转圈截帧（默认生成方式）");
{
  /** 转圈模式的项目桩：一段转圈视频 + 32 张候选帧 + 八个方向图（都是切出来的）。 */
  function makeTurnProject(overrides = {}) {
    const images = {};
    const picks = {};
    const order = ["front", "downLeft", "left", "upLeft", "back", "upRight", "right", "downRight"];
    COMPASSES.forEach((key, index) => {
      images[key] = { file: `images/${key}.png`, status: "ready", updatedAt: 1, model: "转圈截帧" };
      picks[key] = Math.round((index * 32) / 8);
    });
    return makeProject({
      imageMode: "turn",
      images,
      turn: {
        direction: "cw",
        video: { status: "ready", file: "videos/turn.mp4", updatedAt: 1, firstFrame: "source/hero.png", approved: false },
        frames: {
          status: "ready",
          frames: Array.from({ length: 32 }, (_, i) => `turn/frames/f${String(i).padStart(2, "0")}.png`),
          times: Array.from({ length: 32 }, (_, i) => (i * 2) / 32),
          raw: "turn/raw.bin",
          rawWidth: 120,
          rawHeight: 120,
          rawFrameCount: 32,
          duration: 2,
          picks,
          strip: "turn/strip.png",
          approved: false,
          updatedAt: 2
        }
      },
      ...overrides
    });
  }

  /** 把整棵树（含函数组件内部）的文字拼起来：textOf 只走 element.children，够不到组件内部。 */
  const renderedText = (tree) => collect(tree, () => true).map((node) => textOf(node)).join(" | ");

  const idle = renderStage(makeTurnProject(), "images", makeTasks());
  check("空闲时一个遮罩都没有", overlays(idle.tree).length === 0, `${overlays(idle.tree).length} 个`);
  const turnPanels = collect(idle.tree, (node) => typeof node.type === "function" && node.type.name === "TurnImageStage");
  check("有转圈截帧面板", turnPanels.length >= 1, `${turnPanels.length} 个`);
  const modeButtons = byClass(idle.tree, "SPR_mode");
  check("两种生成方式都能选", modeButtons.length === 2, `${modeButtons.length} 个`);
  const defaultTag = byClass(idle.tree, "SPR_modeTag");
  check(
    "默认那种被标成「默认」且处于选中态",
    defaultTag.length === 1 &&
      textOf(defaultTag[0]) === "默认" &&
      modeButtons.some((node) => node.props["data-active"] === "true"),
    `${defaultTag.length} 个标记 / ${modeButtons.map((node) => node.props["data-active"]).join(",")}`
  );
  const dots = collect(idle.tree, (node) => typeof node.props?.["data-testid"] === "string" && node.props["data-testid"].startsWith("turn-dot-"));
  check("时间轴上有八个圆圈", dots.length === 8, `${dots.length} 个`);
  check(
    "圆圈是按钮（可聚焦 / 可键盘微调）",
    dots.every((node) => node.type === "button" && typeof node.props.onPointerDown === "function" && typeof node.props.onKeyDown === "function")
  );
  check("圆圈上有缩略条带", byClass(idle.tree, "SPR_axisStrip").length === 1);
  check("转圈视频能播", collect(idle.tree, (node) => node.type === "video").length === 1);
  check("八个方向图都在网格里", byClass(idle.tree, "SPR_node").length === 8, `${byClass(idle.tree, "SPR_node").length} 个`);
  check("转圈模式也有审核模式下拉", hasReviewModeSelect(idle.tree));
  check("有「通过」按钮", approveLabels(idle.tree).length >= 1);

  // 宿主那批「抽候选帧 + 切八张图」还在跑：已经切过的方向在重切时要盖着遮罩，
  // 还没切出来的方向要给可读的等待文案——否则界面会退回「还没有这一方向的图」，
  // 看着像点击没生效（实测过的表现）。
  const cutting = makeTurnProject();
  cutting.jobs = [{ key: "turn:frames", label: "抽取转圈候选帧", startedAt: 1, targets: ["front", "back"] }];
  const cuttingTree = renderStage(cutting, "images", makeTasks()).tree;
  check("切帧期间正在重切的方向被盖住", overlays(cuttingTree).length === 2, `${overlays(cuttingTree).length} 个`);
  check("切帧遮罩文案可读", overlayText(cuttingTree).includes("候选帧"), overlayText(cuttingTree));
  check("切帧期间出现忙碌徽章", byClass(cuttingTree, "SPR_busyBadge").length >= 1);
  check(
    "切帧期间重复抽帧被禁用",
    byClass(cuttingTree, "SPR_btn").some((node) => node.props.disabled === true)
  );

  const cuttingEmpty = makeTurnProject();
  cuttingEmpty.images.front = { status: "empty" };
  cuttingEmpty.jobs = [{ key: "turn:frames", label: "抽取转圈候选帧", startedAt: 1, targets: ["front"] }];
  const cuttingEmptyTree = renderStage(cuttingEmpty, "images", makeTasks()).tree;
  check(
    "还没切出来的方向显示等待文案",
    emptyTexts(cuttingEmptyTree).includes("正在切出这一帧…"),
    emptyTexts(cuttingEmptyTree).join("、")
  );

  // 本地刚点下「生成转圈视频」：视频区要立刻有转圈 / 遮罩反馈。
  const submitting = renderStage(makeTurnProject(), "images", makeTasks(["turn:*video"]));
  check("提交转圈视频时出现遮罩", overlays(submitting.tree).length >= 1, `${overlays(submitting.tree).length} 个`);
  check("提交转圈视频时按钮转圈", byClass(submitting.tree, "SPR_btn").some((node) => node.props["data-busy"] === "true"));

  // 还没有视频（新项目）：整条链路要给出「先做什么」，而不是空白。
  const empty = makeTurnProject();
  COMPASSES.forEach((key) => (empty.images[key] = { status: "empty" }));
  empty.turn = {
    direction: "cw",
    video: { status: "empty", approved: false },
    frames: { status: "empty", frames: [], times: [], picks: Object.fromEntries(COMPASSES.map((k) => [k, 0])), approved: false }
  };
  const emptyTree = renderStage(empty, "images", makeTasks()).tree;
  const emptyRendered = renderedText(emptyTree);
  check("没有视频时给出下一步提示", emptyRendered.includes("生成转圈视频"), emptyRendered.slice(0, 120));
  check("没有候选帧时给出说明", emptyRendered.includes("还没有候选帧"), "");
  check("空闲时仍然一个遮罩都没有", overlays(emptyTree).length === 0, `${overlays(emptyTree).length} 个`);

  // ── 本地自选视频 + 中间图片保存 ────────────────────────────────────────
  // 「选择本地视频」是**和远程生成并列**的一条路：按钮必须真的在（点了能选文件），
  // 而且不能因为它是 label 就被当成「通过」按钮统计进验收控件。
  {
    const pickers = localPickers(idle.tree);
    check("转圈阶段有「选择本地视频」入口", pickers.length === 1, `${pickers.length} 个`);
    check(
      "入口带 data-testid（深链接 / 自动化能定位）",
      pickers[0]?.props["data-testid"] === "turn-local-video",
      String(pickers[0]?.props["data-testid"])
    );
    const inputs = pickers.flatMap((node) => fileInputsOf(node));
    check("入口里真的有一个文件选择框", inputs.length === 1, `${inputs.length} 个`);
    check("选择框只收视频（accept=video/*）", inputs[0]?.props.accept === "video/*", String(inputs[0]?.props.accept));
    check("选择框被藏起来（点 label 才弹框）", inputs[0]?.props.style?.display === "none", JSON.stringify(inputs[0]?.props.style));
    check(
      "本地视频入口没有被算进「通过」按钮（验收统计不能被污染）",
      approveLabels(idle.tree).length >= 1 && !approveLabels(idle.tree).some((text) => text.includes("本地视频"))
    );

    // 八张方向图 + 条带 + 转圈视频都要能单独「保存」。
    const names = saveNames(idle.tree);
    check(
      "八个方向的绿幕图各有一个保存链接",
      ["front", "back", "left", "right", "downLeft", "downRight", "upLeft", "upRight"].every((key) =>
        names.some((name) => name.endsWith(`-${key}.png`))
      ),
      names.join("、")
    );
    check("整圈候选帧条带可单独保存", names.some((name) => name === "角色-turn-strip.png"), names.join("、"));
    check("转圈视频本身可保存", names.some((name) => name.endsWith("-turn.mp4")), names.join("、"));
    check(
      "保存链接指向真实产物路径（不是空 href）",
      saveHrefs(idle.tree).every((href) => href.includes("/assets/p1/")),
      saveHrefs(idle.tree).slice(0, 3).join("、")
    );

    // 「保存全部图片（zip）」放在各阶段共用的底部工具栏：候选帧一抽就是 32~64 张，
    // 一张一个链接既点不完也看不清，必须有一个整包出口。
    const exportBtn = collect(idle.tree, (node) => node.props?.className === "SPR_btn" && textOf(node) === "保存全部图片（zip）");
    check("有「保存全部图片（zip）」出口", exportBtn.length === 1, `${exportBtn.length} 个`);

    // 还没有任何产物时不该给出空的保存链接（点下去只会下载一个 404 页面）。
    const nothing = makeTurnProject();
    COMPASSES.forEach((key) => (nothing.images[key] = { status: "empty" }));
    nothing.turn = {
      direction: "cw",
      video: { status: "empty", approved: false },
      frames: { status: "empty", frames: [], times: [], picks: Object.fromEntries(COMPASSES.map((k) => [k, 0])), approved: false }
    };
    const nothingTree = renderStage(nothing, "images", makeTasks()).tree;
    check("没有产物时不渲染保存链接", saveLinks(nothingTree).length === 0, `${saveLinks(nothingTree).length} 个`);
    check("没有产物时仍然有「选择本地视频」入口", localPickers(nothingTree).length === 1, `${localPickers(nothingTree).length} 个`);

    // 本地导入的转圈视频：这一段没有「首帧」（不是图生视频），界面不能照旧
    // 印「首帧用的是源图」——那会把用户指向一张跟它无关的图。
    const localTurn = makeTurnProject();
    localTurn.turn.video = {
      status: "ready",
      file: "videos/turn.mp4",
      approved: false,
      origin: "local",
      originalName: "我转的.mp4",
      updatedAt: 1
    };
    const localTurnTree = renderStage(localTurn, "images", makeTasks()).tree;
    const rows = byClass(localTurnTree, "SPR_refRow").map(textOf);
    check("本地导入的转圈视频标出来路与原文件名", rows.includes("本地视频：我转的.mp4（不花远程调用）"), rows.join("、"));
    check("本地导入的转圈视频不再印「首帧用的是…」", !rows.some((text) => text.startsWith("首帧用的是")), rows.join("、"));
  }
}

// ── 阶段②：视频 ─────────────────────────────────────────────────────────
section("阶段② 行走动作视频");
{
  const idle = renderStage(makeProject(), "videos", makeTasks());
  check("空闲时一个遮罩都没有", overlays(idle.tree).length === 0, `${overlays(idle.tree).length} 个`);
  const busy = renderStage(makeProject(), "videos", makeTasks(["video:front"]));
  check("生成视频时遮罩盖住预览", overlays(busy.tree).length >= 1, `${overlays(busy.tree).length} 个`);
  check("遮罩文案带方向", overlayText(busy.tree).includes("video:front"), overlayText(busy.tree));
  const all = renderStage(makeProject(), "videos", makeTasks(["video:*all"]));
  check("批量提交时未轮到的方向也被盖住", overlays(all.tree).length >= 7, `${overlays(all.tree).length} 个`);

  // 宿主侧那批提交还在跑：覆盖面里的方向盖着，覆盖面外的一个都不多盖。
  const hostSubmit = makeProject();
  hostSubmit.videos.upLeft = { status: "empty" };
  hostSubmit.videos.upRight = { status: "running", remoteStatus: "提交中" };
  hostSubmit.jobs = [{ key: "videos:submit", label: "提交视频任务", startedAt: 1, targets: ["upLeft", "upRight"] }];
  const hostTree = renderStage(hostSubmit, "videos", makeTasks()).tree;
  check("宿主批量提交：还没轮到的方向也被盖住", overlays(hostTree).length === 2, `${overlays(hostTree).length} 个`);
  check("宿主批量提交期间重复提交被禁用", byClass(hostTree, "SPR_btn").some((node) => node.props.disabled === true));

  // 每个方向都要能自己选一段本地视频（和「生成视频」并列），并且成片能单独保存。
  {
    const pickers = localPickers(idle.tree);
    check("八个方向各有一个「选择本地视频」入口", pickers.length === 8, `${pickers.length} 个`);
    check(
      "每个入口都点名了槽位（不会把 A 的视频塞进 B）",
      COMPASSES.every((key) => pickers.some((node) => node.props["data-testid"] === `local-video-${key}`)),
      pickers.map((node) => node.props["data-testid"]).join("、")
    );
    check(
      "每个入口里都是一个只收视频的文件框",
      pickers.every((node) => {
        const inputs = fileInputsOf(node);
        return inputs.length === 1 && inputs[0].props.accept === "video/*";
      })
    );
    const names = saveNames(idle.tree);
    check(
      "八段行走视频各有一个保存链接",
      COMPASSES.every((key) => names.some((name) => name.endsWith(`-${key}.mp4`))),
      names.join("、")
    );
    check(
      "保存链接指向这一方向的成片（不是别人那一段）",
      saveLinks(idle.tree).some((node) => String(node.props.href).includes("/videos/front.mp4") && String(node.props.download).endsWith("-front.mp4")),
      saveLinks(idle.tree).map((node) => node.props.href).slice(0, 2).join("、")
    );

    // 本地导入进来的那一段：界面要说清来路，而不是印「远端状态」。
    const local = makeProject();
    local.videos.front = { status: "ready", file: "videos/front.mp4", approved: false, origin: "local", originalName: "我的行走.mp4", updatedAt: 1 };
    const localTree = renderStage(local, "videos", makeTasks()).tree;
    // 每格的那一行「来路」都是 SPR_refRow，逐个看比全文匹配可靠
    // （全文里父子节点的文字会层层重复）。
    const refRows = byClass(localTree, "SPR_refRow").map(textOf);
    check("本地导入的视频标出来路与原文件名", refRows.includes("本地视频：我的行走.mp4（不花远程调用）"), refRows.join("、"));
    check(
      "本地导入的那一格不再显示「远端状态」（其余七格照旧）",
      refRows.filter((text) => text.startsWith("远端状态：")).length === 7,
      refRows.join("、")
    );
  }
}

// ── 阶段③：抽帧 ─────────────────────────────────────────────────────────
/** 八个方向都还没抽过帧的那一份桩数据（下面两段抽帧用例都要用）。 */
function emptyFrames() {
  const project = makeProject();
  for (const key of COMPASSES) project.frames[key] = { status: "empty", frames: [], keyed: [], approved: false };
  return project;
}
/** 桩：宿主运行表里那次抽帧任务，`targets` 是它负责的方向。 */
function frameJob(targets) {
  return [{ key: "frames:extract", label: "抽取序列帧", startedAt: 1, targets }];
}

section("阶段③ 提取序列帧");
{
  const idle = renderStage(makeProject(), "frames", makeTasks());
  check("空闲时一个遮罩都没有", overlays(idle.tree).length === 0, `${overlays(idle.tree).length} 个`);
  const busy = renderStage(makeProject(), "frames", makeTasks(["frames:front"]));
  check("抽帧时遮罩盖住序列条", overlays(busy.tree).length >= 1, `${overlays(busy.tree).length} 个`);
  const all = renderStage(makeProject(), "frames", makeTasks(["frames:*all"]));
  check("批量抽帧时出现忙碌徽章", byClass(all.tree, "SPR_busyBadge").length >= 1);

  // 点下去到「宿主任务表回来」之间那一下：本地 pending 的批量 key 必须自己盖住，
  // 否则会出现一次「点了没反应」的空档。
  const localBatch = renderStage(emptyFrames(), "frames", makeTasks(["frames:*all"]));
  check(
    "本地批量 key 也要盖住还没轮到的方向",
    emptyTexts(localBatch.tree).every((text) => text === "正在抽帧…"),
    emptyTexts(localBatch.tree).join("、")
  );

  // 抽出来的帧也要能存下来：预览带（这一段的全部帧）每格一个保存链接，
  // 一张一张地拿则走底部的「保存全部图片（zip）」。
  {
    const names = saveNames(idle.tree);
    check(
      "八个方向的预览带各有一个保存链接",
      COMPASSES.every((key) => names.some((name) => name.endsWith(`-${key}-strip.png`))),
      names.join("、")
    );
    check(
      "预览带链接指向这一方向的条图",
      saveLinks(idle.tree).some((node) => String(node.props.href).includes("/frames/front.png")),
      saveLinks(idle.tree).map((node) => node.props.href).slice(0, 2).join("、")
    );
    const exportBtn = collect(idle.tree, (node) => node.props?.className === "SPR_btn" && textOf(node) === "保存全部图片（zip）");
    check("抽帧阶段同样有整包保存出口", exportBtn.length === 1, `${exportBtn.length} 个`);
  }
}

// ── 批量抽帧：还没轮到的方向不能退回空态（实测踩过的坑）──────────────────
//
// 「提取全部序列帧」是 kick 型调用：远程调用立刻返回 `{started:true}`，真正的活在
// 宿主后台一个方向一个方向地做（并发只有 2）。本地 pending 表只多留 700ms，
// 于是点下去八个方向先一起转圈，紧接着还没轮到的那几个变回「尚未抽帧」，
// 过一阵才陆续出结果——看着像点击没生效，用户会以为按钮坏了。
// 宿主的运行表（`project.jobs[].targets`）在整个任务期间都在，界面必须看它。
section("批量抽帧：宿主任务的覆盖面");
{
  const batch = emptyFrames();
  batch.frames.front = { status: "running", frames: [], keyed: [], approved: false };
  // 本地 pending 已经撤了（远程调用早返回了），只剩宿主这张表。
  batch.jobs = frameJob([...COMPASSES]);
  const hostBusy = renderStage(batch, "frames", makeTasks());
  check(
    "宿主还在抽帧时八个方向都不显示「尚未抽帧」",
    emptyTexts(hostBusy.tree).every((text) => text === "正在抽帧…"),
    emptyTexts(hostBusy.tree).join("、")
  );
  check("宿主还在抽帧时出现忙碌徽章", byClass(hostBusy.tree, "SPR_busyBadge").length >= 1);
  check(
    "宿主还在抽帧时重复提交被禁用",
    byClass(hostBusy.tree, "SPR_btn").some((node) => node.props.disabled === true)
  );

  // 抽帧完成、预览带还没写出来的那一小段：仍然算「在跑」，不能闪回空态。
  const writing = makeProject();
  writing.frames.front = { status: "ready", frames: ["frames/front/f00.png"], keyed: [], approved: false, duration: 2 };
  writing.jobs = frameJob(["front"]);
  const gap = renderStage(writing, "frames", makeTasks());
  check(
    "抽完帧但预览带还没出来时不显示「尚未抽帧」",
    emptyTexts(gap.tree).every((text) => text !== "尚未抽帧"),
    emptyTexts(gap.tree).join("、")
  );

  // 只抽一个方向时不能连累其余方向：覆盖面是按方向公布的。
  const single = emptyFrames();
  single.frames.front = { status: "running", frames: [], keyed: [], approved: false };
  single.jobs = frameJob(["front"]);
  const scoped = renderStage(single, "frames", makeTasks());
  check(
    "只抽一个方向时其余方向照常显示「尚未抽帧」",
    emptyTexts(scoped.tree).filter((text) => text === "尚未抽帧").length === 7,
    emptyTexts(scoped.tree).join("、")
  );

  // 抽帧失败的方向必须让人看见错误，不能被遮罩糊住。
  const failed = emptyFrames();
  failed.frames.back = { status: "error", error: "抽帧失败：ffmpeg 挂了", frames: [], keyed: [], approved: false };
  failed.jobs = frameJob([...COMPASSES]);
  const errored = renderStage(failed, "frames", makeTasks());
  check(
    "抽帧失败的方向不被盖住（错误要看得见）",
    emptyTexts(errored.tree).includes("尚未抽帧") &&
      byClass(errored.tree, "SPR_error").length === 1,
    `${emptyTexts(errored.tree).join("、")} / ${byClass(errored.tree, "SPR_error").length} 个错误`
  );

  const idle = renderStage(emptyFrames(), "frames", makeTasks());
  check(
    "没有任务在跑时该显示「尚未抽帧」",
    emptyTexts(idle.tree).every((text) => text === "尚未抽帧"),
    emptyTexts(idle.tree).join("、")
  );
}

// ── 阶段④：合成整图 ─────────────────────────────────────────────────────
section("序列帧预览：双击看大图");
{
  const zoomables = (tree) =>
    collect(tree, (node) => node.props?.["data-zoomable"] === "true" && typeof node.props.onDoubleClick === "function");
  const frames = renderStage(makeProject(), "frames", makeTasks());
  check("空闲时一个遮罩都没有（大图窗口默认关闭）", overlays(frames.tree).length === 0, `${overlays(frames.tree).length} 个`);
  check("八个方向的预览带都能双击放大", zoomables(frames.tree).length === 8, `${zoomables(frames.tree).length} 个`);
  check(
    "缩略图带「双击看大图」提示",
    zoomables(frames.tree).every((node) => node.props.title === "双击看大图")
  );

  // 大图窗口本身：把 __test 里的 ZoomableImage 直接渲染成"已打开"（Hook 槽位喂 true）。
  const { ZoomableImage } = bundle.__test ?? {};
  check("测试把手导出 ZoomableImage", typeof ZoomableImage === "function");
  if (typeof ZoomableImage === "function") {
    HOOK.slots = [true];
    HOOK.cursor = 0;
    const opened = collect(ZoomableImage({ src: "/a/b.png", alt: "第 1 帧", className: "SPR_frame", caption: "第 1 / 8 帧" }), () => true);
    const mask = collect(opened, (node) => node.props?.className === "SPR_zoomMask");
    const close = collect(opened, (node) => node.props?.className === "SPR_zoomClose");
    const big = collect(opened, (node) => node.props?.className === "SPR_zoomImg");
    check("大图窗口渲染出遮罩", mask.length === 1, `${mask.length} 个`);
    check("右上角有关闭按钮", close.length === 1 && textOf(close[0]) === "×", close.map(textOf).join("、"));
    check("大图用的是原图地址", big.length === 1 && big[0].props.src === "/a/b.png");
    check("大图窗口有点击背景关闭", typeof mask[0].props.onClick === "function");
    check("大图窗口有图注", /第 1 \/ 8 帧/.test(textOf(collect(opened, (node) => node.props?.className === "SPR_zoomCaption")[0] ?? {})));
    check("关闭按钮的点击不会冒泡到遮罩", typeof close[0].props.onClick === "function");
  }
}

section("阶段④ 抠绿幕合成整图");
{
  const idle = renderStage(makeProject(), "sheet", makeTasks());
  check("空闲时一个遮罩都没有", overlays(idle.tree).length === 0, `${overlays(idle.tree).length} 个`);
  const busy = renderStage(makeProject(), "sheet", makeTasks(["sheet:compose"]));
  check("合成时整图被遮罩盖住", overlays(busy.tree).length >= 1, `${overlays(busy.tree).length} 个`);
  check("遮罩文案说明在合成", overlayText(busy.tree).includes("sheet:compose"), overlayText(busy.tree));
  check(
    "合成期间不显示旧整图",
    byClass(busy.tree, "SPR_sheet").every((node) => node.props.style?.visibility === "hidden")
  );
  const rekey = renderStage(makeProject(), "sheet", makeTasks(["sheet:rekey"]));
  check("重跑抠像时也盖遮罩", overlays(rekey.tree).length >= 1, `${overlays(rekey.tree).length} 个`);
}

// ── 宿主侧状态 running（不是本地 pending）也要有遮罩 ─────────────────────
section("宿主任务状态 running 的反馈");
{
  const project = makeProject();
  project.images.upLeft = { ...project.images.upLeft, status: "running" };
  const busy = renderStage(project, "images", makeTasks());
  check("宿主标 running 的方向出现遮罩", overlays(busy.tree).length >= 1, `${overlays(busy.tree).length} 个`);

  const project2 = makeProject();
  project2.sheet = { ...project2.sheet, status: "running" };
  const running = renderStage(project2, "sheet", makeTasks());
  check("整图 running 时出现遮罩", overlays(running.tree).length >= 1, `${overlays(running.tree).length} 个`);

  const project3 = makeProject();
  project3.frames.front = { ...project3.frames.front, status: "running" };
  const frames = renderStage(project3, "frames", makeTasks());
  check("抽帧 running 时出现遮罩", overlays(frames.tree).length >= 1, `${overlays(frames.tree).length} 个`);
}

// ── 模块②、③ 的组件 ─────────────────────────────────────────────────────
const { ImageModule, SequenceModule } = bundle.__test ?? {};
check("产物带出三个模块组件（__test 把手）", typeof ImageModule === "function" && typeof SequenceModule === "function");

/** 模块②的桩任务。 */
function makeImageJob(overrides = {}) {
  return {
    id: "i1",
    name: "图片任务",
    assetBase: "/dsh-game-material-master/image-assets/i1/",
    updatedAt: 2,
    prompt: "一只猫",
    suffix: "",
    refs: [],
    settings: { count: 2, size: "2K", sizeMode: "global" },
    keying: { enabled: false },
    log: [],
    items: [
      { status: "ready", source: "generated", file: "out/1.png", updatedAt: 2 },
      { status: "ready", source: "generated", file: "out/2.png", updatedAt: 2, keyedFile: "keyed/2.png", backgroundFraction: 0.4 }
    ],
    ...overrides
  };
}

/** 模块③的桩任务。 */
function makeSequenceJob(overrides = {}) {
  return {
    id: "s1",
    name: "序列帧任务",
    assetBase: "/dsh-game-material-master/sequence-assets/s1/",
    updatedAt: 3,
    mode: "frames",
    prompt: "走路",
    suffix: "",
    settings: { duration: 5, resolution: "768P", frameCount: 4 },
    keying: {},
    refs: { firstFrame: { file: "refs/first.png", name: "first.png" }, referenceImages: [], referenceVideos: [] },
    video: { status: "ready", file: "videos/out.mp4", updatedAt: 3, remoteStatus: "Success" },
    frames: { status: "ready", files: ["frames/1.png", "frames/2.png", "frames/3.png"], keyed: ["keyed/1.png", "keyed/2.png", "keyed/3.png"], duration: 5, updatedAt: 3 },
    sheet: { status: "ready", file: "out/strip.png", updatedAt: 3 },
    log: [],
    ...overrides
  };
}

/**
 * 渲染模块②/③。
 *
 * ImageModule 的 useState 顺序：
 *   0 useLocaleTick（语言切换计数器）/ 1 jobs / 2 jobId / 3 job / 4 notice /
 *   5 uploading / 6 promptDraft / 7 suffixDraft /
 *   8 settingsDraft / 9 keyingDraft / 10 useGlobalConfig /
 *   11 usePendingTasks.map / 12 useStudioIntent（深链接意图）/
 *   13 loadedDrafts(useRef，上次从宿主读到的草稿；不读槽位)
 * SequenceModule 的顺序与之完全相同（它另有自己的 jobIdRef，排在这个 ref 之前）。
 */
function renderModule(component, job, tasks) {
  const base = [
    0,
    [job],
    job.id,
    job,
    null,
    false,
    job.prompt ?? "",
    job.suffix ?? "",
    { ...(job.settings ?? {}) },
    { ...(job.keying ?? {}) }
  ];
  HOOK.slots = [...base, undefined, tasks.map, null];
  HOOK.cursor = 0;
  const tree = component({ api });
  return { tree, overflow: false, hooks: HOOK.cursor };
}

section("可撤销的归档提示");
{
  HOOK.slots = []; HOOK.cursor = 0;
  const events = [];
  const notice = bundle.__test.NoticePopup({ notice: { kind: "ok", text: "已归档聊天", persistent: true, icon: "archive", actions: [{ label: "查看", onClick: () => events.push("view") }, { label: "撤销", primary: true, onClick: () => events.push("undo") }] }, onClose: () => events.push("close") });
  check("归档提示显示查看和撤销操作", byClass(notice, "SPR_noticePopupActions").length === 1 && byTag(notice, "button").map(textOf).join("/") === "查看/撤销/");
  byTag(notice, "button").find(node => textOf(node) === "撤销")?.props.onClick();
  check("先关闭原提示再撤销，保留回调的新提示", events.join() === "close,undo");
}

section("图片项目右键菜单");
{
  const project = { id: "icontext1", name: "右键目标", dir: "D:/素材/icontext1" };
  const context = { item: project, left: 200, top: 300 }, events = [];
  const props = { context, onClose: () => events.push("close"), onRename: item => events.push("rename:" + item.id), onPin: item => events.push("pin:" + item.id), onUnread: item => events.push("unread:" + item.id), onArchive: item => events.push("archive:" + item.id), onDelete: item => events.push("delete:" + item.id) };
  HOOK.slots = []; HOOK.cursor = 0;
  const menu = bundle.__test.ImageProjectContextMenu(props);
  check("右键菜单包含六项操作并使用顶层popover", menu.props.popover === "manual" && byTag(menu, "button").map(textOf).join("/") === "重命名/置顶/标记为未读/复制›/归档/永久删除");
  for (const button of byTag(menu, "button").filter(node => !node.props["aria-haspopup"])) button.props.onClick();
  check("菜单操作始终绑定右键目标并先关闭菜单", events.join() === "close,rename:icontext1,close,pin:icontext1,close,unread:icontext1,close,archive:icontext1,close,delete:icontext1");
  check("永久删除具有危险操作样式", byTag(menu, "button").find(node => textOf(node) === "永久删除")?.props["data-danger"] === true);
  HOOK.slots = [true]; HOOK.cursor = 0;
  const copyMenu = bundle.__test.ImageProjectContextMenu({ ...props, pinned: true, unread: true });
  check("置顶和未读的反向操作文案正确", textOf(copyMenu).includes("取消置顶") && textOf(copyMenu).includes("标记为已读"));
  check("复制子菜单提供名称ID和真实目录", byTag(copyMenu, "div").some(node => node.props.className?.split(" ").includes("SPR_imageCopyMenu")) && byTag(copyMenu, "button").slice(-3).map(textOf).join("/") === "复制名称/复制 ID/复制路径");
  HOOK.slots = []; HOOK.cursor = 0;
  const archivedMenu = bundle.__test.ImageProjectContextMenu({ ...props, archived: true, pinned: true });
  check("归档右键菜单提供恢复与删除，不显示置顶", textOf(archivedMenu).includes("取消归档") && !textOf(archivedMenu).includes("置顶") && textOf(archivedMenu).includes("永久删除"));
  HOOK.slots = []; HOOK.cursor = 0;
  let renameCalls = 0, renameClosed = 0, finishRename;
  const renameDialog = bundle.__test.ImageProjectRenameDialog({ project, onRename: (target, name) => { check("重命名使用指定目标并保留名称", target === project && name === project.name); renameCalls++; return new Promise(resolve => { finishRename = resolve; }); }, onClose: () => renameClosed++ });
  check("重命名使用自定义原生弹窗和80字限制", renameDialog.type === "dialog" && byTag(renameDialog, "input")[0].props.maxLength === 80);
  const submit = byTag(renameDialog, "form")[0].props.onSubmit;
  const pending = submit({ preventDefault() {} }); await submit({ preventDefault() {} }); renameDialog.props.onCancel({ preventDefault() {} });
  check("重命名处理中阻止连击及关闭", renameCalls === 1 && renameClosed === 0);
  finishRename(); await pending;
  check("重命名成功后关闭弹窗", renameCalls === 1 && renameClosed === 1);
  HOOK.slots = []; HOOK.cursor = 0;
  let selection, unreadPatch;
  const sidebar = bundle.__test.JobSidebar({ title: "项目", items: [project], activeId: "other", storageKey: "image", preferences: { layout: "merged", unreadProjects: [project.id] }, renderActions: () => null, onProjectRename: () => {}, onSelect: id => { selection = id; }, onPreferences: patch => { unreadPatch = patch; } });
  const row = byClass(sidebar, "SPR_projectRow")[0];
  check("图片项目行支持右键和未读圆点", typeof row.props.onContextMenu === "function" && row.props["data-unread"] === true && byClass(row, "SPR_projUnreadDot").length === 1);
  row.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: { querySelector() { return null; }, getBoundingClientRect() { return { left: 10, bottom: 40 }; } }, clientX: 20, clientY: 30 });
  check("右键打开不选择其他项目", selection === undefined);
  byClass(row, "SPR_projItem")[0].props.onClick();
  check("打开未读项目后移除未读状态", selection === project.id && unreadPatch.unreadProjects.length === 0);
}

section("图片项目侧栏与创建弹窗");
{
  HOOK.slots = []; HOOK.cursor = 0;
  const projectEvents = [];
  const projectActions = bundle.__test.ImageProjectActions({ pinned: true, archived: false, onPin: () => projectEvents.push("pin"), onArchive: () => projectEvents.push("archive") });
  const projectButtons = byTag(projectActions, "button");
  projectButtons[1]?.props.onClick({ stopPropagation: () => projectEvents.push("stop") });
  check("单个项目使用置顶和归档快捷图标，不再展开更多菜单", projectButtons.length === 2 && projectButtons[0].props["aria-label"] === "取消置顶" && projectButtons[0].props["aria-pressed"] === true && projectButtons[1].props["aria-label"] === "归档聊天" && !byClass(projectActions, "SPR_projectMoreButton").length && projectEvents.join() === "stop,archive");
  HOOK.slots = []; HOOK.cursor = 0;
  const archivedActions = bundle.__test.ImageProjectActions({ pinned: true, archived: true, onPin: () => {}, onArchive: () => {}, onDelete: () => {} });
  const archivedButtons = byTag(archivedActions, "button");
  check("归档项目提供取消归档和彻底删除，不显示置顶", archivedButtons.length === 2 && archivedButtons[0].props["aria-label"] === "取消归档" && archivedButtons[1].props["aria-label"] === "彻底删除" && !archivedButtons.some(node => node.props["data-action"] === "pin"));
  HOOK.slots = []; HOOK.cursor = 0;
  let deleteCalls = 0, deleteClosed = 0, finishDelete;
  const deleteProject = { id: "itest123", name: "归档项目", dir: "D:/素材/itest123" };
  const deletion = bundle.__test.ImageProjectDeleteDialog({ project: deleteProject, onDelete: target => { check("彻底删除绑定确认的项目", target === deleteProject); deleteCalls++; return new Promise(resolve => { finishDelete = resolve; }); }, onClose: () => deleteClosed++ });
  check("彻底删除弹窗展示目标目录和不可撤销说明", deletion.props.role === "alertdialog" && textOf(deletion).includes(deleteProject.dir) && textOf(deletion).includes("无法撤销"));
  byTag(deletion, "button")[0].props.onClick();
  check("取消删除不调用删除接口", deleteClosed === 1 && deleteCalls === 0);
  deleteClosed = 0;
  const pendingDelete = byTag(deletion, "form")[0].props.onSubmit({ preventDefault() {} });
  await byTag(deletion, "form")[0].props.onSubmit({ preventDefault() {} });
  byTag(deletion, "button")[0].props.onClick(); deletion.props.onCancel({ preventDefault() {} });
  check("删除处理中阻止重复提交和关闭", deleteCalls === 1 && deleteClosed === 0);
  finishDelete(); await pendingDelete;
  check("删除完成后关闭确认弹窗", deleteCalls === 1 && deleteClosed === 1);
  HOOK.slots = []; HOOK.cursor = 0;
  const preferences = { directory: "", sort: "updated", layout: "merged", order: [] };
  const tree = bundle.__test.JobSidebar({ title: "项目", items: [makeImageJob()], activeId: "i1", storageKey: "image", preferences, onPreferences: () => {}, onCreate: () => {}, onOpenFolder: () => {}, renderMeta: () => "" });
  check("图片侧栏标题为项目，不显示数量", byClass(tree, "SPR_taskSideTitle").some(node => textOf(node) === "项目"));
  check("侧栏顶栏打开文件夹与整理项目分开", byTag(tree, "button").some(node => node.props["aria-label"] === "打开文件夹") && byTag(tree, "button").some(node => node.props["aria-label"] === "整理项目") && !byTag(tree,"button").some(node=>node.props["aria-label"]==="创建项目"));
  check("顶栏操作收进悬停操作容器", byClass(tree, "SPR_taskHeadActions").length === 1);
  HOOK.slots = []; HOOK.cursor = 0;
  let selectedDirectory;
  const grouped = bundle.__test.JobSidebar({ title: "项目", items: [{...makeImageJob(),saveDirectory:"C:/素材"}], activeId:"i1",storageKey:"image",preferences:{...preferences,layout:"grouped"},onPreferences:()=>{},onCreate:directory=>{selectedDirectory=directory;},renderMeta:()=>"" });
  const folderCreate=byTag(grouped,"button").find(node=>node.props["aria-label"]==="在此文件夹新建项目");
  folderCreate?.props.onClick();
  check("目录行有更多和在当前文件夹新建入口", !!folderCreate&&selectedDirectory==="C:/素材"&&byTag(grouped,"button").some(node=>node.props["aria-label"]==="文件夹「素材」的更多操作"));
  const folderMenu = byTag(grouped, "div").find(node => node.props.className?.split(" ").includes("SPR_taskFolderMenu"));
  check("文件夹更多菜单内容与顺序和参考一致", byTag(folderMenu, "button").map(node => textOf(node)).join("/") === "置顶/编辑/在资源管理器中打开/归档聊天/移除项目" && byTag(folderMenu, "div").filter(node => node.props.role === "separator").length === 3, byTag(folderMenu, "button").map(node => textOf(node)).join("/") + " separators=" + byTag(folderMenu, "div").filter(node => node.props.role === "separator").length);
  check("空文件夹不会渲染占位内容撑大分组间距", !byClass(grouped, "SPR_taskGroupEmpty").length);
  check("列表折叠与全局侧栏使用独立控件", byClass(tree, "SPR_taskSideTitle").some(node => node.props["aria-controls"] === "task-list-image"));
  const linkedPreferences = { ...preferences, layout: "grouped", folders: { "C:/素材": { name: "角色素材", directories: ["C:/素材", "D:/道具"] } } };
  const linkedJobs = [{ id: "i1", saveDirectory: "c:\\素材", imageCount: 4, keyedCount: 3, createdAt: 123, updatedAt: 456 }, { id: "i2", saveDirectory: "D:/道具", imageCount: 2, keyedCount: 1 }];
  const linked = bundle.__test.imageFolderGroups(linkedJobs, linkedPreferences);
  check("关联多个源目录后只显示一个分组，兼容Windows路径大小写", linked.length === 1 && linked[0].entries.length === 2 && linked[0].name === "角色素材");
  check("移除分组同时隐藏各个源目录入口", bundle.__test.imageFolderGroups(linkedJobs, { ...linkedPreferences, folders: { "C:/素材": { ...linkedPreferences.folders["C:/素材"], removed: true } } }).length === 0);
  check("已本地移除的单个项目在多目录分组中仍保持隐藏", bundle.__test.imageFolderGroups(linkedJobs, { ...linkedPreferences, hiddenProjects: ["i1"] })[0].entries.map(item => item.id).join() === "i2");
  const archivePreferences = { ...linkedPreferences, archivedProjects: ["i1"] };
  const activeFolders = bundle.__test.imageFolderGroups(linkedJobs, archivePreferences), archivedFolders = bundle.__test.imageFolderGroups(linkedJobs, { ...archivePreferences, showArchived: true });
  check("归档仅隐藏列表项并保留全部统计与记录", activeFolders[0].entries.map(item => item.id).join() === "i2" && activeFolders[0].allEntries.length === 2 && linkedJobs.length === 2);
  check("归档视图仅显示已归档内容，移除入口优先于归档", archivedFolders[0].entries.map(item => item.id).join() === "i1" && bundle.__test.imageFolderGroups(linkedJobs, { ...archivePreferences, showArchived: true, hiddenProjects: ["i1"] })[0].entries.length === 0);
  const pinFolders = bundle.__test.imageFolderGroups(linkedJobs, { folders: { "D:/道具": { pinned: true } } });
  check("置顶目录优先显示，取消后沿用原有顺序", pinFolders[0].key === "D:/道具" && bundle.__test.imageFolderGroups(linkedJobs, { folders: { "D:/道具": { pinned: false } } })[0].key === "c:\\素材");
  HOOK.slots = []; HOOK.cursor = 0;
  const pinnedSidebar = bundle.__test.JobSidebar({ title: "项目", items: linkedJobs, storageKey: "image", preferences: { ...preferences, layout: "grouped", folders: { "D:/道具": { pinned: true } } }, onPreferences: () => {}, onCreate: () => {} });
  const pinnedSection = byClass(pinnedSidebar, "SPR_taskPinned")[0], regularSection = byClass(pinnedSidebar, "SPR_taskList").find(node => node.props.id === "task-list-image");
  check("置顶目录在独立分组内且不在普通列表重复", !!pinnedSection && [...new Set(byClass(pinnedSection, "SPR_taskFolderLabel").map(textOf))].join() === "道具" && [...new Set(byClass(regularSection, "SPR_taskFolderLabel").map(textOf))].join() === "素材" && byClass(pinnedSidebar, "SPR_taskGroup").length === 2);
  check("没有置顶目录就不显示置顶分组", byClass(grouped, "SPR_taskPinned").length === 0);
  HOOK.slots = []; HOOK.cursor = 0;
  const mergedPins = bundle.__test.JobSidebar({ title: "项目", items: linkedJobs, storageKey: "image", preferences: { ...preferences, folders: { "D:/道具": { pinned: true } } }, onPreferences: () => {}, onCreate: () => {} });
  const mergedPinSection = byClass(mergedPins, "SPR_taskPinned")[0], mergedRegular = byClass(mergedPins, "SPR_taskList").find(node => node.props.id === "task-list-image");
  check("合并显示仍保留置顶文件夹，普通列表不重复", byClass(mergedPinSection, "SPR_taskGroupTitle").length === 1 && byClass(mergedPinSection, "SPR_projItem").length === 1 && !byClass(mergedRegular, "SPR_taskGroupTitle").length && byClass(mergedRegular, "SPR_projItem").length === 1);
  for (const layout of ["grouped", "merged"]) {
    HOOK.slots = []; HOOK.cursor = 0;
    const pinnedProject = bundle.__test.JobSidebar({ title: "项目", items: linkedJobs, storageKey: "image", preferences: { ...preferences, layout, pinnedProjects: ["i1"], folders: { "c:\\素材": { pinned: true } } }, onPreferences: () => {}, onCreate: () => {} });
    const pinnedList = byClass(pinnedProject, "SPR_taskPinned")[0];
    check(`${layout}中单独置顶项目与置顶文件夹同时显示且不重复`, byClass(pinnedList, "SPR_projItem").length === 1 && byClass(pinnedProject, "SPR_projItem").length === 2 && byClass(pinnedList, "SPR_taskGroupTitle").length === 1);
  }
  HOOK.slots = []; HOOK.cursor = 0;
  const emptyArchive = bundle.__test.JobSidebar({ title: "项目", items: linkedJobs, storageKey: "image", preferences: { ...linkedPreferences, showArchived: true, folders: { "C:/素材": { ...linkedPreferences.folders["C:/素材"], pinned: true } } }, onPreferences: () => {}, onCreate: () => {} });
  check("归档空状态不夹带空文件夹或置顶标题", byClass(emptyArchive, "SPR_archiveEmpty").length === 1 && !byClass(emptyArchive, "SPR_taskGroupTitle").length && !byClass(emptyArchive, "SPR_taskPinned").length);
  HOOK.slots = []; HOOK.cursor = 0;
  const archivedPinnedProject = bundle.__test.JobSidebar({ title: "项目", items: linkedJobs, storageKey: "image", preferences: { ...linkedPreferences, showArchived: true, archivedProjects: ["i1"], pinnedProjects: ["i1"] }, onPreferences: () => {}, onCreate: () => {} });
  check("归档项目使用单一紧凑列表，独立于普通布局和置顶", byClass(archivedPinnedProject, "SPR_projItem").length === 1 && !byClass(archivedPinnedProject, "SPR_taskGroupTitle").length && !byClass(archivedPinnedProject, "SPR_taskPinned").length && !byClass(archivedPinnedProject, "SPR_archiveEmpty").length);
  HOOK.slots = []; HOOK.cursor = 0;
  let folderMove;
  const sortableFolders = bundle.__test.JobSidebar({ title: "项目", items: linkedJobs, storageKey: "image", preferences: { ...preferences, layout: "grouped", sort: "manual" }, onPreferences: patch => { folderMove = patch; }, onCreate: () => {} });
  const folderRows = byClass(sortableFolders, "SPR_taskGroup");
  byClass(folderRows[1], "SPR_taskGroupTitle")[0].props.onDragStart({ stopPropagation() {}, dataTransfer: { setData() {} } });
  folderRows[0].props.onDrop({ preventDefault() {}, stopPropagation() {}, clientY: 1, currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 100 }) } });
  check("手动排序允许拖动整个文件夹并保存独立顺序", byClass(sortableFolders, "SPR_taskGroupTitle").every(node => node.props.draggable) && folderMove?.folderOrder.join("|") === "D:/道具|c:\\素材");
  check("文件夹顺序恢复后仍优先按置顶分区", bundle.__test.imageFolderGroups(linkedJobs, { sort: "manual", folderOrder: ["D:/道具", "c:\\素材"] }).map(group => group.key).join("|") === "D:/道具|c:\\素材" && bundle.__test.imageFolderGroups(linkedJobs, { sort: "manual", folderOrder: ["D:/道具", "c:\\素材"], folders: { "c:\\素材": { pinned: true } } })[0].key === "c:\\素材");
  HOOK.slots = []; HOOK.cursor = 0;
  let pinnedPatch;
  const collapsedPins = bundle.__test.JobSidebar({ title: "项目", items: linkedJobs, storageKey: "image", preferences: { ...preferences, layout: "grouped", pinnedCollapsed: true, folders: { "D:/道具": { pinned: true } } }, onPreferences: patch => { pinnedPatch = patch; }, onCreate: () => {} });
  const pinToggle = byClass(collapsedPins, "SPR_taskSideTitle").find(node => node.props["aria-controls"] === "pinned-task-list-image");
  pinToggle?.props.onClick();
  check("置顶分组可独立展开收起", pinToggle?.props["aria-expanded"] === false && byClass(collapsedPins, "SPR_taskList").find(node => node.props.id === "pinned-task-list-image")?.props.hidden === true && pinnedPatch?.pinnedCollapsed === false);
  HOOK.slots = []; HOOK.cursor = 0;
  let archivePatch;
  const archivedSidebar = bundle.__test.JobSidebar({ title: "项目", items: linkedJobs, storageKey: "image", preferences: archivePreferences, onPreferences: patch => { archivePatch = patch; }, onCreate: () => {} });
  const archiveLink = byClass(archivedSidebar, "SPR_taskArchiveLink")[0];
  archiveLink?.props.onClick();
  check("已归档聊天有独立可见入口并包含归档数量", !!archiveLink && textOf(archiveLink) === "已归档聊天（1）" && archivePatch?.showArchived === true);
  HOOK.slots = []; HOOK.cursor = 0;
  const archiveView = bundle.__test.JobSidebar({ title: "项目", items: linkedJobs, storageKey: "image", preferences: { ...archivePreferences, showArchived: true }, onPreferences: patch => { archivePatch = patch; }, onCreate: () => {} });
  byClass(archiveView, "SPR_taskArchiveLink")[0]?.props.onClick();
  check("归档视图提供返回入口", textOf(byClass(archiveView, "SPR_taskArchiveLink")[0]) === "返回未归档聊天" && archivePatch?.showArchived === false);
  check("没有归档时仍保留底部快捷入口", textOf(byClass(grouped, "SPR_taskArchiveLink")[0]) === "已归档聊天（0）");
  HOOK.slots = [true]; HOOK.cursor = 0;
  let editedFolder = 0;
  const info = bundle.__test.ImageSidebarInfo({ id: "folder-info-test", name: "角色素材", directory: "C:/素材", directories: ["C:/素材", "D:/道具"], entries: linkedJobs, folder: true, onEdit: () => editedFolder++, children: ReactStub.createElement("button", {}, "角色素材") });
  check("可操作的文件夹信息卡使用具名非模态dialog", byTag(info, "div").some(node => node.props.role === "dialog" && node.props["aria-label"] === "角色素材"));
  check("悬浮信息只显示一行统计并增加聊天图标", byClass(info, "SPR_sidebarInfoStats").some(node => textOf(node) === "2 个项目 · 6 张 · 抠像 4" && byTag(node, "svg").length === 1) && !textOf(info).includes("当前 ") && !textOf(info).includes("含历史版本"));
  check("文件夹详情不展示最近更新时间", !byClass(info, "SPR_sidebarInfoDates").length);
  byClass(info, "SPR_sidebarInfoEdit")[0]?.props.onClick();
  check("悬浮信息卡的编辑按钮绑定当前文件夹", editedFolder === 1 && byClass(info, "SPR_sidebarInfoPath").length === 2);
  HOOK.slots = []; HOOK.cursor = 0;
  const compactList = bundle.__test.JobSidebar({ title: "项目", items: linkedJobs, storageKey: "image", preferences: linkedPreferences, onPreferences: () => {}, onCreate: () => {} });
  check("图片项目列表为单行，不重复展示图片数", !byClass(compactList, "SPR_projMeta").length);
  HOOK.slots = []; HOOK.cursor = 0;
  const dialog = bundle.__test.ImageTaskDialog({ api, preferences, defaultDirectory: "/tmp/image-jobs", onSubmit: () => {}, onClose: () => {} });
  check("自定义创建项目弹窗使用原生modal容器", byTag(dialog, "dialog").some(node => node.props["aria-label"] === "创建项目"));
  check("项目名称必填且有长度限制", byTag(dialog, "input").some(node => node.props["aria-label"] === "项目名称" && node.props.required && node.props.maxLength === 80));
  check("未填写名称时禁用创建项目", byTag(dialog, "button").some(node => node.props.type === "submit" && node.props.disabled));
  check("添加文件夹只有点击时打开系统选择窗口", byTag(dialog, "button").some(node => node.props["aria-label"] === "添加文件夹" && typeof node.props.onClick === "function"));
  check("未选文件夹显示居中添加态", byClass(dialog, "SPR_taskSourceEmpty").length === 1 && byClass(dialog, "SPR_taskSourceRow").length === 0);
  check("未选目录不显示此电脑", byClass(dialog, "SPR_taskComputer").length === 0);
  HOOK.slots = []; HOOK.cursor = 0;
  const selectedDialog = bundle.__test.ImageTaskDialog({ api, preferences: { ...preferences, directory: "/tmp/project" }, onSubmit: () => {}, onClose: () => {} });
  check("选中目录显示目录行与移除", byClass(selectedDialog, "SPR_taskSourceRow").length === 1 && byTag(selectedDialog, "button").some(node => node.props["aria-label"] === "移除文件夹"));
  check("选中目录显示此电脑并隐藏居中态", byClass(selectedDialog, "SPR_taskComputer").length === 1 && byClass(selectedDialog, "SPR_taskSourceEmpty").length === 0);
  HOOK.slots = []; HOOK.cursor = 0;
  const folderEditor = bundle.__test.ImageTaskDialog({ api, preferences, project: { name: "角色素材", directories: ["C:/素材", "D:/道具"] }, editableSources: true, onSubmit: () => {}, onClose: () => {}, onRemove: () => {} });
  check("文件夹编辑复用名称与源文件夹弹窗，允许添加和移除源目录", byTag(folderEditor, "dialog").some(node => node.props["aria-label"] === "编辑项目") && byClass(folderEditor, "SPR_taskSourceRow").length === 2 && byTag(folderEditor, "button").filter(node => node.props["aria-label"] === "移除文件夹").length === 2 && byTag(folderEditor, "button").some(node => node.props["aria-label"] === "添加文件夹"));
  check("当前结果空态有说明与图标", byTag(bundle.__test.ImageResultsEmpty({}), "strong").some(node => textOf(node) === "还没有生成结果"));
  check("历史记录空态说明自动保存", byTag(bundle.__test.ImageResultsEmpty({ history: true }), "p").some(node => textOf(node).includes("自动保存")));

}

if (typeof ImageModule === "function") {
  section("图片聊天轮次与版本归组");
  {
    const build = bundle.__test.imageConversationRounds;
    const snapshot = { prompt: "已提交的描述", settings: { size: "2K" }, refs: [], keying: {} };
    const original = { id: "v1", batchId: "r1", createdAt: 2, kind: "generated", item: { versionId: "v1", index: 0, status: "ready", file: "out/a.png" }, request: snapshot };
    const second = { ...original, id: "v2", item: { ...original.item, versionId: "v2", index: 1, file: "out/b.png" } };
    const cutout = { ...original, id: "cut1", batchId: "keyed", createdAt: 4, kind: "keyed", sourceVersionId: "v1", item: { ...original.item, versionId: "cut1", keyedFile: "keyed/a.png" } };
    const generated = { id: "r1", createdAt: 1, request: snapshot, results: [{ index: 0, status: "ready", versionId: "v1" }, { index: 1, status: "ready", versionId: "v2" }], logs: [{ at: 3, level: "info", message: "本轮日志" }] };
    const failed = { id: "r2", createdAt: 5, request: { ...snapshot, prompt: "失败的请求" }, results: [{ index: 0, status: "error", error: "测试失败" }] };
    const fixture = { ...makeImageJob(), prompt: "仍在编辑的描述", items: [cutout.item], history: [original, second, cutout], rounds: [generated, failed], log: [{ at: 3, level: "info", message: "其他日志" }] };
    const rounds = build(fixture);
    check("原始批次两张图片与本地抠图组成同一轮", rounds.length === 2 && rounds[0].slots.length === 2 && rounds[0].slots[0].versions.length === 2);
    check("历史消息使用提交快照，不使用编辑草稿", rounds[0].request.prompt === "已提交的描述" && fixture.prompt === "仍在编辑的描述");
    check("失败轮次保留独立描述、状态和错误", rounds[1].request.prompt === "失败的请求" && rounds[1].status === "error" && rounds[1].slots[0].versions[0].item.error === "测试失败");
    check("仅存于结果的旧错误补入执行详情，原轮次日志不变", rounds[1].logs.some(entry => entry.level === "error" && entry.message.includes("测试失败")) && !failed.logs);
    check("执行日志优先使用对应轮次的持久化日志", rounds[0].logs.length === 1 && rounds[0].logs[0].message === "本轮日志");
    const withoutOriginal = build({ ...fixture, history: [second, cutout] });
    check("删除原始历史条目后，抠图仍通过来源版本归到原轮次", withoutOriginal.length === 2 && withoutOriginal[0].entries.some(entry => entry.id === "cut1"));
    const currentRetained = build({ ...fixture, items: [original.item], history: [second] });
    check("当前结果仍引用已删历史时，不额外创建虚假轮次", currentRetained.length === 2 && currentRetained[0].entries.some(entry => entry.id === "v1"));
    const legacy = build({ ...makeImageJob(), history: [{ ...original, kind: "legacy", request: undefined }], items: [original.item], prompt: "新文字" });
    check("旧记录不伪造请求快照", legacy.length === 1 && !legacy[0].request);
    const detached = { ...cutout, sourceVersionId: "removed-parent", roundId: "r1", item: { ...cutout.item, file: "out/missing-original.png", roundId: "r1" } };
    const stable = build({ ...fixture, history: [detached], items: [detached.item] });
    check("原始版本移除后，持久化轮次ID仍把抠图留在原消息", stable.length === 2 && stable[0].slots.length === 1 && stable[0].entries[0].id === "cut1");
    const unordered = build({ ...fixture, rounds: [], history: [{ ...cutout, createdAt: 1 }, { ...original, createdAt: 9 }], items: [] });
    check("旧抠图记录先于原图或时间不准也只显示一条消息", unordered.length === 1 && unordered[0].slots.length === 1 && unordered[0].slots[0].versions.length === 2);
    check("整理消息不改写宿主轮次的结果数组", generated.results.length === 2 && failed.results.length === 1);
    const repeated = build({ ...fixture, rounds: [], items: [], history: [original, { ...original, id: "repeat", batchId: "separate-generation", item: { ...original.item, versionId: "repeat", file: "out/repeat.png" } }] });
    check("相同描述的两次真实生成仍保留为两轮", repeated.length === 2);
    const materials = bundle.__test.imageConversationMaterials;
    const refs = [{ file: "refs/a.png", name: "参考.png" }];
    const cutout2 = { ...cutout, id: "cut2", createdAt: 6, item: { ...cutout.item, versionId: "cut2", keyedFile: "keyed/a2.png" } };
    const rich = { ...fixture, refs, history: [original, second, cutout, cutout2], items: [cutout2.item] };
    const assets = materials(rich, build(rich));
    check("素材按文件去重，保留参考图、两张原图和两次抠图", assets.length === 5 && new Set(assets.map(asset => asset.file)).size === 5);
    check("素材显示真实类型与对应轮次张数", assets.find(asset => asset.file === "out/a.png")?.kind === "original" && assets.find(asset => asset.file === "out/b.png")?.imageNumber === 2 && assets.find(asset => asset.file === "keyed/a.png")?.roundNumber === 1 && assets.find(asset => asset.file === "refs/a.png")?.kind === "reference");
    check("两次抠图拥有独立版本编号", assets.find(asset => asset.file === "keyed/a.png")?.label === "抠图版本 1" && assets.find(asset => asset.file === "keyed/a2.png")?.label === "抠图版本 2");
    const auto = { ...original, item: { ...original.item, keyedFile: "keyed/auto.png" } };
    const autoJob = { ...makeImageJob(), items: [auto.item], history: [auto] };
    const display = bundle.__test.imageConversationDisplayVersions(build(autoJob)[0].slots[0]);
    check("自动抠图同条历史也能分别选择原图与透明图", display.length === 2 && !display[0].item.keyedFile && display[1].item.keyedFile === "keyed/auto.png" && display[0].displayId !== display[1].id);
    check("原图显示分支保留真实历史ID且不改写历史", display[0].id === auto.id && auto.item.keyedFile === "keyed/auto.png" && !auto.displayId);
    const autoMaterials = materials(autoJob, build(autoJob));
    check("自动抠图依据实际文件分类而非历史kind", autoMaterials.some(asset => asset.file === "out/a.png" && asset.kind === "original") && autoMaterials.some(asset => asset.file === "keyed/auto.png" && asset.label === "抠图版本 1"));
    check("没有历史的旧结果也会出现在素材中", materials({ items: [original.item] }, build({ items: [original.item] })).some(asset => asset.file === "out/a.png"));
    check("空素材不产生占位文件", materials({}, build({})).length === 0);
  }
  section("模块② 图片生成");
  {
    const idle = renderModule(ImageModule, makeImageJob(), makeTasks());
    check(
      "Hook 槽位与 ImageModule 对齐",
      idle.hooks === EXPECTED_HOOKS.ImageModule,
      `调用 ${idle.hooks} 个 Hook，期望 ${EXPECTED_HOOKS.ImageModule}`
    );
    check("空闲时一个遮罩都没有", overlays(idle.tree).length === 0, `${overlays(idle.tree).length} 个`);
    check(
      "图片模块有抠像底色选择器（角色穿绿衣服时可换蓝 / 品红）",
      byTag(idle.tree, "input").some((node) => node.props.type === "color"),
      ""
    );
    check("图片模块有全局输出尺寸输入框", byTag(idle.tree, "input").some((node) => node.props["data-testid"] === "image-global-size"));
    check("图片模块有「尺寸来源」选择器（默认跟随全局）", byTag(idle.tree, "select").some((node) => node.props["data-testid"] === "image-size-mode" && node.props.value === "global"));
    check("跟随全局时不显示任务尺寸输入框", !byTag(idle.tree, "input").some((node) => node.props["data-testid"] === "image-task-size"));
    const composerBottom = byClass(idle.tree, "SPR_chatComposerBottom")[0];
    check("输入栏不再显示重复的尺寸设置按钮", !!composerBottom && !byTag(composerBottom, "button").some(node => node.props["aria-label"] === "生成参数"));
    const customSize = renderModule(ImageModule, makeImageJob({ settings: { count: 2, size: "1024x1536", sizeMode: "custom" } }), makeTasks());
    check("自定义尺寸时显示任务尺寸输入框", byTag(customSize.tree, "input").some((node) => node.props["data-testid"] === "image-task-size" && node.props.value === "1024x1536"));

    const gen = renderModule(ImageModule, makeImageJob(), makeTasks(["img:job"]));
    check("提交新一轮时保留旧图，工具栏反馈忙碌", overlays(gen.tree).length === 0 && byClass(gen.tree, "SPR_busyBadge").length >= 1);
    const pendingBatch = makeImageJob({ rounds: [{ id: "batch-new", createdAt: 3, request: { prompt: "新一轮描述", settings: { size: "2K" }, refs: [], keying: {} }, results: [{ index: 0, status: "running" }, { index: 1, status: "running" }] }] });
    pendingBatch.history = pendingBatch.items.map((item, index) => ({ id: "old-" + index, batchId: "batch-old", createdAt: 1, kind: "generated", item: { ...item, index, versionId: "old-" + index } }));
    const pendingTree = renderModule(ImageModule, pendingBatch, makeTasks()).tree;
    check("新一轮等待的全部图片均有反馈，旧轮次仍可查看", overlays(pendingTree).length === 1 && byClass(pendingTree, "SPR_imageGalleryThumbBusy").length === 2 && byClass(pendingTree, "SPR_chatRound").length === 2);
    const failedMessage = 'OpenAI API 生图失败（HTTP 502）：<!DOCTYPE html><html><head><title>502: Bad gateway</title></head></html>';
    const failedJob = makeImageJob({ items: [{ index: 0, status: "error", error: failedMessage }], history: [], rounds: [], log: [] });
    const failedTree = renderModule(ImageModule, failedJob, makeTasks()).tree;
    const imageHeads = tree => byTag(tree, "div").filter(node => node.props.className?.split(" ").includes("SPR_imageResultHead"));
    check("失败结果仅保留顶部状态，不重复显示错误大框和空预览", byClass(failedTree, "SPR_imageGalleryMedia").length === 0 && byClass(failedTree, "SPR_error").length === 0 && byClass(failedTree, "SPR_chatProgress").some(node => node.props["data-status"] === "error"));
    check("失败图片直接提供重新生成图标，不显示空的图片菜单", byTag(failedTree, "button").some(node => node.props["aria-label"] === "重新生成" && !node.props.disabled && byTag(node, "svg").length === 1) && imageHeads(failedTree).length === 1 && imageHeads(failedTree).every(node => byTag(node, "button").length === 0));
    const failureLogs = byClass(failedTree, "SPR_chatLogs").map(textOf).join();
    check("旧HTML报错在执行详情中保留502原因并隐藏源码", failureLogs.includes("HTTP 502") && failureLogs.includes("中转服务或上游") && !/DOCTYPE|<html|<title>/.test(failureLogs));
    check("提交中图标变为停止方块并禁止重复提交", byTag(gen.tree, "button").some(node => node.props.className?.includes("SPR_chatGenerate") && node.props["aria-label"] === "停止生成" && node.props.disabled && byTag(node, "rect").length === 1));
    check("后台生成期间停止按钮保持可用且不重复显示底部进度条", byTag(pendingTree, "button").some(node => node.props.className?.includes("SPR_chatGenerate") && node.props["aria-label"] === "停止生成" && !node.props.disabled) && byClass(pendingTree, "SPR_chatRound").every(node => byClass(node, "SPR_busyBadge").length === 0));

    const one = renderModule(ImageModule, makeImageJob(), makeTasks(["img:item:0"]));
    check("单张重新生成时只有那张被盖住", overlays(one.tree).length === 1, `${overlays(one.tree).length} 个`);

    const key = renderModule(ImageModule, makeImageJob(), makeTasks(["img:key"]));
    check("重新抠像时结果被盖住", overlays(key.tree).length >= 1, `${overlays(key.tree).length} 个`);
    HOOK.effects = [];
    const hostKey = renderModule(ImageModule, makeImageJob({ tasks: ["image:key"] }), makeTasks());
    const hostKeyEffects = HOOK.effects;
    HOOK.effects = undefined;
    check("本地pending结束后，宿主抠像任务继续覆盖主图与缩略图", overlays(hostKey.tree).length === 1 && byClass(hostKey.tree, "SPR_imageGalleryThumbBusy").length === 2);
    check("宿主抠像未完成时按钮继续转圈并禁止重复点击", byTag(hostKey.tree, "button").some(node => node.props["data-busy"] === "true" && textOf(node).includes("正在抠像")));
    const pollEffect = hostKeyEffects.find(effect => effect.deps?.length === 3 && effect.deps[1] === "i1" && typeof effect.deps[2] === "function");
    const savedSetInterval = globalThis.setInterval, savedClearInterval = globalThis.clearInterval;
    let intervalMs, clearedInterval;
    try {
      globalThis.setInterval = (_callback, ms) => { intervalMs = ms; return 712; };
      globalThis.clearInterval = id => { clearedInterval = id; };
      const cleanup = pollEffect?.fn();
      check("宿主抠像任务使页面持续轮询，超过本地700ms等待仍可刷新", intervalMs === 2500 && typeof cleanup === "function");
      cleanup?.();
      check("图片轮询清理定时器", clearedInterval === 712);
    } finally { globalThis.setInterval = savedSetInterval; globalThis.clearInterval = savedClearInterval; }

    const upload = renderModule(ImageModule, makeImageJob(), makeTasks(["img:upload"]));
    check("上传时出现忙碌徽章", byClass(upload.tree, "SPR_busyBadge").length >= 1);
    check(
      "上传时可点击虚线框禁用并转圈",
      byTag(upload.tree, "button").some((node) => node.props.className?.includes("SPR_uploadDrop") && node.props.disabled === true && byClass(node, "SPR_spinSm").length === 1)
    );

    // 宿主侧 running：还没轮到的那些也要盖住
    const runningJob = makeImageJob();
    runningJob.items = [
      { status: "running", source: "generated", file: "out/1.png", updatedAt: 2 },
      { status: "empty", source: "generated" }
    ];
    const running = renderModule(ImageModule, runningJob, makeTasks());
    check("宿主 running 时出现遮罩", overlays(running.tree).length >= 1, `${overlays(running.tree).length} 个`);

    // 结果只展示当前主图，底部下载与重新生成始终绑定当前结果。
    const acceptance = renderModule(ImageModule, makeImageJob(), makeTasks());
    const renderSelection = (tree, selectedIndex) => {
      const gallery = collect(tree, node => node.type?.name === "ImageResultGallery")[0];
      const previous = { slots: HOOK.slots, cursor: HOOK.cursor };
      try {
        HOOK.slots = [selectedIndex]; HOOK.cursor = 0;
        return gallery.type(gallery.props);
      } finally { Object.assign(HOOK, previous); }
    };
    check("图片结果菜单移除不再使用的「通过」", approveLabels(acceptance.tree).length === 0, approveLabels(acceptance.tree).join("、"));
    check("结果区只有一张主图卡片", byClass(acceptance.tree, "SPR_node").length === 1);
    check("底部保留所有结果的缩略图", byClass(acceptance.tree, "SPR_imageGalleryThumb").length === 2);
    const single = renderModule(ImageModule, makeImageJob({ items: [makeImageJob().items[0]] }), makeTasks());
    check("单张结果隐藏整个缩略图条", byClass(single.tree, "SPR_imageGalleryThumbs").length === 0);
    check("重新生成使用循环箭头图标并保留可访问名称和悬停说明", byTag(acceptance.tree, "button").some(node => node.props["aria-label"] === "重新生成" && node.props.title === "重新生成" && byTag(node, "path").some(path => path.props.d.startsWith("M3 12a9")) && textOf(node) === ""));
    const snapshotJob = makeImageJob();
    snapshotJob.history = snapshotJob.items.map((item, index) => ({ id: "actions-" + index, batchId: "round-actions", createdAt: 1, kind: "generated", item: { ...item, index }, request: { prompt: "历史描述", finalPrompt: "历史最终请求", settings: { count: 2 }, refs: [], keying: {} } }));
    const actionsTree = renderModule(ImageModule, snapshotJob, makeTasks()).tree;
    check("复用本轮直接可见，单独复用提示词保留在本轮更多菜单", byClass(actionsTree, "SPR_chatRoundActions").every(footer => byTag(footer, "button").some(node => textOf(node) === "复用本轮" && !node.props.role && !node.props.disabled) && byTag(footer, "button").some(node => textOf(node) === "复用提示词" && node.props.role === "menuitem") && !textOf(footer).includes("复用参数")));
    check("成功历史提供重新生成，无快照旧成功记录禁用", byTag(actionsTree, "button").some(node => node.props["aria-label"] === "重新生成" && !node.props.disabled) && byTag(acceptance.tree, "button").some(node => node.props["aria-label"] === "重新生成" && node.props.disabled));
    check("图片顶部移除重复更多菜单和设为当前结果", imageHeads(acceptance.tree).length === 1 && imageHeads(acceptance.tree).every(head => byTag(head, "button").length === 0) && !textOf(acceptance.tree).includes("设为当前结果"));
    const conversation = collect(acceptance.tree, node => node.type?.name === "ImageConversation")[0];
    const savedHooks = { slots: HOOK.slots, cursor: HOOK.cursor };
    let requestTree;
    try {
      HOOK.slots = []; HOOK.slots[5] = { finalPrompt: "已保存的最终生图请求" }; HOOK.cursor = 0;
      requestTree = conversation.type(conversation.props);
    } finally { Object.assign(HOOK, savedHooks); }
    const requestDialog = byTag(requestTree, "dialog").find(node => node.props["aria-label"] === "查看最终生图请求");
    const closeRequest = byTag(requestDialog, "button")[0];
    check("最终请求弹窗只有右上角关闭图标，不显示底部文字关闭", byTag(requestDialog, "button").length === 1 && closeRequest?.props["aria-label"] === "关闭" && textOf(closeRequest) === "" && byClass(requestDialog, "SPR_chatRequestHead").some(head => byTag(head, "button").includes(closeRequest)) && textOf(requestDialog).includes("已保存的最终生图请求"));
    let prevented = false;
    HOOK.capture = [];
    requestDialog.props.onCancel({ preventDefault: () => { prevented = true; } });
    check("最终请求弹窗保留Esc关闭", prevented && HOOK.capture.some(update => update.index === 5 && update.next === null));
    HOOK.capture = undefined;
    check("轮次顶部不再显示重复收藏或时间", byClass(acceptance.tree, "SPR_chatRoundHead").every(head => byTag(head, "button").length === 0 && byTag(head, "time").length === 0));
    check("每轮时间移动到底部操作栏", byClass(acceptance.tree, "SPR_chatRoundActions").every(footer => byTag(footer, "time").some(node => node.props.className === "SPR_chatRoundTime" && node.props.dateTime)));
    const firstNav = byClass(acceptance.tree, "SPR_imageGalleryArrow");
    check("首张禁用上一张，下一张可切换", firstNav.length === 2 && firstNav[0].props.disabled && !firstNav[1].props.disabled);
    const secondTree = renderSelection(acceptance.tree, 1);
    check("抠像PNG下载链接与预览共用图片版本，避免下载旧缓存", byTag(secondTree, "a").some(node => textOf(node) === "下载 PNG" && node.props.download.endsWith(".png") && node.props.href.endsWith("keyed/2.png?v=2")));
    const secondNav = byClass(secondTree, "SPR_imageGalleryArrow");
    check("切换后底部重新生成指向第二张", byTag(secondTree, "button").some(node => node.props["aria-label"] === "重新生成" && node.props["data-index"] === 1));
    check("末张禁用下一张，上一张可切换", !secondNav[0].props.disabled && secondNav[1].props.disabled);
    check("当前缩略图高亮", byClass(secondTree, "SPR_imageGalleryThumb").map(node => node.props["aria-pressed"]).join(",") === "false,true");
    check("删除末张后越界索引回到剩余结果", byTag(renderSelection(acceptance.tree, 7), "button").some(node => node.props["aria-label"] === "重新生成" && node.props["data-index"] === 1));
    check("图片任务有审核模式下拉", hasReviewModeSelect(acceptance.tree), modeOptions(acceptance.tree).join("、"));
    const approvedJob = makeImageJob();
    approvedJob.items = [
      { index: 0, status: "ready", source: "generated", file: "out/1.png", updatedAt: 2, approved: true },
      { index: 1, status: "empty", source: "generated" }
    ];
    const approvedTree = renderModule(ImageModule, approvedJob, makeTasks()).tree;
    check("旧的通过标记不会恢复已移除的审核按钮", approveLabels(approvedTree).length === 0, approveLabels(approvedTree).join("、"));
    const pendingApproval = collect(renderSelection(approvedTree, 1), node => node.props?.className === "SPR_btn" && textOf(node) === "通过");
    check("未就绪图片同样不显示「通过」", pendingApproval.length === 0);
  }
}

if (typeof SequenceModule === "function") {
  section("模块③ 序列帧生成");
  {
    const idle = renderModule(SequenceModule, makeSequenceJob(), makeTasks());
    check(
      "Hook 槽位与 SequenceModule 对齐",
      idle.hooks === EXPECTED_HOOKS.SequenceModule,
      `调用 ${idle.hooks} 个 Hook，期望 ${EXPECTED_HOOKS.SequenceModule}`
    );
    check("空闲时一个遮罩都没有", overlays(idle.tree).length === 0, `${overlays(idle.tree).length} 个`);
    check(
      "序列帧模块有抠像底色选择器",
      byTag(idle.tree, "input").some((node) => node.props.type === "color"),
      ""
    );

    const video = renderModule(SequenceModule, makeSequenceJob(), makeTasks(["seq:video"]));
    check("生成视频时遮罩盖住 video", overlays(video.tree).length >= 1, `${overlays(video.tree).length} 个`);
    check("遮罩文案是视频", overlayText(video.tree).includes("seq:video"), overlayText(video.tree));

    const frames = renderModule(SequenceModule, makeSequenceJob(), makeTasks(["seq:frames"]));
    check("抽帧时遮罩盖住预览", overlays(frames.tree).length >= 1, `${overlays(frames.tree).length} 个`);

    const key = renderModule(SequenceModule, makeSequenceJob(), makeTasks(["seq:key"]));
    check("重新抠像时遮罩盖住序列帧", overlays(key.tree).length >= 1, `${overlays(key.tree).length} 个`);

    const compose = renderModule(SequenceModule, makeSequenceJob(), makeTasks(["seq:compose"]));
    check("合成条图时遮罩盖住条图", overlays(compose.tree).length >= 1, `${overlays(compose.tree).length} 个`);

    const runningJob = makeSequenceJob();
    runningJob.video = { status: "running", remoteStatus: "Processing" };
    const running = renderModule(SequenceModule, runningJob, makeTasks());
    check("宿主视频 running 时出现遮罩", overlays(running.tree).length >= 1, `${overlays(running.tree).length} 个`);

    // 验收：视频 / 序列帧 / 条图三步各自可「通过」，审核模式下拉在。
    const acceptance = renderModule(SequenceModule, makeSequenceJob(), makeTasks());
    check("序列帧三步都有「通过」按钮", approveLabels(acceptance.tree).length === 3, approveLabels(acceptance.tree).join("、"));
    const seqZoom = collect(
      acceptance.tree,
      (node) => node.props?.["data-zoomable"] === "true" && typeof node.props.onDoubleClick === "function"
    );
    check("序列帧的逐帧缩略图可双击放大", seqZoom.length === 3, `${seqZoom.length} 个`);
    check("序列帧任务有审核模式下拉", hasReviewModeSelect(acceptance.tree), modeOptions(acceptance.tree).join("、"));
    const halfApproved = makeSequenceJob();
    halfApproved.frames = { ...halfApproved.frames, approved: true };
    check(
      "已通过的步骤显示「已通过」",
      collect(renderModule(SequenceModule, halfApproved, makeTasks()).tree, (node) => node.props?.className === "SPR_btn").map(textOf).includes("已通过")
    );
  }
}

// ── 深链接：会话里点一下链接就切到插件页面 ──────────────────────────────
//
// 这一段测的是**真实链路**：装好的捕获阶段监听器 → 解析 href → 切面板 → 广播意图。
// 模型在回复里贴的那条链接能不能用，全靠它。
section("深链接");
{
  const test = bundle.__test ?? {};
  check("测试把手导出深链接工具", typeof test.parseIntents === "function" && typeof test.subscribeIntent === "function", Object.keys(test).join("、"));
  check("拦截器已装在 document 上", CLICK_LISTENERS.length >= 1, `${CLICK_LISTENERS.length} 个监听器`);

  const click = CLICK_LISTENERS[0];
  const link = `http://127.0.0.1:43120/?dsh-gmm=1&module=sprite&project=p1&stage=videos`;

  const received = [];
  const unsubscribe = test.subscribeIntent((intent) => received.push(intent));

  const makeEvent = (href, overrides = {}) => {
    const anchor = { getAttribute: (name) => (name === "href" ? href : null) };
    return {
      button: 0,
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      target: { closest: (selector) => (selector === "a[href]" ? anchor : null) },
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
      ...overrides
    };
  };

  const panelsBefore = SELECTED_PANELS.length;
  const event = makeEvent(link);
  click(event);
  check("点击深链接被拦下（不跳转、不新开标签）", event.defaultPrevented === true && event.stopped === true, JSON.stringify({ prevented: event.defaultPrevented, stopped: event.stopped }));
  check("切到了工作台面板", SELECTED_PANELS.length === panelsBefore + 1 && SELECTED_PANELS.at(-1) === bundle.GAME_STUDIO_PANEL_ID, SELECTED_PANELS.at(-1));
  check("意图被广播出去", received.length === 1, JSON.stringify(received));
  check(
    "意图内容与链接一致",
    JSON.stringify(received[0]) === JSON.stringify({ module: "sprite", projectId: "p1", stage: "videos" }),
    JSON.stringify(received[0])
  );

  // 别的链接一律放行——拦错链接比不拦更糟。
  const plain = makeEvent("https://example.com/");
  click(plain);
  check("没有 dsh-gmm 参数的链接放行", plain.defaultPrevented === false, String(plain.defaultPrevented));
  const foreign = makeEvent("https://example.com/?utm=1");
  click(foreign);
  check("站外普通链接放行", foreign.defaultPrevented === false, String(foreign.defaultPrevented));
  // 我们的匹配只看参数、不看 origin：宿主拼链接时未必知道浏览器真实 origin
  // （可能被反代改写），所以换成别的 host 也必须照样切面板。
  const receivedBefore = received.length;
  click(makeEvent("http://192.168.1.9:43120/?dsh-gmm=1&module=image&job=i7"));
  check(
    "origin 不同但带我们的参数，仍按路径切面板",
    received.length === receivedBefore + 1 && received.at(-1).jobId === "i7",
    JSON.stringify(received.at(-1))
  );

  // 用户按 Ctrl / 中键想新开标签页时，不能抢走这次点击。
  const ctrl = makeEvent(link, { ctrlKey: true });
  click(ctrl);
  check("Ctrl+点击交给浏览器新开标签", ctrl.defaultPrevented === false, String(ctrl.defaultPrevented));
  const middle = makeEvent(link, { button: 1 });
  click(middle);
  check("中键点击交给浏览器", middle.defaultPrevented === false, String(middle.defaultPrevented));

  unsubscribe();
  const afterUnsubscribe = received.length;
  click(makeEvent(link));
  check("退订后不再收到意图", received.length === afterUnsubscribe, `${received.length}`);

  // 直接以 /?dsh-gmm=… 打开（中键新开标签的兜底路径）：应用启动时读一次并清掉参数。
  const bootstrapPanels = SELECTED_PANELS.length;
  windowStub.location.search = "?dsh-gmm=1&module=sequence&job=s9";
  windowStub.location.href = `http://127.0.0.1:43120/?dsh-gmm=1&module=sequence&job=s9`;
  const bootstrapReceived = [];
  const unsubscribeBootstrap = test.subscribeIntent((intent) => bootstrapReceived.push(intent));
  // apply 时会执行 consumeUrlIntent（effect 在桩里是立即执行）。
  bundle.apply(fakeCtx);
  check("以深链接打开时会切面板", SELECTED_PANELS.length === bootstrapPanels + 1, `${SELECTED_PANELS.length}`);
  check("地址栏里的参数被清掉", windowStub.location.search === "", windowStub.location.search);
  unsubscribeBootstrap();
  CLICK_LISTENERS.splice(0, CLICK_LISTENERS.length);
}

// ── 功能管理：隐藏的模块在界面上也必须真的消失 ────────────────────────────
//
// 「隐藏」是双向的（工具面由 verify-tools.mjs 钉），这里只管界面这一半：
// 页签、侧栏菜单、以及全隐藏时的空态。设置页的勾选要能写回宿主。
section("功能管理（隐藏模块）");
{
  const test = bundle.__test ?? {};
  const { visibleModulesOf, normalizeHiddenKeys, StudioGlyph, ConfigSection } = test;
  check(
    "测试把手导出可见性工具",
    typeof visibleModulesOf === "function" && typeof normalizeHiddenKeys === "function" && typeof StudioGlyph === "function",
    Object.keys(test).join("、")
  );

  // 收敛口径：只留已知模块，顺序固定 —— 与宿主 normalizeHiddenModules 同口径。
  check(`空数组 = 全部 ${MODULE_COUNT} 个模块可见`, visibleModulesOf([]).length === MODULE_COUNT, `${visibleModulesOf([]).length}`);
  check(
    "隐藏 rig / iso 后剩下的都还在（顺序固定）",
    JSON.stringify(visibleModulesOf(["rig", "iso"]).map((entry) => entry.key)) ===
      JSON.stringify(MODULE_KEYS.filter((key) => key !== "rig" && key !== "iso")),
    JSON.stringify(visibleModulesOf(["rig", "iso"]).map((entry) => entry.key))
  );
  check(
    "不认识的 key 被丢掉、顺序固定",
    JSON.stringify(normalizeHiddenKeys(["nope", "iso", "sprite"])) === JSON.stringify(["sprite", "iso"]),
    JSON.stringify(normalizeHiddenKeys(["nope", "iso", "sprite"]))
  );

  const tabs = (tree) => byClass(tree, "SPR_module").map((node) => node.props?.["data-module"]);
  const all = renderStage(makeProject(), "images", makeTasks());
  check(`默认 ${MODULE_COUNT} 个页签都在`, tabs(all.tree).length === MODULE_COUNT, tabs(all.tree).join("、"));
  check("默认没有「已隐藏」提示", byClass(all.tree, "SPR_modulesHiddenNote").length === 0);

  const some = renderStage(makeProject(), "images", makeTasks(), ["rig", "iso"]);
  check("隐藏后对应页签不再渲染", !tabs(some.tree).includes("rig") && !tabs(some.tree).includes("iso"), tabs(some.tree).join("、"));
  const visibleKeys = MODULE_KEYS.filter((key) => key !== "rig" && key !== "iso");
  check(`其余页签保留（${visibleKeys.length} 个）`, tabs(some.tree).join("、") === visibleKeys.join("、"), tabs(some.tree).join("、"));
  check("出现「已隐藏 N 个功能」提示", byClass(some.tree, "SPR_modulesHiddenNote").length === 1);

  // 当前选中的模块被隐藏时，界面必须落到第一个可见模块，而不是渲染一个被隐藏的模块。
  const fallback = renderStage(makeProject(), "images", makeTasks(), ["sprite"]);
  check(
    "选中的模块被隐藏时落到第一个可见模块",
    tabs(fallback.tree).join("、") === MODULE_KEYS.filter((key) => key !== "sprite").join("、"),
    tabs(fallback.tree).join("、")
  );
  check("被隐藏模块的界面不再渲染", byClass(fallback.tree, "SPR_moduleTitle").map(textOf).includes("图片生成"));

  const none = renderStage(makeProject(), "images", makeTasks(), MODULE_KEYS);
  check("全隐藏时一个页签都没有", tabs(none.tree).length === 0, tabs(none.tree).join("、"));
  check(
    "全隐藏时给出去哪打开的提示",
    textOf(none.tree).includes("所有功能都已被隐藏") && textOf(none.tree).includes("功能管理"),
    textOf(none.tree).slice(0, 120)
  );

  // ── 侧栏入口的菜单按钮 ──────────────────────────────────────────────────
  //
  // StudioGlyph 渲染在宿主 `<button class=…panelRow>` **内部**，所以它只能自己
  // 挂一个 `span[role=button]` 的触发器，并把这一下点击 stopPropagation 掉。
  // Hook 顺序：0 useHiddenModules / 1 open / 2 anchor / 3 rootRef / 4 menuRef。
  function renderRail(hidden, open = true) {
    HOOK.slots = [hidden, open, { left: 300, top: 120, bottom: 140 }];
    HOOK.cursor = 0;
    hookOverflow = false;
    return StudioGlyph({ size: 18, api: undefined, studioCtx: fakeCtx });
  }

  const closed = renderRail([], false);
  const trigger = byClass(closed, "SPR_railMenuBtn");
  check("入口上有菜单按钮", trigger.length === 1, `${trigger.length} 个`);
  check("菜单按钮带 aria 契约", trigger[0]?.props?.role === "button" && trigger[0]?.props?.["aria-haspopup"] === "menu", JSON.stringify({ role: trigger[0]?.props?.role, haspopup: trigger[0]?.props?.["aria-haspopup"] }));
  check("菜单默认不展开", byClass(closed, "SPR_railMenu").length === 0);
  check("图标本体还在", collect(closed, (node) => node.type === "svg").length >= 1);

  // 点一下菜单按钮：必须 preventDefault + 拦住冒泡，否则会顺带把面板切了。
  let toggled = false;
  const triggerEvent = {
    currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 100, right: 46, bottom: 136 }) },
    preventDefault: () => {
      toggled = true;
    },
    stopPropagation: () => {
      toggled = true;
    }
  };
  trigger[0].props.onClick(triggerEvent);
  check("点菜单按钮时拦住冒泡（不会顺手切面板）", toggled === true);

  const opened = renderRail(["rig"], true);
  const menu = byClass(opened, "SPR_railMenu");
  check("展开后出现菜单", menu.length === 1, `${menu.length} 个`);
  const items = byClass(opened, "SPR_railMenuItem");
  check(`菜单列出全部可见模块（${MODULE_COUNT - 1} 个）`, items.length === MODULE_COUNT - 1, `${items.length} 个`);
  check(
    "被隐藏的模块不在菜单里",
    !items.some((node) => node.props?.["data-module"] === "rig"),
    items.map((node) => node.props?.["data-module"]).join("、")
  );
  check("菜单里能直接点进某个功能", typeof items[0]?.props?.onClick === "function");
  check("菜单容器吞掉点击，不会冒泡到宿主按钮", typeof menu[0]?.props?.onClick === "function" && typeof menu[0]?.props?.onMouseDown === "function");
  check("菜单底部说明隐藏了几个", textOf(opened).includes("已隐藏 1 个功能"), textOf(opened).slice(0, 80));

  // 点某一项 → 广播意图 + 切到工作台面板（与深链接同一条路径）。
  const received = [];
  const unsubscribe = test.subscribeIntent((intent) => received.push(intent));
  const panelsBefore = SELECTED_PANELS.length;
  items.find((node) => node.props?.["data-module"] === "sequence").props.onClick({
    preventDefault() {},
    stopPropagation() {}
  });
  check("点菜单项会切到工作台面板", SELECTED_PANELS.length === panelsBefore + 1 && SELECTED_PANELS.at(-1) === bundle.GAME_STUDIO_PANEL_ID, SELECTED_PANELS.at(-1));
  check("点菜单项广播对应模块的意图", JSON.stringify(received.at(-1)) === JSON.stringify({ module: "sequence" }), JSON.stringify(received.at(-1)));
  unsubscribe();

  const railAllHidden = renderRail(MODULE_KEYS, true);
  check("全隐藏时菜单给出提示而不是空菜单", byClass(railAllHidden, "SPR_railMenuEmpty").length === 1 && byClass(railAllHidden, "SPR_railMenuItem").length === 0);

  // ── 设置页的「功能管理」分组 ────────────────────────────────────────────
  check("设置页组件已注册", typeof ConfigSection === "function", typeof ConfigSection);
  if (typeof ConfigSection === "function") {
    const featureConfig = {
      hiddenModules: ["rig"],
      imageProvider: "ark",
      customProtocol: "openai",
      customBaseUrl: "https://api.openai.com/v1",
      customModel: "gpt-image-1",
      customSize: "1024x1024",
      customWorkflow: "",
      customApiKeySet: false,
      customApiKeyHint: "",
      customProtocols: [],
      imageProviderSummary: "火山方舟 · doubao-seedream-5-0-flash-260915",
      imageProviderBlocker: "尚未配置火山方舟 API Key（设置 → 游戏素材大师 → 生图后端 → 火山方舟）",
      customImageBlocker: null,
      arkApiKeySet: false,
      minimaxApiKeySet: false,
      arkModel: "doubao-seedream-5-0-flash-260915",
      arkRedrawModel: "",
      arkSize: "2K",
      arkBaseUrl: "https://ark.example/api/v3",
      arkModels: [],
      minimaxModel: "MiniMax-H3",
      minimaxDuration: 5,
      minimaxResolution: "2K",
      minimaxBaseUrl: "https://api.minimaxi.com",
      minimaxModels: [],
      minimaxHosts: [],
      cellWidth: 256,
      cellHeight: 256,
      frameCount: 8,
      concurrency: 3,
      keyLow: 14,
      keyHigh: 80,
      despill: 0.65,
      edgeShrink: 0,
      bgTolerance: 90,
      workingLongEdge: 768,
      pixelSize: 0,
      fillRatio: 0.94,
      bottomMargin: 2,
      dataRoot: "/tmp/dsh-gmm"
    };

    const saved = [];
    const configApi = {
      getConfig: () => Promise.resolve(featureConfig),
      saveConfig: (payload) => {
        saved.push(payload);
        return Promise.resolve({ ...featureConfig, ...payload });
      },
      testArk: () => Promise.resolve({}),
      testMinimax: () => Promise.resolve({})
    };

    // Hook 顺序（位置桩）：0 useLocaleTick / 1 config / 2 arkKey / 3 customKey /
    // 4 toapisKey / 5 minimaxKey / 6 notice / 7 testing / 8 workflowDraft /
    // 9 comfyWorkflowDraft / 10 comfyProbe / 11 comfyCookie / 12 musicKey /
    // 13 scorePaths / 14 sfxKey / 15 settingsTab。
    HOOK.slots = [0, featureConfig, "", "", "", "", null, "", undefined, undefined, undefined, undefined, undefined, undefined, undefined, "image"];
    HOOK.cursor = 0;
    hookOverflow = false;
    const settings = ConfigSection({ api: configApi });

    const rows = collect(settings, (node) => typeof node.props?.["data-feature"] === "string");
    check(`设置页有 ${MODULE_COUNT} 个功能开关`, rows.length === MODULE_COUNT, `${rows.length} 个`);
    const rigRow = rows.find((node) => node.props["data-feature"] === "rig");
    check("被隐藏的那一行标成已隐藏", rigRow?.props?.["data-hidden"] === "true");
    const checkboxes = collect(settings, (node) => typeof node.props?.["data-testid"] === "string" && node.props["data-testid"].startsWith("cfg-feature-"));
    check(`每个开关都有可点的勾选框（${MODULE_COUNT} 个）`, checkboxes.length === MODULE_COUNT, `${checkboxes.length} 个`);
    check(
      "勾选框与隐藏状态一致（rig 未勾）",
      checkboxes.find((node) => node.props["data-testid"] === "cfg-feature-rig")?.props?.checked === false &&
        checkboxes.find((node) => node.props["data-testid"] === "cfg-feature-sprite")?.props?.checked === true
    );

    // 重新勾上 rig → 写回宿主的 hiddenModules 应当只剩空数组。
    checkboxes.find((node) => node.props["data-testid"] === "cfg-feature-rig").props.onChange({ target: { checked: true } });
    check("勾选后写回宿主", JSON.stringify(saved.at(-1)) === JSON.stringify({ hiddenModules: [] }), JSON.stringify(saved.at(-1)));

    // 隐藏 sprite → hiddenModules 按固定顺序排列。
    checkboxes.find((node) => node.props["data-testid"] === "cfg-feature-sprite").props.onChange({ target: { checked: false } });
    check("取消勾选后写回宿主", JSON.stringify(saved.at(-1)) === JSON.stringify({ hiddenModules: ["sprite", "rig"] }), JSON.stringify(saved.at(-1)));
    check("设置页说明隐藏后 AI 也调不到", textOf(settings).includes("对话里的 AI 也无法调用它"));

    // 插入线画在两行之间，必须由列表接收事件；只给行绑定 drop 会显示能放但不保存。
    const FeatureOrderList = collect(settings, node => node.type?.name === "FeatureOrderList")[0]?.type;
    const layoutRows = MODULE_KEYS.map((key, i) => ({
      dataset: { feature: key }, getBoundingClientRect: () => ({ top: 100 + i * 62, height: 56 })
    }));
    for (const [label, source, y, expected] of [
      ["行间插入线", "music", 159, ["sprite", "music", ...MODULE_KEYS.filter(key => !["sprite", "music"].includes(key))]],
      ["列表顶部留白", "sfx", 96, ["sfx", ...MODULE_KEYS.filter(key => key !== "sfx")]],
      ["列表底部留白", "sprite", 593, [...MODULE_KEYS.filter(key => key !== "sprite"), "sprite"]]
    ]) {
      HOOK.slots = []; HOOK.cursor = 0;
      const saves = [];
      const tree = FeatureOrderList({ order: MODULE_KEYS, hidden: [], onToggle() {}, onSaveOrder: async next => { saves.push(next); } });
      const list = byClass(tree, "SPR_featureList")[0];
      const handle = byClass(tree, "SPR_featureRow").find(node => node.props["data-feature"] === source).children[0];
      const calls = { prevented: 0, stopped: 0 };
      const event = {
        clientY: y, currentTarget: { querySelectorAll: () => layoutRows, parentElement: {} },
        dataTransfer: { setData() {}, setDragImage() {} },
        preventDefault() { calls.prevented++; }, stopPropagation() { calls.stopped++; }
      };
      handle.props.onDragStart(event);
      check(`${label}由整个列表接收拖放`, typeof list.props.onDragOver === "function" && typeof list.props.onDrop === "function");
      list.props.onDragOver?.(event); list.props.onDrop?.(event);
      check(`${label}放下后提交正确顺序且只保存一次`, saves.length === 1 && JSON.stringify(saves[0]) === JSON.stringify(expected), JSON.stringify(saves));
      check(`${label}阻止宿主把排序误当成外部文件拖放`, calls.prevented === 2 && calls.stopped === 3);
    }
    HOOK.slots = []; HOOK.cursor = 0;

    /**
     * 生图连接配置常驻；实际后端与模型由输入栏选择，不在设置重复选择。
     *
     * 这两组**必须同时渲染**：用户经常要先配好自定义服务、点一次「测试连接」，
     * 确认能出图之后再把它切成当前后端。只渲染「当前那一组」的话，
     * 没配火山方舟 Key 的用户连自己的本地服务都配不上。
     */
    const providerSelect = collect(settings, (node) => node.props?.["data-testid"] === "cfg-image-provider")[0];
    check("设置页不再重复提供生图后端选择器", providerSelect === undefined);
    const imagePanel = collect(settings, node => node.props?.["data-testid"] === "cfg-panel-image")[0];
    const imageSections = collect(imagePanel, node => node.props?.className === "SPR_settingsSectionTab");
    check("生图设置只保留三个连接页签", imageSections.length === 3 && imageSections.every(node => textOf(node) !== "生图后端"));
    check("ToAPIs 独立设置组存在", collect(settings,node=>node.props?.["data-testid"] === "cfg-toapis").length === 1);
    check("ToAPIs API Key 使用密码框", collect(collect(settings,node=>node.props?.["data-testid"] === "cfg-toapis")[0],node=>node.props?.type === "password").length === 1);
    check("缺 Key 时在当前连接页给出阻塞原因", collect(imagePanel, node => node.props?.className === "SPR_note").some(node => textOf(node).includes("还不能开跑")));
    check("当前连接在设置页签中有标记", collect(imagePanel, node => node.props?.className === "SPR_settingsSectionCurrent" && node.props?.["aria-label"] === "当前使用").length === 1);

    // 默认协议是 openai：协议下拉、地址、模型名、尺寸、测试按钮都要在。
    check("自定义那一组有协议下拉（三种协议由宿主给）", collect(settings, (node) => node.props?.["data-testid"] === "cfg-custom-protocol").length === 1);
    check("自定义那一组有 Base URL 与模型名输入框", collect(settings, (node) => node.props?.["data-testid"] === "cfg-custom-base-url").length === 1 && collect(settings, (node) => node.props?.["data-testid"] === "cfg-custom-model").length === 1);
    check("自定义那一组有输出尺寸输入框", collect(settings, (node) => node.props?.["data-testid"] === "cfg-custom-size").length === 1);
    check("OpenAI 协议不显示 ComfyUI 的工作流文本框（调了也没用的控件不该出现）", collect(settings, (node) => node.props?.["data-testid"] === "cfg-custom-workflow").length === 0);
    check("自定义那一组也有自己的「测试连接」", textOf(settings).includes("测试连接（会真实生成 1 张测试图"));

    // ── 分类页签：六个入口、六个面板常驻挂载 ──────────────────────────────
    const tabButtons = collect(settings, (node) => typeof node.props?.["data-testid"] === "string" && node.props["data-testid"].startsWith("cfg-tab-"));
    const panels = collect(settings, (node) => node.type === "div" && typeof node.props?.["data-testid"] === "string" && node.props["data-testid"].startsWith("cfg-panel-"));
    check("设置页有 7 个分类页签", tabButtons.length === 7, `${tabButtons.length} 个`);
    check("默认停在「生图」页签", tabButtons.find((node) => node.props["data-testid"] === "cfg-tab-image")?.props?.["data-active"] === "true");
    check("七个页签面板都常驻挂载（只是 hidden）", panels.length === 7, `${panels.length} 个`);
    check("非当前面板被 hidden", panels.find((node) => node.props["data-testid"] === "cfg-panel-music")?.props?.hidden === true);
    check("当前面板没有 hidden", panels.find((node) => node.props["data-testid"] === "cfg-panel-image")?.props?.hidden === false);
    // 后端表单不再折叠，由左右选项卡切换；表单常驻，切换不会丢草稿。
    const arkGroup = collect(settings, (node) => node.props?.["data-testid"] === "cfg-ark-group")[0];
    const customGroup = collect(settings, (node) => node.props?.["data-testid"] === "cfg-custom-group")[0];
    check("当前后端表单完整展开", arkGroup?.props?.["data-open"] === "true");
    check("非当前后端也可由选项卡打开", customGroup?.props?.["data-open"] === "true" && customGroup?.props?.["data-collapsible"] === undefined);
    check("隐藏的后端仍渲染，可先配置再切换", collect(customGroup, (node) => node.props?.["data-testid"] === "cfg-custom-protocol").length === 1);
    check("ToAPIs 视频单独成组", collect(settings, (node) => node.props?.["data-testid"] === "cfg-toapis-video").length === 1);
    const miscPanel = panels.find((node) => node.props["data-testid"] === "cfg-panel-misc");
    check("ffmpeg 状态归到「功能与数据」", textOf(miscPanel).includes("ffmpeg"));
    check("数据路径也在「功能与数据」里", textOf(miscPanel).includes("所有项目"));

    // 切到 ComfyUI：工作流文本框与保存按钮出现（UTF-8 JSON 不能每敲一个字就提交一次）。
    const comfyConfig = {
      ...featureConfig,
      imageProvider: "custom",
      customProtocol: "comfyui",
      customBaseUrl: "http://127.0.0.1:8188",
      customModel: "sdxl.safetensors",
      customSize: "1024x1024",
      customWorkflow: '{"1":{}}',
      customProtocols: [
        { id: "openai", label: "OpenAI API", baseUrl: "https://api.openai.com/v1", hint: "hint" },
        { id: "comfyui", label: "ComfyUI API", baseUrl: "http://127.0.0.1:8188", hint: "hint" },
        { id: "sdwebui", label: "Stable Diffusion WebUI API", baseUrl: "http://127.0.0.1:7860", hint: "hint" }
      ],
      imageProviderSummary: "自定义 · ComfyUI API · http://127.0.0.1:8188",
      imageProviderBlocker: null,
      customImageBlocker: null
    };
    const saved2 = [];
    const api2 = {
      getConfig: () => Promise.resolve(comfyConfig),
      saveConfig: (payload) => {
        saved2.push(payload);
        return Promise.resolve({ ...comfyConfig, ...payload });
      },
      testArk: () => Promise.resolve({}),
      testCustomImage: () => Promise.resolve({ provider: "自定义 · ComfyUI API", bytes: 1 }),
      testMinimax: () => Promise.resolve({})
    };
    HOOK.slots = [0, comfyConfig, "", "", "", "", null, null, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "image"];
    HOOK.cursor = 0;
    hookOverflow = false;
    const comfySettings = ConfigSection({ api: api2 });
    const workflowBox = collect(comfySettings, (node) => node.props?.["data-testid"] === "cfg-custom-workflow")[0];
    check("切到 ComfyUI 后出现工作流文本框", workflowBox !== undefined);
    check("工作流文本框里是已经存过的那份", workflowBox?.props?.value === '{"1":{}}', String(workflowBox?.props?.value).slice(0, 40));
    const comfyImagePanel = collect(comfySettings, node => node.props?.["data-testid"] === "cfg-panel-image")[0];
    check("生图设置默认打开当前自定义连接", collect(comfyImagePanel, node => node.props?.className === "SPR_settingsSectionTab" && node.props?.["aria-selected"] === true).some(node => textOf(node).includes("自定义生图模型")));
    check("切到自定义后该卡展开", collect(comfySettings, (node) => node.props?.["data-testid"] === "cfg-custom-group")[0]?.props?.["data-open"] === "true");
    check("非当前 Ark 表单仍可完整配置", collect(comfySettings, (node) => node.props?.["data-testid"] === "cfg-ark-group")[0]?.props?.["data-open"] === "true");
    check("已就绪的连接不重复显示就绪横幅或阻塞信息", collect(comfyImagePanel, node => node.props?.className === "SPR_note").length === 0);
    // NumField 是函数组件，`textOf` 展不开它，只能按 props.label 找。
    check(
      "ComfyUI 下显示采样步数 / CFG 等高级参数",
      collect(comfySettings, (node) => node.props?.label === "采样步数").length === 1 &&
        collect(comfySettings, (node) => node.props?.label === "CFG / 引导强度").length === 1
    );
    check("超时对所有协议都显示（不受协议条件块影响）", collect(comfySettings, (node) => node.props?.label === "请求超时（毫秒，本地模型建议给足）").length === 1);
    check("协议说明里写出真实端点", textOf(comfySettings).includes("请求端点"));
    // 每敲一个字都不发请求：草稿只在变化后由「保存工作流」提交。
    workflowBox.props.onChange({ target: { value: '{"1":{"a":1}}' } });
    check("改工作流不立刻写配置（大 JSON 每字符一次往返会卡）", saved2.length === 0, JSON.stringify(saved2));
  }

  // 收尾：把共享状态复位，免得影响后续断言。
  test.publishHiddenModules([]);
}

section("骨骼语义保存：真实组件事件的业务失败反馈");
{
  const { RigSemanticsPanel } = bundle.__test ?? {};
  check("产物暴露骨骼语义面板测试入口", typeof RigSemanticsPanel === "function");
  if (typeof RigSemanticsPanel === "function") {
    const notices = [], calls = [], pending = [];
    let response = { ok: false, touched: 0, errors: [{ message: "父级链成环：torso → head → torso" }], warnings: [] };
    const run = (fn, text, key) => {
      const operation = Promise.resolve().then(fn).then((value) => {
        notices.push({ kind: "ok", text, key }); return value;
      }, (error) => { notices.push({ kind: "error", text: error.message, key }); });
      pending.push(operation);
      return operation;
    };
    HOOK.slots = []; HOOK.cursor = 0;
    const tree = RigSemanticsPanel({
      job: { id: "rfixture", parts: [
        { name: "torso", status: "ready", role: "torso", parent: null },
        { name: "head", status: "ready", role: "head", parent: "torso" }
      ] },
      api: { setRigSemantics: (payload) => { calls.push(payload); return Promise.resolve(response); } },
      run, activeKey: "rig:layout"
    });
    const parent = collect(tree, (node) => node.props?.["data-testid"] === "rig-sem-parent-torso")[0];
    check("语义面板父级下拉有可执行事件", typeof parent?.props?.onChange === "function");
    if (parent?.props?.onChange) {
      parent.props.onChange({ target: { value: "head" } });
      await pending.at(-1);
      check("成环业务结果显示具体错误", notices.at(-1)?.kind === "error" && notices.at(-1).text.includes("父级链成环"));
      check("成环没有显示已更新成功", notices.every((n) => n.kind !== "ok"));
      response = { ok: true, touched: 1, errors: [], warnings: [] };
      parent.props.onChange({ target: { value: "" } });
      await pending.at(-1);
      check("选 root 发送明确的 null 父级", calls.at(-1).parts[0].parent === null);
      check("合法语义变更仍显示成功", notices.at(-1)?.kind === "ok" && notices.at(-1).text.includes("已更新"));
      response = { ok: false, touched: 0, errors: [], warnings: [] };
      parent.props.onChange({ target: { value: "head" } });
      await pending.at(-1);
      check("无详细错误时仍显示语义校验失败", notices.at(-1)?.kind === "error" && notices.at(-1).text.includes("语义校验失败"));
    }
  }
}

section("草稿合并：轮询不许覆盖用户正在输入的内容");
{
  // 真机反馈：「这个提示词是无法替换的呀，我替换的时候它一秒钟又换回来。」
  // 根因：有任务在跑时界面每 2.5~5 秒拉一次项目 / 任务，load() 无条件拿宿主的值
  // 整份覆盖草稿 —— 用户正在长文本框里替换提示词，刚打进去的内容就被打回原形。
  // 现在只有「草稿 === 上一次宿主值」（没改过）的字段才跟着宿主走。
  const { mergeDrafts } = bundle.__test ?? {};
  check("产物暴露草稿合并测试入口", typeof mergeDrafts === "function");
  if (typeof mergeDrafts === "function") {
    const SERVER = "[Static shot] 固定机位…";
    // 没改过：跟着宿主更新（切语言 / 重置默认都靠这条）。
    check("没改过的提示词跟着宿主更新", mergeDrafts(SERVER, SERVER, "新模板", false) === "新模板");
    check("草稿还没初始化时用宿主的值", mergeDrafts(undefined, "", SERVER, false) === SERVER);
    // 改过：轮询（宿主值没变）不能把它打回去。
    const TYPED = "我自己的提示词：镜头不动，走三步就行。";
    let draft = mergeDrafts(SERVER, SERVER, SERVER, false);
    draft = TYPED; // 用户输入（受控 textarea 的 local state）
    for (let i = 0; i < 5; i++) draft = mergeDrafts(draft, SERVER, SERVER, false);
    check("连续 5 次轮询后仍是用户输入的内容", draft === TYPED, draft);
    // 换项目 / 明确重置：整份换成宿主的。
    check("force 时即使改过也换成宿主的值", mergeDrafts(TYPED, SERVER, "默认模板", true) === "默认模板");

    // 对象草稿（八方向提示词 / 参数）：逐字段判断，别互相牵连。
    const before = { front: "A", back: "B" };
    const merged = mergeDrafts({ front: "用户改过的 A", back: "B" }, before, { front: "A2", back: "B2" }, false);
    check("改过的方向留住、没改过的方向跟着宿主更新", merged.front === "用户改过的 A" && merged.back === "B2", JSON.stringify(merged));
    check("对象草稿在 force 时整份替换", JSON.stringify(mergeDrafts({ front: "X" }, before, { front: "A2", back: "B2" }, true)) === JSON.stringify({ front: "A2", back: "B2" }));

    // 同一份逻辑也用于模块②③④ 的参数草稿（尺寸 / 网格这些）。
    const oldSettings = { size: "1024x1024", count: 2, animations: ["idle"] };
    const nextSettings = { size: "1024x1024", count: 8, animations: ["idle", "walk"] };
    const settings = mergeDrafts({ ...oldSettings, count: 4 }, oldSettings, nextSettings, false);
    check("正在改的参数不被轮询冲掉，其余参数照常同步", settings.count === 4 && settings.animations.join() === "idle,walk", JSON.stringify(settings));
    // 宿主回包缺字段（老版本）时不能把草稿里的键吞掉判断成「改过」——缺的键直接用宿主的。
    check("草稿里没有的字段直接用宿主的值", mergeDrafts({}, oldSettings, nextSettings, false).count === 8);
  }
}


section("图片提示词保存与生成时序");
{
  const job = makeImageJob({ prompt: "previous saved prompt" });
  const calls = [];
  let releaseFirst, signalGenerated;
  const firstSave = new Promise(resolve => { releaseFirst = resolve; });
  const generated = new Promise(resolve => { signalGenerated = resolve; });
  const apiQueued = {
    saveImageJob: async payload => {
      calls.push({ type: "save", prompt: payload.prompt });
      if (calls.filter(x => x.type === "save").length === 1) await firstSave;
      job.prompt = payload.prompt;
      return { ok: true };
    },
    runImageJob: async () => {
      calls.push({ type: "generate", prompt: job.prompt });
      signalGenerated();
      return { started: true };
    },
    getImageJob: async () => job,
    listImageJobs: async () => ({ jobs: [job] })
  };
  HOOK.slots = [0, [job], job.id, job, null, false, "latest typed prompt", "", {...job.settings}, {...job.keying}, undefined, {}, null];
  HOOK.cursor = 0;
  const tree = ImageModule({ api: apiQueued });
  const prompt = byTag(tree, "textarea").find(node => node.props.placeholder === "描述你要生成的图片…");
  const generate = byTag(tree, "button").find(node => (/^生成 [0-9]+ 张$/).test(node.props["aria-label"] ?? ""));
  check("真渲染中存在提示词和生成入口", Boolean(prompt && generate));
  prompt.props.onBlur();
  generate.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  check("失焦保存未完成时不提交生成", calls.length === 1 && calls[0].type === "save", JSON.stringify(calls));
  releaseFirst();
  await generated;
  await new Promise(resolve => setImmediate(resolve));
  check("所有保存完成后才使用最新提示词生成", calls.map(x=>x.type).join(",") === "save,save,generate" && calls.at(-1).prompt === "latest typed prompt", JSON.stringify(calls));
  check("主动生成成功后才跟随最新轮次", CLIENT_EVENTS.some(event => event.type === "gmm-image-conversation" && event.detail.jobId === job.id && event.detail.latest === true));
}

section("手动抠像保存时序");
for (const failSave of [false, true]) {
  const job = makeImageJob({ keying: { enabled: true, despill: 0.1 } });
  const calls = [];
  let releaseSave;
  const pendingSave = new Promise(resolve => { releaseSave = resolve; });
  const apiKeying = {
    saveImageJob: async payload => {
      calls.push({ type: "save", ...payload });
      if (calls.length === 1) await pendingSave;
      if (payload.keying) {
        if (failSave) return { ok: false };
        job.keying = payload.keying;
      }
      return { ok: true };
    },
    keyImageJob: async () => { calls.push({ type: "key", despill: job.keying.despill }); return { started: true }; },
    getImageJob: async () => job,
    listImageJobs: async () => ({ jobs: [job] })
  };
  HOOK.slots = [0, [job], job.id, job, null, false, "draft", "", {...job.settings}, { enabled: true, despill: 0.75 }, undefined, {}, null];
  HOOK.cursor = 0;
  const tree = ImageModule({ api: apiKeying });
  byTag(tree, "textarea").find(node => node.props.placeholder === "描述你要生成的图片…").props.onBlur();
  byTag(tree, "button").find(node => textOf(node) === "按当前参数重新抠像").props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  check(`已有保存未完成时不启动抠像（保存${failSave ? "拒绝" : "成功"}）`, calls.length === 1 && calls[0].type === "save");
  releaseSave();
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  check(failSave ? "参数保存失败不提交抠像" : "等待保存当前抠像参数后才提交，使用最新强度", failSave ? !calls.some(call => call.type === "key") : calls.map(call => call.type).join(",") === "save,save,key" && calls.at(-1).despill === 0.75);
}

section("白模动作流程：五阶段、费用确认与选择反馈");
{
  const { MotionModule } = bundle.__test;
  const segments = [{action:'walkfoward',start:0,end:2,frameCount:4},{action:'runforward',start:2,end:4,frameCount:4}];
  const frames = [{id:'walk-front-0',action:'walkfoward',direction:'front',index:0,keyed:'frames/raw.png'}, {id:'walk-front-1',action:'walkfoward',direction:'front',index:1,keyed:'frames/raw1.png',redraw:{status:'ready',file:'redraw/hd.png'}}];
  const job = {id:'w123456789',name:'测试角色',description:'白发蓝衣',prompt:'固定动作和颜色',segments,ranges:segments,rangesConfirmed:false,frames,prepared:{video:'prepared/ref.mp4'},costs:{video:1.28,imageRate:.1},templates:[{key:'walkfoward',name:'行走',originalName:'walk'},{key:'runforward',name:'奔跑',originalName:'run'}],assetBase:'/dsh-game-material-master/motion-assets/w123456789/'};
  const renderMotion = (stage, overrides={}, slotOverrides={}) => {
    const value={...job,...overrides};
    HOOK.slots=[0,[value],[],"",value.id,value,stage,{...value},null,{baseUrl:'http://localhost:11434/v1',model:'',videoRate:.16,imageRate:.1},'',false,false,false,false,[],"",'front'];
    HOOK.slots[20]={}; // usePendingTasks map, after two refs
    for(const [key,val] of Object.entries(slotOverrides))HOOK.slots[Number(key)]=val;
    HOOK.cursor=0;
    return MotionModule({api});
  };
  const button = (tree,label) => byTag(tree,'button').find(n=>textOf(n)===label);
  check('白模组件可从构建产物加载',typeof MotionModule==='function');
  const first=renderMotion(0);
  check('导航含五个阶段',byTag(first,'nav').some(n=>byTag(n,'button').length===5));
  check('默认选择两动作，最多三动作',byTag(first,'select').some(n=>n.props.value===2 && modeOptions(n).includes(3) && !modeOptions(n).includes(4)));
  check('已有八方向项目提供免费导入',Boolean(button(first,'导入已有角色和八方向图（免费）')));
  check('两种角色参考输入存在',byTag(first,'input').filter(n=>n.props.type==='file').length===2);
  const second=renderMotion(1);
  check('未确认费用时不能生成视频',button(second,'生成八方向多动作视频')?.props.disabled===true);
  check('已确认且有参考时允许提交',button(renderMotion(1,{}, {11:true}),'生成八方向多动作视频')?.props.disabled===false);
  check('已有视频须显式重新生成',button(renderMotion(1,{video:{status:'ready'}},{11:true}),'生成八方向多动作视频')?.props.disabled===true);
  check('手动提示词保持可编辑',byTag(second,'textarea').some(n=>n.props.value==='固定动作和颜色'&&!n.props.disabled));
  check('未配文字模型时禁用整理，模板仍可用',button(second,'使用文字模型整理角色描述')?.props.disabled===true && !button(second,'按当前动作重建提示词')?.props.disabled);
  const busy=renderMotion(1,{active:true,operation:'prepare'});
  check('本地处理显示状态和停止入口',byTag(busy,'p').some(n=>n.props.role==='status')&&Boolean(button(busy,'停止后续处理（已提交请求可能计费）')));
  check('本地处理时禁止重复提交',button(busy,'正在提交视频…')?.props.disabled===true);
  const third=renderMotion(2,{video:{status:'ready',file:'videos/test.mp4',duration:4}});
  check('未验收范围时禁止抽帧',button(third,'按动作抽取八方向帧')?.props.disabled===true);
  check('确认实际范围后可抽帧',button(renderMotion(2,{video:{status:'ready',duration:4},rangesConfirmed:true}),'按动作抽取八方向帧')?.props.disabled===false);
  check('视频分段页面支持本地视频导入',byTag(third,'input').some(n=>n.props.accept==='video/mp4,video/webm'));
  const fourth=renderMotion(3,{}, {15:frames.map(f=>f.id)});
  check('已完成重绘不重复计入调用数量',textOf(fourth).includes('本次新增图片调用：1张'));
  check('未确认图片费用禁用重绘',button(fourth,'重绘选中帧')?.props.disabled===true);
  check('确认图片费用才允许重绘',button(renderMotion(3,{}, {12:true,15:[frames[0].id]}),'重绘选中帧')?.props.disabled===false);
  HOOK.capture=[];
  button(fourth,'选择当前可见帧').props.onClick();
  check('改变批量选择会撤销旧费用确认',HOOK.capture.some(u=>u.index===12&&u.next===false));
  HOOK.capture=undefined;
  const fifth=renderMotion(4,{archive:'out/sprites.zip'});
  check('导出包链接使用相对assetBase',saveHrefs(fifth).some(s=>s.startsWith(job.assetBase)&&s.includes('sprites.zip')));
  check('空帧任务不能导出',button(renderMotion(4,{frames:[]}),'打包全部动作')?.props.disabled===true);
  renderStage(makeProject(),'images',makeTasks(),[],undefined);
  // Exercise the actual default by omitting the selector fixture.
  HOOK.slots[5]=undefined;HOOK.cursor=0;
  const defaultTree=panel({api});
  check('插件默认显示白模入口且原流程可切换',collect(defaultTree,n=>n.type===MotionModule).length===1 && Boolean(button(defaultTree,'原有八方向流程')));
}

// ── 工作台功能缓存（不读写真实浏览器或宿主配置）─────────────────────────
{
  const test = bundle.__test;
  const storage = new Map();
  windowStub.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const cacheKey = "dsh-game-material-master:last-module";
  check("无功能缓存时返回空值", test.readLastStudioModule() === null);
  test.rememberStudioModule("image");
  check("保存并读取上次功能", test.readLastStudioModule() === "image" && storage.get(cacheKey) === "image");
  test.rememberStudioModule("settings");
  check("设置页不覆盖上次功能", test.readLastStudioModule() === "image");
  storage.set(cacheKey, "removed-module");
  check("失效功能缓存被忽略", test.readLastStudioModule() === null);
  windowStub.localStorage = { getItem() { throw Error("Storage unavailable"); }, setItem() { throw Error("Storage unavailable"); } };
  test.rememberStudioModule("sequence");
  check("浏览器禁用存储时保留页面内选择", test.readLastStudioModule() === "sequence");
  windowStub.localStorage = undefined;
  test.publishModuleOrder(["sequence", "image", "sprite"]);
  const selected = (module, hidden = []) => byClass(renderStage(makeProject(), "images", makeTasks(), hidden, "classic", module).tree, "SPR_module").find(node => node.props["aria-selected"] === true)?.props["data-module"];
  check("无缓存按保存后的顺序打开第一个功能", selected(null) === "sequence");
  check("有效缓存优先于功能排序", selected("image") === "image");
  check("缓存功能隐藏后打开第一个可见功能", selected("image", ["sequence", "image"]) === "sprite");
  check("缓存功能无效时打开第一个功能", selected("removed-module") === "sequence");
  test.publishModuleOrder(undefined);
}

report();

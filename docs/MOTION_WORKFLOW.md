# DSH 白模动作流程

这是「八方向图生成」模块内的新默认入口，保留 DSH 插件结构与原有八方向流程。日常操作在插件内完成，不需要 Codex 或聊天 agent 参与。

## 从公开 GitHub 安装

适用于 **DeepSeek Harness（DSH）** 的插件系统。DSH 的 `plugin` 命令将包参数传给 pnpm，因此支持 GitHub 源码和 HTTP 安装包。普通 DeepSeek 网页聊天没有这套 DSH 插件加载器。

推荐使用带构建产物的版本包；无需安装 Python 或手动编译：

```powershell
dsh plugin --profile desktop add "https://github.com/censki-sketch/dsh-game-material-master/releases/download/v0.12.0-motion.1/dsh-game-material-master-0.12.0-motion.1.tgz"
```

从同一版本的源码安装：

```powershell
dsh plugin --profile desktop add "github:censki-sketch/dsh-game-material-master#v0.12.0-motion.1"
```

使用其他 profile（例如 `web`）时替换名称。重启 DSH 后打开侧栏「游戏素材大师」。如果终端找不到 `dsh`，请先启用 DSH 的命令行入口；Windows 也可使用安装目录下 `resources/runtime/cli/bin/dsh.cmd`。这版保留原插件 ID，应替换已有安装，避免同时加载两份。GitHub 仓库为公开 MIT Fork，任何人可克隆；内置白模为 CC0，每个使用者自行配置 API Key，仓库不附带账号额度或私人角色素材。

## 操作顺序

1. **角色与动作**：从已有八方向项目免费导入外观，或上传角色细节图和四列两行的八方向外观图。上排：北、东北、东、东南；下排：南、西南、西、西北。选择内置 40 种 CC0 白模动作，默认行走与奔跑各 2 秒。4 秒只允许 2 或 3 种动作，3 种仍为实验性。
2. **参考与提示词**：本地拼成 4 秒、24 FPS、864×480 白模参考视频。短动作循环播放，统一缩放和基线。查看参考视频、编辑模板提示词；可选用 Ollama、LM Studio 的 OpenAI 兼容文字接口，或第三方文字 API 整理角色描述。文字模型只补充外观约束，布局、动作和时间结构由插件追加。
3. **视频分段与抽帧**：确认费用后，向配置的 MiniMax 服务提交一次 4 秒、480P 参考视频生成。拿到视频先预览，再调整实际动作范围并确认。每种动作每方向可抽 4–24 帧，允许跳过切换过渡区。也可导入已有视频。模型未遵守动作、方向或格子布局时，需要先判断可用性，不能仅靠裁切修好。
4. **逐帧高清重绘（可选）**：先选择一帧试效果，满意后再补其余帧。使用全局配置的自定义 OpenAI 兼容 `images/edits`，发送目标动作图、角色参考和内部遮罩；请求 1024×1024，规范为 512×512。保留原视频帧、原始回图、输入与遮罩、提示词和位置校正记录。界面显示选中帧的新增调用数量；已完成帧默认跳过。**重绘仍可能有姿势偏移、颜色变化和帧间抖动，不能保证像素绝对一致。**
5. **导出素材**：每种动作单独生成八行方向图集和透明序列帧，一并打入 ZIP，附 `animation.json`、视频提示词与白模来源许可。高清版要求全部帧已完成，以免混入清晰度不同的帧。循环接缝需人工验收，元数据标为 `loopVerified:false`。

## 配置与成本

- 视频使用插件全局 MiniMax 配置，选择支持 4 秒、480P、参考视频的 **MiniMax-H3-Lite**。当前白模流程不接入缺少对应参考视频工作流的 ComfyUI / ToAPIs 后端；它们仍可用于原有流程。
- 图片使用全局「自定义生图 → OpenAI 兼容」配置。中转必须支持多图与遮罩的 `images/edits`。不支持时直接报错，不自动改走无动作约束的 `generations`，也不自动重试。
- 文字模型配置和估算单价位于「参考与提示词 → 文字模型与费用设置」。默认本地地址 `http://127.0.0.1:11434/v1`，无需文字模型也能使用模板。
- 视频估算按 **4 秒输入 + 4 秒输出** 计算，默认 ¥0.16/秒只是此前试验使用的参考值，可修改，**不是实时平台报价**。图片单价默认 0 表示未知。以服务商账单为准；第三方文字模型也可能计费。
- 白模拼接、裁切、抠像、图集和 ZIP 导出在本地完成。480P 八格中的每个角色只有约 216×240 的画面；512×512 是输出画布尺寸，局部放大不会创造原生细节。

## 任务与恢复

- 数据放在 `<DSH_HOME>/game-material-master/motion-jobs/w…/`，文字模型设置在相邻的 `motion-settings.json`，凭据只在本机保存且不回传界面或 agent。
- 每个任务同一时间只执行一个步骤。视频提交前落盘记录；提交结果未知时锁住再次生成，避免网络中断导致重复扣费。可导入已获取的视频继续。
- 每帧重绘前保存尝试记录；结果未知的帧不会自动重试，须用户明确勾选重新生成。成功回图在后处理失败时也保留。
- DSH 重启后只查询和下载已经提交的视频，不自动重新提交收费步骤。中断的本地步骤保留已有文件，可手动重做。
- 「停止后续处理」在本地处理边界生效。已经提交的远端请求可能继续完成并计费，不代表退款或远端取消。
- 后台刷新使用草稿合并，保留用户尚未保存的提示词和分段编辑。

## 开发验证

```powershell
npm run typecheck
npm run build
node scripts/verify-motion.mjs
node scripts/verify-feedback.mjs
node scripts/verify-client.mjs
node scripts/verify-tools.mjs
node scripts/verify-i18n.mjs
node scripts/verify-custom-image.mjs
```

`verify-motion.mjs` 使用临时 DSH_HOME、本机假 API 和真实 ffmpeg，拦截非测试服务的网络请求，不花 API 费用。需要 `ffmpeg` 与 `ffprobe`，可通过 `FFMPEG_PATH` / `FFPROBE_PATH` 指定。构建后宿主代码需重启 DSH；仅刷新浏览器不足以载入新宿主方法。界面验证包含五个阶段、加载反馈、费用确认、选择帧后重新确认和旧流程切换；上线前仍需在真实 DSH 中验收布局和收费 API，不能用模拟通过来保证模型质量。

内置模板来自 [Hormelz 八方向近战角色](https://hormelz.itch.io/8-directional-melee-character)，CC0-1.0。原始动作关键帧、画布与时间信息以 gzip RGBA 保存，运行时无需 Python。开发导入脚本为 `scripts/import-motion-templates.py`，导入时需要 Pillow。插件代码沿用原仓库 MIT 许可；模型生成素材的使用权仍由对应服务条款与输入素材授权决定。

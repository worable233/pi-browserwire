<h1 align="center">pi-browserwire</h1>

<p align="center">为 pi 打造的轻量浏览器调试工具。通过 CDP 操作真实 Chromium 浏览器，并提供单一工具和零运行时依赖的 Node.js CLI。</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 22+">
  <a href="https://www.npmjs.com/package/pi-browserwire"><img src="https://img.shields.io/npm/v/pi-browserwire?style=flat-square&color=cb3837&logo=npm&logoColor=white" alt="npm 版本"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT 许可证"></a>
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="./README.en.md">English</a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#功能">功能</a> ·
  <a href="#pi-集成">Pi 集成</a> ·
  <a href="./CHANGELOG.md">更新日志</a> ·
  <a href="./CONTRIBUTING.md">参与贡献</a>
</p>

---

> [!TIP]
> pi-browserwire 仍处于早期开发阶段，命令、集成接口和设置可能发生变化。升级前请阅读更新日志；欢迎提交问题、报告 Bug 和精简明确的 Pull Request。

pi-browserwire 让 pi 通过 Chrome DevTools Protocol（CDP）检查并操作真实的 Chrome、Chromium、Edge 或 Brave 浏览器。它为 pi 提供一个 `browser` 工具，也提供使用相同命令集的 `bw` CLI。

## 快速开始

### 安装到 pi

```bash
pi install npm:pi-browserwire
```

开发时可从本地检出目录安装：`pi install ./pi-browserwire`。

运行要求：Node.js 22+，以及已安装的 Chrome、Chromium、Microsoft Edge 或 Brave。CLI 使用 Node.js 内置的 `WebSocket` 和 `fetch`，没有运行时依赖。

### 可选：输入框上方的批注条

默认安装不需要任何补丁——批注随下一条消息一起发送，输入框保持干净。如果想让
Percho 输入框正上方多一条 `N 条批注` 的胶囊（点击展开、逐条删除、发完自动消失），
给宿主打一次补丁：

```bash
bw percho-patch     # 打补丁，重启 Percho 后生效
bw percho-status    # 看补丁 / 备份 / 插件状态
bw percho-unpatch   # 从备份还原
```

补丁只在宿主没有这条路时才需要（原因见 [percho/README.md](percho/README.md)），
且每次 Percho 升级后要重打一次——`bw percho-status` 会告诉你当前是否还是打过的状态。

### 运行 CLI

```bash
cd /path/to/pi-browserwire
node cli/bw.mjs doctor
node cli/bw.mjs open localhost:3000
node cli/bw.mjs console --errors
```

若要在终端中直接使用 `bw`，可将内置可执行文件链接到 `PATH` 中的目录：

```bash
mkdir -p ~/.local/bin
ln -s "$(pwd)/cli/bw.mjs" ~/.local/bin/bw
```

### 第一次浏览器检查

```bash
bw open localhost:3000
bw find "Sign in"
bw click "button[type=submit]"
bw wait-text "h1" "Welcome"
bw console --errors
```

`open` 会报告本次页面加载产生的控制台错误和失败请求。检查异步加载的内容前，先使用 `wait`、`wait-text` 或 `wait-idle` 等待页面就绪。

## 功能

| 工作流 | 示例 |
| --- | --- |
| 页面导航与标签管理 | 打开 URL、重新加载、前进后退、切换标签页和窗口 |
| 模拟用户操作 | 通过 CDP 输入事件点击、输入、填充、选择、上传、拖动和滚动 |
| 检查页面并断言 | 查询文本、HTML、属性、样式、元素边界和可见元素数量 |
| 排查运行时问题 | 读取控制台输出和跨调用保留的网络日志，包括失败请求与响应正文 |
| 捕获页面 | 截取屏幕和生成 PDF，将文件保存到磁盘并返回路径 |
| 调试复杂布局 | 检查 iframe，包括跨站点的进程外 iframe（OOPIF） |
| 模拟设备与网络 | 模拟视口尺寸、限制网络或 CPU，并检查 Cookie 和存储 |
| 收集人工反馈 | 标注页面元素，备注与粘贴的截图随下一条消息一起发送 |

### 操作列表

`browser` 工具通过单一 `action` 字段提供 84 项操作。这样可以保持工具 Schema 紧凑，同时让 codemode 脚本按需选择操作。

| 分组 | 操作 |
| --- | --- |
| 导航 | `open` `go` `reload` `back` `forward` `hard-reload` |
| 标签页与窗口 | `tabs` `use` `new-tab` `new-window` `close-tab` `windows` `window` |
| 输入操作 | `click` `dblclick` `hover` `focus` `blur` `type` `fill` `keys` `press` `select` `check` `uncheck` `scroll` `drag` `upload` |
| 等待与断言 | `wait` `wait-text` `wait-idle` `assert-visible` `assert-hidden` `assert-text` `assert-count` `assert-value` |
| 页面查询 | `text` `html` `attr` `style` `box` `count` `find` `eval` `title` `outline` |
| 日志与网络 | `console` `errors` `net` `net-body` `headers` `clear-logs` |
| 捕获 | `shot` `screenshot` `pdf` |
| 帧 | `frames` `frame` |
| 设备与存储 | `viewport` `reset-viewport` `cookies` `storage` `dialog` `dialog-policy` |
| 网络模拟 | `clear-cache` `throttle` `cpu-throttle` |
| DOM 高亮 | `highlight` `highlight-clear` |
| 人工标注 | `pick` `mark` `marks` `clear` `annotate` `annotate-done` `ann` `ann-export` `ann-shot` `ann-clear` |
| 配置与生命周期 | `hotkey` `browser` `status` `doctor` `close` `run` |

各操作的位置参数和标志以 CLI 为准。运行 `bw help` 查看命令帮助。

## Pi 集成

`extensions/index.ts` 注册单一的 `browser` 工具和 `/bw` 命令。工具默认使用 `direct` 暴露模式，因此模型可以直接调用，codemode 脚本也能通过 `ctx.executeTool` 使用。设置 `BROWSERWIRE_EXPOSURE=codemode` 后，工具会从基础提示中隐藏，并通过 codemode 发现机制提供。

### Codemode 示例

只读操作可以并行执行。会改变页面状态的操作必须串行执行，避免互相竞争。

```js
const [errs, failed, title] = await Promise.all([
  tools.browser({ action: "console", flags: { errors: true } }),
  tools.browser({ action: "net", flags: { fail: true } }),
  tools.browser({ action: "title" }),
]);
text(errs.output);
```

```js
for (const step of [
  ["type", "#email", "user@example.com"],
  ["type", "#password", "secret"],
  ["click", "button[type=submit]"],
]) {
  await tools.browser({ action: step[0], target: step[1], arg: step[2] });
}
await tools.browser({ action: "assert-text", target: "h1", arg: "Welcome" });
```

### 人工标注

运行 `bw annotate` 进入标注模式。点击页面元素会在其下方打开备注编辑器；输入备注后按 Enter 保存。可用 `⌘V` 粘贴截图，之后点击编号徽标可以编辑或删除备注。按 Esc 分两级：面板开着时先放弃当前备注、仍留在标注模式；再按一次 Esc 完全退出标注模式（已保存的徽章保留）。

编辑器打开时，元素选择会冻结，因此备注仍关联到刚才选中的元素。标注按页面 URL 保存，包含富文本、纯文本和粘贴的图片。一轮批注只发一次：发送后卡片清空、页面上的编号徽标变淡（点它可编辑，改动后重新算待发送），`ann` 默认只列待发送的，`ann --all` 才看历史。扩展会监听标注文件，在消息发送时把尚未发送过的批注附加到该消息上——输入框因此保持干净，不会出现大段文本；Agent 也可以用 `ann` 或 `ann-export` 直接读取。`annotate` 和 `pick` 是供人使用的交互操作，Agent 不应伪造用户反馈。

编辑器左侧的滑杆按钮会展开**样式微调**面板：文本、文本颜色、背景、Opacity、字体、字号。修改通过内联 `!important` 声明即时生效，因此结果是直接显示在页面上的，而不只是一句描述。`取消` 会把元素还原成面板打开时的样子。保存时会为每个真正改动过的属性记录 `from → to` diff，与备注一起存储——备注说明“要改成什么”，diff 说明“从什么改成什么”。只记录确实变化的属性；读取基准值时先摘掉批注高亮，否则它写入的紫色背景会被误当成元素自身的背景。

### Percho 设置界面

可选的 `bw-config` UI 插件位于 `~/.percho/ui-plugins/bw-config/`，会在 Percho 设置中添加“浏览器”分类，用于选择浏览器和标注快捷键。可在 **Settings → UI Plugins → 浏览器 → 启用** 中启用。信任确认是刻意保留的：Agent 不能代替用户启用此插件。

Percho 插件沙箱没有文件系统访问或 IPC。设置插件通过 `uiPluginsAssignSlot` 保存值，将其编码成 `bw:<key>=<value>` 写入 `ui-plugins.json`；Node CLI 读取这些设置，并优先于 `settings.json`。槽位渲染只会替换已加载插件的名称，因此这些设置值不会替换 UI 组件。

## 会话与配置

每个会话名都有独立的浏览器配置目录、调试端口和状态目录。并行任务可以使用不同会话，互不共享标签页和登录状态：

```bash
BW_SESSION=task-a bw open localhost:3000
BW_SESSION=task-b bw open localhost:3001
```

```text
~/.pi/bw/sessions/<name>/
├── state.json          端口、进程 ID、当前页面
├── settings.json       快捷键、浏览器
├── annotations.json    所有页面的标注
├── profile/            Chrome 用户数据目录
└── shots/              截图
```

文件锁可避免多个调用同时启动同一会话时重复打开 Chrome。空闲浏览器会在两小时后回收；设置 `BW_IDLE_MS` 可调整超时时间。

截图默认保留 7 天，过期且未被任何标注引用的文件会被清理（每条命令最多检查一次）。设置 `BW_SHOT_TTL_MS` 可调整保留时长，`BW_SHOT_TTL_MS=0` 关闭清理；被 `annotations.json` 引用的截图永远不会删除。

| 命令 | 用途 |
| --- | --- |
| `bw hotkey` | 查看标注快捷键（默认 `shift+a`） |
| `bw hotkey alt+a` | 设置其他标注快捷键 |
| `bw browser` | 查看选中的浏览器和已安装选项 |
| `bw browser edge` | 为下次启动选择浏览器 |

设置保存在 `~/.pi/bw/sessions/<name>/settings.json`。加载 Percho UI 插件时，`ui-plugins.json` 中的设置优先级更高。

## 设计取舍

- **一个工具，使用一个枚举。** 用 action 列表代替几十个独立工具，减少 Schema 体积。
- **输出以文本为主。** 每项操作返回简短结果；截图和完整 HTML 等大内容写入文件，并返回文件路径。
- **浏览器日志持续保留。** 后台守护进程连接浏览器目标，在 CLI 调用之间缓存控制台、网络和对话框事件。
- **明确呈现失败。** 工具返回退出码和具体原因，不会静默重试；调用方可以自行决定是否以及如何重试。
- **并行边界清楚。** 扩展在 `details.readOnly` 中标记 28 项只读操作。会改变状态的操作应串行执行。
- **使用真实输入事件。** 输入文字通过 CDP 和原生 value setter 执行，使 React 受控输入框收到更新；不依赖合成的 `dispatchEvent`。

## 跨站点 iframe

`Page.getFrameTree` 不包含进程外 iframe。Browserwire 会结合 `Target.getTargets` 返回的 `iframe` 目标，连接其 CDP 会话，并将命令路由到对应的 frame。

```bash
bw frames                 # 列出 frame 及其偏移量
bw frame /checkout        # 按 URL 片段将操作范围切换到某个 frame
bw frame top              # 返回顶层页面
```

`box` 会输出局部坐标和 `[top: x,y]` 顶层坐标。向顶层目标发送鼠标事件时使用顶层坐标。

## 开发

CLI 位于 `cli/bw.mjs`；pi 工具注册和标注桥接位于 `extensions/`；面向模型的使用指南位于 `skills/browser-debug/`。

```bash
npm test
```

本项目刻意不添加运行时依赖。action 对齐检查、代码约定和浏览器冒烟流程见[贡献指南](./CONTRIBUTING.md)。

## 已知限制

- Browserwire 使用专属的 `--user-data-dir` 启动 Chrome，不能连接到已经运行的 Chrome 用户配置。这个独立配置目录不会包含你现有的登录状态。
- 无法向 `chrome://` 页面注入脚本或执行操作。
- Chrome 丢弃响应正文后，`net-body` 可能无法读取（返回 `gone`）；检查 API 时可尝试在页面中用 `eval` 执行 `fetch(...)`。
- 页面导航会清除注入脚本。守护进程会在 `Page.frameNavigated` 后重新注入，但切换到新标签页后需要重新运行标注模式。
- 视口模拟是连接级设置，因此状态会保存下来，并在重新连接时恢复。
- macOS 和 Linux 已测试。Windows 浏览器路径已列出，但尚未验证。

## 许可证

[MIT](./LICENSE)。

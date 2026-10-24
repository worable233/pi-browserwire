# Percho 补丁：输入框上方的批注条

可选件。不打补丁时 `pi-browserwire` 一切照常工作（批注随消息发送，详情见仓库根
README）；打上补丁后，输入框正上方多一条 `N 条批注` 的胶囊：**点击展开**列表（再点一次 /
点外面 / Esc 收起），逐条 `×` 删除。列表里只有**还没发出去**的批注——随消息
发出后自动消失。

## 为什么不能「默认就有」

不是没做，是宿主两条路都堵着：

1. **没有挂载点**：区域表里没有输入框上方这一格（`composer.footer` 是底部工具行，
   位置不对）；
2. **没有数据通道**（更致命）：contribution 无 props，数据只能从
   `window.PerchoUI.stores` 自取，而批注不在任何 store 里；渲染进程 `sandbox` +
   CSP `default-src 'self'`，无文件系统、不能 `fetch` 本地端口；扩展侧只有 4 条
   IPC，没有一条能把结构化数据送到插件。

所以哪怕把卡片硬塞进 `composer.footer`，它也不知道「有几条批注」。三个选项里选了
第 2 个：

| 方案 | 结果 |
|---|---|
| ① 不打补丁 | 批注随消息发送，输入框保持干净，但上方没有胶囊 |
| ② 打一次补丁（本目录） | 有胶囊；可配 watchdog 让升级后自动补回来 |
| ③ 把打补丁写进 npm 安装流程 | 自动改别人签名过的 app 并要重启，不该由包管理器干 |

## 补丁做了什么

宿主目前没有这条路：

| 需要的能力 | 宿主现状 |
|---|---|
| 在输入框上方挂组件 | Region 只有 `app.background` / `app.overlay` / `chat.corner.*` / `composer.footer` / `settings.panel`，没有 `composer.top` |
| 从扩展渲染 UI | `ctx.ui.setWidget()` 在主进程里是 `setWidget: () => {}` 空实现 |
| 扩展 → 渲染进程 | 只有 4 条 IPC：`dialog-request` / `editor-text` / `notify` / `dialog-resolved` |
| 插件读批注文件 | 渲染进程 `sandbox` + CSP `default-src 'self'`，无文件系统、无网络 |

补丁因此只加两件事，别的一概不动：

1. 新区域 `composer.top`（`RegionHost` 里一个 case + composer JSX 里一行挂载）；
2. `window.PerchoUI.annotations = { list(), remove(file, id) }`，背后是主进程
   `bw:annotations` 通道，读写 `~/.pi/bw/sessions/<name>/annotations.json`（取最近
   改动过的会话），并读取同目录的 `sent.json`（pi 扩展在发送时写入 `id → updatedAt`）
   把「已发送」标出来，卡片据此只显示待发送的批注。

`app.asar` 可执行文件本身没有被替换，Esbuild 二进制等 unpacked 资源原样保留。

## 用法

```bash
python3 percho/patch-percho.py     # 生成 /tmp/app-patched.asar（不落盘到 App）
./percho/apply.sh --detach         # 后台守护：Percho 一退出就替换并重新打开
./percho/apply.sh                  # 或者前台等退出
```

替换时会把原文件备份到 `Contents/Resources/app.asar.bak-<时间戳>`。

做完之后去 **设置 → 外观 → UI 插件**（不是「扩展」——那是 pi 扩展，另一套系统）
打开总开关并启用「浏览器批注条」——这是信任门，agent 不能代劳。

### 升级后自动补回来

Percho 每次升级都会换掉整个 `app.asar`，补丁随之消失——表现为「胶囊没了」。
让脚本盯着：

```bash
./percho/watchdog.sh install     # 登录项：登录时 + 每 30 分钟检查一次
./percho/watchdog.sh uninstall
./percho/watchdog.sh check       # 只检查一次
```

发现 asar 里没有 `bw-patch:main-ipc` 标记就重新打并换入（运行中的 Percho 不受影响，
下次启动生效）；锚点对不上就直接放弃，日志在 `/tmp/percho-patch.log`。

补丁可重复运行（每次插入的块都带 `bw-patch:<name> start/end` 标记，脚本先摘掉
旧块再按锚点重打），所以改完桥接逻辑不用回滚备份：

```bash
python3 percho/patch-percho.py                 # 直接在已打补丁的 asar 上重打
python3 percho/patch-percho.py <src.asar> <out.asar>
```

插件目录必须是**真实目录**，不能用 symlink：

```bash
cp -R percho/composer-card ~/.percho/ui-plugins/bw-annotations
```

宿主扫描用的是 `readdir(..., { withFileTypes: true })` + `if (!entry.isDirectory()) continue`，
symlink 的 `isDirectory()` 是 `false`，整个插件会被静默跳过（日志里只有一条
`scanAll` 什么都没有）。

## 风险

- Percho 是「ad-hoc 签名」的包，资源随时会被升级覆盖：**每次升级后要重新跑一次
  `patch-percho.py`**，脚本会检查锚点，锚点变了会直接报错退出而不写坏文件。
- 补丁版本只针对当前 Percho 的渲染器 bundle（`out/renderer/assets/index-*.js`），
  脚本按内容（`window.PerchoUI`）自动定位，不写死文件名。
- 卸载：`cp Contents/Resources/app.asar.bak-<时间戳> Contents/Resources/app.asar`。

## 已知坑

- `apply.sh` 等退出用的是 `pgrep -fx /Applications/Percho.app/Contents/MacOS/Percho`
  精确匹配。早先用 `pgrep -f "…/MacOS/Percho"` 会连 `Percho Helper` 一起命中，
  永远等不到「已退出」，守护进程会一直挂着不动。
- 补丁只在**下一次启动**生效：换了 `app.asar` 而 Percho 还在跑时，主进程内存里仍是
  旧代码，设置页日志会明说
  `manifest contribution 忽略未知 region: {"id":"bar","region":"composer.top"…}`。

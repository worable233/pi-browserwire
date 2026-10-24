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
| ② 打一次补丁（`bw percho-patch`） | 有胶囊；升级后重跑一次即可 |
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

补丁是 `bw` 的子命令，不需要 Python、不需要后台守护：

```bash
bw percho-status               # 补丁 / 备份 / 插件 / 开关 状态
bw percho-patch                # 打补丁（已有备份、可重复运行、幂等）
bw percho-patch --dry-run      # 只构建到临时文件，不换入
bw percho-patch --force        # 已打过也重打
bw percho-patch --from <asar>  # 对任意 asar 副本试打（自查用）
bw percho-unpatch              # 从最近备份还原
```

换入是原子的（备份 → rename → 运行中的 Percho 不受影响），重启后生效。第一次打
之前会留一份 `Contents/Resources/app.asar.bak-<时间戳>`，`percho-unpatch` 就是拿它
还原；重装 Percho 同样能恢复原样。

打完之后去 **设置 → 外观 → UI 插件**（不是「扩展」——那是 pi 扩展，另一套系统）
打开总开关并启用「浏览器批注条」——这是信任门，agent 不能代劳。

插件目录必须是**真实目录**，不能用 symlink：

```bash
cp -R percho/composer-card ~/.percho/ui-plugins/bw-annotations
```

宿主扫描用的是 `readdir(..., { withFileTypes: true })` + `if (!entry.isDirectory()) continue`，
symlink 的 `isDirectory()` 是 `false`，整个插件会被静默跳过（日志里只有一条
`scanAll` 什么都没有）。

## 实现要点

- 插入的每一段都带 `bw-patch:<name> start/end` 标记，重打前先摘掉 → **幂等**：
  对同一份 asar 连打三次，输出逐字节相同（对拍过 Python 旧实现，也是逐字节一致）。
- 打完会让 `node --check` 解析 main（ESM）/ preload（CJS）/ renderer（ESM）三个入口，
  写坏了当场失败，不会留下白屏的包。
- 锚点失配（Percho 改结构）会直接报错退出，不写半截包。

## 风险

- Percho 是「ad-hoc 签名」的包，资源随时会被升级覆盖：**每次升级后跑一次
  `bw percho-patch`**（`bw percho-status` 会显示「未安装」）。锚点变了会直接报错退出
  而不写坏文件。
- 补丁版本只针对当前 Percho 的渲染器 bundle（`out/renderer/assets/index-*.js`），
  脚本按内容（`window.PerchoUI`）自动定位，不写死文件名。
- 卸载：`cp Contents/Resources/app.asar.bak-<时间戳> Contents/Resources/app.asar`。

## 已知坑

- 补丁只在**下一次启动**生效：换了 `app.asar` 而 Percho 还在跑时，主进程内存里仍是
  旧代码，设置页日志会明说
  `manifest contribution 忽略未知 region: {"id":"bar","region":"composer.top"…}`。

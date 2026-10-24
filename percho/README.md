# Percho 补丁：输入框上方的批注条

可选件。不打补丁时 `pi-browserwire` 一切照常工作（批注随消息发送，详情见仓库根
README）；打上补丁后，输入框正上方多一条 `N 条批注` 的胶囊，悬停展开列表，逐条
`×` 删除。

## 为什么需要补丁

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
   改动过的会话）。

`app.asar` 可执行文件本身没有被替换，Esbuild 二进制等 unpacked 资源原样保留。

## 用法

```bash
python3 percho/patch-percho.py     # 生成 /tmp/app-patched.asar（不落盘到 App）
./percho/apply.sh --detach         # 后台守护：Percho 一退出就替换并重新打开
./percho/apply.sh                  # 或者前台等退出
```

替换时会把原文件备份到 `Contents/Resources/app.asar.bak-<时间戳>`。

做完之后去 **设置 → UI 插件** 打开总开关并启用「浏览器批注条」——这是信任门，
agent 不能代劳。

## 风险

- Percho 是「ad-hoc 签名」的包，资源随时会被升级覆盖：**每次升级后要重新跑一次
  `patch-percho.py`**，脚本会检查锚点，锚点变了会直接报错退出而不写坏文件。
- 补丁版本只针对当前 Percho 的渲染器 bundle（`out/renderer/assets/index-*.js`），
  脚本按内容（`window.PerchoUI`）自动定位，不写死文件名。
- 卸载：`cp Contents/Resources/app.asar.bak-<时间戳> Contents/Resources/app.asar`。

<h1 align="center">pi-browserwire</h1>

<p align="center">A compact browser debugger for pi. Drive a real Chromium browser over CDP with one tool and a zero-dependency Node.js CLI.</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 22+">
  <img src="https://img.shields.io/badge/npm-not%20published-lightgrey?style=flat-square" alt="Not published on npm">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.md">简体中文</a>
</p>

<p align="center">
  <a href="#start-here">Start here</a> ·
  <a href="#what-it-does">Features</a> ·
  <a href="#pi-integration">Pi integration</a> ·
  <a href="./CHANGELOG.md">Changelog</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

---

> [!TIP]
> pi-browserwire is in early development. Its commands, integration points, and settings may change. Review the changelog before upgrading, and contributions, bug reports, and focused pull requests are welcome.

pi-browserwire lets pi inspect and operate a real Chrome, Chromium, Edge, or Brave browser through the Chrome DevTools Protocol (CDP). It provides one `browser` tool for pi and the same command set through the `bw` CLI.

## Start here

### Install from a local checkout

The npm package is not published yet. From the directory containing this checkout, install it into pi:

```bash
pi install ./pi-browserwire
```

After a future npm release, the package can be installed with `pi install npm:pi-browserwire`.

Requirements: Node.js 22+ and an installed Chrome, Chromium, Microsoft Edge, or Brave browser. The CLI uses Node's built-in `WebSocket` and `fetch`; the package has no runtime dependencies.

### Run the CLI

```bash
cd /path/to/pi-browserwire
node cli/bw.mjs doctor
node cli/bw.mjs open localhost:3000
node cli/bw.mjs console --errors
```

To use `bw` directly from your shell, link the bundled executable into a directory on your `PATH`:

```bash
mkdir -p ~/.local/bin
ln -s "$(pwd)/cli/bw.mjs" ~/.local/bin/bw
```

### A first browser check

```bash
bw open localhost:3000
bw find "Sign in"
bw click "button[type=submit]"
bw wait-text "h1" "Welcome"
bw console --errors
```

`open` reports console errors and failed requests produced by that page load. Use `wait`, `wait-text`, or `wait-idle` before checking content that loads asynchronously.

## What it does

| Workflow | Examples |
| --- | --- |
| Navigate pages and manage tabs | Open URLs, reload, move through history, switch tabs and windows |
| Interact like a user | Click, type, fill, select, upload, drag, and scroll using CDP input events |
| Inspect and assert | Query text, HTML, attributes, styles, element bounds, and visible counts |
| Debug runtime behavior | Read console output and persistent network logs, including failed requests and response bodies |
| Capture output | Save screenshots and PDFs to disk and return their paths |
| Debug complex layouts | Inspect frames, including out-of-process cross-origin iframes (OOPIFs) |
| Reproduce device conditions | Emulate viewport sizes, throttle network or CPU, and inspect cookies and storage |
| Collect human feedback | Annotate page elements; notes and pasted screenshots ride along with your next message |

### Actions

The `browser` tool exposes 84 actions through one `action` field. This keeps the tool schema compact while allowing codemode scripts to choose what to run.

| Group | Actions |
| --- | --- |
| Navigation | `open` `go` `reload` `back` `forward` `hard-reload` |
| Tabs and windows | `tabs` `use` `new-tab` `new-window` `close-tab` `windows` `window` |
| Input | `click` `dblclick` `hover` `focus` `blur` `type` `fill` `keys` `press` `select` `check` `uncheck` `scroll` `drag` `upload` |
| Wait and assert | `wait` `wait-text` `wait-idle` `assert-visible` `assert-hidden` `assert-text` `assert-count` `assert-value` |
| Query | `text` `html` `attr` `style` `box` `count` `find` `eval` `title` `outline` |
| Logs and network | `console` `errors` `net` `net-body` `headers` `clear-logs` |
| Capture | `shot` `screenshot` `pdf` |
| Frames | `frames` `frame` |
| Device and storage | `viewport` `reset-viewport` `cookies` `storage` `dialog` `dialog-policy` |
| Network shaping | `clear-cache` `throttle` `cpu-throttle` |
| DOM highlighting | `highlight` `highlight-clear` |
| Human annotations | `pick` `mark` `marks` `clear` `annotate` `annotate-done` `ann` `ann-export` `ann-shot` `ann-clear` |
| Configuration and lifecycle | `hotkey` `browser` `status` `doctor` `close` `run` |

The CLI is the reference for each action's positional arguments and flags. Run `bw help` for its command help.

## Pi integration

The extension in `extensions/index.ts` registers a single `browser` tool and a `/bw` command. The tool defaults to `direct` exposure, so the model can call it and codemode scripts can also use it via `ctx.executeTool`. Set `BROWSERWIRE_EXPOSURE=codemode` to hide it from the base prompt and expose it through codemode discovery instead.

### Codemode example

Read-only actions can run in parallel. Actions that change page state must run serially so they do not race with one another.

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

### Human annotations

Run `bw annotate` to enter annotation mode. Click an element to open a note composer below it, add a note, and press Enter to save. Paste screenshots with `⌘V`; click a numbered badge later to edit or delete its note. Esc works in two steps: with the note panel open it discards the note and keeps you in annotation mode; a second Esc leaves annotation mode entirely (saved badges stay).

Selection freezes while the composer is open, so the note remains attached to the selected element. Annotations are stored per page URL with rich text, plain text, and pasted images. The extension watches the annotation file and attaches unsent notes to your next message as it is sent, so the composer never gets filled with text; agents can also read them directly with `ann` or `ann-export`. `annotate` and `pick` are interactive human actions, not ways for an agent to fabricate feedback.

The sliders button on the left of the composer expands a **style tweak** panel for the selected element: text, text colour, background, opacity, font family and font size. Edits apply live through inline `!important` declarations so you see the result on the page itself, and `取消` restores the element to how it looked when the panel opened. Saving records a `from → to` diff per property next to your note, which is what makes the annotation actionable: the note says *what* should change and the diff says *from what to what*. Only properties you actually changed are recorded, and the diff is taken against the element's real computed style — the purple annotation highlight is stripped before reading, so it never shows up as the element's background.

### Percho settings UI

The optional `bw-config` UI plugin at `~/.percho/ui-plugins/bw-config/` adds a **浏览器** category for choosing a browser and annotation hotkey. Enable it under **Settings → UI Plugins → 浏览器 → 启用**. The trust gate is intentional: an agent cannot enable the plugin on the user's behalf.

Percho's plugin sandbox has no filesystem access or IPC. The settings plugin stores values through `uiPluginsAssignSlot`, encoding them as `bw:<key>=<value>` in `ui-plugins.json`; the Node CLI reads these values and gives them precedence over `settings.json`. Slot rendering only substitutes names of loaded plugins, so these settings values do not replace UI components.

## Sessions and configuration

Each session name gets an isolated browser profile, debugging port, and state directory. Concurrent tasks can use separate sessions without sharing tabs or login state:

```bash
BW_SESSION=task-a bw open localhost:3000
BW_SESSION=task-b bw open localhost:3001
```

```text
~/.pi/bw/sessions/<name>/
├── state.json          port, pid, active target
├── settings.json       hotkey, browser
├── annotations.json    annotations for all pages
├── profile/            Chrome user-data-dir
└── shots/              screenshots
```

A file lock prevents duplicate Chrome launches when several calls start a session at once. Idle browsers are reaped after two hours; set `BW_IDLE_MS` to change the timeout.

Screenshots are kept for seven days. Expired files that no annotation references are pruned at most once per command. Set `BW_SHOT_TTL_MS` to change the retention window, or `BW_SHOT_TTL_MS=0` to disable pruning; screenshots referenced by `annotations.json` are never deleted.

| Command | Purpose |
| --- | --- |
| `bw hotkey` | Show the annotation hotkey (default `shift+a`) |
| `bw hotkey alt+a` | Set a different annotation hotkey |
| `bw browser` | Show the selected browser and installed browser options |
| `bw browser edge` | Select a browser for the next launch |

Settings are stored in `~/.pi/bw/sessions/<name>/settings.json`. When the Percho UI plugin is loaded, its values from `ui-plugins.json` take precedence.

## Design

- **One tool, one enum.** The action list keeps the schema smaller than dozens of separate tools.
- **Compact text output.** Actions return a short line. Large output such as screenshots and full HTML is written to disk and returned as a path.
- **Persistent browser logs.** A background daemon attaches to the browser target and buffers console, network, and dialog events between CLI calls.
- **Failures stay visible.** The tool returns an exit code and a reason; it does not silently retry. Callers can choose whether and how to retry.
- **Parallelism is explicit.** The extension marks 28 actions as read-only in `details.readOnly`. Mutating actions should be run serially.
- **Real input events.** Typing uses CDP input and the native value setter so controlled React inputs receive the update; it does not rely on synthetic `dispatchEvent` calls.

## Cross-origin iframes

`Page.getFrameTree` does not include out-of-process iframes. Browserwire combines it with `Target.getTargets` entries of type `iframe`, attaches to their CDP sessions, and routes commands through the correct frame target.

```bash
bw frames                 # list frames and their offsets
bw frame /checkout        # scope commands to a frame URL fragment
bw frame top              # return to the top-level page
```

`box` reports local coordinates and `[top: x,y]` coordinates. Mouse events use top-level coordinates when sent to the top-level target.

## Development

The CLI is in `cli/bw.mjs`; pi tool registration and the annotation bridge are in `extensions/`; the model-facing usage guide is in `skills/browser-debug/`.

```bash
npm test
```

This project intentionally has no runtime dependencies. See [CONTRIBUTING.md](./CONTRIBUTING.md) for action alignment, coding rules, and browser smoke checks.

## Known limits

- Browserwire launches Chrome with a dedicated `--user-data-dir`; it cannot attach to an already-running Chrome profile. The dedicated profile starts without your existing logins.
- `chrome://` pages cannot be injected or scripted.
- `net-body` may not be available after Chrome discards a response body (`gone`); for API inspection, try `eval` with `fetch(...)` from the page.
- Injected scripts are lost on navigation. The daemon re-injects them after `Page.frameNavigated`, but annotation mode must be started again for a new tab.
- Viewport emulation is connection-level, so its state is saved and restored on reconnect.
- macOS and Linux are tested. Windows browser paths are declared but remain unverified.

## License

[MIT](./LICENSE).

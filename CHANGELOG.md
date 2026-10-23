# Changelog

## 0.2.0

### Annotations
- Composer is now a **rich text** field (`contenteditable`) with `⌘B` / `⌘I` /
  `⌘U`, `Shift+Enter` for a newline, and preserved formatting on paste. Stored as
  `noteHtml` alongside plain `note`.
- **Images**: paste directly into the composer (`⌘V`). Files are read as data
  URLs, shown as removable 46px thumbnails, and attached to the outgoing message
  as image content.
- **Selection freezes while the composer is open.** The hover box stops tracking
  the mouse and page clicks are ignored, so a note can't be attached to the wrong
  element mid-edit. `Esc` or save unfreezes.
- `bw annotate` no longer blocks the terminal — it activates the layer and returns
  in ~0.1s. Saved annotations queue in-page and flush to `annotations.json` on the
  next `bw` command.
- `annotate-done` deactivates the layer while keeping the badges.

### Entry points
- **Hotkey** (default `Shift+A`) toggles annotation mode inside the page.
  Suppressed while focus is in an input/textarea/contenteditable, except `Esc`.
- Removed the custom in-page context menu. Chrome's native menu is untouched.

### Configuration
- `bw hotkey [keys]` — view or set the annotation hotkey (`shift+a`, `alt+a`,
  `mod+shift+a`, …). Hot-applied to the live page on the next command.
- `bw browser [id]` — view or choose the browser (`auto` / `chrome` / `chromium`
  / `edge` / `brave`), with install detection per platform path. Applies on next
  launch.
- Settings live in `~/.pi/bw/sessions/<name>/settings.json`, with GUI values from
  Percho's `ui-plugins.json` taking precedence.

### Percho settings UI
- Optional `bw-config` UI plugin contributing a **浏览器** settings category with
  browser and hotkey chips, styled with the host's semantic tokens.
- Persists through `uiPluginsAssignSlot` (the plugin sandbox has no `fs`/IPC but
  `pluginName` is an unvalidated string), encoded as `bw:<key>=<value>` into slot
  assignments. Slot substitution only happens for actually-loaded plugins, so the
  defaults render untouched.

### Added
- Screenshot retention: files older than `BW_SHOT_TTL_MS` (default 7 days) are
  pruned, at most once per hour per session. Screenshots referenced by
  `annotations.json` are never deleted, so annotation images cannot break.
  `BW_SHOT_TTL_MS=0` disables pruning.

### Fixed
- **Annotations never reached the composer on the default session.** The bridge
  watched `~/.pi/bw/annotations.json` while the CLI writes to
  `~/.pi/bw/sessions/<name>/annotations.json`. The bridge now resolves the same
  session name the CLI does (`--session`, then `BW_SESSION`, then `default`) and
  watches that directory.
- `bw doctor` crashed with `CHROME_CANDIDATES is not defined`, left over from the
  browser-table refactor. It now reports the resolved browser.
- `run` was a silent no-op through the tool: the child process gets `/dev/null`
  on stdin, so the script was always empty. It now accepts `--script=<text>` or
  the first positional argument, falling back to stdin, and errors instead of
  running nothing.
- **Stale pids could kill an unrelated process.** `close` and idle reaping sent
  signals to whatever the recorded pid happened to be, and a recycled pid could
  belong to any process on the machine. Signals are now sent only after the
  process command line is confirmed to match (`__daemon`, or the session profile
  path for the browser).
- `state.json` was written with a truncate-then-write, so a concurrent reader
  could observe a half-written file and reset state (losing the browser pid, the
  viewport, and the viewport replay). Writes now go to a temp file and rename.
- Recursive `fs.watch` is unsupported on Linux, so the annotation bridge was
  silently inert there. It watches the session directory directly instead.
- Read-only set was missing `screenshot`, `outline`, and `ann-shot`, so those were
  reported as mutating and forced into serial execution.
- **Host restart when pi runs inside Electron.** The extension spawns its own
  process to run the CLI, and `process.execPath` is the *host application binary*
  when pi is embedded in an Electron main process, not a node binary. Spawning it
  booted a second copy of the app, which took over the Chromium profile and
  restarted the host. The child is now started with `ELECTRON_RUN_AS_NODE=1`, so
  the same binary behaves as a plain node runtime (verified on Node 24 with a
  working `WebSocket` global). The internal daemon spawn carries the same flag.
- Duplicate console/network events from double-attaching targets
  (`targetCreated` + `attachedToTarget`).
- Viewport override lost on disconnect — `Emulation.setDeviceMetricsOverride` is
  connection-level, so it's now persisted in `state.json` and replayed on connect.
- `upsertAnnotation` dropped the generated `id` (`...patch` spread order) and
  missed selector-based upserts.
- Cross-origin (OOPIF) input dispatch must target the top-level session with
  top-level coordinates; `frameOffset` now measures via `DOM.getFrameOwner` in the
  parent.

## 0.1.0

- Zero-dependency CDP CLI (`cli/bw.mjs`): navigation, tabs, windows, real input,
  waits, assertions, DOM/style queries, console + network capture with bodies and
  headers, screenshots, PDF, cross-origin iframe scoping, device emulation,
  throttling, cookies/storage, dialogs, cache control, batch runner.
- Background daemon buffers console/network/dialog events across tool calls.
- Session isolation: one Chrome profile, port, and state dir per session; file
  lock prevents duplicate launches under parallel cold starts.
- Single `browser` tool with an `action` enum (~410 tokens of schema).
- `AbortSignal` propagation so harness cancellation kills the child process.
- Failure results carry `retryable` + `hint` for scripted branching.
- Annotation system: in-page picker with notes, per-tab attribution, editable via
  badge click, pushed to the composer through `ctx.ui.setEditorText()`, and
  screenshots attached to the outgoing message via the `context` event.
- `browser-debug` skill for model-facing usage guidance.

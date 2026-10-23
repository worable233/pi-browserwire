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

### Fixed
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

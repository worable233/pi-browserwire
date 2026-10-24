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

### Added
- **Style tweaks in the annotation composer.** The sliders button expands a panel
  for the selected element: text, text colour, background, opacity, font family
  and font size, applied live as inline `!important` declarations. `取消` restores
  the element; saving stores a `from → to` diff per changed property alongside the
  note, so the annotation says both what should change and from what to what. The
  diff is taken against the element's real computed style — the annotation
  highlight is removed before reading so its purple fill is never mistaken for the
  element's background. The `<tag>` header is a drag handle: hold it (or the dots)
  to move the panel anywhere in the viewport, clamped so it never leaves the
  screen. Long property lists otherwise cover the element you are tweaking.

### Added
- **Optional Percho patch: an annotation bar above the composer.** `percho/` holds a
  lossless `app.asar` patcher that adds two things and nothing else: a `composer.top`
  UI plugin region mounted between `ImageTray` and the input box, and
  `window.PerchoUI.annotations` (`list` / `remove`) backed by a main-process
  `bw:annotations` channel that reads the most recently touched
  `~/.pi/bw/sessions/<name>/annotations.json`. `percho/composer-card/` is the plugin:
  an `N 条批注` pill that expands on hover into a per-annotation list with a delete
  button per row. The patch keeps every other asar entry byte-identical and re-checks
  its anchors on every run, so a Percho upgrade fails loudly instead of half-patching.

### Changed
- **Annotations no longer get typed into the composer at all.** They are attached
  to the outgoing message through the `context` event instead — the documented
  place where an extension may replace messages — and a toast reports how many are
  waiting. Your draft stays yours: write whatever you want, the annotation rides
  along. Annotations are tracked by `id + updatedAt`, so each one is attached once,
  editing one re-attaches only that one, and `bw-annotations` re-arms everything.
  A Codex-style chip above the composer is not reachable from an extension: Percho
  stubs `ctx.ui.setWidget()` to a no-op, exposes only four extension IPC channels
  (dialog, editor-text, notify), and its UI plugin regions carry no annotation
  data — the renderer cannot read files or reach 127.0.0.1 under its CSP.
- **Annotation push into the composer is now two lines instead of a wall of
  markdown.** The old summary used `###` headings, the full percent-encoded URL,
  full selector chains, and wrapped each style change on its own line — it filled
  the draft area and buried whatever the user was typing. Now: one header line,
  and one line per annotation with the last two selector steps, the note capped at
  32 characters, and changes folded inline (`字号 16px→40px｜色 #e0e0e0→#ff3b30`).
  The URL is dropped entirely for a single page since the title identifies it and
  the agent can read it back with `bw ann-export`.

### Fixed
- **The submit arrow did nothing when annotation mode was started with the hotkey.**
  The page-side outbox hooks (`__bwAnnSave` / `__bwAnnDelete`) were only created by
  `bw annotate`, so the hotkey path — and any page after a reload — threw
  `window.__bwAnnSave is not a function` on submit and left the panel open with
  nothing saved. The outbox is now part of the annotation layer itself, so every
  way of entering annotation mode works.
- **The selection highlight vanished as soon as the composer opened**, leaving no
  way to tell which element the note was attached to. The box was deliberately
  hidden when selection froze; it now stays pinned to the target, survives mouse
  movement over the veil, and follows scroll and resize while the panel is open.
- **The panel text was not vertically centred.** Three offsets stacked: the panel
  had asymmetric padding (8 top / 6 bottom), the row aligned its children to the
  bottom, and the editor added its own padding again. The row is now centred with
  a fixed height, the editor has no padding and a line box of exactly 21px, and
  the panel padding is symmetric — the text centre now lands within 0.2px of the
  panel centre instead of 2.5px below it.
- **The panel placeholder sat 8px too high**, so "添加评论…" floated above the
  caret instead of sitting on the text line. The placeholder was absolutely
  positioned against the panel, which added the panel's own padding on top of the
  editor's; it now lives in a positioning box the size of the editor.
- Injected page code was never refreshed in pages that were already open, so a
  fixed panel still looked broken until the tab was reloaded by hand. The runtime
  now carries a version: every command re-checks it and rebuilds the annotation
  layer in place when it is stale.
- **The hotkey did nothing when focus was inside an iframe.** Pages that embed
  demos or players in cross-origin frames (a component gallery, a video embed)
  never see keydown from the top document — the listener was installed there
  only. Every frame now gets a small bridge that forwards the pressed key spec to
  the top frame, which decides whether it matches the configured hotkey, so the
  hotkey is not baked into the frame script and changing it needs no reinjection.
  The daemon also attaches to `iframe` targets, which it previously ignored.
- Page runtime injection was skipped whenever `window.__bwHotkeyHandler` already
  existed, so an upgraded CLI could never update hotkey logic in an already-open
  page (this is why the message channel above stayed missing). Reinjection is now
  unconditional and idempotent.
- **Viewport screenshots returned a stale frame after scrolling.** `shot` used
  `fromSurface` capture with `captureBeyondViewport: false`, which returns the
  last *composited* frame — after a scroll that is the pre-scroll surface, so the
  image showed only the background. Dominated by DOM checks (`elementsFromPoint`,
  opacity) looking correct. All captures now use `captureBeyondViewport` with a
  clip in page coordinates, the tab is brought to the front first, and two frames
  are awaited. Element shots also work for elements outside the viewport now, and
  the reported size is the real pixel size (`clip * devicePixelRatio`).
- **`annotations.json` could be lost entirely.** The file was written with a
  truncate-then-write while two writers exist (daemon heartbeat and the CLI
  fallback flush). A reader hitting the truncated window got an empty object,
  and the next write persisted that emptiness. Writes are now temp-file + rename,
  and every batch update runs under a cross-process lock so concurrent flushes
  cannot clobber each other.
- The annotation bridge's `fs.watch` had no `error` handler; a deleted or moved
  directory would raise an uncaught exception inside the host's main process.
- PNG screenshots were delivered with `mimeType: image/jpeg`.
- Tool output accumulation is capped at 512 KB per stream, and the abort listener
  is detached on completion instead of lingering for the session lifetime.
- **Saved annotations could sit in the page forever.** Notes went into an in-page
  outbox that only the next `bw` command drained, so annotating while the agent
  was idle waiting for input meant the composer never received anything. The
  daemon now drains every attached page every 1.5s.
- **The annotation hotkey did nothing.** The daemon injected the keydown listener
  but not the annotation layer that defines `window.__bwAnnToggle`, so every press
  silently returned. The layer is now injected together with the listener, keeps
  itself hidden, and works on pages opened by a plain `open` — `annotate` is no
  longer a prerequisite.
- A daemon started by an older CLI kept serving stale behavior after an upgrade
  (including the broken injection above). The daemon now reports a build
  fingerprint and is replaced when the CLI file changes.
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

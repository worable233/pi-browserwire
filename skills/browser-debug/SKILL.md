---
name: browser-debug
description: Drive a real Chrome to reproduce, inspect, and fix front-end issues — console errors, network failures, layout, form flows, cross-origin iframes. Use when a task needs to look at what a page actually renders or does, not just its source.
---

# Browser debugging with browserwire

One tool, `browser`, with an `action` field. Everything below maps to
`browser({action, target, arg, arg2, flags, session})`.

## The loop

1. `open <url>` — returns `ok complete "title" url | clean` or `| N issue: ...`.
   Issues are console errors/warnings plus failed requests produced **by this load**.
2. `wait-idle` or `wait <sel> --visible` — never assert on a page that is still moving.
3. Inspect: `text`, `console --errors`, `net --fail`, `box`, `style`, `count`, `find`.
4. Fix code, then `reload`.
5. `shot` when you need to see it.

## Locating things

- CSS selectors everywhere. `find "Save changes"` reverse-maps visible text to a selector.
- `count <sel>` before iterating; `box` to check layout; `attr`/`style` for values.
- Dynamic UI: `wait <sel> [--visible] [--gone]`, `wait-text <sel> "text"`, `wait-idle`.

## Acting like a user

- `click` dispatches real mouse events at the element's coordinates — correct for
  canvas, drag handles, and anything listening on pointer events.
- `click --js` calls `el.click()` instead; use when a real click is intercepted by an overlay.
- `type` sets form values through the prototype setter, so React/Vue bindings fire.
- `press Cmd+Enter`, `select`, `check`, `upload`, `drag from to`, `scroll`.

## Verifying

`assert-visible / assert-hidden / assert-text / assert-count / assert-value` exit non-zero
on mismatch and print the actual value. Chain them in `run` to fail fast:

```
browser({action:"run", flags:{/* stdin script */}})
```

Prefer `run` for multi-step flows: one call, one round trip.

## Reading failures

- `console --errors` — runtime exceptions and uncaught rejections.
- `net --fail` — HTTP >= 400 and network errors; `headers <url>` shows request/response headers.
- `net-body <url>` — response body for API debugging.
- `shot --sel <sel>` — crop one element; plain `shot` does full page up to 3000px.

## Cross-origin iframes

`frames` lists both same-process iframes and OOPIFs. `frame <url-fragment>` scopes every
later action to that frame; `frame top` returns. Coordinates are translated automatically,
so `click` works inside cross-origin frames.

## Isolation

Every `session` gets its own Chrome profile, ports, and state directory. Use one session
per task so concurrent work never fights over the active tab. Read-only actions can be
issued in parallel inside a codemode script; state-changing ones must be serial.

## What the agent must not do

`annotate` and `pick` open interactive UI for a human. Do not call them to gather
information — use `find`, `text`, or `shot`. Read annotations with `ann` / `ann-export`.

## Configuration

`hotkey` and `browser` read or set the annotation hotkey and the target browser.
Both are user preferences — only change them when the user asks.

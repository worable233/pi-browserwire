# Contributing

## What this is

`pi-browserwire` is two things in one package:

- `cli/bw.mjs` — a zero-dependency CDP CLI. **No `dependencies` may ever be added.**
  Node 22+ built-ins (`WebSocket`, `fetch`) cover everything.
- `extensions/` — pi extension code downloaded and run by the harness.

Keep both true when changing anything.

## Ground rules

**No new dependencies.** This is the whole point of the project. If a feature
needs a library, reconsider the feature or write the 50 lines.

**One tool, one enum.** Actions go into the existing `browser` tool's `action`
enum, never into new tools. Every new tool costs schema tokens on every turn.

**Text-first output.** One compact line per action. Anything large (screenshots,
full HTML) goes to disk with the path returned.

**No silent retries.** Failures return a code plus a concrete reason so scripted
callers can branch. Retrying inside the tool hides real problems.

**Input actions must dispatch real events.** `Input.insertText` plus the native
value setter — never `dispatchEvent`. Synthetic events skip React state entirely
and make the tool lie about what it did.

## Adding an action

1. Add the `case` in `cli/bw.mjs` (keep the existing grouping and comment style).
2. Add the name to `ACTIONS` in `extensions/index.ts`.
3. Add it to `READ_ONLY` if it does not mutate the page.
4. Document it in the README action table.
5. Verify the alignment check below passes.

```bash
# every CLI case must exist in the tool enum
node -e '
const fs = require("fs");
const cli = fs.readFileSync("cli/bw.mjs", "utf8");
const ext = fs.readFileSync("extensions/index.ts", "utf8");
const cases = [...cli.matchAll(/^\t\tcase "([a-z-]+)":/gm)]
  .map((m) => m[1])
  .filter((a) => !["help", "--help", "-h"].includes(a));
const declared = new Set(
  [...ext.match(/const ACTIONS = \[([\s\S]*?)\];/)[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]),
);
const missing = cases.filter((c) => !declared.has(c));
if (missing.length) {
  console.error("missing from ACTIONS:", missing.join(" "));
  process.exit(1);
}
console.log("ok", cases.length, "actions aligned");
'
```

## Testing

The CLI is exercised against a real browser; there is no mock CDP layer, by
design. Before opening a PR:

```bash
node --check cli/bw.mjs

# smoke test against a local page
bw open file:///tmp/bw-test.html
bw eval "document.title"
bw shot            # returns a path; open it
bw console --errors # must be empty
bw close
```

For annotation changes, verify interactively with `bw annotate`:

- hover box follows the mouse **before** the composer opens
- composer opens below the element, flips above when short on space
- **selection freezes** while the composer is open (hover box hidden, page clicks ignored)
- `⌘V` with an image in the clipboard adds a thumbnail
- `Enter` saves, `Esc` discards and unfreezes
- the badge number appears and is clickable to edit
- the note reaches the host composer as markdown

## Commit messages

Conventional prefixes, imperative mood:

```
feat: add cpu-throttle action
fix: viewport override lost on disconnect
docs: document the settings UI channel
refactor: merge OOPIF frame routing
```

Keep the subject under 72 characters. Explain *why* in the body when the change
is not self-evident.

## Scope

The CLI runs against a browser it launches itself, with a dedicated
`--user-data-dir`. It cannot attach to an already-running Chrome, and `chrome://`
pages are out of reach. Those are CDP constraints, not bugs to fix.

Platform support: macOS and Linux are tested. Windows paths are declared but
unverified — reports welcome.

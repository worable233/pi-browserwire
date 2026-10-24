#!/usr/bin/env python3
"""
Patch Percho's app.asar to grow one host hook: a `composer.top` UI plugin region
plus a tiny annotation bridge.

Why this exists
---------------
The browserwire annotation card wants to sit above the composer showing "N 条批注",
hover to delete. Percho cannot host that today:

  * ctx.ui.setWidget() is a no-op stub in the main process
  * only four extension IPC channels exist (dialog / editor-text / notify)
  * UI plugin regions carry no annotation data, and the renderer is sandboxed
    (CSP default-src 'self', no filesystem) so it cannot read bw's JSON itself

So we add exactly two things and nothing else:

  1. UI region `composer.top` — mounted right above the composer input box.
  2. `window.PerchoUI.annotations` = { list(), remove(file, id) } backed by an
     IPC handler that reads/writes ~/.pi/bw/sessions/<name>/annotations.json,
     always the most recently touched session.

The script rebuilds the asar losslessly: every other entry keeps its bytes,
its order and its `unpacked` flag. Run it again after a Percho upgrade (the
anchors below are checked; it refuses to write a half-patched archive).

Usage:
    python3 percho/patch-percho.py            # writes /tmp/app-patched.asar
    ./percho/apply.sh                         # swap it in on next Percho exit
"""

import glob
import json
import os
import struct
import sys

APP = "/Applications/Percho.app/Contents/Resources/app.asar"
OUT = "/tmp/app-patched.asar"


# ---------------------------------------------------------------- asar codec

def read_asar(path):
    with open(path, "rb") as f:
        raw = f.read()
    # layout: [4][b][c][d][json d bytes], data starts at 8 + b
    _, header_total, _, json_len = struct.unpack("<4I", raw[:16])
    header = json.loads(raw[16:16 + json_len])
    return header, raw[8 + header_total:], raw[16:16 + json_len]


def walk(node, prefix=""):
    """Yield (path, node) for every file entry, depth first, in header order."""
    for name, child in node.get("files", {}).items():
        path = prefix + "/" + name
        if "files" in child:
            yield from walk(child, path)
        else:
            yield path, child


def build_asar(header, data_by_path, out_path):
    """Serialise header + data, preserving order and unpacked flags."""
    offset = 0
    for path, node in walk(header):
        body = data_by_path.get(path)
        if body is None or node.get("unpacked"):
            continue
        node["size"] = len(body)
        node["offset"] = str(offset)
        offset += len(body)

    hdr = json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode()
    pad = (4 - len(hdr) % 4) % 4
    hdr += b" " * pad  # trailing spaces keep JSON.parse happy and the pickle aligned
    json_len = len(hdr)

    with open(out_path, "wb") as f:
        f.write(struct.pack("<4I", 4, json_len + 8, json_len + 4, json_len))
        f.write(hdr)
        for path, node in walk(header):
            body = data_by_path.get(path)
            if body is None or node.get("unpacked"):
                continue
            f.write(body)


# ------------------------------------------------------------ patch helpers

def patch(text, old, new, label, count=1):
    if text.count(old) < count:
        sys.exit(f"✗ anchor not found: {label}\n  expected: {old[:80]!r}")
    return text.replace(old, new, count)


REGION_ANCHOR = '  ComposerFooter: "composer.footer",\n  SettingsPanel: "settings.panel"'
REGION_PATCH = (
    '  ComposerFooter: "composer.footer",\n'
    '  /** 输入框正上方：整行卡片（bw 批注条） */\n'
    '  ComposerTop: "composer.top",\n'
    '  SettingsPanel: "settings.panel"'
)

MAIN_IPC = '''
/* ---- bw 批注桥（本地补丁，见 pi-browserwire/percho/patch-percho.py） ----
   读/删 ~/.pi/bw/sessions/<name>/annotations.json，取最近改动过的那个会话。 */
const BW_ANN_ROOT = join(homedir(), ".pi", "bw", "sessions");
function bwAnnRead() {
  try {
    const files = [];
    for (const name of readdirSync(BW_ANN_ROOT)) {
      const file = join(BW_ANN_ROOT, name, "annotations.json");
      try {
        files.push({ file, mtime: statSync(file).mtimeMs });
      } catch {}
    }
    files.sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return { file: null, items: [], seq: 0 };
    const data = JSON.parse(readFileSync(files[0].file, "utf8"));
    return { file: files[0].file, items: Array.isArray(data.items) ? data.items : [], seq: data.seq ?? 0 };
  } catch {
    return { file: null, items: [], seq: 0 };
  }
}
ipcMain.handle("bw:annotations", async (_e, args) => {
  const action = args && args.action ? args.action : "list";
  if (action === "delete") {
    const current = bwAnnRead();
    const file = args && args.file ? args.file : current.file;
    if (!file || !resolve(file).startsWith(resolve(BW_ANN_ROOT))) return current;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      const id = String((args && args.id) ?? "");
      data.items = (Array.isArray(data.items) ? data.items : []).filter((a) => a && a.id !== id);
      data.items.forEach((a, i) => {
        a.n = i + 1;
      });
      data.seq = (data.seq ?? 0) + 1;
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      renameSync(tmp, file);
      return { file, items: data.items, seq: data.seq };
    } catch {
      return current;
    }
  }
  return bwAnnRead();
});
'''

PRELOAD_ANCHOR = "  getPathForFile: (file) => electron.webUtils.getPathForFile(file),"
PRELOAD_PATCH = (
    PRELOAD_ANCHOR
    + '\n  /** bw 批注桥（本地补丁）：{ action: "list" } / { action: "delete", file, id } */\n'
    + '  bwAnnotations: (args) => electron.ipcRenderer.invoke("bw:annotations", args),'
)

REGION_CASE_ANCHOR = """    case UI_REGIONS.ComposerFooter:
      return /* @__PURE__ */ jsxRuntimeExports.jsx(jsxRuntimeExports.Fragment, { children: list2.map(renderContribution) });"""
REGION_CASE_PATCH = (
    REGION_CASE_ANCHOR
    + """
    case UI_REGIONS.ComposerTop:
      return /* @__PURE__ */ jsxRuntimeExports.jsx(jsxRuntimeExports.Fragment, { children: list2.map(renderContribution) });"""
)

MOUNT_MARK = """      /* @__PURE__ */ jsxRuntimeExports.jsx(RegionHost, { region: UI_REGIONS.ComposerTop }),"""

PERCHO_UI_ANCHOR = """    useUiPreferencesStore
  }
};"""
PERCHO_UI_PATCH = """    useUiPreferencesStore
  }
};
/* bw 批注桥（本地补丁）：UI 插件只拿 PerchoUI，不透出 window.pi */
window.PerchoUI.annotations = {
  list: () => window.pi.bwAnnotations({ action: "list" }),
  remove: (file, id) => window.pi.bwAnnotations({ action: "delete", file, id })
};"""


def mount_composer_card(src):
    """Insert <RegionHost region=ComposerTop/> just above the composer input box."""
    marker = "onMouseDown: handleComposerMouseDown,"
    if src.count(marker) != 1:
        sys.exit(f"✗ composer anchor is not unique ({src.count(marker)})")
    at = src.index(marker)
    # walk back to the jsxs( that opens the rounded input box
    open_at = src.rindex("jsxRuntimeExports.jsxs(", 0, at)
    line_start = src.rindex("\n", 0, open_at) + 1
    return src[:line_start] + MOUNT_MARK + "\n" + src[line_start:]


def main():
    if not os.path.exists(APP):
        sys.exit(f"✗ {APP} not found")

    header, data, _ = read_asar(APP)
    blobs = {}
    for path, node in walk(header):
        if node.get("unpacked"):
            continue
        blobs[path] = data[int(node["offset"]): int(node["offset"]) + node["size"]]

    # /out/renderer/assets/index-*.js — the entry is the one that sets up window.PerchoUI
    renderer = [
        p
        for p in blobs
        if p.startswith("/out/renderer/assets/index-") and p.endswith(".js")
        and b"window.PerchoUI" in blobs[p]
    ]
    if len(renderer) != 1:
        sys.exit(f"✗ expected one renderer bundle with window.PerchoUI, found {renderer}")
    renderer = renderer[0]

    patches = {}

    mainjs = blobs["/out/main/index.js"].decode()
    mainjs = patch(mainjs, REGION_ANCHOR, REGION_PATCH, "main UI_REGIONS")
    if '"bw:annotations"' in mainjs:
        sys.exit("✗ main already patched")
    mainjs = mainjs.rstrip("\n") + "\n" + MAIN_IPC
    patches["/out/main/index.js"] = mainjs.encode()

    preload = blobs["/out/preload/index.cjs"].decode()
    if "bwAnnotations" in preload:
        sys.exit("✗ preload already patched")
    preload = patch(preload, PRELOAD_ANCHOR, PRELOAD_PATCH, "preload api")
    patches["/out/preload/index.cjs"] = preload.encode()

    r = blobs[renderer].decode()
    r = patch(r, REGION_ANCHOR, REGION_PATCH, "renderer UI_REGIONS")
    r = patch(r, REGION_CASE_ANCHOR, REGION_CASE_PATCH, "renderer RegionHost case")
    r = patch(r, PERCHO_UI_ANCHOR, PERCHO_UI_PATCH, "renderer PerchoUI")
    r = mount_composer_card(r)
    patches[renderer] = r.encode()

    original = dict(blobs)
    blobs.update(patches)
    build_asar(header, blobs, OUT)

    # verify round trip
    h2, d2, _ = read_asar(OUT)
    got = {}
    for path, node in walk(h2):
        if node.get("unpacked"):
            continue
        got[path] = d2[int(node["offset"]): int(node["offset"]) + node["size"]]
    if len(got) != len(blobs):
        sys.exit(f"✗ entry count differs: {len(got)} != {len(blobs)}")
    for path, body in patches.items():
        if got[path] != body:
            sys.exit(f"✗ {path} did not round-trip")
    changed = [p for p in patches if original.get(p) != got[p]]
    if len(changed) != 3:
        sys.exit(f"✗ expected 3 patched entries, got {changed}")
    print(f"✓ wrote {OUT}  ({os.path.getsize(OUT) / 1e6:.0f} MB, {len(got)} entries)")
    print(f"  patched: {', '.join(changed)}")


if __name__ == "__main__":
    main()

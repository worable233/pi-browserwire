/**
 * Package entry point.
 *
 * The host derives an extension's display name from the *directory* of its entry
 * file (`path.replace(/\/index\.(ts|js)$/, "")` then take the last segment). An
 * entry at `extensions/index.ts` therefore shows up in 设置 → 扩展 as
 * "extensions", which is useless. Keeping a root shim named `index.ts` makes the
 * last segment the package directory itself: "pi-browserwire".
 *
 * The real implementation lives in `extensions/`; this file only re-exports so
 * the module is loaded exactly once either way.
 */
export { default } from "./extensions/index.ts";

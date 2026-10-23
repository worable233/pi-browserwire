/**
 * browserwire entry point.
 *
 * Two exposure modes:
 *   - direct (default): the tool is declared to the model while active and stays
 *     callable from codemode scripts via ctx.executeTool.
 *   - codemode: schema stays out of the base prompt entirely; the model reaches it
 *     only through codemode scripts. Set BROWSERWIRE_EXPOSURE=codemode.
 *
 * The split matters: a single fat tool with an `action` enum costs far fewer
 * tokens than ~87 separate tools, and codemode lets the model filter results
 * (e.g. only errors) before they ever enter the conversation.
 */

import { registerAnnotationBridge } from "./annotations.ts";
import { Type as T } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
const BUNDLED_CLI = join(PKG_ROOT, "cli", "bw.mjs");
const USER_CLI = join(homedir(), ".local", "bin", "bw");

/** Actions grouped by intent; the enum string is the whole schema cost. */
const ACTIONS = [
	// navigate
	"open", "reload", "back", "forward", "hard-reload", "go",
	// tabs / windows
	"tabs", "use", "new-tab", "new-window", "close-tab", "windows", "window",
	// interact
	"click", "dblclick", "hover", "focus", "blur", "type", "fill", "keys", "press",
	"select", "check", "uncheck", "scroll", "drag", "upload",
	// wait / assert
	"wait", "wait-text", "wait-idle", "assert-visible", "assert-hidden",
	"assert-text", "assert-count", "assert-value",
	// query
	"text", "html", "attr", "style", "box", "count", "find", "eval", "title",
	// logs / network
	"console", "errors", "net", "net-body", "headers", "clear-logs",
	// capture
	"shot", "screenshot", "pdf", "outline",
	// annotate (user-driven)
	"pick", "mark", "marks", "clear", "annotate", "annotate-done",
	"ann", "ann-export", "ann-shot", "ann-clear",
	// frames / device / storage
	"frames", "frame", "viewport", "reset-viewport", "cookies", "storage", "dialog",
	"dialog-policy",
	// net shaping
	"clear-cache", "throttle", "cpu-throttle",
	// dom highlight
	"highlight", "highlight-clear",
	// config
	"hotkey", "browser",
	// lifecycle / batch
	"status", "doctor", "close", "run",
] as const;

const READ_ONLY = new Set([
	"tabs", "text", "html", "attr", "style", "box", "count", "find", "title",
	"console", "errors", "net", "net-body", "headers", "marks", "ann", "ann-export",
	"frames", "windows", "cookies", "storage", "status", "doctor", "shot", "pdf",
]);

function cliPath(): string {
	return existsSync(BUNDLED_CLI) ? BUNDLED_CLI : USER_CLI;
}

export interface RunResult {
	ok: boolean;
	out: string;
	err?: string;
	code: number;
}

/** Run one subcommand. Never throws; every failure is returned as data. */
export function runBw(
	args: string[],
	opts: { session?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RunResult> {
	const cli = cliPath();
	if (!existsSync(cli)) {
		return Promise.resolve({
			ok: false,
			out: "",
			err: `CLI missing at ${cli}; reinstall browserwire`,
			code: 127,
		});
	}
	const timeoutMs = opts.timeoutMs ?? 30_000;
	const env = { ...process.env };
	if (opts.session) env.BW_SESSION = opts.session;
	// pi can run inside Electron's main process, where `process.execPath` is the app
	// binary rather than node. Spawning it directly boots a second app instance
	// (Chromium profile takeover -> host restart). ELECTRON_RUN_AS_NODE makes the
	// same binary behave as a plain node runtime. Ignored by real node binaries.
	if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";

	return new Promise((resolve) => {
		const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		let done = false;
		const finish = (r: RunResult) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(r);
		};
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			finish({
				ok: false,
				out: out.trim(),
				err: `timeout ${timeoutMs}ms — page likely busy. Retry with a larger timeoutMs, or call 'wait-idle' first.`,
				code: 124,
			});
		}, timeoutMs);

		child.stdout?.on("data", (c) => (out += c.toString()));
		child.stderr?.on("data", (c) => (err += c.toString()));
		child.on("error", (e) => finish({ ok: false, out: "", err: `spawn failed: ${e.message}`, code: 126 }));
		child.on("close", (code) =>
			finish({ ok: code === 0, out: out.trim(), err: err.trim() || undefined, code: code ?? 1 }),
		);

		// Cancellation from the harness (user stop, sibling failure, session dispose).
		if (opts.signal) {
			const onAbort = () => {
				try {
					child.kill("SIGKILL");
				} catch {}
				finish({ ok: false, out: out.trim(), err: "aborted", code: 130 });
			};
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function toArgs(p: any): string[] {
	const args: string[] = [String(p.action)];
	if (p.target !== undefined) args.push(String(p.target));
	if (p.arg !== undefined) args.push(String(p.arg));
	if (p.arg2 !== undefined) args.push(String(p.arg2));
	if (Array.isArray(p.files)) args.push(...p.files.map(String));
	for (const [k, v] of Object.entries(p.flags ?? {})) {
		if (v === false || v === undefined || v === null) continue;
		args.push(v === true ? `--${k}` : `--${k}=${v}`);
	}
	return args;
}

const PARAMS = T.Object({
	action: T.String({ description: `One of: ${ACTIONS.join(", ")}` }),
	target: T.Optional(T.String({ description: "Selector | url | tab index | key" })),
	arg: T.Optional(T.String({ description: "2nd positional: text, value, note, expected" })),
	arg2: T.Optional(T.String({ description: "3rd positional: drag target, etc." })),
	files: T.Optional(T.Array(T.String(), { description: "Upload paths" })),
	flags: T.Optional(
		T.Record(T.String(), T.Union([T.String(), T.Number(), T.Boolean()]), {
			description: "Flags: {full|viewport|visible|gone|errors|fail|outer|png|mobile|new-tab|window, timeout, sel, width, height, limit, filter, max, times, count, button, state}",
		}),
	),
	session: T.Optional(T.String({ description: "Isolated profile; one per task" })),
	timeoutMs: T.Optional(T.Number({ description: "Kill after ms (default 30000)" })),
});

/** Model-facing description: terse, but enough to choose correctly. */
const DESCRIPTION = [
	"Drive real Chrome over CDP. One line per call; screenshots saved to disk.",
	"Start with `open`; it reports console errors + failed requests for that load.",
	"`console`/`net` read a background daemon persisting across calls.",
	"Wait before asserting on dynamic UI (`wait`, `wait-text`, `wait-idle`).",
	"`find <text>` maps visible text to a selector.",
	"Read-only actions parallelize in codemode; state-changing ones must be serial.",
	"On failure retry once with bigger timeoutMs, or `wait` first.",
	"`annotate`/`pick` are for humans, not the agent.",
].join(" ");

function makeTool(exposure: "codemode" | "direct") {
	return {
		name: "browser",
		label: "Browser",
		description: DESCRIPTION,
		parameters: PARAMS,
		exposure,
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		async execute(_id: string, p: any, signal?: AbortSignal) {
			const action = String(p.action ?? "");
			if (!(ACTIONS as readonly string[]).includes(action)) {
				return {
					content: [{ type: "text", text: `Unknown action "${action}". Valid: ${ACTIONS.join(", ")}` }],
					details: { ok: false, action },
				};
			}
			const r = await runBw(toArgs(p), { session: p.session, timeoutMs: p.timeoutMs, signal });
			const text = r.ok
				? r.out || "(no output)"
				: `FAILED(exit ${r.code}): ${r.err || r.out || "unknown"}`;
			return {
				content: [{ type: "text", text }],
				details: {
					ok: r.ok,
					action,
					code: r.code,
					readOnly: READ_ONLY.has(action),
					session: p.session ?? null,
					// Actionable hint so a codemode script can branch without re-parsing prose.
					retryable: r.code === 124 || r.code === 1,
					hint:
						r.code === 124
							? "timeout: retry with larger timeoutMs, or run wait-idle first"
							: r.code === 1
								? "command failed: check selector with find/count, or wait for the element"
								: undefined,
				},
			};
		},
	};
}

export default function (pi: any) {
	/**
	 * `direct` is the right default: the model sees the tool AND codemode scripts
	 * can call it through ctx.executeTool (direct tools are "callable while active").
	 * `codemode`-only exposure would hide it from the model unless codemode is on.
	 * Set BROWSERWIRE_EXPOSURE=codemode to keep the base prompt at zero cost.
	 */
	const exposure = process.env.BROWSERWIRE_EXPOSURE === "codemode" ? "codemode" : "direct";
	pi.registerTool(makeTool(exposure));

	pi.registerCommand("bw", {
		description: "Run a browserwire command: /bw open localhost:3000",
		handler: async (args: string, ctx: any) => {
			const argv = splitArgs(args.trim());
			if (!argv.length) {
				ctx.ui.notify("Usage: /bw <action> [args]  ·  try /bw doctor", "info");
				return;
			}
			const r = await runBw(argv, { timeoutMs: 60_000 });
			ctx.ui.notify((r.ok ? r.out : `FAILED: ${r.err ?? r.out}`).slice(0, 600), r.ok ? "info" : "error");
		},
	});

	registerAnnotationBridge(pi);
}

function splitArgs(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let q: string | null = null;
	for (const c of line) {
		if (q) {
			if (c === q) q = null;
			else cur += c;
		} else if (c === '"' || c === "'") q = c;
		else if (/\s/.test(c)) {
			if (cur) {
				out.push(cur);
				cur = "";
			}
		} else cur += c;
	}
	if (cur) out.push(cur);
	return out;
}

/**
 * Annotation bridge.
 *
 * `browser annotate` writes annotations to ~/.pi/bw/sessions/<sid>/annotations.json.
 * This module watches that file and:
 *   1. pushes a compact markdown summary into the composer via ctx.ui.setEditorText()
 *   2. on send, attaches the annotation screenshots as image content
 *
 * The composer push is the only host-sanctioned text path (extension -> main ->
 * IPC pi:extension-editor-text -> useDraftStore). Images cannot ride that path,
 * so they are appended to the outgoing user message through the `context` event,
 * which is the documented place where an extension may replace messages.
 */

import { existsSync, mkdirSync, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_ROOT = join(homedir(), ".pi", "bw");
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const NOTE_LIMIT = 120;

interface Annotation {
	id: string;
	n: number;
	selector: string;
	tag: string;
	text?: string;
	note: string;
	url: string;
	title?: string;
	tabIndex?: number;
	shot?: string;
	updatedAt?: number;
}

/** 与 CLI 的 resolveSessionName 保持一致：未指定时就是 "default" */
function resolveSession(explicit?: string): string {
	const raw = explicit ?? process.env.BW_SESSION ?? "default";
	return raw.replace(/[^a-zA-Z0-9_-]/g, "") || "default";
}

function annFile(session: string): string {
	return join(STATE_ROOT, "sessions", session, "annotations.json");
}

function readItems(file: string): Annotation[] {
	try {
		if (!existsSync(file)) return [];
		const d = JSON.parse(readFileSync(file, "utf8"));
		return Array.isArray(d.items) ? d.items : [];
	} catch {
		return [];
	}
}

/** Compact markdown: one line per annotation, notes truncated. */
export function buildSummary(items: Annotation[]): string {
	if (!items.length) return "";
	const groups = new Map<string, Annotation[]>();
	for (const a of items) {
		const list = groups.get(a.url) ?? [];
		list.push(a);
		groups.set(a.url, list);
	}
	const lines = ["【页面批注】", ""];
	let i = 0;
	for (const [url, list] of groups) {
		i++;
		const head = list[0];
		const tab = typeof head.tabIndex === "number" ? ` · tab ${head.tabIndex}` : "";
		lines.push(`### ${i}. ${head.title || "(untitled)"}${tab}`, url);
		for (const a of list) {
			lines.push(`${a.n}. \`${a.selector}\` (${a.tag}) — ${a.note.replace(/\s+/g, " ").slice(0, NOTE_LIMIT)}`);
			if (a.shot) lines.push(`   shot: ${a.shot}`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

const sigOf = (items: Annotation[]) => items.map((a) => `${a.id}:${a.updatedAt ?? 0}`).join("|");

export function registerAnnotationBridge(pi: any, opts: { session?: string } = {}) {
	let watcher: ReturnType<typeof watch> | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastSig = "";
	let pending: Annotation[] = [];
	const attached = new Set<string>();

	const file = annFile(resolveSession(opts.session));
	const watchDir = dirname(file);

	const push = (ctx: any) => {
		const items = readItems(file);
		if (!items.length) return;
		const sig = sigOf(items);
		if (sig === lastSig) return;
		lastSig = sig;
		pending = items;
		try {
			ctx.ui.setEditorText(buildSummary(items));
			ctx.ui.notify(`${items.length} 条页面批注已填入输入框`, "info");
		} catch {
			// headless modes have no composer
		}
	};

	const schedule = (ctx: any) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => push(ctx), 250);
	};

	pi.on("session_start", (_e: any, ctx: any) => {
		try {
			if (watcher) return;
			// Watch the session directory itself. Recursive watching is unsupported on
			// Linux, and the annotation file always lives exactly one level down.
			mkdirSync(watchDir, { recursive: true });
			watcher = watch(watchDir, { persistent: false }, (_ev: string, f: string | null) => {
				if (f && !String(f).endsWith("annotations.json")) return;
				schedule(ctx);
			});
			// fs.watch 在目录被删/移动时会把 error 事件抛成未捕获异常，直接打穿宿主主进程
			watcher.on("error", () => {
				try {
					watcher?.close();
				} catch {}
				watcher = null;
			});
			schedule(ctx);
		} catch {}
	});

	pi.on("session_shutdown", () => {
		if (timer) clearTimeout(timer);
		timer = null;
		try {
			watcher?.close();
		} catch {}
		watcher = null;
	});

	pi.registerCommand("bw-annotations", {
		description: "Push browser annotations into the composer",
		handler: async (_a: string, ctx: any) => {
			const items = readItems(file);
			if (!items.length) {
				ctx.ui.notify("No annotations. Run: bw annotate", "warning");
				return;
			}
			lastSig = "";
			push(ctx);
		},
	});

	/** Attach screenshots to the outgoing message exactly once per signature. */
	pi.on("context", async (event: any) => {
		if (!pending.length) return;
		const messages: any[] = event.messages ?? [];
		let idx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]?.role === "user") {
				idx = i;
				break;
			}
		}
		if (idx < 0) return;

		const msg = messages[idx];
		const text =
			typeof msg.content === "string"
				? msg.content
				: Array.isArray(msg.content)
					? msg.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n")
					: "";
		if (!text.includes("【页面批注】")) return;

		const sig = sigOf(pending);
		if (attached.has(sig)) return;
		if (Array.isArray(msg.content) && msg.content.some((c: any) => c?.type === "image")) {
			attached.add(sig);
			return;
		}

		const images: any[] = [];
		for (const a of pending) {
			if (!a.shot || !existsSync(a.shot)) continue;
			try {
				const buf = readFileSync(a.shot);
				if (buf.length > MAX_IMAGE_BYTES) continue;
				const mimeType = a.shot.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
				images.push({ type: "image", data: buf.toString("base64"), mimeType });
			} catch {}
		}
		attached.add(sig);
		if (!images.length) return;

		const next = messages.slice();
		next[idx] = {
			...msg,
			content: [
				...(Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }]),
				...images,
			],
		};
		return { messages: next };
	});
}

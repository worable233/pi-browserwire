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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_ROOT = join(homedir(), ".pi", "bw");
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const NOTE_LIMIT = 32;

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
	images?: string[];
	changes?: Array<{ prop: string; from: string; to: string }>;
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

/** 属性名 → 中文短标签，避免 diff 撑长输入框 */
const PROP_LABEL: Record<string, string> = {
	color: "色",
	"background-color": "背景",
	opacity: "透明度",
	"font-family": "字体",
	"font-size": "字号",
};

/** rgb(224, 224, 224) → #e0e0e0：diff 里颜色占的地方最大 */
const compactColor = (v: string) => {
	const m = String(v).match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
	if (!m) return v;
	const hex = "#" + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("");
	return m[4] !== undefined && Number(m[4]) !== 1 ? hex + "@" + m[4] : hex;
};

const clip = (v: string, n: number) => {
	const t = String(v).replace(/\s+/g, " ").trim();
	return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** 选择器只留最后两级：完整路径太长，定位元素这两级已经够用 */
function shortSelector(sel: string): string {
	const parts = String(sel)
		.split(" > ")
		.filter(Boolean)
		.map((p) => p.replace(/:nth-of-type\(\d+\)/g, ""));
	return parts.slice(-2).join(" > ") || sel;
}

/** 百分号编码的中文路径解码后会短很多，也更好读 */
function shortUrl(url: string): string {
	try {
		return decodeURI(url);
	} catch {
		return url;
	}
}

function fmtChanges(changes: Annotation["changes"]): string {
	return (changes ?? [])
		.map((c) => {
			if (c.prop === "text") return `文本「${clip(c.from, 12)}」→「${clip(c.to, 12)}」`;
			const label = PROP_LABEL[c.prop] ?? c.prop;
			return `${label} ${clip(compactColor(c.from), 18)}→${clip(compactColor(c.to), 18)}`;
		})
		.join("｜");
}

/**
 * 进输入框的内容必须极短：这里会变成用户输入框里的草稿，写成长篇 markdown
 * 会把输入框整个盖住。一行一条批注，详细信息由 agent 自己跑 `bw ann-export` 取。
 */
export function buildSummary(items: Annotation[]): string {
	if (!items.length) return "";
	const groups = new Map<string, Annotation[]>();
	for (const a of items) {
		const list = groups.get(a.url) ?? [];
		list.push(a);
		groups.set(a.url, list);
	}
	const lines: string[] = [];
	// 只有一页时省掉 URL 行：标题已足够定位，URL 由 agent 用 `bw ann-export` 取，
	// 输入框里每多一行都是在盖住用户的草稿区。
	const multi = groups.size > 1;
	for (const [url, list] of groups) {
		const head = list[0];
		const tab = typeof head.tabIndex === "number" ? ` · tab ${head.tabIndex}` : "";
		lines.push(`【批注】${head.title || "(untitled)"}${tab}`);
		if (multi) lines.push(shortUrl(url));
		for (const a of list) {
			const note = a.note ? `「${clip(a.note, NOTE_LIMIT)}」` : "";
			const diff = fmtChanges(a.changes);
			const shot = a.shot ? "📷" : "";
			lines.push(
				`${a.n}. ${shortSelector(a.selector)}${note}${diff ? "｜" + diff : ""}${shot}`,
			);
		}
	}
	return lines.join("\n");
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
	// 已发送标记落在批注同目录：主进程的补丁读它来把「发过的」从卡片里去掉
	// （卡片只显示待发送的，发完就消失）。只写这个文件，绝不回写 annotations.json，
	// 免得和 CLI 的原子写抢。
	const sentFile = join(watchDir, "sent.json");

	/** 已随消息发送过的批注：id + updatedAt，改动过的算新的 */
	const sent = new Set<string>();
	const itemSig = (a: Annotation) => `${a.id}:${a.updatedAt ?? 0}`;
	const unsent = (items: Annotation[]) => items.filter((a) => !sent.has(itemSig(a)));

	const readSent = (): Record<string, number> => {
		try {
			const d = JSON.parse(readFileSync(sentFile, "utf8"));
			return d && typeof d === "object" ? d : {};
		} catch {
			return {};
		}
	};
	for (const [id, at] of Object.entries(readSent())) sent.add(`${id}:${Number(at) || 0}`);

	/** 原子写：tmp + rename，和 CLI 的写法一致 */
	const persistSent = () => {
		try {
			mkdirSync(watchDir, { recursive: true });
			const live = new Set(readItems(file).map((a) => a.id));
			const map: Record<string, number> = {};
			for (const sig of sent) {
				const at = sig.lastIndexOf(":");
				const id = sig.slice(0, at);
				if (!live.has(id)) continue; // 批注已删，标记也清掉
				map[id] = Number(sig.slice(at + 1)) || 0;
			}
			const tmp = `${sentFile}.tmp-${process.pid}`;
			writeFileSync(tmp, JSON.stringify(map), "utf8");
			renameSync(tmp, sentFile);
		} catch {}
	};

	/**
	 * 输入框保持干净：不再把批注正文塞进草稿，只提示数量，
	 * 正文在发送时通过 context 事件附加到用户消息上（见下方 context 处理器）。
	 */
	const push = (ctx: any) => {
		const items = readItems(file);
		if (!items.length) return;
		const sig = sigOf(items);
		if (sig === lastSig) return;
		lastSig = sig;
		pending = items;
		const n = unsent(items).length;
		if (!n) return;
		try {
			ctx.ui.notify(`${n} 条页面批注将随消息附上`, "info");
		} catch {
			// headless modes have no UI
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
		description: "Re-attach browser annotations to the next message",
		handler: async (_a: string, ctx: any) => {
			const items = readItems(file);
			if (!items.length) {
				ctx.ui.notify("No annotations. Run: bw annotate", "warning");
				return;
			}
			// 清掉已发送标记，让下一条消息重新带上全部批注
			sent.clear();
			try {
				rmSync(sentFile, { force: true });
			} catch {}
			lastSig = "";
			pending = items;
			ctx.ui.notify(`${items.length} 条批注将随下一条消息附上`, "info");
		},
	});

	/**
	 * Attach annotations — and their screenshots — to the outgoing user message.
	 * This is the documented place where an extension may replace messages, and it
	 * keeps the composer untouched: the user writes their own words, the annotation
	 * rides along as an attachment.
	 */
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

		const todo = unsent(pending);
		if (!todo.length) return;

		const images: any[] = [];
		for (const a of todo) {
			if (!a.shot || !existsSync(a.shot)) continue;
			try {
				const buf = readFileSync(a.shot);
				if (buf.length > MAX_IMAGE_BYTES) continue;
				const mimeType = a.shot.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
				images.push({ type: "image", data: buf.toString("base64"), mimeType });
			} catch {}
		}

		// 老行为（批注正文已在草稿里）或用户手动粘贴时不要重复追加
		const summary = text.includes("【批注】") || text.includes("【页面批注】") ? "" : buildSummary(todo);
		if (!summary && !images.length) return;

		const existing = Array.isArray(msg.content)
			? msg.content
			: [{ type: "text", text: String(msg.content ?? "") }];
		const next = messages.slice();
		next[idx] = { ...msg, content: [...existing, ...(summary ? [{ type: "text", text: summary }] : []), ...images] };

		for (const a of todo) sent.add(itemSig(a));
		persistSent();
		return { messages: next };
	});
}

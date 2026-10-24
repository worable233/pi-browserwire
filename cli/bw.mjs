#!/usr/bin/env node
/**
 * bw — 浏览器调试 CLI（零依赖，纯 CDP）
 *
 * 设计目标（pi 理念）：不新增工具定义、输出紧凑、图片落盘、单命令亚秒级。
 * 覆盖调试全流程，agent 不需要手写 CDP 或起 Playwright。
 *
 * 三层：
 *   1) 一次性 CLI 命令 → 直连 page target 做动作/查询
 *   2) 常驻 daemon    → 挂在 browser target 上收集 console/network/dialog（跨调用持久）
 *   3) 批量 runner    → `bw run` 从 stdin 顺序执行，减少往返
 */

import { execFileSync, spawn } from "node:child_process";
import {
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
/** 本文件指纹。daemon 上报它，CLI 升级后旧 daemon 会被自动替换。 */
const BUILD = (() => {
	try {
		return statSync(SELF).mtimeMs;
	} catch {
		return 0;
	}
})();
const HOME = homedir();

/**
 * 会话隔离：多个 pi 会话同时用 bw 时，各自独立浏览器 + 独立 state，互不干扰。
 * 优先级：--session=<name> > BW_SESSION 环境变量 > "default"
 * 目录：~/.pi/bw/sessions/<name>/{state.json,profile/,shots/,annotations.json}
 */
function resolveSessionName() {
	const arg = process.argv.find((a) => a.startsWith("--session="));
	if (arg) return arg.slice("--session=".length).replace(/[^a-zA-Z0-9_-]/g, "") || "default";
	const env = process.env.BW_SESSION;
	if (env) return env.replace(/[^a-zA-Z0-9_-]/g, "") || "default";
	return "default";
}
const SESSION_NAME = resolveSessionName();
const ROOT_DIR = join(HOME, ".pi", "bw");
const STATE_DIR = join(ROOT_DIR, "sessions", SESSION_NAME);
const PROFILE_DIR = join(STATE_DIR, "profile");
const SHOT_DIR = join(STATE_DIR, "shots");
const STATE_FILE = join(STATE_DIR, "state.json");
const SETTINGS_FILE = join(STATE_DIR, "settings.json");
/** 用户配置：批注热键等。可被 Percho 设置面板或手写编辑覆盖。 */
const DEFAULT_SETTINGS = { hotkey: "shift+a", browser: "auto" };

/**
 * Percho UI 插件的配置出口。插件沙箱无 fs / IPC，唯一能把值写进宿主 JSON 的
 * 通道是 `uiPluginsAssignSlot` 的 pluginName（main 侧只校验字符串类型），
 * 所以 GUI 把配置编码成 `bw:<key>=<value>` 存在槽位指派里。
 * 这里反向解密全部键值：GUI 配置优先于 settings.json。
 *
 * 多个键用不同槽位承载（每个槽位存一条），互不覆盖。
 */
/** Percho userData 目录，按平台解析（应用名 @percho/desktop）。不存在则返回 null。 */
function perchoConfigDir() {
	const candidates =
		process.platform === "darwin"
			? [join(HOME, "Library", "Application Support", "@percho", "desktop")]
			: process.platform === "win32"
				? [join(process.env.APPDATA ?? join(HOME, "AppData", "Roaming"), "@percho", "desktop")]
				: [
						join(process.env.XDG_CONFIG_HOME ?? join(HOME, ".config"), "@percho", "desktop"),
						join(HOME, ".config", "@percho", "desktop"),
					];
	return candidates.find((p) => existsSync(join(p, "ui-plugins.json"))) ?? null;
}

function readPerchoConfig() {
	const out = {};
	const dir = perchoConfigDir();
	if (!dir) return out;
	try {
		const raw = JSON.parse(readFileSync(join(dir, "ui-plugins.json"), "utf8"));
		for (const v of Object.values(raw?.assignments ?? {})) {
			if (typeof v !== "string" || !v.startsWith("bw:")) continue;
			const body = v.slice(3);
			const eq = body.indexOf("=");
			if (eq <= 0) continue;
			const k = body.slice(0, eq).trim();
			const val = body.slice(eq + 1).trim();
			if (k && val) out[k] = val;
		}
	} catch {}
	return out;
}

function readSettings() {
	let fileCfg = {};
	try {
		fileCfg = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
	} catch {}
	// GUI（Percho 设置页）优先
	return { ...DEFAULT_SETTINGS, ...fileCfg, ...readPerchoConfig() };
}
function writeSettings(patch) {
	const next = { ...readSettings(), ...patch };
	mkdirSync(STATE_DIR, { recursive: true });
	writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + "\n");
	return next;
}

/** 受支持的 Chromium 系浏览器。id 用于配置持久化，paths 按平台列出候选。 */
const BROWSERS = [
	{
		id: "chrome",
		name: "Google Chrome",
		paths: [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/usr/bin/google-chrome",
			"/usr/bin/google-chrome-stable",
			"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		],
	},
	{
		id: "chromium",
		name: "Chromium",
		paths: [
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
		],
	},
	{
		id: "edge",
		name: "Microsoft Edge",
		paths: [
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/usr/bin/microsoft-edge",
			"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
		],
	},
	{
		id: "brave",
		name: "Brave",
		paths: [
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
			"/usr/bin/brave-browser",
			"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
		],
	},
];

/** 解析某 id 的可执行文件路径；未安装返回 null */
function browserPath(id) {
	const b = BROWSERS.find((x) => x.id === id);
	if (!b) return null;
	return b.paths.find((p) => existsSync(p)) ?? null;
}

/** 按配置解析要启动的浏览器；auto 或缺失 → 第一个已安装的 */
function resolveBrowser() {
	const want = readSettings().browser ?? "auto";
	if (want !== "auto") {
		const p = browserPath(want);
		if (p) return { id: want, path: p };
	}
	for (const b of BROWSERS) {
		const p = b.paths.find((x) => existsSync(x));
		if (p) return { id: b.id, path: p };
	}
	return null;
}

const MAX_TEXT = 400;
const MAX_FULL_H = 3000;

/** 标注视觉对齐 Percho：--color-accent 浅 #7c3aed / 深 #8b5cf6，圆角 6px，11px 字体 */
const MARK_STYLE = {
	accent: "#7c3aed",
	accentDark: "#8b5cf6",
	fill: "rgba(124,58,237,.10)",
	fillDark: "rgba(139,92,246,.14)",
	radius: "6px",
	font: "-apple-system, BlinkMacSystemFont, sans-serif",
};

/* ==================================================================== */
/* 浏览器侧注入的运行时（真实函数，toString 后注入，避免转义地狱）      */
/* ==================================================================== */

/** 页面注入代码的版本：改 __bwInit/__bwAnnotator/__bwHotkeys/__bwPicker 时必须 +1 */
const RUNTIME_V = 11;

function __bwInit(style) {
	if (window.__bw) {
		window.__bw.style = style;
		return "ok";
	}
	const S = { ...style };
	const dark = () => !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
	const accent = () => (dark() ? S.accentDark : S.accent);
	const fill = () => (dark() ? S.fillDark : S.fill);

	const selector = (el) => {
		const parts = [];
		let n = el;
		while (n && n.nodeType === 1 && parts.length < 6) {
			let s = n.tagName.toLowerCase();
			if (n.id) {
				s += "#" + CSS.escape(n.id);
				parts.unshift(s);
				break;
			}
			const cls = [...n.classList].slice(0, 2).map((c) => "." + CSS.escape(c));
			if (cls.length) s += cls.join("");
			const p = n.parentElement;
			if (p) {
				const sibs = [...p.children].filter((c) => c.tagName === n.tagName);
				if (sibs.length > 1) s += ":nth-of-type(" + (sibs.indexOf(n) + 1) + ")";
			}
			parts.unshift(s);
			n = n.parentElement;
		}
		return parts.join(" > ");
	};

	const paint = (el) => {
		el.style.outline = "1.5px solid " + accent();
		el.style.outlineOffset = "1px";
		el.style.borderRadius = el.style.borderRadius || S.radius;
		el.style.backgroundColor = fill();
		el.style.boxShadow = "0 0 0 3px " + fill();
		el.dataset.bwPainted = "1";
	};
	const unpaint = (el) => {
		el.style.outline = "";
		el.style.outlineOffset = "";
		el.style.backgroundColor = "";
		el.style.boxShadow = "";
		delete el.dataset.bwPainted;
	};

	const placeBadge = (b, el) => {
		if (!b || !el || !el.isConnected) return;
		const r = el.getBoundingClientRect();
		b.style.left = Math.max(0, r.left + window.scrollX - 7) + "px";
		b.style.top = Math.max(0, r.top + window.scrollY - 7) + "px";
	};
	const sync = () => {
		for (const m of window.__bw.marks) placeBadge(m.badge, m.el);
	};
	const startSync = () => {
		if (window.__bw.syncTimer) return;
		window.__bw.syncTimer = setInterval(sync, 120);
		window.addEventListener("resize", sync, true);
		window.addEventListener("scroll", sync, true);
		if (window.ResizeObserver) {
			window.__bw.ro = new ResizeObserver(sync);
			window.__bw.ro.observe(document.documentElement);
		}
		if (window.MutationObserver) {
			window.__bw.mo = new MutationObserver(sync);
			window.__bw.mo.observe(document.documentElement, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["class", "style"],
			});
		}
	};
	const stopSync = () => {
		if (window.__bw.syncTimer) {
			clearInterval(window.__bw.syncTimer);
			window.__bw.syncTimer = null;
		}
		window.removeEventListener("resize", sync, true);
		window.removeEventListener("scroll", sync, true);
		try {
			window.__bw.ro && window.__bw.ro.disconnect();
		} catch {}
		try {
			window.__bw.mo && window.__bw.mo.disconnect();
		} catch {}
		window.__bw.ro = null;
		window.__bw.mo = null;
	};

	const badge = (n, el) => {
		const b = document.createElement("div");
		b.dataset.bwBadge = "1";
		b.textContent = String(n);
		Object.assign(b.style, {
			position: "absolute",
			zIndex: "2147483647",
			pointerEvents: "none",
			background: accent(),
			color: "#fff",
			font: "600 10px/15px " + S.font,
			width: "15px",
			height: "15px",
			borderRadius: "999px",
			textAlign: "center",
			boxShadow: "0 1px 3px rgba(0,0,0,.18)",
			transition: "left .08s linear, top .08s linear",
		});
		document.documentElement.appendChild(b);
		placeBadge(b, el);
		startSync();
		return b;
	};

	const visible = (el) => {
		if (!el || !el.isConnected) return false;
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return false;
		const cs = getComputedStyle(el);
		if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
		return true;
	};

	window.__bw = { style: S, accent, fill, selector, paint, unpaint, badge, sync, startSync, stopSync, visible, marks: [] };
	return "ok";
}

/**
 * 快捷键批注入口。
 *
 * 页面内监听 keydown，匹配用户配置的热键（默认 Shift+A）进入批注模式。
 * 热键存在 ~/.pi/bw/sessions/<name>/settings.json 的 hotkey 字段，可被 Percho 设置或直接编辑覆盖。
 * 不接管右键菜单——浏览器原生菜单保持原样。
 */
function __bwHotkeys(hotkey) {
	const norm = (e) => {
		const parts = [];
		if (e.ctrlKey || e.metaKey) parts.push("mod");
		if (e.altKey) parts.push("alt");
		if (e.shiftKey) parts.push("shift");
		const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
		parts.push(k);
		return parts.join("+");
	};

	// "shift+a" / "mod+shift+a" / "alt+a"
	const target = String(hotkey || "shift+a")
		.toLowerCase()
		.replace(/cmd|ctrl|meta/g, "mod")
		.split("+")
		.map((x) => x.trim())
		.join("+");

	const handler = (e) => {
		// 批注模式下 Esc：面板开着就先丢当前批注，再按一次退出批注模式。
		// 捕获阶段先于编辑器自己的 keydown，所以这里统一处理，不必再区分焦点。
		if (e.key === "Escape" && window.__bwAnnActive) {
			e.preventDefault();
			e.stopPropagation();
			const ann = window.__bwAnn;
			if (!ann) {
				window.__bwAnnActive = false;
				return;
			}
			if (ann.isOpen && ann.isOpen()) ann.closePanel();
			else ann.setActive(false);
			return;
		}
		// 输入框/可编辑区内不触发，避免打字冲突
		const t = e.target;
		if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
		if (norm(e) !== target) return;
		e.preventDefault();
		e.stopPropagation();
		window.__bwAnnToggle && window.__bwAnnToggle();
	};

	// 先摘掉旧监听（热键变更时重新注入）
	if (window.__bwHotkeyHandler) {
		document.removeEventListener("keydown", window.__bwHotkeyHandler, true);
	}
	window.__bwHotkeyHandler = handler;
	document.addEventListener("keydown", handler, true);

	// 子 frame 里的按键不会冒泡到顶层文档，由 frame 桥转发过来
	const onMsg = (e) => {
		const d = e && e.data;
		if (!d || typeof d !== "object" || typeof d.__bwKey !== "string") return;
		if (d.__bwKey === "escape") {
			if (window.__bwAnnActive && window.__bwAnn) {
				if (window.__bwAnn.isOpen && window.__bwAnn.isOpen()) window.__bwAnn.closePanel();
				else window.__bwAnn.setActive(false);
			}
			return;
		}
		if (d.__bwKey !== target) return;
		window.__bwAnnToggle && window.__bwAnnToggle();
	};
	if (window.__bwHotkeyMsgListener) window.removeEventListener("message", window.__bwHotkeyMsgListener);
	window.__bwHotkeyMsgListener = onMsg;
	window.addEventListener("message", onMsg);

	window.__bwHotkey = target;
	return target;
}

/**
 * 子 frame 的按键桥。
 * 跨源 iframe 里的 keydown 不会冒泡到顶层文档，所以每个 frame 各装一个监听，
 * 把按键规格 postMessage 给顶层，由顶层统一判断并切换批注层。
 * 不烘焙具体热键——顶层用自己的配置比对，改热键不必重注入子 frame。
 */
function __bwFrameKeyBridge() {
	if (window.__bwFrameBridge) return "already";
	if (window.top === window) return "top";
	const norm = (e) => {
		const parts = [];
		if (e.ctrlKey || e.metaKey) parts.push("mod");
		if (e.altKey) parts.push("alt");
		if (e.shiftKey) parts.push("shift");
		parts.push(String(e.key).toLowerCase());
		return parts.join("+");
	};
	const post = (msg) => {
		try {
			window.top.postMessage(msg, "*");
		} catch {}
	};
	const handler = (e) => {
		const t = e.target;
		if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
			if (e.key === "Escape") post({ __bwKey: "escape" });
			return;
		}
		post({ __bwKey: norm(e) });
	};
	document.addEventListener("keydown", handler, true);
	window.__bwFrameBridge = handler;
	return "ok";
}

function __bwAnnotator() {
	if (window.__bwAnn) return "already";
	const S = window.__bw.style;
	const accent = window.__bw.accent;
	const dark = () => !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
	const surface = () => (dark() ? "#212126" : "#ffffff");
	const border = () => (dark() ? "#38383f" : "#e2e8f0");
	const ink = () => (dark() ? "#e6e6ea" : "#18181b");
	const inkDim = () => (dark() ? "#a1a1aa" : "#71717a");

	// 十字光标遮罩
	const veil = document.createElement("div");
	veil.dataset.bwVeil = "1";
	Object.assign(veil.style, {
		position: "fixed",
		inset: "0",
		zIndex: "2147483645",
		cursor: "crosshair",
		background: "transparent",
	});

	// 悬停高亮框
	const box = document.createElement("div");
	Object.assign(box.style, {
		position: "absolute",
		pointerEvents: "none",
		zIndex: "2147483646",
		border: "1.5px solid " + accent(),
		background: window.__bw.fill(),
		borderRadius: S.radius,
		boxShadow: "0 0 0 3px " + window.__bw.fill(),
		display: "none",
	});
	document.documentElement.appendChild(box);

	const placeBox = (el) => {
		const r = el.getBoundingClientRect();
		Object.assign(box.style, {
			display: "block",
			left: r.left + scrollX + "px",
			top: r.top + scrollY + "px",
			width: r.width + "px",
			height: r.height + "px",
		});
	};

	/** 把任意 CSS 颜色转成 #rrggbb；透明返回 null（color input 不接受 alpha） */
	const cssHex = (color) => {
		try {
			const cv = document.createElement("canvas");
			cv.width = cv.height = 1;
			const ctx = cv.getContext("2d");
			ctx.fillStyle = "#000";
			ctx.fillStyle = color;
			ctx.fillRect(0, 0, 1, 1);
			const d = ctx.getImageData(0, 0, 1, 1).data;
			if (d[3] === 0) return null;
			return "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
		} catch {
			return null;
		}
	};

	// 输入浮层
	let panel = null;
	let panelTarget = null;
	let editingId = null;
	/** 输入框打开时冻结选框，防止误选下一个元素 */
	let frozen = false;

	/** 面板打开期间跟随滚动/缩放的清理函数 */
	let unfollowBox = null;
	const closePanel = () => {
		if (panel) panel.remove();
		panel = null;
		panelTarget = null;
		editingId = null;
		frozen = false;
		box.style.display = "none";
		if (unfollowBox) {
			unfollowBox();
			unfollowBox = null;
		}
		if (window.__bwAnnActive) veil.style.pointerEvents = "auto";
	};

	/**
	 * 打开输入条。此时必须冻结选框：veil 设为 pointer-events:none 并移除 mousemove 跟随，
	 * 让用户只能操作输入框。保存或 Esc 后才恢复选元素能力。
	 */
	const openPanel = (el, existing) => {
		closePanel();
		panelTarget = el;
		editingId = existing ? existing.id : null;
		frozen = true;
		// 冻结后选框必须留着：否则一打开输入框，用户就不知道自己在标注哪个元素
		placeBox(el);
		const follow = () => {
			if (panelTarget && panelTarget.isConnected) placeBox(panelTarget);
		};
		window.addEventListener("scroll", follow, true);
		window.addEventListener("resize", follow);
		unfollowBox = () => {
			window.removeEventListener("scroll", follow, true);
			window.removeEventListener("resize", follow);
		};
		veil.style.pointerEvents = "none";
		const r = el.getBoundingClientRect();

		/* ---- 样式微调：用户点左侧按钮后展开，改的是元素本身的 inline style ---- */
		let styleMode = false;
		/** prop -> 首次进入时的计算值，作为 diff 的 from（页面已被改过也不会串味） */
		const pristine = {};
		/** prop -> { from, to }，只有真的变了才记录 */
		const edits = {};
		const origInline = el.getAttribute("style");
		const origText = el.textContent ?? "";
		const noTextEdit = el.childElementCount > 0;
		const STYLE_PROPS = ["color", "background-color", "opacity", "font-family", "font-size"];
		// 批注高亮是画在元素自己的 inline style 上的，直接读计算值会把紫色高亮当成
		// 元素真实背景。读之前先临时摘掉高亮，读完原样还原。
		const base = (() => {
			const saved = el.getAttribute("style");
			if (el.dataset.bwPainted) {
				for (const p of ["outline", "outline-offset", "background-color", "box-shadow"]) {
					el.style.removeProperty(p);
				}
			}
			const cs = getComputedStyle(el);
			const v = {};
			for (const p of STYLE_PROPS) v[p] = cs.getPropertyValue(p).trim();
			if (saved === null) el.removeAttribute("style");
			else el.setAttribute("style", saved);
			return v;
		})();
		const snap = () => {
			for (const p of STYLE_PROPS) if (!(p in pristine)) pristine[p] = base[p] ?? "";
		};
		const apply = (prop, value) => {
			if (value === "" || value == null) el.style.removeProperty(prop);
			else el.style.setProperty(prop, value, "important");
			const now = getComputedStyle(el).getPropertyValue(prop).trim();
			const from = pristine[prop] ?? now;
			if (now.replace(/\s+/g, "").toLowerCase() === from.replace(/\s+/g, "").toLowerCase()) delete edits[prop];
			else edits[prop] = { from, to: now };
		};

		const shots = existing && Array.isArray(existing.images) ? existing.images.slice() : [];

		panel = document.createElement("div");
		panel.dataset.bwPanel = "1";
		Object.assign(panel.style, {
			position: "absolute",
			zIndex: "2147483647",
			width: "320px",
			background: surface(),
			border: "1px solid " + border(),
			borderRadius: "14px",
			boxShadow: "0 10px 32px rgba(0,0,0,.18), 0 1px 3px rgba(0,0,0,.08)",
			font: "14px/1.5 " + S.font,
			color: ink(),
			boxSizing: "border-box",
			padding: "7px 8px 7px 12px",
		});

		// 图片缩略图区
		const thumbs = document.createElement("div");
		Object.assign(thumbs.style, { display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "6px" });
		const renderThumbs = () => {
			thumbs.innerHTML = "";
			thumbs.style.display = shots.length ? "flex" : "none";
			shots.forEach((src, i) => {
				const wrap = document.createElement("div");
				Object.assign(wrap.style, { position: "relative", width: "46px", height: "46px" });
				const img = document.createElement("img");
				img.src = src;
				Object.assign(img.style, {
					width: "46px",
					height: "46px",
					objectFit: "cover",
					borderRadius: "8px",
					border: "1px solid " + border(),
					display: "block",
				});
				const x = document.createElement("button");
				x.textContent = "×";
				Object.assign(x.style, {
					position: "absolute",
					top: "-5px",
					right: "-5px",
					width: "17px",
					height: "17px",
					borderRadius: "999px",
					border: "none",
					background: "rgba(0,0,0,.72)",
					color: "#fff",
					font: "600 11px/17px " + S.font,
					cursor: "pointer",
					padding: "0",
				});
				x.addEventListener("click", () => {
					shots.splice(i, 1);
					renderThumbs();
				});
				wrap.append(img, x);
				thumbs.appendChild(wrap);
			});
		};
		renderThumbs();

		const row = document.createElement("div");
		// 垂直居中：底部对齐会让文字相对整块 pill 偏下
		Object.assign(row.style, {
			display: "flex",
			alignItems: "center",
			gap: "8px",
			minHeight: "36px",
		});

		// 左侧滑杆图标
		const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		icon.setAttribute("viewBox", "0 0 24 24");
		icon.setAttribute("width", "17");
		icon.setAttribute("height", "17");
		icon.style.flexShrink = "0";
		icon.style.cursor = "pointer";
		icon.style.transition = "opacity .12s";
		icon.setAttribute("role", "button");
		icon.setAttribute("title", "调整样式");
		const stroke = inkDim();
		icon.innerHTML =
			'<line x1="4" y1="7" x2="20" y2="7" stroke="' + stroke + '" stroke-width="2" stroke-linecap="round"/>' +
			'<circle cx="9" cy="7" r="2.4" fill="' + surface() + '" stroke="' + stroke + '" stroke-width="2"/>' +
			'<line x1="4" y1="16" x2="20" y2="16" stroke="' + stroke + '" stroke-width="2" stroke-linecap="round"/>' +
			'<circle cx="15" cy="16" r="2.4" fill="' + surface() + '" stroke="' + stroke + '" stroke-width="2"/>';

		// contenteditable 富文本
		const editor = document.createElement("div");
		editor.contentEditable = "true";
		editor.dataset.bwEditor = "1";
		editor.spellcheck = false;
		if (existing && existing.noteHtml) editor.innerHTML = existing.noteHtml;
		else editor.textContent = existing ? existing.note : "";
		Object.assign(editor.style, {
			flex: "1",
			minWidth: "0",
			minHeight: "21px",
			maxHeight: "132px",
			overflowY: "auto",
			outline: "none",
			font: "14px/21px " + S.font,
			color: ink(),
			padding: "0",
			wordBreak: "break-word",
		});

		const empty = () => !editor.textContent.trim() && shots.length === 0;
		const syncPlaceholder = () => {
			if (empty() && !editor.dataset.ph) {
				editor.dataset.ph = "1";
				editor.setAttribute("data-placeholder", existing ? "编辑批注…" : "添加评论…");
			} else if (!empty() && editor.dataset.ph) {
				delete editor.dataset.ph;
				editor.removeAttribute("data-placeholder");
			}
		};
		// placeholder 用伪元素需要样式表，改为绝对定位覆盖层。
		// 必须挂在与编辑器同尺寸的定位容器里：挂在 panel 上会把 panel 的 padding
		// 也算进偏移，字会比光标高出一截。
		const field = document.createElement("div");
		Object.assign(field.style, {
			position: "relative",
			display: "flex",
			flex: "1",
			minWidth: "0",
		});
		const ph = document.createElement("span");
		ph.textContent = existing ? "编辑批注…" : "添加评论…";
		Object.assign(ph.style, {
			position: "absolute",
			left: "0",
			top: "0",
			pointerEvents: "none",
			color: inkDim(),
			font: "14px/1.5 " + S.font,
			opacity: "1",
			transition: "opacity .1s",
		});
		const refreshPh = () => {
			ph.style.opacity = empty() ? "1" : "0";
		};
		editor.addEventListener("input", refreshPh);
		setTimeout(refreshPh, 0);

		// 粘贴图片 → base64 缩略图
		editor.addEventListener("paste", (e) => {
			const items = e.clipboardData?.items;
			if (!items) return;
			let handled = false;
			for (const it of items) {
				if (!it.type.startsWith("image/")) continue;
				const file = it.getAsFile();
				if (!file) continue;
				handled = true;
				const fr = new FileReader();
				fr.onload = () => {
					shots.push(String(fr.result));
					renderThumbs();
					refreshPh();
				};
				fr.readAsDataURL(file);
			}
			if (handled) e.preventDefault();
		});

		// 提交按钮
		const submit = document.createElement("button");
		submit.title = "保存 (Enter)";
		Object.assign(submit.style, {
			width: "32px",
			height: "32px",
			flexShrink: "0",
			borderRadius: "999px",
			border: "none",
			background: accent(),
			cursor: "pointer",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			transition: "opacity .12s",
			marginBottom: "2px",
		});
		submit.addEventListener("mouseenter", () => (submit.style.opacity = ".85"));
		submit.addEventListener("mouseleave", () => (submit.style.opacity = "1"));
		const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		arrow.setAttribute("viewBox", "0 0 24 24");
		arrow.setAttribute("width", "16");
		arrow.setAttribute("height", "16");
		arrow.innerHTML =
			'<line x1="12" y1="19" x2="12" y2="6" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>' +
			'<polyline points="6,12 12,6 18,12" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
		submit.appendChild(arrow);

		const save = () => {
			const plain = editor.innerText.trim();
			if (!plain && !shots.length && !Object.keys(edits).length) {
				editor.focus();
				return;
			}
			const changes = Object.entries(edits).map(([prop, v]) => ({ prop, from: v.from, to: v.to }));
			window.__bwAnnSave({
				id: editingId,
				selector: window.__bw.selector(el),
				tag: el.tagName.toLowerCase(),
				text: (el.innerText || el.textContent || "").trim().slice(0, 120),
				note: plain,
				noteHtml: editor.innerHTML,
				images: shots,
				changes,
			});
			closePanel();
		};
		submit.addEventListener("click", save);

		editor.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				closePanel();
				return;
			}
			// Enter 保存；Shift+Enter 换行
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				save();
				return;
			}
			// 基础富文本快捷键
			if ((e.metaKey || e.ctrlKey) && !e.altKey) {
				const k = e.key.toLowerCase();
				if (k === "b" || k === "i" || k === "u") {
					e.preventDefault();
					document.execCommand(k === "b" ? "bold" : k === "i" ? "italic" : "underline");
				}
			}
		});

		const inputStyle = {
			background: "rgba(255,255,255,.045)",
			border: "1px solid " + border(),
			borderRadius: "8px",
			color: ink(),
			font: "13px/1 " + S.font,
			padding: "7px 9px",
			outline: "none",
			minWidth: "0",
			width: "100%",
			boxSizing: "border-box",
		};

		// 样式面板：点左侧图标才展开
		const styleBox = document.createElement("div");
		Object.assign(styleBox.style, {
			display: "none",
			marginTop: "6px",
			borderTop: "1px solid " + border(),
		});

		const tagRow = document.createElement("div");
		Object.assign(tagRow.style, {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			padding: "8px 4px",
		});
		const tagLabel = document.createElement("span");
		tagLabel.textContent = "<" + el.tagName.toLowerCase() + ">";
		Object.assign(tagLabel.style, {
			font: "12px/1 ui-monospace, SFMono-Regular, Menlo, monospace",
			color: inkDim(),
		});
		const dots = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		dots.setAttribute("viewBox", "0 0 20 20");
		dots.setAttribute("width", "14");
		dots.setAttribute("height", "14");
		dots.innerHTML =
			[6, 10, 14]
				.map(
					(y) =>
						[6, 14]
							.map(
								(x) =>
									'<circle cx="' + x + '" cy="' + y + '" r="1.3" fill="' + inkDim() + '"/>',
							)
							.join(""),
				)
				.join("");
		dots.style.opacity = ".55";
		tagRow.append(tagLabel, dots);
		styleBox.append(tagRow);

		// 标题行可拖动：按住圆点（或整行空白处）移动面板，位置夹在视口内
		Object.assign(tagRow.style, { cursor: "grab", userSelect: "none", touchAction: "none" });
		tagRow.title = "拖动面板";
		tagRow.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			const x0 = e.clientX;
			const y0 = e.clientY;
			const l0 = parseFloat(panel.style.left) || 0;
			const t0 = parseFloat(panel.style.top) || 0;
			const pr = panel.getBoundingClientRect();
			const maxL = Math.max(scrollX + 8, scrollX + innerWidth - pr.width - 8);
			const maxT = Math.max(scrollY + 8, scrollY + innerHeight - pr.height - 8);
			const move = (ev) => {
				panel.style.left =
					Math.min(Math.max(scrollX + 8, l0 + (ev.clientX - x0)), maxL) + "px";
				panel.style.top =
					Math.min(Math.max(scrollY + 8, t0 + (ev.clientY - y0)), maxT) + "px";
			};
			const up = () => {
				panel.style.cursor = "";
				document.removeEventListener("pointermove", move, true);
				document.removeEventListener("pointerup", up, true);
				document.removeEventListener("pointercancel", up, true);
			};
			panel.style.cursor = "grabbing";
			document.addEventListener("pointermove", move, true);
			document.addEventListener("pointerup", up, true);
			document.addEventListener("pointercancel", up, true);
		});

		const propRow = (label, nodes) => {
			const rr = document.createElement("div");
			Object.assign(rr.style, {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: "10px",
				padding: "7px 4px",
				borderTop: "1px solid " + border(),
			});
			const l = document.createElement("span");
			l.textContent = label;
			Object.assign(l.style, { flexShrink: "0", font: "13px/1 " + S.font, color: ink() });
			const box2 = document.createElement("div");
			Object.assign(box2.style, {
				display: "flex",
				alignItems: "center",
				gap: "7px",
				flex: "1",
				justifyContent: "flex-end",
				minWidth: "0",
			});
			box2.append(...nodes);
			rr.append(l, box2);
			styleBox.append(rr);
			return rr;
		};

		// 文本
		const textInput = document.createElement("input");
		textInput.type = "text";
		textInput.value = (el.innerText || el.textContent || "").trim().slice(0, 200);
		textInput.disabled = noTextEdit;
		if (noTextEdit) textInput.title = "该元素含子元素，文本需在源码里改";
		Object.assign(textInput.style, inputStyle, noTextEdit ? { opacity: ".5" } : {});
		textInput.addEventListener("input", () => {
			if (noTextEdit) return;
			el.textContent = textInput.value;
			if (textInput.value === origText.trim()) delete edits.text;
			else edits.text = { from: origText.trim(), to: textInput.value };
		});
		propRow("文本", [textInput]);

		// 颜色 / 背景
		const colorRow = (label, prop) => {
			const start = base[prop] || "";
			const hex = cssHex(start);
			const sw = document.createElement("input");
			sw.type = "color";
			sw.value = hex || "#000000";
			Object.assign(sw.style, {
				width: "26px",
				height: "26px",
				flexShrink: "0",
				padding: "0",
				border: "1px solid " + border(),
				borderRadius: "999px",
				background: "transparent",
				cursor: "pointer",
			});
			const tx = document.createElement("input");
			tx.type = "text";
			tx.spellcheck = false;
			tx.value = hex || start || "transparent";
			Object.assign(tx.style, inputStyle);
			sw.addEventListener("input", () => {
				tx.value = sw.value;
				apply(prop, sw.value);
			});
			let t = null;
			tx.addEventListener("input", () => {
				clearTimeout(t);
				t = setTimeout(() => {
					const v = tx.value.trim();
					if (!v) return;
					const h = cssHex(v);
					if (h) sw.value = h;
					apply(prop, v);
				}, 260);
			});
			propRow(label, [sw, tx]);
		};
		colorRow("文本颜色", "color");
		colorRow("背景", "background-color");

		// Opacity
		const opInput = document.createElement("input");
		opInput.type = "number";
		opInput.step = "0.05";
		opInput.min = "0";
		opInput.max = "1";
		opInput.value = String(Math.round(parseFloat(base.opacity || "1") * 100) / 100);
		Object.assign(opInput.style, inputStyle);
		opInput.addEventListener("input", () => apply("opacity", opInput.value));
		propRow("Opacity", [opInput]);

		// 字体
		const curFont = base["font-family"];
		const FONTS = [
			["Geist", 'Geist, ui-sans-serif, system-ui, sans-serif'],
			["系统无衬线", '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'],
			["Inter", 'Inter, ui-sans-serif, system-ui, sans-serif'],
			["思源黑体", '"Source Han Sans SC", "Noto Sans SC", sans-serif'],
			["宋体", '"Songti SC", SimSun, serif'],
			["等宽", "ui-monospace, SFMono-Regular, Menlo, monospace"],
		];
		const fontSel = document.createElement("select");
		Object.assign(fontSel.style, inputStyle, {
			cursor: "pointer",
			appearance: "none",
			paddingRight: "26px",
			backgroundImage:
				"url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%23a1a1aa' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/></svg>\")",
			backgroundRepeat: "no-repeat",
			backgroundPosition: "right 9px center",
		});
		if (!FONTS.some(([, v]) => v === curFont)) FONTS.unshift([curFont.split(",")[0].replace(/["']/g, ""), curFont]);
		for (const [name, v] of FONTS) {
			const o = document.createElement("option");
			o.value = v;
			o.textContent = name;
			o.style.background = surface();
			fontSel.append(o);
		}
		fontSel.value = curFont;
		fontSel.addEventListener("change", () => apply("font-family", fontSel.value));
		propRow("字体", [fontSel]);

		// 字号
		const fsInput = document.createElement("input");
		fsInput.type = "number";
		fsInput.step = "1";
		fsInput.min = "6";
		fsInput.value = String(Math.round(parseFloat(base["font-size"] || "16") * 100) / 100);
		Object.assign(fsInput.style, inputStyle);
		fsInput.addEventListener("input", () => apply("font-size", fsInput.value ? fsInput.value + "px" : ""));
		propRow("字号", [fsInput]);

		// footer：取消 + 提交
		const footer = document.createElement("div");
		Object.assign(footer.style, {
			display: "none",
			alignItems: "center",
			justifyContent: "space-between",
			marginTop: "6px",
			paddingTop: "8px",
			borderTop: "1px solid " + border(),
		});
		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.textContent = "取消";
		Object.assign(cancel.style, {
			background: "transparent",
			border: "1px solid " + border(),
			borderRadius: "8px",
			color: inkDim(),
			font: "500 12px/1 " + S.font,
			padding: "8px 12px",
			cursor: "pointer",
		});
		cancel.addEventListener("click", () => {
			// 取消：把元素恢复成打开面板前的样子
			if (origInline === null) el.removeAttribute("style");
			else el.setAttribute("style", origInline);
			if (!noTextEdit) el.textContent = origText;
			for (const k of Object.keys(edits)) delete edits[k];
			closePanel();
		});

		const setStyleMode = (on) => {
			styleMode = on;
			snap();
			styleBox.style.display = on ? "block" : "none";
			footer.style.display = on ? "flex" : "none";
			icon.style.opacity = on ? "1" : ".72";
			if (on) {
				footer.append(cancel, submit);
				ph.textContent = "描述这些更改…";
				// 面板变高后可能超出视口
				const pr2 = panel.getBoundingClientRect();
				const maxTop = scrollY + innerHeight - pr2.height - 8;
				if (parseFloat(panel.style.top) > maxTop) panel.style.top = Math.max(scrollY + 8, maxTop) + "px";
			} else {
				submit.style.marginBottom = "2px";
				row.append(submit);
				ph.textContent = existing ? "编辑批注…" : "添加评论…";
			}
		};
		icon.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			setStyleMode(!styleMode);
		});
		setStyleMode(false);

		field.appendChild(editor);
		field.appendChild(ph);
		row.append(icon, field, submit);
		panel.append(thumbs, row, styleBox, footer);

		// 编辑模式：删除按钮
		if (existing) {
			const del = document.createElement("button");
			del.textContent = "删除";
			Object.assign(del.style, {
				position: "absolute",
				right: "10px",
				top: "-26px",
				font: "500 11px/1 " + S.font,
				color: "#dc2626",
				background: surface(),
				border: "1px solid " + border(),
				borderRadius: "999px",
				padding: "5px 10px",
				cursor: "pointer",
				boxShadow: "0 2px 8px rgba(0,0,0,.10)",
			});
			del.addEventListener("click", () => {
				window.__bwAnnDelete(existing.id);
				closePanel();
			});
			panel.appendChild(del);
		}

		document.documentElement.appendChild(panel);

		// 定位：元素下方，空间不足翻上方，水平夹视口
		const pr = panel.getBoundingClientRect();
		let left = r.left + scrollX;
		let top = r.bottom + scrollY + 10;
		if (r.bottom + pr.height + 24 > innerHeight + scrollY) top = r.top + scrollY - pr.height - 10;
		left = Math.max(scrollX + 8, Math.min(left, scrollX + innerWidth - pr.width - 8));
		top = Math.max(scrollY + 8, top);
		panel.style.left = left + "px";
		panel.style.top = top + "px";
		setTimeout(() => editor.focus(), 0);
	};

	// 收集：点击 veil 时命中的真实元素
	veil.addEventListener("mousemove", (e) => {
		// 冻结时选框钉在 panelTarget 上，不能被跟随高亮擦掉
		if (frozen) return;
		veil.style.pointerEvents = "none";
		const el = document.elementFromPoint(e.clientX, e.clientY);
		veil.style.pointerEvents = "auto";
		if (!el || el.closest("[data-bw-panel],[data-bw-badge]")) return;
		placeBox(el);
	});

	veil.addEventListener(
		"click",
		(e) => {
			if (frozen) return; // 输入中忽略页面点击
			e.preventDefault();
			e.stopPropagation();
			veil.style.pointerEvents = "none";
			const el = document.elementFromPoint(e.clientX, e.clientY);
			veil.style.pointerEvents = "auto";
			if (!el || el.closest("[data-bw-panel],[data-bw-badge]")) return;
			const hit = window.__bw.marks.find((m) => m.el === el);
			openPanel(el, hit ? { id: hit.id, n: hit.n, note: hit.note, images: hit.images, noteHtml: hit.noteHtml } : null);
		},
		true,
	);

	// 点徽章 → 编辑
	document.addEventListener(
		"click",
		(e) => {
			const badge = e.target && e.target.closest && e.target.closest("[data-bw-badge]");
			if (!badge) return;
			e.preventDefault();
			e.stopPropagation();
			const n = Number(badge.textContent);
			const m = window.__bw.marks.find((x) => x.n === n);
			if (m) openPanel(m.el, { id: m.id, n: m.n, note: m.note });
		},
		true,
	);

	document.documentElement.appendChild(veil);
	veil.style.display = "none";
	veil.style.pointerEvents = "none";

	const setActive = (on) => {
		window.__bwAnnActive = !!on;
		veil.style.display = on ? "block" : "none";
		veil.style.pointerEvents = on ? "auto" : "none";
		if (!on) {
			closePanel();
			box.style.display = "none";
		}
	};
	window.__bwAnnToggle = () => setActive(!window.__bwAnnActive);
	/** 右键菜单「添加批注」调用：直接对指定元素开面板 */
	window.__bwAnnStart = (el) => {
		setActive(true);
		openPanel(el, null);
	};

	// 出站队列：用热键进入标注模式时不会经过 `bw annotate`，这两个钩子必须在
	// 批注层里自带，否则点提交会抛 __bwAnnSave is not a function，表现为「按了没反应」。
	window.__bwAnnOut = window.__bwAnnOut || [];
	if (typeof window.__bwAnnSave !== "function") {
		window.__bwAnnSave = (payload) => window.__bwAnnOut.push({ op: "save", payload });
	}
	if (typeof window.__bwAnnDelete !== "function") {
		window.__bwAnnDelete = (id) => window.__bwAnnOut.push({ op: "delete", payload: { id } });
	}

	window.__bwAnn = { veil, closePanel, openPanel, setActive, isOpen: () => !!panel };
	return "injected";
}

function __bwPicker() {
	if (window.__bwPickerActive) return "already";
	const box = document.createElement("div");
	box.dataset.bwPickerBox = "1";
	Object.assign(box.style, {
		position: "absolute",
		pointerEvents: "none",
		zIndex: "2147483646",
		border: "1.5px solid " + window.__bw.accent(),
		background: window.__bw.fill(),
		borderRadius: window.__bw.style.radius,
		boxShadow: "0 0 0 3px " + window.__bw.fill(),
		display: "none",
	});
	document.documentElement.appendChild(box);
	const place = (el) => {
		const r = el.getBoundingClientRect();
		Object.assign(box.style, {
			display: "block",
			left: r.left + window.scrollX + "px",
			top: r.top + window.scrollY + "px",
			width: r.width + "px",
			height: r.height + "px",
		});
	};
	document.addEventListener(
		"mousemove",
		(e) => {
			const t = e.target;
			if (!t || t === box || (t.closest && t.closest("[data-bw-badge]"))) return;
			place(t);
		},
		true,
	);
	document.addEventListener(
		"click",
		(e) => {
			e.preventDefault();
			e.stopPropagation();
			const el = e.target;
			if (!el || (el.closest && el.closest("[data-bw-badge]"))) return;
			box.remove();
			window.__bwPickerActive = false;
			window.__bwPick = {
				selector: window.__bw.selector(el),
				tag: el.tagName.toLowerCase(),
				text: (el.innerText || el.textContent || "").trim().slice(0, 200),
				w: el.getBoundingClientRect().width,
				h: el.getBoundingClientRect().height,
			};
			window.__bw.paint(el);
			window.__bw.marks.push({ n: 1, selector: window.__bwPick.selector, note: "", el, badge: window.__bw.badge(1, el) });
		},
		true,
	);
	window.__bwPickerActive = true;
	return "injected";
}

/**
 * 页面运行时引导表达式：版本一致时早退，几乎零成本。
 * 版本不一致（CLI 升级、或页面里跑着旧逻辑）时清掉旧批注层并按新版重建，
 * 这样不必让用户手动刷新页面。
 */
function runtimeExpr() {
	const hotkey = readSettings().hotkey || "shift+a";
	return `(() => {
		if (window.__bwRuntimeV === ${RUNTIME_V} && window.__bwAnn) return "ok";
		if (!window.__bw) (${__bwInit.toString()})(${JSON.stringify(MARK_STYLE)});
		document.querySelectorAll("[data-bw-veil],[data-bw-panel],[data-bw-badge]").forEach((n) => n.remove());
		window.__bwAnn = null;
		window.__bwAnnActive = false;
		(${__bwAnnotator.toString()})();
		(${__bwHotkeys.toString()})(${JSON.stringify(hotkey)});
		window.__bwRuntimeV = ${RUNTIME_V};
		return "ok";
	})()`;
}

const injectRuntime = (cdp) => evaluate(cdp, runtimeExpr());

/* ==================================================================== */
/* state / util                                                          */
/* ==================================================================== */

function ensureDirs() {
	for (const d of [STATE_DIR, PROFILE_DIR, SHOT_DIR]) mkdirSync(d, { recursive: true });
}
function readState() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return {};
	}
}
function writeState(patch) {
	ensureDirs();
	const next = JSON.stringify({ ...readState(), ...patch }, null, 0);
	// 先写临时文件再 rename：并发命令与读取方永远不会看到半截 JSON
	const tmp = `${STATE_FILE}.${process.pid}.tmp`;
	writeFileSync(tmp, next);
	renameSync(tmp, STATE_FILE);
}

/**
 * 校验 pid 的 command line 是否含标记。
 * state.json 里的 pid 可能已被系统复用给别的进程（包括宿主），盲杀会误伤，所以先核对。
 */
function pidMatches(pid, marker) {
	if (!pid || process.platform === "win32") return false;
	try {
		return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).includes(marker);
	} catch {
		return false;
	}
}

/**
 * 截图清理：删除超过 TTL 且未被任何批注引用的截图。
 * 被 annotations.json 里 shot 字段引用的文件永远保留，否则批注里的图会变成断链。
 * 每次命令最多检查一次（间隔 1 小时），避免给每条命令加目录遍历开销。
 */
const SHOT_TTL_MS = Number(process.env.BW_SHOT_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);
const PRUNE_EVERY_MS = 60 * 60 * 1000;

function pruneShots(force = false) {
	if (!(SHOT_TTL_MS > 0)) return 0;
	const now = Date.now();
	const st = readState();
	if (!force && st.lastPruneAt && now - st.lastPruneAt < PRUNE_EVERY_MS) return 0;

	let names = [];
	try {
		names = readdirSync(SHOT_DIR);
	} catch {
		return 0;
	}

	const keep = new Set();
	try {
		const d = JSON.parse(readFileSync(ANN_FILE, "utf8"));
		for (const a of d.items ?? []) if (a.shot) keep.add(a.shot);
	} catch {}

	let removed = 0;
	for (const name of names) {
		const file = join(SHOT_DIR, name);
		if (keep.has(file)) continue;
		try {
			const s = statSync(file);
			if (!s.isFile() || now - s.mtimeMs < SHOT_TTL_MS) continue;
			unlinkSync(file);
			removed++;
		} catch {}
	}
	writeState({ lastPruneAt: now });
	return removed;
}

/** 仅当 pid 确实是目标进程时才发信号；非 win32 外的平台没有 ps，一律不动手 */
function killVerified(pid, marker) {
	if (!pidMatches(pid, marker)) return false;
	try {
		process.kill(pid);
		return true;
	} catch {
		return false;
	}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 跨进程互斥锁（基于 O_EXCL 原子创建）。
 * 用于 launch()：避免多个并发命令各自起一个 Chrome。
 * 拿不到锁就等，超时则放弃（让调用方走已有端口）。
 */
async function withLock(name, fn, { timeoutMs = 15000, staleMs = 20000 } = {}) {
	ensureDirs();
	const lockFile = join(STATE_DIR, `.${name}.lock`);
	const start = Date.now();
	let acquired = false;
	while (Date.now() - start < timeoutMs) {
		try {
			writeFileSync(lockFile, String(process.pid), { flag: "wx" });
			acquired = true;
			break;
		} catch {
			// 清理僵尸锁
			try {
				const st = statSync(lockFile);
				if (Date.now() - st.mtimeMs > staleMs) {
					writeFileSync(lockFile, String(process.pid));
					acquired = true;
					break;
				}
			} catch {}
			await sleep(80);
		}
	}
	if (!acquired) return { acquired: false, result: await fn() };
	try {
		return { acquired: true, result: await fn() };
	} finally {
		try {
			unlinkSync(lockFile);
		} catch {}
	}
}

function brief(s, n = MAX_TEXT) {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
}
function humanBytes(n) {
	if (!n || n < 0) return "-";
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
	return `${(n / 1024 / 1024).toFixed(1)}M`;
}

/* ==================================================================== */
/* CDP client                                                            */
/* ==================================================================== */

class CDP {
	constructor(wsUrl, { timeoutMs = 30_000 } = {}) {
		this.ws = new WebSocket(wsUrl);
		this.id = 0;
		this.pending = new Map();
		this.handlers = new Map();
		this.timeoutMs = timeoutMs;
	}
	async open() {
		await new Promise((res, rej) => {
			this.ws.addEventListener("open", res, { once: true });
			this.ws.addEventListener("error", () => rej(new Error("CDP 连接失败")), { once: true });
		});
		this.ws.addEventListener("message", (ev) => {
			let m;
			try {
				m = JSON.parse(ev.data);
			} catch {
				return;
			}
			if (m.id && this.pending.has(m.id)) {
				const { resolve, reject, timer } = this.pending.get(m.id);
				clearTimeout(timer);
				this.pending.delete(m.id);
				m.error ? reject(new Error(m.error.message)) : resolve(m.result);
				return;
			}
			if (m.method) {
				const list = this.handlers.get(m.method);
				if (list) for (const fn of list) fn(m.params, m.sessionId);
			}
		});
		return this;
	}
	on(method, fn) {
		if (!this.handlers.has(method)) this.handlers.set(method, []);
		this.handlers.get(method).push(fn);
	}
	send(method, params = {}, sessionId) {
		const id = ++this.id;
		const payload = { id, method, params };
		if (sessionId) payload.sessionId = sessionId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`${method} 超时`));
				}
			}, this.timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.ws.send(JSON.stringify(payload));
		});
	}
	close() {
		for (const { reject, timer } of this.pending.values()) {
			clearTimeout(timer);
			try {
				reject(new Error("closed"));
			} catch {}
		}
		this.pending.clear();
		try {
			this.ws.close();
		} catch {}
		this.ws.onmessage = null;
	}
}

/* ---------------- browser lifecycle ---------------- */

async function portAlive(port) {
	if (!port) return false;
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
		return res.ok;
	} catch {
		return false;
	}
}

async function browserWsUrl(port) {
	const res = await fetch(`http://127.0.0.1:${port}/json/version`);
	return (await res.json()).webSocketDebuggerUrl;
}

async function launch() {
	ensureDirs();
	const picked = resolveBrowser();
	if (!picked) throw new Error("找不到可用的 Chromium 系浏览器（bw browser <chrome|chromium|edge|brave>）");
	const chrome = picked.path;

	const port = 9200 + Math.floor(Math.random() * 500);
	const child = spawn(
		chrome,
		[
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${PROFILE_DIR}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-features=Translate",
			"--window-size=1280,900",
			"about:blank",
		],
		{ detached: true, stdio: "ignore" },
	);
	child.unref();
	for (let i = 0; i < 80; i++) {
		await sleep(120);
		if (await portAlive(port)) {
			// 必须同时续期 lastUsedAt：否则新起的浏览器带着上一次的陈旧时间戳，
			// 下一条命令立刻又判定「idle 超时」→ 关掉刚开的浏览器 → 再重启一次，
			// 表现就是 open 之后 shot/title 卡死、Chrome 停在 about:blank。
			writeState({ port, pid: child.pid, daemonPort: null, daemonPid: null, lastUsedAt: Date.now() });
			return port;
		}
	}
	throw new Error("Chrome 启动超时");
}

async function ensureBrowser() {
	const st = readState();
	if (await portAlive(st.port)) {
		// 每次使用都续期，供 idle 回收判断
		writeState({ lastUsedAt: Date.now() });
		return st.port;
	}
	// 脏 state：端口已死但记录了 pid
	if (st.port || st.pid || st.daemonPort) {
		writeState({ port: null, pid: null, daemonPort: null, daemonPid: null, activeTargetId: null, viewport: null });
	}
	// 并发保护：拿到锁的进程负责启动，其余等待后复用
	const { result } = await withLock("launch", async () => {
		const again = readState();
		if (await portAlive(again.port)) return again.port;
		return launch();
	});
	return result;
}

/** 回收 idle 太久的浏览器（默认 2 小时）。由任何 bw 命令顺带触发，不额外常驻进程。 */
async function reapIfIdle() {
	const st = readState();
	if (!st.port) return false;
	if (!(await portAlive(st.port))) return false;
	const idleMs = Number(process.env.BW_IDLE_MS ?? 2 * 60 * 60 * 1000);
	if (!st.lastUsedAt) return false;
	if (Date.now() - st.lastUsedAt < idleMs) return false;
	try {
		const wsUrl = await browserWsUrl(st.port);
		const b = await new CDP(wsUrl, { timeoutMs: 3000 }).open();
		await b.send("Browser.close").catch(() => {});
		b.close();
	} catch {}
	killVerified(st.daemonPid, "__daemon");
	writeState({ port: null, pid: null, daemonPort: null, daemonPid: null, activeTargetId: null, viewport: null });
	console.error("bw: 浏览器 idle 超时，已回收");
	return true;
}

async function listTargets(port) {
	const res = await fetch(`http://127.0.0.1:${port}/json/list`);
	return (await res.json()).filter((t) => t.type === "page");
}

async function activeTarget(port) {
	const pages = await listTargets(port);
	if (!pages.length) throw new Error("没有可用标签页");
	const st = readState();
	if (st.activeTargetId) {
		const hit = pages.find((p) => p.id === st.activeTargetId);
		if (hit) return hit;
	}
	if (typeof st.activeTab === "number" && pages[st.activeTab]) return pages[st.activeTab];
	return pages.find((p) => !p.url.startsWith("devtools://")) ?? pages[0];
}

async function connect(port) {
	const target = await activeTarget(port);
	const cdp = await new CDP(target.webSocketDebuggerUrl).open();
	await cdp.send("Page.enable");
	await cdp.send("Runtime.enable");
	// Emulation 覆盖是连接级状态，断开即失效；每次连上后按 state 重放
	const vp = readState().viewport;
	if (vp && vp.width) {
		try {
			await cdp.send("Emulation.setDeviceMetricsOverride", {
				width: vp.width,
				height: vp.height,
				deviceScaleFactor: vp.dpr ?? 1,
				mobile: !!vp.mobile,
			});
			if (vp.mobile) {
				await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
			}
		} catch {}
	}
	return { cdp, target };
}

/* ---------------- page helpers ---------------- */

/* frame 执行上下文缓存：cdp -> Map(frameId -> contextId) */
const frameCtxCache = new WeakMap();

/**
 * 解析当前 frame 目标。两种情形：
 *   A) 同进程 iframe（同站点）→ Page.getFrameTree 能看到，用 Page.createIsolatedWorld 取 contextId
 *   B) OOPIF（跨站点 iframe）→ getFrameTree 看不到，需 Target.getTargets 找 type:"iframe"，
 *      再 Target.attachToTarget 拿 sessionId，之后所有命令带 sessionId 发送
 * 返回 { kind: 'main'|'isolated'|'oopif', contextId?, sessionId?, frameId? }
 */
async function resolveFrame(cdp, override) {
	const frameUrl = override === "main" ? null : readState().frameUrl;
	if (!frameUrl) return { kind: "main" };

	// B) 先查 OOPIF
	try {
		const { targetInfos } = await cdp.send("Target.getTargets");
		const oopif = targetInfos.find((t) => t.type === "iframe" && (t.url ?? "").includes(frameUrl));
		if (oopif) {
			let cache = frameCtxCache.get(cdp);
			if (!cache) {
				cache = new Map();
				frameCtxCache.set(cdp, cache);
			}
			const key = `oopif:${oopif.targetId}`;
			if (!cache.has(key)) {
				const { sessionId } = await cdp.send("Target.attachToTarget", {
					targetId: oopif.targetId,
					flatten: true,
				});
				await cdp.send("Runtime.enable", {}, sessionId).catch(() => {});
				await cdp.send("Page.enable", {}, sessionId).catch(() => {});
				cache.set(key, { sessionId, targetId: oopif.targetId });
			}
			return { kind: "oopif", ...cache.get(key) };
		}
	} catch {}

	// A) 同进程 iframe
	const { frameTree } = await cdp.send("Page.getFrameTree");
	const all = [];
	const walk = (node) => {
		all.push(node.frame);
		for (const c of node.childFrames ?? []) walk(c);
	};
	walk(frameTree);
	const hit = all.find((f) => (f.url ?? "").includes(frameUrl));
	if (!hit) throw new Error(`找不到 iframe: ${frameUrl}（用 frames 查看，frame top 退出）`);
	let cache = frameCtxCache.get(cdp);
	if (!cache) {
		cache = new Map();
		frameCtxCache.set(cdp, cache);
	}
	if (!cache.has(hit.id)) {
		const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
			frameId: hit.id,
			worldName: "__bw_world",
		});
		cache.set(hit.id, executionContextId);
	}
	return { kind: "isolated", contextId: cache.get(hit.id), frameId: hit.id };
}

async function evaluate(cdp, expression, { awaitPromise = true, byValue = true, contextId, frameOverride } = {}) {
	const params = {
		expression,
		returnByValue: byValue,
		awaitPromise,
		userGesture: true,
	};
	const frame = await resolveFrame(cdp, frameOverride);
	if (frame.kind === "isolated") params.contextId = frame.contextId;
	const res = await cdp.send("Runtime.evaluate", params, frame.kind === "oopif" ? frame.sessionId : undefined);
	if (res.exceptionDetails) {
		const d = res.exceptionDetails;
		throw new Error((d.exception?.description ?? d.text ?? "页面异常").split("\n")[0]);
	}
	return res.result?.value;
}

function pageInfo(cdp) {
	return evaluate(cdp, "({url: location.href, title: document.title, ready: document.readyState})");
}

function waitLoad(cdp, timeoutMs = 15_000) {
	return new Promise((resolve) => {
		let done = false;
		const fin = () => {
			if (done) return;
			done = true;
			resolve();
		};
		cdp.on("Page.loadEventFired", fin);
		setTimeout(fin, timeoutMs);
	});
}

/** 等布局稳定：两帧 rAF 后确认尺寸不再变化，最多等 1s */
async function waitLayout(cdp, maxMs = 1000) {
	const deadline = Date.now() + maxMs;
	let prev = null;
	while (Date.now() < deadline) {
		const cur = await evaluate(
			cdp,
			`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() =>
				r(window.innerWidth + 'x' + window.innerHeight + ':' + document.body.scrollHeight))))`,
		);
		if (cur === prev) return cur;
		prev = cur;
		await sleep(80);
	}
	return prev;
}

/**
 * 计算当前 frame 在顶层页面中的累计偏移。
 * 关键点：OOPIF 的 <iframe> 元素归属父 frame，必须在父上下文里量；
 * 且 OOPIF 内 Input.dispatchMouseEvent 的坐标仍是顶层坐标系，
 * 所以这里给出的是「加多少能变顶层」的偏移量。
 */
async function frameOffset(cdp) {
	const frameUrl = readState().frameUrl;
	if (!frameUrl) return { x: 0, y: 0 };

	// 在顶层文档找 <iframe> 元素（不经过 resolveFrame 路由，直接顶层执行）
	const inTop = await evaluate(
		cdp,
		`(() => {
			const target = ${JSON.stringify(frameUrl)};
			for (const f of document.querySelectorAll('iframe,frame')) {
				if ((f.src || '').includes(target)) {
					const r = f.getBoundingClientRect();
					return { x: r.x, y: r.y };
				}
			}
			return null;
		})()`,
		{ frameOverride: "main" },
	);
	if (inTop) return inTop;

	// 同进程 iframe：DOM.getFrameOwner 逐层累加
	try {
		const { frameTree } = await cdp.send("Page.getFrameTree");
		let cur = null;
		const walk = (node) => {
			if ((node.frame.url ?? "").includes(frameUrl)) cur = node.frame.id;
			for (const c of node.childFrames ?? []) walk(c);
		};
		walk(frameTree);
		if (!cur) return { x: 0, y: 0 };
		let x = 0;
		let y = 0;
		await cdp.send("DOM.enable");
		for (let depth = 0; depth < 8 && cur; depth++) {
			const { frameTree: ft } = await cdp.send("Page.getFrameTree");
			let parentId = null;
			const find = (node, parent) => {
				if (node.frame.id === cur) {
					parentId = parent;
					return true;
				}
				for (const c of node.childFrames ?? []) if (find(c, node.frame.id)) return true;
				return false;
			};
			find(ft, null);
			if (!parentId) break;
			const { nodeId } = await cdp.send("DOM.getFrameOwner", { frameId: cur });
			const { model } = await cdp.send("DOM.getBoxModel", { nodeId });
			const c = model.content;
			x += Math.min(c[0], c[2], c[4], c[6]);
			y += Math.min(c[1], c[3], c[5], c[7]);
			cur = parentId;
		}
		return { x, y };
	} catch {
		return { x: 0, y: 0 };
	}
}

async function rectOf(cdp, selector) {
	const raw = await evaluate(
		cdp,
		`(() => {
			const el = document.querySelector(${JSON.stringify(selector)});
			if (!el) return null;
			if (!window.__bw) (${__bwInit.toString()})(${JSON.stringify(MARK_STYLE)});
			el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
			const r = el.getBoundingClientRect();
			return { x: r.x, y: r.y, w: r.width, h: r.height,
				sx: window.scrollX || 0, sy: window.scrollY || 0,
				cx: r.x + r.width / 2, cy: r.y + r.height / 2, visible: window.__bw.visible(el) };
		})()`,
	);
	return raw;
}

/* ---------------- input ---------------- */

const MODS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };
const KEYMAP = {
	enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
	tab: { key: "Tab", code: "Tab", vk: 9 },
	escape: { key: "Escape", code: "Escape", vk: 27 },
	esc: { key: "Escape", code: "Escape", vk: 27 },
	backspace: { key: "Backspace", code: "Backspace", vk: 8 },
	delete: { key: "Delete", code: "Delete", vk: 46 },
	space: { key: " ", code: "Space", vk: 32, text: " " },
	arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
	arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
	arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
	arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
	home: { key: "Home", code: "Home", vk: 36 },
	end: { key: "End", code: "End", vk: 35 },
	pageup: { key: "PageUp", code: "PageUp", vk: 33 },
	pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};

function parseKey(spec) {
	const parts = spec.split("+").map((p) => p.trim()).filter(Boolean);
	let modifiers = 0;
	let main = null;
	for (const p of parts) {
		const low = p.toLowerCase();
		if (MODS[low] !== undefined) modifiers |= MODS[low];
		else main = p;
	}
	if (!main) throw new Error(`无效按键: ${spec}`);
	const low = main.toLowerCase();
	if (KEYMAP[low]) return { ...KEYMAP[low], modifiers };
	if (main.length === 1) {
		const ch = main;
		const isUpper = ch !== ch.toLowerCase();
		const code = /[a-zA-Z]/.test(ch) ? `Key${ch.toUpperCase()}` : /[0-9]/.test(ch) ? `Digit${ch}` : "";
		return {
			key: ch,
			code,
			vk: ch.toUpperCase().charCodeAt(0),
			text: modifiers & (MODS.ctrl | MODS.meta) ? undefined : ch,
			modifiers: modifiers | (isUpper ? MODS.shift : 0),
		};
	}
	throw new Error(`不支持的按键: ${spec}`);
}

async function pressKey(cdp, spec, { times = 1 } = {}) {
	const k = parseKey(spec);
	for (let i = 0; i < times; i++) {
		await cdp.send("Input.dispatchKeyEvent", {
			type: k.text ? "keyDown" : "rawKeyDown",
			modifiers: k.modifiers,
			key: k.key,
			code: k.code,
			windowsVirtualKeyCode: k.vk,
			nativeVirtualKeyCode: k.vk,
			text: k.text,
			unmodifiedText: k.text,
		});
		await cdp.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			modifiers: k.modifiers,
			key: k.key,
			code: k.code,
			windowsVirtualKeyCode: k.vk,
			nativeVirtualKeyCode: k.vk,
		});
		await sleep(16);
	}
}

/** 当前 frame 对应的 CDP sessionId（OOPIF 需要，其余返回 undefined） */
async function frameSession(cdp) {
	const f = await resolveFrame(cdp);
	return f.kind === "oopif" ? f.sessionId : undefined;
}

async function mouseClick(cdp, rect, { button = "left", clickCount = 1 } = {}) {
	// 坐标统一换算到顶层页面坐标系，Input 事件一律发往顶层 target
	// （OOPIF session 上的 Input 坐标语义不一致，发顶层最稳）
	const off = await frameOffset(cdp);
	const base = { x: rect.cx + off.x, y: rect.cy + off.y, button, clickCount, modifiers: 0 };
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...base, button: "none", clickCount: 0 });
	await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
}

/* ==================================================================== */
/* daemon：常驻收集 console / network / dialog                          */
/* ==================================================================== */

const DAEMON_MAX_EVENTS = 3000;

async function daemonHealth(port) {
	if (!port) return null;
	try {
		const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(600) });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

async function ensureDaemon() {
	const st = readState();
	const alive = await daemonHealth(st.daemonPort);
	// 同一端口上的 daemon 若来自旧版 CLI（注入逻辑、事件缓冲等已变），直接换掉
	if (alive && alive.build === BUILD) return st.daemonPort;
	if (alive) killVerified(st.daemonPid, "__daemon");
	const port = 9600 + Math.floor(Math.random() * 300);
	const wsUrl = await browserWsUrl(st.port);
	const child = spawn(process.execPath, [SELF, "__daemon", wsUrl, String(port)], {
		detached: true,
		stdio: "ignore",
		// 在 Electron 主进程里 process.execPath 是宿主二进制；不设这个会拉起第二个宿主实例
		env: process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env,
	});
	child.unref();
	for (let i = 0; i < 50; i++) {
		await sleep(100);
		const h = await daemonHealth(port);
		if (h) {
			writeState({ daemonPort: port, daemonPid: child.pid });
			return port;
		}
	}
	return null;
}

async function daemonQuery(path) {
	const st = readState();
	const port = await ensureDaemon();
	if (!port) throw new Error("日志 daemon 不可用");
	const res = await fetch(`http://127.0.0.1:${port}${path}`);
	return await res.json();
}

async function runDaemon(wsUrl, port) {
	const { createServer } = await import("node:http");
	const events = [];
	const bodies = new Map(); // requestId -> { sessionId }
	let seq = 0;
	let browserCdp = null;

	const push = (ev) => {
		ev.seq = ++seq;
		ev.t = Date.now();
		events.push(ev);
		if (events.length > DAEMON_MAX_EVENTS) events.splice(0, events.length - DAEMON_MAX_EVENTS);
	};

	const textOfArgs = (args) =>
		(args ?? [])
			.map((a) => {
				if (a.type === "string") return a.value;
				if (a.value !== undefined) return String(a.value);
				return a.description ?? a.preview?.description ?? a.type;
			})
			.join(" ");


	browserCdp = await new CDP(wsUrl, { timeoutMs: 15_000 }).open();

	/**
	 * 注入页面运行时（marks 基础 + 热键 + 批注层）。
	 * 每次导航后重新注入（导航会销毁注入脚本）。
	 * 批注层必须一起注入：热键 handler 调用的 window.__bwAnnToggle 由它定义，
	 * 少了它，用户按热键不会有任何反应。批注层注入后默认隐藏，不干扰浏览。
	 */
	const injectMenu = async (sessionId) => {
		try {
			await browserCdp.send(
				"Runtime.evaluate",
				{ expression: runtimeExpr(), returnByValue: true, awaitPromise: false },
				sessionId,
			);
		} catch {}
	};

	browserCdp.on("Page.frameNavigated", async (p, sessionId) => {
		if (p.frame?.parentId) return;
		if (!sessionId) return;
		await sleep(180);
		await injectMenu(sessionId);
	});

	/** 已注册过 frame 按键桥的 session（导航会重建文档，脚本注册一次即可长期生效） */
	const bridgeRegistered = new Set();
	const injectFrameBridge = async (sessionId) => {
		if (bridgeRegistered.has(sessionId)) return;
		bridgeRegistered.add(sessionId);
		try {
			// runImmediately 让已存在的 frame 也立刻装上，不必等下次导航
			await browserCdp.send(
				"Page.addScriptToEvaluateOnNewDocument",
				{ source: `(${__bwFrameKeyBridge.toString()})()`, runImmediately: true },
				sessionId,
			);
		} catch {}
	};

	/** 给一个 session 打开所需域，并注入页面运行时 */
	const attach = async (sessionId, targetType) => {
		try {
			await browserCdp.send("Runtime.enable", {}, sessionId);
			await browserCdp.send("Log.enable", {}, sessionId);
			await browserCdp.send("Network.enable", {}, sessionId);
		} catch {}

		if (targetType === "iframe") {
			// 跨源 iframe 是独立 target：只装按键桥，不装批注层（批注层必须在顶层绘制）
			try {
				await browserCdp.send("Page.enable", {}, sessionId);
			} catch {}
			await injectFrameBridge(sessionId);
			return;
		}

		try {
			await browserCdp.send("Page.enable", {}, sessionId);
		} catch {}
		await injectMenu(sessionId);
		// 同进程子 frame（sandbox 等）走脚本注册，一次覆盖全部 frame
		await injectFrameBridge(sessionId);
	};

	// 只走 targetCreated 一条路径 attach。attachedToTarget 由我们自己 attach 时也会触发，
	// 两边都订阅会让同一条 console/network 事件重复入库，所以这里只记录、不再 attach。
	const attached = new Set();
	/** targetId -> sessionId，供批注 outbox 定时落盘遍历 */
	const sessionByTarget = new Map();
	/** targetId -> target 类型，区分 page 与 iframe 会话 */
	const sessionTypes = new Map();
	const attachOnce = async (targetId, targetType) => {
		if (attached.has(targetId)) return;
		attached.add(targetId);
		try {
			const r = await browserCdp.send("Target.attachToTarget", { targetId, flatten: true });
			sessionByTarget.set(targetId, r.sessionId);
			sessionTypes.set(targetId, targetType);
			await attach(r.sessionId, targetType);
		} catch {
			attached.delete(targetId);
			sessionByTarget.delete(targetId);
		}
	};

	/**
	 * 批注落盘心跳。
	 * 页面里的批注先进 outbox，过去要等下一条 bw 命令才写盘——用户批注完、
	 * agent 正在等待输入时，备注会一直卡在页面里，输入框永远收不到。
	 * 这里每 1.5s 扫一遍所有页面，让「按热键批注 → 输入框出现内容」立刻生效。
	 */
	const annFlushTimer = setInterval(() => {
		for (const [targetId, sessionId] of sessionByTarget) {
			if (!attached.has(targetId)) continue;
			if (sessionTypes.get(targetId) !== "page") continue;
			browserCdp
				.send("Runtime.evaluate", { expression: ANN_OUTBOX_EXPR, returnByValue: true }, sessionId)
				.then(async (r) => {
					const v = r?.result?.value;
					if (!v || !Array.isArray(v.o) || !v.o.length) return;
					const saved = await applyAnnEvents({ url: v.url, title: v.title, tabIndex: undefined }, v.o);
					for (const item of saved) {
						browserCdp
							.send("Runtime.evaluate", { expression: ANN_SYNC_EXPR(item), returnByValue: true }, sessionId)
							.catch(() => {});
					}
				})
				.catch(() => {});
		}
	}, 1500);
	annFlushTimer.unref?.();

	browserCdp.on("Target.targetCreated", async (p) => {
		const type = p.targetInfo.type;
		if (type !== "page" && type !== "iframe") return;
		await attachOnce(p.targetInfo.targetId, type);
	});
	browserCdp.on("Target.attachedToTarget", (p) => {
		if (p.targetInfo?.targetId) attached.add(p.targetInfo.targetId);
	});
	browserCdp.on("Target.targetDestroyed", (p) => {
		attached.delete(p.targetId);
		sessionByTarget.delete(p.targetId);
		sessionTypes.delete(p.targetId);
		push({ kind: "tab", action: "closed", targetId: p.targetId });
	});

	browserCdp.on("Runtime.consoleAPICalled", (p) => {
		push({ kind: "console", level: p.type, text: brief(textOfArgs(p.args), 300) });
	});
	browserCdp.on("Runtime.exceptionThrown", (p) => {
		const d = p.exceptionDetails;
		const text = d?.exception?.description ?? d?.text ?? "exception";
		push({ kind: "console", level: "error", text: brief(text.split("\n")[0], 300), source: d?.url });
	});
	browserCdp.on("Log.entryAdded", (p) => {
		const e = p.entry;
		if (!e) return;
		push({ kind: "console", level: e.level, text: brief(e.text, 300), source: e.url });
	});
	browserCdp.on("Network.requestWillBeSent", (p) => {
		push({
			kind: "net",
			phase: "req",
			requestId: p.requestId,
			method: p.request?.method,
			url: p.request?.url,
			type: p.type,
			headers: p.request?.headers,
		});
	});
	browserCdp.on("Network.responseReceived", (p) => {
		bodies.set(p.requestId, { sessionId: p.__sessionId });
		push({
			kind: "net",
			phase: "res",
			requestId: p.requestId,
			url: p.response?.url,
			status: p.response?.status,
			mime: p.response?.mimeType,
			size: p.response?.encodedDataLength,
			type: p.type,
			headers: p.response?.headers,
		});
	});
	browserCdp.on("Network.loadingFailed", (p) => {
		push({
			kind: "net",
			phase: "fail",
			requestId: p.requestId,
			errorText: p.errorText,
			canceled: p.canceled,
		});
	});
	browserCdp.on("Page.frameNavigated", (p) => {
		if (p.frame?.parentId) return;
		push({ kind: "nav", url: p.frame?.url });
	});
	let dialogPolicy = readState().dialogPolicy ?? "accept";
	browserCdp.on("Page.javascriptDialogOpening", async (p, sessionId) => {
		push({ kind: "dialog", dialogType: p.type, message: brief(p.message, 200) });
		if (dialogPolicy === "manual") return;
		try {
			await browserCdp.send(
				"Page.handleJavaScriptDialog",
				{ accept: dialogPolicy === "accept" },
				sessionId,
			);
		} catch {}
	});

	// 现有 target 也接上
	try {
		await browserCdp.send("Target.setDiscoverTargets", { discover: true });
		const { targetInfos } = await browserCdp.send("Target.getTargets");
		for (const t of targetInfos) {
			if (t.type !== "page" && t.type !== "iframe") continue;
			await attachOnce(t.targetId, t.type);
		}
	} catch {}

	const server = createServer(async (req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const json = (obj, code = 200) => {
			res.writeHead(code, { "content-type": "application/json" });
			res.end(JSON.stringify(obj));
		};
		try {
			if (url.pathname === "/health") return json({ ok: true, seq, events: events.length, build: BUILD });
			if (url.pathname === "/events") {
				const since = Number(url.searchParams.get("since") ?? 0);
				const kind = url.searchParams.get("kind");
				const limit = Number(url.searchParams.get("limit") ?? 200);
				let out = events.filter((e) => e.seq > since);
				if (kind && kind !== "all") {
					const kinds = kind.split(",");
					out = out.filter((e) => kinds.includes(e.kind) || (kinds.includes("net") && e.kind === "net"));
				}
				return json({ seq, events: out.slice(-limit) });
			}
			if (url.pathname === "/policy") {
				const p = url.searchParams.get("dialog");
				if (p) dialogPolicy = p;
				return json({ ok: true, dialog: dialogPolicy });
			}
			if (url.pathname === "/clear" && req.method === "POST") {
				events.length = 0;
				return json({ ok: true });
			}
			if (url.pathname === "/body") {
				const requestId = url.searchParams.get("requestId");
				const meta = bodies.get(requestId);
				if (!meta) return json({ error: "body 不可用（已过期或未记录）" }, 404);
				const r = await browserCdp.send("Network.getResponseBody", { requestId }, meta.sessionId);
				return json({ body: r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body });
			}
			return json({ error: "not found" }, 404);
		} catch (err) {
			return json({ error: String(err.message ?? err) }, 500);
		}
	});

	server.listen(port, "127.0.0.1");

	const shutdown = () => {
		try {
			server.close();
		} catch {}
		try {
			browserCdp?.close();
		} catch {}
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	// 浏览器没了就退出
	setInterval(async () => {
		try {
			await browserCdp.send("Browser.getVersion");
		} catch {
			shutdown();
		}
	}, 5000);
}

/* ==================================================================== */
/* commands                                                              */
/* ==================================================================== */

async function withPage(fn) {
	const port = await ensureBrowser();
	await ensureDaemon();
	const { cdp, target } = await connect(port);
	try {
		// 每个命令都确保页面里是当前版本的注入代码（版本一致时是一次早退）
		await injectRuntime(cdp).catch(() => {});
		return await fn(cdp, port, target);
	} finally {
		cdp.close();
	}
}

const nav = async (cdp, url) => {
	if (!/^[a-z]+:\/\//i.test(url) && !url.startsWith("about:") && !url.startsWith("data:")) {
		url = `http://${url}`;
	}
	const loaded = waitLoad(cdp);
	await cdp.send("Page.navigate", { url });
	await loaded;
	await sleep(200);
};

async function cmdOpen(url, opts) {
	return withPage(async (cdp, port) => {
		const before = (await daemonQuery("/health")).seq;
		if (opts.newTab) {
			const wsUrl = await browserWsUrl(port);
			const b = await new CDP(wsUrl).open();
			const r = await b.send("Target.createTarget", {
				url: /^[a-z]+:\/\//i.test(url) ? url : `http://${url}`,
			});
			b.close();
			const pages = await listTargets(port);
			const t = pages.find((p) => p.id === r.targetId);
			if (t) writeState({ activeTargetId: t.id });
			console.log(`ok new-tab ${url}`);
			return;
		}
		await nav(cdp, url);
		const info = await pageInfo(cdp);
		const { events } = await daemonQuery(`/events?since=${before}&kind=console,net&limit=200`);
		const errs = events.filter(
			(e) =>
				(e.kind === "console" && (e.level === "error" || e.level === "warning")) ||
				(e.kind === "net" && e.phase === "fail" && !e.canceled),
		);
		const head = `ok ${info.ready} "${brief(info.title, 60)}" ${info.url}`;
		console.log(errs.length ? `${head} | ${errs.length} issue: ${summarizeIssues(errs)}` : `${head} | clean`);
	});
}

function summarizeIssues(events) {
	return events
		.slice(0, 6)
		.map((e) => {
			if (e.kind === "net") return `NET ${e.errorText}`;
			return `${e.level === "error" ? "E" : "W"} ${brief(e.text, 100)}`;
		})
		.join(" ; ");
}

async function cmdReload() {
	return withPage(async (cdp) => {
		const loaded = waitLoad(cdp);
		await cdp.send("Page.reload", {});
		await loaded;
		const info = await pageInfo(cdp);
		console.log(`ok reload ${info.url}`);
	});
}

async function cmdHistory(dir) {
	return withPage(async (cdp) => {
		const h = await cdp.send("Page.getNavigationHistory");
		const target = dir === "back" ? h.entries[h.currentIndex - 1] : h.entries[h.currentIndex + 1];
		if (!target) throw new Error(`没有${dir === "back" ? "上一页" : "下一页"}`);
		const loaded = waitLoad(cdp);
		await cdp.send("Page.navigateToHistoryEntry", { entryId: target.id });
		await loaded;
		const info = await pageInfo(cdp);
		console.log(`ok ${dir} ${info.url}`);
	});
}

async function cmdClick(selector, opts) {
	return withPage(async (cdp) => {
		const r = await rectOf(cdp, selector);
		if (!r) throw new Error(`找不到元素: ${selector}`);
		if (!r.visible) throw new Error(`元素不可见: ${selector}`);
		const before = (await pageInfo(cdp)).url;
		const loaded = waitLoad(cdp, 6000);
		if (opts.js) {
			await evaluate(cdp, `document.querySelector(${JSON.stringify(selector)}).click()`);
		} else {
			await mouseClick(cdp, r, { button: opts.button ?? "left", clickCount: opts.count ?? 1 });
		}
		await loaded;
		await sleep(180);
		const after = await pageInfo(cdp);
		console.log(`ok click${after.url !== before ? ` → ${after.url}` : ""}`);
	});
}

async function cmdHover(selector) {
	return withPage(async (cdp) => {
		const r = await rectOf(cdp, selector);
		if (!r) throw new Error(`找不到元素: ${selector}`);
		await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.cx, y: r.cy, button: "none" });
		await sleep(120);
		console.log("ok hover");
	});
}

async function cmdFocus(selector, blur = false) {
	return withPage(async (cdp) => {
		const ok = await evaluate(
			cdp,
			`(() => { const el = document.querySelector(${JSON.stringify(selector)});
			   if (!el) return false; el.${blur ? "blur" : "focus"}(); return true; })()`,
		);
		if (!ok) throw new Error(`找不到元素: ${selector}`);
		console.log(`ok ${blur ? "blur" : "focus"}`);
	});
}

async function cmdType(selector, text) {
	return withPage(async (cdp) => {
		await injectRuntime(cdp);
		const res = await evaluate(
			cdp,
			`(() => {
				const el = document.querySelector(${JSON.stringify(selector)});
				if (!el) return 'notfound';
				el.focus();
				const isForm = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
				if (isForm) {
					const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
					const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
					setter ? setter.call(el, ${JSON.stringify(text)}) : (el.value = ${JSON.stringify(text)});
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
					return 'form';
				}
				if (el.isContentEditable) {
					el.textContent = ${JSON.stringify(text)};
					el.dispatchEvent(new InputEvent('input', { bubbles: true }));
					return 'editable';
				}
				return 'other';
			})()`,
		);
		if (res === "notfound") throw new Error(`找不到元素: ${selector}`);
		console.log(`ok type "${brief(text, 50)}" (${res})`);
	});
}

async function cmdKeys(text) {
	return withPage(async (cdp) => {
		await cdp.send("Input.insertText", { text });
		console.log(`ok keys "${brief(text, 50)}"`);
	});
}

async function cmdPress(spec, opts) {
	return withPage(async (cdp) => {
		await pressKey(cdp, spec, { times: opts.times ?? 1 });
		console.log(`ok press ${spec}${opts.times > 1 ? ` x${opts.times}` : ""}`);
	});
}

async function cmdSelect(selector, value) {
	return withPage(async (cdp) => {
		const res = await evaluate(
			cdp,
			`(() => {
				const el = document.querySelector(${JSON.stringify(selector)});
				if (!el) return 'notfound';
				if (el.tagName !== 'SELECT') return 'notselect';
				const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
				setter ? setter.call(el, ${JSON.stringify(value)}) : (el.value = ${JSON.stringify(value)});
				el.dispatchEvent(new Event('input', { bubbles: true }));
				el.dispatchEvent(new Event('change', { bubbles: true }));
				return el.value;
			})()`,
		);
		if (res === "notfound") throw new Error(`找不到元素: ${selector}`);
		if (res === "notselect") throw new Error("不是 <select>");
		console.log(`ok select ${res}`);
	});
}

async function cmdCheck(selector, checked) {
	return withPage(async (cdp) => {
		const res = await evaluate(
			cdp,
			`(() => {
				const el = document.querySelector(${JSON.stringify(selector)});
				if (!el) return 'notfound';
				const want = ${checked};
				if (el.checked === want) return 'nochange';
				el.click();
				return el.checked ? 'checked' : 'unchecked';
			})()`,
		);
		if (res === "notfound") throw new Error(`找不到元素: ${selector}`);
		console.log(`ok ${res}`);
	});
}

async function cmdScroll(arg) {
	return withPage(async (cdp) => {
		if (!arg) {
			await evaluate(cdp, "window.scrollBy(0, Math.round(window.innerHeight * 0.85)); 0");
			console.log("ok scroll down");
			return;
		}
		if (arg === "top" || arg === "bottom") {
			await evaluate(
				cdp,
				`window.scrollTo({ top: ${arg === "top" ? 0 : "document.documentElement.scrollHeight"}, behavior: 'instant' }); 0`,
			);
			console.log(`ok scroll ${arg}`);
			return;
		}
		if (/^-?\d+$/.test(arg)) {
			await evaluate(cdp, `window.scrollTo({ top: ${Number(arg)}, behavior: 'instant' }); 0`);
			console.log(`ok scroll ${arg}`);
			return;
		}
		const ok = await evaluate(
			cdp,
			`(() => { const el = document.querySelector(${JSON.stringify(arg)});
			   if (!el) return false; el.scrollIntoView({ block: 'center' }); return true; })()`,
		);
		if (!ok) throw new Error(`找不到元素: ${arg}`);
		console.log("ok scroll into view");
	});
}

async function cmdDrag(from, to) {
	return withPage(async (cdp) => {
		const a = await rectOf(cdp, from);
		const b = await rectOf(cdp, to);
		if (!a || !b) throw new Error(`找不到元素: ${!a ? from : to}`);
		await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.cx, y: a.cy, button: "none" });
		await cdp.send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: a.cx,
			y: a.cy,
			button: "left",
			clickCount: 1,
		});
		const steps = 8;
		for (let i = 1; i <= steps; i++) {
			await cdp.send("Input.dispatchMouseEvent", {
				type: "mouseMoved",
				x: a.cx + ((b.cx - a.cx) * i) / steps,
				y: a.cy + ((b.cy - a.cy) * i) / steps,
				button: "left",
				buttons: 1,
			});
			await sleep(20);
		}
		await cdp.send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x: b.cx,
			y: b.cy,
			button: "left",
			clickCount: 1,
		});
		console.log("ok drag");
	});
}

async function cmdUpload(selector, files) {
	return withPage(async (cdp) => {
		const abs = files.map((f) => (f.startsWith("/") ? f : join(process.cwd(), f)));
		for (const f of abs) {
			if (!existsSync(f)) throw new Error(`文件不存在: ${f}`);
		}
		await cdp.send("DOM.enable");
		const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
		const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
		if (!nodeId) throw new Error(`找不到元素: ${selector}`);
		await cdp.send("DOM.setFileInputFiles", { nodeId, files: abs });
		console.log(`ok upload ${abs.length} file(s)`);
	});
}

/* ---------------- wait / assert ---------------- */

async function waitFor(cdp, predicate, timeoutMs, interval = 120) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(cdp, predicate)) return true;
		await sleep(interval);
	}
	return false;
}

async function cmdWait(selector, opts) {
	return withPage(async (cdp) => {
		await injectRuntime(cdp);
		const t = opts.timeout ?? 10_000;
		let pred;
		if (opts.gone) {
			pred = `!document.querySelector(${JSON.stringify(selector)})`;
		} else if (opts.visible) {
			pred = `(() => { const el = document.querySelector(${JSON.stringify(selector)});
			   return !!el && window.__bw.visible(el); })()`;
		} else {
			pred = `!!document.querySelector(${JSON.stringify(selector)})`;
		}
		const ok = await waitFor(cdp, pred, t);
		if (!ok) throw new Error(`等待超时 ${t}ms: ${selector}`);
		console.log(`ok wait ${selector}`);
	});
}

async function cmdWaitText(selector, text, opts) {
	return withPage(async (cdp) => {
		const t = opts.timeout ?? 10_000;
		const ok = await waitFor(
			cdp,
			`(() => { const el = document.querySelector(${JSON.stringify(selector)});
			   if (!el) return false;
			   return ((el.innerText || el.textContent || '').includes(${JSON.stringify(text)})); })()`,
			t,
		);
		if (!ok) throw new Error(`等待文本超时 ${t}ms: ${selector} ⊃ "${text}"`);
		console.log(`ok wait-text "${brief(text, 40)}"`);
	});
}

async function cmdWaitIdle(opts) {
	return withPage(async (cdp) => {
		const t = opts.timeout ?? 10_000;
		const start = Date.now();
		let last = -1;
		let stable = 0;
		while (Date.now() - start < t) {
			const n = await evaluate(cdp, "performance.getEntriesByType('resource').length");
			if (n === last) {
				stable += 150;
				if (stable >= 600) {
					console.log("ok idle");
					return;
				}
			} else {
				last = n;
				stable = 0;
			}
			await sleep(150);
		}
		throw new Error(`网络未在 ${t}ms 内空闲`);
	});
}

async function cmdAssert(kind, args, opts) {
	return withPage(async (cdp) => {
		await injectRuntime(cdp);
		let pass = false;
		let detail = "";
		const [selector, expected] = args;
		if (kind === "visible") {
			pass = await evaluate(
				cdp,
				`(() => { const el = document.querySelector(${JSON.stringify(selector)});
				   return !!el && window.__bw.visible(el); })()`,
			);
			detail = `visible(${selector})`;
		} else if (kind === "text") {
			const actual = await evaluate(
				cdp,
				`(() => { const el = document.querySelector(${JSON.stringify(selector)});
				   return el ? (el.innerText || el.textContent || '') : null; })()`,
			);
			pass = actual !== null && actual.includes(expected);
			detail = `text(${selector}) ⊃ "${expected}"${pass ? "" : ` — 实际: "${brief(actual ?? "(无元素)", 120)}"`}`;
		} else if (kind === "count") {
			const n = await evaluate(cdp, `document.querySelectorAll(${JSON.stringify(selector)}).length`);
			pass = n === Number(expected);
			detail = `count(${selector}) == ${expected} — 实际 ${n}`;
		} else if (kind === "value") {
			const v = await evaluate(
				cdp,
				`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.value : null; })()`,
			);
			pass = v === expected;
			detail = `value(${selector}) == "${expected}" — 实际 "${v}"`;
		} else if (kind === "hidden") {
			pass = await evaluate(
				cdp,
				`(() => { const el = document.querySelector(${JSON.stringify(selector)});
				   return !el || !window.__bw.visible(el); })()`,
			);
			detail = `hidden(${selector})`;
		}
		if (!pass) {
			console.error(`FAIL ${detail}`);
			process.exit(1);
		}
		console.log(`ok ${detail}`);
	});
}

/* ---------------- query ---------------- */

async function cmdText(selector) {
	return withPage(async (cdp) => {
		const sel = selector ?? "body";
		const v = await evaluate(
			cdp,
			`(() => { const el = document.querySelector(${JSON.stringify(sel)});
			   return el ? (el.innerText || el.textContent || '') : null; })()`,
		);
		if (v === null) throw new Error(`找不到元素: ${sel}`);
		console.log(brief(v));
	});
}

async function cmdHtml(selector, opts) {
	return withPage(async (cdp) => {
		const sel = selector ?? "body";
		const v = await evaluate(
			cdp,
			`(() => { const el = document.querySelector(${JSON.stringify(sel)});
			   if (!el) return null; return ${opts.outer ? "el.outerHTML" : "el.innerHTML"}; })()`,
		);
		if (v === null) throw new Error(`找不到元素: ${sel}`);
		console.log(brief(v, opts.max ?? 1500));
	});
}

async function cmdAttr(selector, name) {
	return withPage(async (cdp) => {
		const v = await evaluate(
			cdp,
			`(() => { const el = document.querySelector(${JSON.stringify(selector)});
			   return el ? el.getAttribute(${JSON.stringify(name)}) : null; })()`,
		);
		if (v === null) throw new Error(`元素不存在或无该属性: ${selector} [${name}]`);
		console.log(v);
	});
}

async function cmdStyle(selector, prop) {
	return withPage(async (cdp) => {
		const v = await evaluate(
			cdp,
			`(() => { const el = document.querySelector(${JSON.stringify(selector)});
			   if (!el) return null; const cs = getComputedStyle(el);
			   return ${prop ? `cs.getPropertyValue(${JSON.stringify(prop)})` : "JSON.stringify({display:cs.display,color:cs.color,fontSize:cs.fontSize,backgroundColor:cs.backgroundColor,width:cs.width,height:cs.height})"}; })()`,
		);
		if (v === null) throw new Error(`找不到元素: ${selector}`);
		console.log(brief(v, 300));
	});
}

async function cmdBox(selector) {
	return withPage(async (cdp) => {
		const r = await evaluate(
			cdp,
			`(() => { const el = document.querySelector(${JSON.stringify(selector)});
			   if (!el) return null; const r = el.getBoundingClientRect();
			   return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
			            docY: Math.round(r.y + window.scrollY) }; })()`,
		);
		if (!r) throw new Error(`找不到元素: ${selector}`);
		const off = await frameOffset(cdp);
		const inFrame = !!(readState().frameUrl);
		console.log(
			`${r.w}x${r.h} at (${Math.round(r.x)},${Math.round(r.y)}) docY=${r.docY}` +
				(inFrame && (off.x || off.y) ? ` [top: ${Math.round(r.x + off.x)},${Math.round(r.y + off.y)}]` : ""),
		);
	});
}

async function cmdCount(selector) {
	return withPage(async (cdp) => {
		const n = await evaluate(cdp, `document.querySelectorAll(${JSON.stringify(selector)}).length`);
		console.log(String(n));
	});
}

async function cmdFind(text) {
	return withPage(async (cdp) => {
		await injectRuntime(cdp);
		const hits = await evaluate(
			cdp,
			`(() => {
				const needle = ${JSON.stringify(text)}.toLowerCase();
				const out = [];
				const all = document.querySelectorAll('body *');
				for (const el of all) {
					if (el.children.length > 3) continue;
					const t = (el.innerText || el.textContent || '').trim();
					if (!t || t.length > 200) continue;
					if (!t.toLowerCase().includes(needle)) continue;
					if (el.closest('[data-bw-badge]')) continue;
					const r = el.getBoundingClientRect();
					if (r.width <= 0 || r.height <= 0) continue;
					out.push({ sel: window.__bw.selector(el), tag: el.tagName.toLowerCase(), text: t.slice(0, 80) });
					if (out.length >= 20) break;
				}
				return out;
			})()`,
		);
		if (!hits?.length) {
			console.log("(no match)");
			return;
		}
		for (const h of hits) console.log(`${h.sel}  ${h.tag}  "${brief(h.text, 60)}"`);
	});
}

async function cmdEval(expression) {
	return withPage(async (cdp) => {
		const v = await evaluate(cdp, expression);
		console.log(typeof v === "string" ? brief(v) : JSON.stringify(v ?? null));
	});
}

async function cmdTitle() {
	return withPage(async (cdp) => {
		const i = await pageInfo(cdp);
		console.log(`${i.title} — ${i.url}`);
	});
}

/* ---------------- logs ---------------- */

function fmtConsole(e) {
	const lv = e.level === "error" ? "E" : e.level === "warning" ? "W" : e.level === "info" ? "I" : "D";
	return `${lv} ${brief(e.text, 200)}${e.source ? `  @${brief(e.source.replace(/^https?:\/\/[^/]+/, ""), 60)}` : ""}`;
}

async function cmdConsole(opts) {
	const kind = opts.errors ? "console" : "console";
	const { events } = await daemonQuery(`/events?kind=${kind}&limit=${opts.limit ?? 60}`);
	let list = events;
	if (opts.errors) list = list.filter((e) => e.level === "error");
	if (opts.filter) list = list.filter((e) => (e.text ?? "").includes(opts.filter));
	if (!list.length) {
		console.log("(empty)");
		return;
	}
	for (const e of list) console.log(fmtConsole(e));
}

async function cmdNet(opts) {
	const { events } = await daemonQuery(`/events?kind=net&limit=${opts.limit ?? 200}`);
	const res = events.filter((e) => e.phase === "res");
	const fails = events.filter((e) => e.phase === "fail" && !e.canceled);
	const reqs = events.filter((e) => e.phase === "req");
	const statusOf = new Map(res.map((e) => [e.requestId, e]));
	const failOf = new Map(fails.map((e) => [e.requestId, e]));

	let rows = reqs.map((r) => {
		const res = statusOf.get(r.requestId);
		const fail = failOf.get(r.requestId);
		return {
			method: r.method,
			url: r.url,
			status: res?.status ?? (fail ? "FAIL" : "…"),
			mime: res?.mime ?? "",
			size: res?.size ?? 0,
			error: fail?.errorText,
			requestId: r.requestId,
		};
	});
	if (opts.fail) rows = rows.filter((r) => r.status === "FAIL" || (typeof r.status === "number" && r.status >= 400));
	if (opts.filter) rows = rows.filter((r) => (r.url ?? "").includes(opts.filter));
	if (!rows.length) {
		console.log("(empty)");
		return;
	}
	for (const r of rows.slice(-(opts.limit ?? 40))) {
		const st = String(r.status).padEnd(4);
		console.log(`${st} ${String(r.method).padEnd(4)} ${humanBytes(r.size).padStart(6)} ${shortUrl(r.url)}${r.error ? ` !${r.error}` : ""}`);
	}
}

function shortUrl(u) {
	try {
		const x = new URL(u);
		const p = x.pathname + x.search;
		return brief(`${x.host}${p}`, 110);
	} catch {
		return brief(u, 110);
	}
}

async function cmdNetBody(idOrUrl) {
	const { events } = await daemonQuery("/events?kind=net&limit=500");
	const reqs = events.filter((e) => e.phase === "req");
	let hit = reqs.find((e) => e.requestId === idOrUrl);
	if (!hit) hit = [...reqs].reverse().find((e) => (e.url ?? "").includes(idOrUrl));
	if (!hit) throw new Error("找不到该请求");
	const { body, error } = await daemonQuery(`/body?requestId=${encodeURIComponent(hit.requestId)}`);
	if (error) throw new Error(error);
	console.log(brief(body, 3000));
}

async function cmdClearLogs() {
	await daemonQuery("/clear");
	console.log("ok clear-logs");
}

/* ---------------- screenshot / pdf ---------------- */

async function cmdShot(outPath, opts) {
	return withPage(async (cdp) => {
		await injectRuntime(cdp);
		if (opts.width) {
			// 临时视口：只影响本次截图，不写入 state
			await cdp.send("Emulation.setDeviceMetricsOverride", {
				width: Number(opts.width),
				height: opts.height ? Number(opts.height) : 900,
				deviceScaleFactor: 1,
				mobile: false,
			});
			await waitLayout(cdp);
		}

		// 后台标签页的合成层会停在旧帧，先拉到前台
		await cdp.send("Page.bringToFront").catch(() => {});
		// 等两帧，确保滚动/动画后的状态已经提交
		await evaluate(
			cdp,
			"new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))",
		).catch(() => {});

		const m = await evaluate(
			cdp,
			`({
				dpr: window.devicePixelRatio || 1,
				sx: window.scrollX || 0,
				sy: window.scrollY || 0,
				vw: window.innerWidth || document.documentElement.clientWidth,
				vh: window.innerHeight,
				docW: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
				docH: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
			})`,
		);

		// clip 一律用「页面坐标」。配合 captureBeyondViewport 才能抓到滚动后的真实内容：
		// fromSurface 的纯视口截取会返回滚动前/未提交的旧合成层（截出来是空白或只有底色）。
		let clip;
		if (opts.selector) {
			const r = await rectOf(cdp, opts.selector);
			if (!r) throw new Error(`找不到元素: ${opts.selector}`);
			const pad = 12;
			clip = {
				x: Math.max(0, r.x + r.sx - pad),
				y: Math.max(0, r.y + r.sy - pad),
				width: r.w + pad * 2,
				height: r.h + pad * 2,
				scale: 1,
			};
		} else if (opts.full) {
			clip = { x: 0, y: 0, width: m.docW, height: Math.min(m.docH, MAX_FULL_H), scale: 1 };
		} else if (opts.viewport) {
			clip = { x: m.sx, y: m.sy, width: m.vw, height: m.vh, scale: 1 };
		} else {
			// 默认：能整页就整页，太长则截当前视口
			clip =
				m.docH <= MAX_FULL_H
					? { x: 0, y: 0, width: m.docW, height: m.docH, scale: 1 }
					: { x: m.sx, y: m.sy, width: m.vw, height: m.vh, scale: 1 };
		}

		const format = opts.png ? "png" : "jpeg";
		const params = { format, clip, captureBeyondViewport: true };
		if (!opts.png) params.quality = 80;
		const res = await cdp.send("Page.captureScreenshot", params);

		ensureDirs();
		const ext = opts.png ? "png" : "jpg";
		const file = outPath ?? join(SHOT_DIR, `shot-${Date.now()}.${ext}`);
		writeFileSync(file, Buffer.from(res.data, "base64"));
		// 输出真实像素尺寸（Retina 上 clip * dpr），避免和实际文件尺寸对不上
		console.log(`${file} ${Math.round(clip.width * m.dpr)}x${Math.round(clip.height * m.dpr)}`);
	});
}

async function cmdPdf(outPath) {
	return withPage(async (cdp) => {
		const res = await cdp.send("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
		ensureDirs();
		const file = outPath ?? join(SHOT_DIR, `page-${Date.now()}.pdf`);
		writeFileSync(file, Buffer.from(res.data, "base64"));
		console.log(file);
	});
}

/* ---------------- annotate ---------------- */

async function cmdPick(timeoutSec = 60) {
	return withPage(async (cdp) => {
		await injectRuntime(cdp);
		await evaluate(cdp, `(${__bwPicker.toString()})()`);
		process.stderr.write(`选元素中…（${timeoutSec}s 内点击页面）\n`);
		const deadline = Date.now() + timeoutSec * 1000;
		let picked = null;
		while (Date.now() < deadline) {
			picked = await evaluate(cdp, "window.__bwPick ?? null", { awaitPromise: false });
			if (picked) break;
			await sleep(150);
		}
		if (!picked) throw new Error("选元素超时");
		console.log(
			`${picked.selector} ${picked.tag} "${brief(picked.text, 60)}" ${Math.round(picked.w)}x${Math.round(picked.h)}`,
		);
	});
}

async function cmdMark(selector, note) {
	return withPage(async (cdp) => {
		await injectRuntime(cdp);
		const res = await evaluate(
			cdp,
			`(() => {
				const el = document.querySelector(${JSON.stringify(selector)});
				if (!el) return null;
				const bw = window.__bw;
				const dup = bw.marks.find((m) => m.el === el);
				if (dup) { bw.sync(); return { n: dup.n, tag: el.tagName.toLowerCase(),
					text: (el.innerText || '').slice(0, 80), dup: true }; }
				el.scrollIntoView({ block: 'center', inline: 'nearest' });
				const n = bw.marks.length + 1;
				bw.paint(el);
				bw.marks.push({ n, selector: ${JSON.stringify(selector)}, note: ${JSON.stringify(note)}, el, badge: bw.badge(n, el) });
				return { n, tag: el.tagName.toLowerCase(), text: (el.innerText || '').slice(0, 80) };
			})()`,
		);
		if (!res) throw new Error(`找不到元素: ${selector}`);
		const head = res.dup ? `#${res.n} (已有)` : `#${res.n} ${selector} ${res.tag} "${brief(res.text, 50)}"`;
		console.log(note ? `${head} — ${brief(note, 80)}` : head);
	});
}

async function cmdMarks() {
	return withPage(async (cdp) => {
		const marks = await evaluate(
			cdp,
			"((window.__bw && window.__bw.marks) || []).map(m => ({ n: m.n, selector: m.selector, note: m.note }))",
		);
		if (!marks?.length) {
			console.log("(none)");
			return;
		}
		for (const m of marks) console.log(`#${m.n} ${m.selector}${m.note ? ` — ${brief(m.note, 60)}` : ""}`);
	});
}

async function cmdClear() {
	return withPage(async (cdp) => {
		await evaluate(
			cdp,
			`(() => {
				const bw = window.__bw;
				if (bw) {
					for (const m of bw.marks) { bw.unpaint(m.el); m.badge.remove(); }
					bw.marks.length = 0;
					bw.stopSync();
				}
				document.querySelectorAll('[data-bw-badge],[data-bw-picker-box]').forEach(n => n.remove());
				window.__bwPick = null;
				return true;
			})()`,
		);
		console.log("ok clear");
	});
}

/* ---------------- annotations（跨标签页批注） ---------------- */

const ANN_FILE = join(STATE_DIR, "annotations.json");
const SENT_FILE = join(STATE_DIR, "sent.json");

function readAnnotations() {
	try {
		const d = JSON.parse(readFileSync(ANN_FILE, "utf8"));
		return { items: d.items ?? [], seq: d.seq ?? 0 };
	} catch {
		return { items: [], seq: 0 };
	}
}
function writeAnnotations(data) {
	ensureDirs();
	// 与 state.json 同理：daemon 心跳和 CLI 可能同时写，截断式写入会被读到半截 JSON，
	// 而 readAnnotations 容错返回空数据，下一笔写入就会把全部批注清空。
	const tmp = `${ANN_FILE}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2));
	renameSync(tmp, ANN_FILE);
}

/**
 * 保存/更新一条批注。pageKey 用来区分「哪个浏览器窗口的哪个标签页」，
 * 这样 agent 能还原归属。id 稳定，编辑时不新增。
 */
/** 纯函数版本的 upsert：只改传入的数据对象，不做 IO。 */
function upsertInto(data, patch) {
	const idx = patch.id ? data.items.findIndex((x) => x.id === patch.id) : -1;
	let item;
	if (idx >= 0) {
		item = { ...data.items[idx], ...patch, updatedAt: Date.now() };
		data.items[idx] = item;
	} else {
		data.seq = (data.seq ?? 0) + 1;
		const { id: _ignored, ...rest } = patch;
		item = {
			...rest,
			id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			n: data.seq,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		data.items.push(item);
	}
	return item;
}

function upsertAnnotation(patch) {
	const data = readAnnotations();
	const item = upsertInto(data, patch);
	writeAnnotations(data);
	return item;
}

/** 组装页面归属信息：窗口序号 + 标签页标题 + URL + 视口 */
async function pageKeyOf(port, target) {
	const pages = await listTargets(port);
	const tabIndex = pages.findIndex((p) => p.id === target.id);
	return {
		tabIndex,
		title: target.title ?? "",
		url: target.url ?? "",
		windowId: null,
	};
}

/**
 * 开启批注模式（非阻塞）。
 * 右键菜单由 daemon 常驻注入，所以这里只需激活当前页的批注层并恢复历史批注。
 * 用户按 Esc 或再次 Alt+A 退出；批注保存由页面内 __bwAnnSave 写入 outbox，
 * daemon 侧定时取走落盘（见 flushAnnotationOutbox）。
 */
async function cmdAnnotate(opts) {
	const port = await ensureBrowser();
	await ensureDaemon();
	const { cdp, target } = await connect(port);
	try {
		await injectRuntime(cdp);

		const pk = await pageKeyOf(port, target);
		const data = readAnnotations();
		const mine = data.items.filter((a) => a.url === pk.url);

		// 恢复本页已有批注（含富文本与图片）
		await evaluate(
			cdp,
			`(() => {
				const bw = window.__bw;
				for (const m of bw.marks) { try { m.badge.remove(); } catch {} }
				bw.marks.length = 0;
				document.querySelectorAll('[data-bw-badge]').forEach(n => n.remove());
				return true;
			})()`,
		);
		for (const a of mine) {
			await evaluate(
				cdp,
				`(() => {
					const el = document.querySelector(${JSON.stringify(a.selector)});
					if (!el) return false;
					const bw = window.__bw;
					bw.paint(el);
					bw.marks.push({ id: ${JSON.stringify(a.id)}, n: ${a.n}, selector: ${JSON.stringify(a.selector)},
						note: ${JSON.stringify(a.note)}, noteHtml: ${JSON.stringify(a.noteHtml ?? "")},
						images: ${JSON.stringify(a.images ?? [])}, el, badge: bw.badge(${a.n}, el) });
					return true;
				})()`,
			);
		}

		// 页面 → CLI 的出站队列
		await evaluate(
			cdp,
			`(() => {
				window.__bwAnnOut = window.__bwAnnOut || [];
				if (typeof window.__bwAnnSave !== 'function') {
					window.__bwAnnSave = (payload) => window.__bwAnnOut.push({ op: 'save', payload });
				}
				if (typeof window.__bwAnnDelete !== 'function') {
					window.__bwAnnDelete = (id) => window.__bwAnnOut.push({ op: 'delete', payload: { id } });
				}
				return true;
			})()`,
		);
		await evaluate(cdp, `window.__bwAnn.setActive(true)`);
		console.log(
			`ok annotate ${mine.length} restored | 点击元素添加批注，${readSettings().hotkey} 切换，Esc 退出`,
		);
	} finally {
		cdp.close();
	}
}

/**
 * 把页面里积压的批注变更取走并落盘。
 * 由每次 bw 命令（含 withPage）顺带调用，所以用户保存后下一条命令就会持久化。
 */
/** 把页面 outbox 里的事件落盘。返回本次写入的条目，供调用方同步页面徽标。 */
async function applyAnnEvents(pk, events) {
	// daemon 心跳与 CLI 兜底刷新可能同时落盘，必须串行化，否则后写的一方会覆盖先写的
	const { result } = await withLock("annotations", async () => {
		const data = readAnnotations();
		const saved = [];
		for (const ev of events) {
			if (ev.op === "save") {
				let id = ev.payload.id ?? undefined;
				if (!id) {
					const hit = data.items.find((x) => x.url === pk.url && x.selector === ev.payload.selector);
					if (hit) id = hit.id;
				}
				const item = upsertInto(data, {
					id,
					selector: ev.payload.selector,
					tag: ev.payload.tag,
					text: ev.payload.text,
					note: ev.payload.note,
					noteHtml: ev.payload.noteHtml,
					images: ev.payload.images,
					changes: Array.isArray(ev.payload.changes) ? ev.payload.changes : [],
					url: pk.url,
					title: pk.title,
					tabIndex: pk.tabIndex,
				});
				saved.push(item);
				const ch = item.changes?.length ? ` (+${item.changes.length} style)` : "";
				console.error(`#${item.n} ${item.selector} — ${item.note}${ch}`);
			} else if (ev.op === "delete") {
				data.items = data.items.filter((x) => x.id !== ev.payload.id);
				console.error(`deleted ${ev.payload.id}`);
			}
		}
		writeAnnotations(data);
		return saved;
	});
	return result;
}

/** 页面内徽标同步（把落盘后的 id / 序号 / 富文本写回内存中的 marks）。 */
const ANN_SYNC_EXPR = (item) => `(() => {
	const bw = window.__bw;
	const sel = ${JSON.stringify(item.selector)};
	const el = document.querySelector(sel);
	if (!el) return false;
	let m = bw.marks.find(x => x.el === el);
	if (m) {
		m.id = ${JSON.stringify(item.id)};
		m.n = ${item.n};
		m.note = ${JSON.stringify(item.note)};
		m.noteHtml = ${JSON.stringify(item.noteHtml ?? "")};
		m.images = ${JSON.stringify(item.images ?? [])};
	m.changes = ${JSON.stringify(item.changes ?? [])};
		if (!m.badge || !m.badge.isConnected) m.badge = bw.badge(m.n, el);
		else m.badge.textContent = String(m.n);
	} else {
		bw.paint(el);
		bw.marks.push({ id: ${JSON.stringify(item.id)}, n: ${item.n}, selector: sel,
			note: ${JSON.stringify(item.note)}, noteHtml: ${JSON.stringify(item.noteHtml ?? "")},
			images: ${JSON.stringify(item.images ?? [])}, el, badge: bw.badge(${item.n}, el) });
	}
	bw.sync();
	return true;
})()`;

const ANN_OUTBOX_EXPR =
	"(() => { const o = (window.__bwAnnOut && window.__bwAnnOut.splice(0)) || []; if (!o.length) return null; return { o, url: location.href, title: document.title }; })()";

/** 下一条命令时兜底刷新一次（daemon 未运行时也能落盘）。 */
async function flushAnnotationOutbox() {
	const st = readState();
	if (!(await portAlive(st.port))) return;
	let cdp;
	try {
		const conn = await connect(st.port);
		cdp = conn.cdp;
		const target = conn.target;
		// GUI（Percho 设置页）改了热键 → 每条命令顺带重注入
		const want = readSettings().hotkey;
		const cur = await evaluate(cdp, "window.__bwHotkey || null");
		if (cur !== want) {
			await evaluate(cdp, `(${__bwHotkeys.toString()})(${JSON.stringify(want)})`);
		}

		const out = await evaluate(cdp, "(window.__bwAnnOut && window.__bwAnnOut.splice(0)) || []");
		if (!out?.length) return;
		const pk = await pageKeyOf(st.port, target);
		const saved = await applyAnnEvents(pk, out);
		for (const item of saved) await evaluate(cdp, ANN_SYNC_EXPR(item));
	} catch {
		// 页面可能已导航，忽略
	} finally {
		try {
			cdp?.close();
		} catch {}
	}
}

async function cmdAnnotateDone() {
	return withPage(async (cdp, port, target) => {
		await evaluate(
			cdp,
			`(() => {
				if (window.__bwAnn) window.__bwAnn.setActive(false);
				const n = (window.__bw.marks || []).length;
				return n;
			})()`,
		);
		const data = readAnnotations();
		const pk = await pageKeyOf(port, target);
		const mine = data.items.filter((a) => a.url === pk.url);
		console.log(`ok annotate-off ${mine.length} annotation(s) kept`);
	});
}

async function cmdAnnList() {
	const data = readAnnotations();
	if (!data.items.length) {
		console.log("(none)");
		return;
	}
	const byUrl = new Map();
	for (const a of data.items) {
		if (!byUrl.has(a.url)) byUrl.set(a.url, []);
		byUrl.get(a.url).push(a);
	}
	for (const [url, items] of byUrl) {
		console.log(`▸ ${brief(items[0].title || "", 40)} ${url}`);
		for (const a of items) {
			const ch = a.changes?.length ? ` [+${a.changes.length} 样式]` : "";
			console.log(`  #${a.n} ${a.selector} — ${brief(a.note, 80)}${ch}`);
		}
	}
}

async function cmdAnnExport() {
	const data = readAnnotations();
	if (!data.items.length) {
		console.log("(none)");
		return;
	}
	// 按页面分组，生成 agent 可直接消费的 markdown
	const byUrl = new Map();
	for (const a of data.items) {
		if (!byUrl.has(a.url)) byUrl.set(a.url, []);
		byUrl.get(a.url).push(a);
	}
	const lines = ["## 页面批注", ""];
	for (const [url, items] of byUrl) {
		lines.push(`### ${items[0].title || "(无标题)"}`);
		lines.push(`页面：${url}`);
		lines.push("");
		for (const a of items) {
			lines.push(`${a.n}. \`${a.selector}\` (${a.tag}) — ${a.note}`);
			for (const c of a.changes ?? []) {
				const label = c.prop === "text" ? "文本" : c.prop;
				lines.push(`   样式 ${label}: ${c.from} → ${c.to}`);
			}
			if (a.shot) lines.push(`   截图：${a.shot}`);
		}
		lines.push("");
	}
	console.log(lines.join("\n"));
}

// ---------------------------------------------------------------- Percho 宿主补丁
// 宿主没有这条路：区域表里没有输入框上方这一格，渲染进程 sandbox 且不存在任何
// 能把结构化数据送进插件的通道。补丁只加两件事 —— composer.top 区域和读
// annotations.json 的桥。每段插入都带 bw-patch:<name> start/end 标记，重打前先
// 摘掉，因此可以反复运行。
const PERCHO_APP = "/Applications/Percho.app/Contents/Resources/app.asar";
const PERCHO_DIR = "/Applications/Percho.app/Contents/Resources";

const BW_PATCH = {
	"REGION_ANCHOR": "  ComposerFooter: \"composer.footer\",\n  SettingsPanel: \"settings.panel\"",
	"REGION_PATCH": "  ComposerFooter: \"composer.footer\",\n/* bw-patch:region-top start */\n  /** 输入框正上方：整行卡片（bw 批注条） */\n  ComposerTop: \"composer.top\",\n/* bw-patch:region-top end */  SettingsPanel: \"settings.panel\"",
	"REGION_CASE_ANCHOR": "    case UI_REGIONS.ComposerFooter:\n      return /* @__PURE__ */ jsxRuntimeExports.jsx(jsxRuntimeExports.Fragment, { children: list2.map(renderContribution) });",
	"REGION_CASE_PATCH": "    case UI_REGIONS.ComposerFooter:\n      return /* @__PURE__ */ jsxRuntimeExports.jsx(jsxRuntimeExports.Fragment, { children: list2.map(renderContribution) });/* bw-patch:region-case start */\n    case UI_REGIONS.ComposerTop:\n      return /* @__PURE__ */ jsxRuntimeExports.jsx(jsxRuntimeExports.Fragment, { children: list2.map(renderContribution) });/* bw-patch:region-case end */",
	"PRELOAD_ANCHOR": "  getPathForFile: (file) => electron.webUtils.getPathForFile(file),",
	"PRELOAD_PATCH": "  getPathForFile: (file) => electron.webUtils.getPathForFile(file),/* bw-patch:preload-api start */\n  /** bw 批注桥（本地补丁）：{ action: \"list\" } / { action: \"delete\", file, id } */\n  bwAnnotations: (args) => electron.ipcRenderer.invoke(\"bw:annotations\", args),/* bw-patch:preload-api end */",
	"PERCHO_UI_ANCHOR": "    useUiPreferencesStore\n  }\n};",
	"PERCHO_UI_PATCH": "    useUiPreferencesStore\n  }\n};/* bw-patch:renderer-api start */\n/* bw 批注桥（本地补丁）：UI 插件只拿 PerchoUI，不透出 window.pi */\nwindow.PerchoUI.annotations = {\n  list: () => window.pi.bwAnnotations({ action: \"list\" }),\n  remove: (file, id) => window.pi.bwAnnotations({ action: \"delete\", file, id })\n};/* bw-patch:renderer-api end */",
	"MAIN_IPC": "\n/* ---- bw 批注桥（本地补丁，见 pi-browserwire/percho/patch-percho.py） ----\n   读/删 ~/.pi/bw/sessions/<name>/annotations.json，取最近改动过的那个会话。\n   同目录的 sent.json 由 pi 扩展写入（id → updatedAt），用来标出「已随消息发出」\n   的批注：卡片只显示还没发的，发完就消失。 */\nconst BW_ANN_ROOT = join(homedir(), \".pi\", \"bw\", \"sessions\");\nfunction bwAnnSent(file) {\n  try {\n    const d = JSON.parse(readFileSync(file, \"utf8\"));\n    return d && typeof d === \"object\" ? d : {};\n  } catch {\n    return {};\n  }\n}\nfunction bwAnnRead() {\n  try {\n    const files = [];\n    for (const name of readdirSync(BW_ANN_ROOT)) {\n      const file = join(BW_ANN_ROOT, name, \"annotations.json\");\n      try {\n        files.push({ file, mtime: statSync(file).mtimeMs });\n      } catch {}\n    }\n    files.sort((a, b) => b.mtime - a.mtime);\n    if (!files.length) return { file: null, items: [], seq: 0 };\n    const file = files[0].file;\n    const data = JSON.parse(readFileSync(file, \"utf8\"));\n    const sent = bwAnnSent(file.slice(0, file.lastIndexOf(\"/\")) + \"/sent.json\");\n    const items = (Array.isArray(data.items) ? data.items : []).map((a) =>\n      a && a.id && sent[a.id] === a.updatedAt ? { ...a, sent: true } : a\n    );\n    return { file, items, seq: data.seq ?? 0 };\n  } catch {\n    return { file: null, items: [], seq: 0 };\n  }\n}\nipcMain.handle(\"bw:annotations\", async (_e, args) => {\n  const action = args && args.action ? args.action : \"list\";\n  if (action === \"delete\") {\n    const current = bwAnnRead();\n    const file = args && args.file ? args.file : current.file;\n    if (!file || !resolve(file).startsWith(resolve(BW_ANN_ROOT))) return current;\n    try {\n      const data = JSON.parse(readFileSync(file, \"utf8\"));\n      const id = String((args && args.id) ?? \"\");\n      data.items = (Array.isArray(data.items) ? data.items : []).filter((a) => a && a.id !== id);\n      data.items.forEach((a, i) => {\n        a.n = i + 1;\n      });\n      data.seq = (data.seq ?? 0) + 1;\n      const tmp = `${file}.tmp-${process.pid}`;\n      writeFileSync(tmp, JSON.stringify(data, null, 2), \"utf8\");\n      renameSync(tmp, file);\n      const sentFile = file.slice(0, file.lastIndexOf(\"/\")) + \"/sent.json\";\n      try {\n        const sent = bwAnnSent(sentFile);\n        if (sent[id] !== void 0) {\n          delete sent[id];\n          writeFileSync(sentFile, JSON.stringify(sent), \"utf8\");\n        }\n      } catch {}\n      return { file, items: data.items, seq: data.seq };\n    } catch {\n      return current;\n    }\n  }\n  return bwAnnRead();\n});\n",
	"MOUNT_MARK": "      /* @__PURE__ */ jsxRuntimeExports.jsx(RegionHost, { region: UI_REGIONS.ComposerTop }),",
	"B_START": "/* bw-patch:%s start */",
	"B_END": "/* bw-patch:%s end */"
};

function asarRead(file) {
	const raw = readFileSync(file);
	if (raw.length < 16) throw new Error(`${file} 不是 asar`);
	const headerStart = raw.readUInt32LE(4);
	const jsonLen = raw.readUInt32LE(12);
	const header = JSON.parse(raw.subarray(16, 16 + jsonLen).toString("utf8"));
	return { header, data: raw.subarray(8 + headerStart) };
}

function* walkAsar(node, prefix = "") {
	for (const [name, child] of Object.entries(node.files || {})) {
		const path = `${prefix}/${name}`;
		if (child.files) yield* walkAsar(child, path);
		else yield [path, child];
	}
}

function asarBuild(header, dataByPath, outFile) {
	let offset = 0;
	for (const [path, node] of walkAsar(header)) {
		const body = dataByPath.get(path);
		if (!body || node.unpacked) continue;
		node.size = body.length;
		node.offset = String(offset);
		offset += body.length;
	}
	let hdr = Buffer.from(JSON.stringify(header), "utf8");
	const pad = (4 - (hdr.length % 4)) % 4;
	if (pad) hdr = Buffer.concat([hdr, Buffer.alloc(pad, 0x20)]);
	const jsonLen = hdr.length;
	const fd = openSync(outFile, "w");
	try {
		const head = Buffer.alloc(16);
		head.writeUInt32LE(4, 0);
		head.writeUInt32LE(jsonLen + 8, 4);
		head.writeUInt32LE(jsonLen + 4, 8);
		head.writeUInt32LE(jsonLen, 12);
		writeSync(fd, head);
		writeSync(fd, hdr);
		for (const [path, node] of walkAsar(header)) {
			const body = dataByPath.get(path);
			if (!body || node.unpacked) continue;
			writeSync(fd, body);
		}
	} finally {
		closeSync(fd);
	}
}

function patchText(text, old, next, label) {
	if (!text.includes(old)) throw new Error(`锚点失配：${label}（Percho 结构变了？）`);
	return text.replace(old, next);
}

/** 摘掉上一次插入的段：标记成对出现，这是幂等的前提 */
function stripBlock(text, name) {
	const start = BW_PATCH.B_START.replace("%s", name);
	const end = BW_PATCH.B_END.replace("%s", name);
	let out = "";
	let i = 0;
	for (;;) {
		const a = text.indexOf(start, i);
		const b = a < 0 ? -1 : text.indexOf(end, a);
		if (a < 0 || b < 0) return out + text.slice(i);
		out += text.slice(i, a);
		i = b + end.length;
	}
}

const wrapBlock = (name, body) =>
	BW_PATCH.B_START.replace("%s", name) + body + BW_PATCH.B_END.replace("%s", name);

function mountComposerCard(src) {
	if (src.includes(BW_PATCH.MOUNT_MARK)) return src;
	const marker = "onMouseDown: handleComposerMouseDown,";
	if (src.split(marker).length !== 2) throw new Error("composer 锚点不唯一");
	const at = src.indexOf(marker);
	const openAt = src.lastIndexOf("jsxRuntimeExports.jsxs(", at);
	if (openAt < 0) throw new Error("composer 锚点失配");
	const lineStart = src.lastIndexOf("\n", openAt) + 1;
	return src.slice(0, lineStart) + BW_PATCH.MOUNT_MARK + "\n" + src.slice(lineStart);
}

/** 打出补丁包（不落盘到 App），返回 { outFile, entries, changed } */
function perchoBuild(asarFile, outFile) {
	const { header, data } = asarRead(asarFile);
	const blobs = new Map();
	for (const [path, node] of walkAsar(header)) {
		if (node.unpacked) continue;
		const at = Number(node.offset);
		blobs.set(path, data.subarray(at, at + node.size));
	}
	const renderer = [...blobs.keys()].filter(
		(p) =>
			p.startsWith("/out/renderer/assets/index-") &&
			p.endsWith(".js") &&
			blobs.get(p).includes("window.PerchoUI"),
	);
	if (renderer.length !== 1) throw new Error(`找不到唯一的渲染器 bundle（${renderer.length} 个）`);

	const patches = new Map();

	let mainjs = stripBlock(stripBlock(blobs.get("/out/main/index.js").toString(), "main-ipc"), "region-top");
	mainjs = patchText(mainjs, BW_PATCH.REGION_ANCHOR, BW_PATCH.REGION_PATCH, "main UI_REGIONS");
	mainjs = `${mainjs.replace(/\n+$/, "")}\n${wrapBlock("main-ipc", BW_PATCH.MAIN_IPC.replace(/\n+$/, ""))}\n`;
	patches.set("/out/main/index.js", Buffer.from(mainjs));

	let preload = stripBlock(blobs.get("/out/preload/index.cjs").toString(), "preload-api");
	preload = patchText(preload, BW_PATCH.PRELOAD_ANCHOR, BW_PATCH.PRELOAD_PATCH, "preload api");
	patches.set("/out/preload/index.cjs", Buffer.from(preload));

	let r = blobs.get(renderer[0]).toString();
	for (const name of ["region-top", "region-case", "renderer-api"]) r = stripBlock(r, name);
	r = patchText(r, BW_PATCH.REGION_ANCHOR, BW_PATCH.REGION_PATCH, "renderer UI_REGIONS");
	r = patchText(r, BW_PATCH.REGION_CASE_ANCHOR, BW_PATCH.REGION_CASE_PATCH, "renderer RegionHost case");
	r = patchText(r, BW_PATCH.PERCHO_UI_ANCHOR, BW_PATCH.PERCHO_UI_PATCH, "renderer PerchoUI");
	r = mountComposerCard(r);
	patches.set(renderer[0], Buffer.from(r));

	// 每个标记恰好一对（重跑不会叠加、也不会吃掉邻行）
	const expect = new Map([
		["/out/main/index.js", ["main-ipc", "region-top"]],
		["/out/preload/index.cjs", ["preload-api"]],
		[renderer[0], ["region-top", "region-case", "renderer-api"]],
	]);
	for (const [path, names] of expect) {
		const text = patches.get(path).toString();
		for (const name of names) {
			const starts = text.split(BW_PATCH.B_START.replace("%s", name)).length - 1;
			const ends = text.split(BW_PATCH.B_END.replace("%s", name)).length - 1;
			if (starts !== 1 || ends !== 1) throw new Error(`${path} 的 ${name} 标记异常（${starts}/${ends}）`);
		}
	}

	// 让 node 亲口解析一遍：写错在这里死，而不是等 Percho 白屏
	for (const [path, buf] of patches) {
		const tmp = join(tmpdir(), `bw-patch-check${path.endsWith(".cjs") ? ".cjs" : ".mjs"}`);
		writeFileSync(tmp, buf);
		try {
			const env = process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env;
			execFileSync(process.execPath, ["--check", tmp], { env, stdio: "pipe" });
		} catch (err) {
			throw new Error(`${path} 语法检查失败：${String(err.stderr || err.message).slice(-400)}`);
		} finally {
			try {
				unlinkSync(tmp);
			} catch {}
		}
	}

	for (const [path, buf] of patches) blobs.set(path, buf);
	const count = [...walkAsar(header)].length;
	asarBuild(header, blobs, outFile);
	if ([...walkAsar(asarRead(outFile).header)].length !== count) throw new Error("条目数变了，放弃");
	return { outFile, entries: count, changed: [...patches.keys()] };
}

function perchoIsPatched(file) {
	try {
		return readFileSync(file).includes("bw-patch:main-ipc start");
	} catch {
		return false;
	}
}

function perchoBackups(dir) {
	try {
		return readdirSync(dir)
			.filter((n) => n.startsWith("app.asar.bak-"))
			.sort()
			.reverse();
	} catch {
		return [];
	}
}

function perchoPluginState() {
	const dir = join(homedir(), ".percho", "ui-plugins", "bw-annotations");
	const cfgDir = perchoConfigDir();
	let enabled = false;
	try {
		const cfg = JSON.parse(readFileSync(join(cfgDir, "ui-plugins.json"), "utf8"));
		enabled = !!cfg?.plugins?.["bw-annotations"]?.enabled && cfg?.enabled !== false;
	} catch {}
	return { dir, exists: existsSync(join(dir, "plugin.json")), enabled };
}

async function cmdPerchoStatus() {
	if (!existsSync(PERCHO_APP)) throw new Error(`找不到 ${PERCHO_APP}`);
	const size = (statSync(PERCHO_APP).size / 1e6).toFixed(0);
	const backups = perchoBackups(PERCHO_DIR);
	const plug = perchoPluginState();
	const rows = [
		["asar", `${PERCHO_APP}  ${size} MB`],
		["补丁", perchoIsPatched(PERCHO_APP) ? "已安装（composer.top + 批注桥）" : "未安装"],
		["备份", backups.length ? backups.slice(0, 3).join("\n         ") : "无"],
		["插件", `${plug.exists ? "已放置" : "缺失"}  ${plug.dir}`],
		["开关", plug.enabled ? "已在设置里启用" : "未启用（设置 → 外观 → UI 插件）"],
	];
	// 中文占两列，padEnd 按字符数算会歪
	const pad = (t) => t + " ".repeat(Math.max(1, 8 - [...t].reduce((n, ch) => n + (ch.charCodeAt(0) > 127 ? 2 : 1), 0)));
	for (const [k, v] of rows) console.log(`${pad(k)} ${v}`);
}

async function cmdPerchoPatch(flags) {
	if (flags.from) {
		// 拿任意 asar 试打（自测 / 从备份重建用），不碰 App
		const to = join(tmpdir(), `bw-percho-from-${Date.now()}.asar`);
		const res = perchoBuild(String(flags.from), to);
		console.log(`ok ${to}`);
		console.log(`   ${res.entries} 条目，改动 ${res.changed.length} 处`);
		return;
	}
	if (!existsSync(PERCHO_APP)) throw new Error(`找不到 ${PERCHO_APP}`);
	if (perchoIsPatched(PERCHO_APP) && !flags.force) {
		console.log("ok 已是打过补丁的版本（要重打加 --force）");
		return;
	}
	const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
	const tmp = join(tmpdir(), `bw-percho-${stamp}.asar`);
	const res = perchoBuild(PERCHO_APP, tmp);
	if (flags["dry-run"]) {
		console.log(`ok 构建成功（未换入）：${tmp}`);
		console.log(`   ${res.entries} 条目，改动 ${res.changed.length} 处`);
		return;
	}
	const backup = `${PERCHO_APP}.bak-${stamp}`;
	renameSync(PERCHO_APP, backup);
	renameSync(tmp, PERCHO_APP);
	console.log(`ok 补丁已换入 ${PERCHO_APP}`);
	console.log(`   备份 ${backup}`);
	console.log("   重启 Percho 后生效，然后去 设置 → 外观 → UI 插件 启用「浏览器批注条」");
}

async function cmdPerchoUnpatch(flags) {
	const backups = perchoBackups(PERCHO_DIR);
	if (!backups.length) throw new Error("没有备份可恢复（重装 Percho 也能恢复原样）");
	const src = `${PERCHO_APP}.bak-${backups[0].slice("app.asar.bak-".length)}`;
	if (flags["dry-run"]) {
		console.log(`ok 会用 ${backups[0]} 覆盖（未执行）`);
		return;
	}
	copyFileSync(src, PERCHO_APP);
	console.log(`ok 已从 ${backups[0]} 恢复`);
	console.log("   重启 Percho 后生效");
}

async function cmdAnnClear() {
	writeAnnotations({ items: [], seq: 0 });
	// 已发送标记跟着清：否则 sent.json 会留下指向不存在批注的陈旧条目
	try {
		unlinkSync(SENT_FILE);
	} catch {}
	console.log("ok annotations cleared");
}

async function cmdAnnShot() {
	return withPage(async (cdp, port, target) => {
		const data = readAnnotations();
		const pk = await pageKeyOf(port, target);
		const mine = data.items.filter((a) => a.url === pk.url);
		if (!mine.length) throw new Error("本页没有批注");
		await injectRuntime(cdp);
		// 重新挂上所有徽章后整页截图
		for (const a of mine) {
			await evaluate(
				cdp,
				`(() => {
					const el = document.querySelector(${JSON.stringify(a.selector)});
					if (!el) return false;
					const bw = window.__bw;
					if (bw.marks.find(m => m.id === ${JSON.stringify(a.id)})) return true;
					bw.paint(el);
					bw.marks.push({ id: ${JSON.stringify(a.id)}, n: ${a.n}, selector: ${JSON.stringify(a.selector)},
						note: ${JSON.stringify(a.note)}, el, badge: bw.badge(${a.n}, el) });
					return true;
				})()`,
			);
		}
		const m = await evaluate(
			cdp,
			"({w: innerWidth, h: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)})",
		);
		const res = await cdp.send("Page.captureScreenshot", {
			format: "jpeg",
			quality: 82,
			clip: { x: 0, y: 0, width: m.w, height: Math.min(m.h, MAX_FULL_H), scale: 1 },
			captureBeyondViewport: true,
		});
		ensureDirs();
		const file = join(SHOT_DIR, `ann-${Date.now()}.jpg`);
		writeFileSync(file, Buffer.from(res.data, "base64"));
		// 记录到每条批注
		const data2 = readAnnotations();
		for (const a of data2.items) if (a.url === pk.url) a.shot = file;
		writeAnnotations(data2);
		console.log(`${file} ${Math.round(m.w)}x${Math.round(Math.min(m.h, MAX_FULL_H))} (${mine.length} annotations)`);
	});
}

/* ---------------- tabs ---------------- */

async function cmdTabs() {
	const port = await ensureBrowser();
	const pages = await listTargets(port);
	const active = await activeTarget(port);
	pages.forEach((p, i) => {
		const mark = p.id === active.id ? "*" : " ";
		const win = p.browserContextId ? "" : "";
		console.log(`${mark}${i} ${brief(p.title || "(untitled)", 40)} ${p.url}${win}`);
	});
}

/** 支持索引、URL 子串、标题子串三种定位 */
async function resolveTarget(spec) {
	const port = await ensureBrowser();
	const pages = await listTargets(port);
	if (spec === undefined || spec === null || spec === "") return { port, pages, target: await activeTarget(port) };
	if (/^\d+$/.test(String(spec))) {
		const i = Number(spec);
		if (!pages[i]) throw new Error(`标签页索引无效: ${spec}`);
		return { port, pages, target: pages[i] };
	}
	const needle = String(spec).toLowerCase();
	const hit =
		pages.find((p) => (p.url ?? "").toLowerCase().includes(needle)) ??
		pages.find((p) => (p.title ?? "").toLowerCase().includes(needle));
	if (!hit) throw new Error(`找不到标签页: ${spec}`);
	return { port, pages, target: hit };
}

async function cmdUse(spec) {
	const { pages, target } = await resolveTarget(spec);
	const i = pages.findIndex((p) => p.id === target.id);
	writeState({ activeTargetId: target.id, activeTab: i });
	console.log(`ok tab ${i} ${brief(target.title || "", 40)} ${target.url}`);
}

async function cmdNewTab(url, opts = {}) {
	const port = await ensureBrowser();
	const wsUrl = await browserWsUrl(port);
	const b = await new CDP(wsUrl).open();
	const target = !url ? "about:blank" : /^[a-z]+:\/\//i.test(url) || url.startsWith("file:") || url.startsWith("data:") ? url : `http://${url}`;
	const params = { url: target };
	if (opts.newWindow) params.newWindow = true;
	const { targetId } = await b.send("Target.createTarget", params);
	b.close();
	writeState({ activeTargetId: targetId });
	console.log(`ok new-${opts.newWindow ? "window" : "tab"} ${target}`);
}

async function cmdCloseTab(spec) {
	const { pages, target } = await resolveTarget(spec);
	const i = pages.findIndex((p) => p.id === target.id);
	const port = await ensureBrowser();
	const wsUrl = await browserWsUrl(port);
	const b = await new CDP(wsUrl).open();
	await b.send("Target.closeTarget", { targetId: target.id });
	b.close();
	const st = readState();
	if (st.activeTargetId === target.id) writeState({ activeTargetId: null });
	console.log(`ok closed tab ${i}`);
}

/* ---------------- windows ---------------- */

async function cmdWindows() {
	const port = await ensureBrowser();
	const wsUrl = await browserWsUrl(port);
	const b = await new CDP(wsUrl).open();
	const { targetInfos } = await b.send("Target.getTargets");
	const pages = targetInfos.filter((t) => t.type === "page");
	const byWindow = new Map();
	for (const p of pages) {
		let win;
		try {
			win = await b.send("Browser.getWindowForTarget", { targetId: p.targetId });
		} catch {
			continue;
		}
		const id = win.windowId;
		if (!byWindow.has(id)) byWindow.set(id, { id, bounds: win.bounds, tabs: [] });
		byWindow.get(id).tabs.push(p);
	}
	b.close();
	let n = 0;
	for (const w of byWindow.values()) {
		const bd = w.bounds ?? {};
		console.log(`win ${n} id=${w.id} ${bd.width ?? "?"}x${bd.height ?? "?"} at (${bd.left ?? "?"},${bd.top ?? "?"})${bd.windowState && bd.windowState !== "normal" ? ` ${bd.windowState}` : ""} tabs=${w.tabs.length}`);
		for (const t of w.tabs) console.log(`    ${brief(t.title || "", 40)} ${t.url}`);
		n++;
	}
}

/** 改窗口尺寸/位置/状态。selector 可用 tab 索引/URL 定位其所在窗口 */
async function cmdWindow(spec, opts) {
	const port = await ensureBrowser();
	const { target } = await resolveTarget(spec);
	const wsUrl = await browserWsUrl(port);
	const b = await new CDP(wsUrl).open();
	const { windowId, bounds } = await b.send("Browser.getWindowForTarget", { targetId: target.id });
	const next = { ...bounds };
	if (opts.width) next.width = Number(opts.width);
	if (opts.height) next.height = Number(opts.height);
	if (opts.left !== undefined) next.left = Number(opts.left);
	if (opts.top !== undefined) next.top = Number(opts.top);
	if (opts.state) next.windowState = opts.state; // normal|minimized|maximized|fullscreen
	// 从 minimized/maximized 恢复尺寸时必须先回 normal
	if (bounds.windowState !== "normal" && !opts.state) next.windowState = "normal";
	await b.send("Browser.setWindowBounds", { windowId, bounds: next });
	b.close();
	console.log(`ok window ${next.width}x${next.height}${next.windowState && next.windowState !== "normal" ? ` ${next.windowState}` : ""}`);
}

/* ---------------- viewport / storage / dialog ---------------- */

async function cmdViewport(w, h, opts) {
	return withPage(async (cdp) => {
		await cdp.send("Emulation.setDeviceMetricsOverride", {
			width: Number(w),
			height: Number(h),
			deviceScaleFactor: opts.dpr ? Number(opts.dpr) : 1,
			mobile: !!opts.mobile,
		});
		if (opts.mobile) {
			await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		}
		writeState({
			viewport: { width: Number(w), height: Number(h), dpr: opts.dpr ? Number(opts.dpr) : 1, mobile: !!opts.mobile },
		});
		console.log(`ok viewport ${w}x${h}${opts.mobile ? " mobile" : ""}`);
	});
}

async function cmdResetViewport() {
	return withPage(async (cdp) => {
		await cdp.send("Emulation.clearDeviceMetricsOverride");
		await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
		writeState({ viewport: null });
		console.log("ok viewport reset");
	});
}

async function cmdCookies(url) {
	return withPage(async (cdp, port, target) => {
		const { cookies } = await cdp.send("Network.getCookies", { urls: url ? [url] : [target.url] });
		if (!cookies.length) {
			console.log("(empty)");
			return;
		}
		for (const c of cookies) {
			console.log(`${c.name}=${brief(c.value, 60)}  ${c.domain}${c.httpOnly ? " httpOnly" : ""}${c.secure ? " secure" : ""}`);
		}
	});
}

async function cmdStorage(kind, key) {
	return withPage(async (cdp) => {
		const store = kind === "session" ? "sessionStorage" : "localStorage";
		if (key) {
			const v = await evaluate(cdp, `${store}.getItem(${JSON.stringify(key)})`);
			console.log(v === null ? "(null)" : brief(v, 800));
			return;
		}
		const all = await evaluate(
			cdp,
			`(() => { const o = {}; for (let i = 0; i < ${store}.length; i++) {
			   const k = ${store}.key(i); o[k] = ${store}.getItem(k); } return o; })()`,
		);
		const keys = Object.keys(all ?? {});
		if (!keys.length) {
			console.log("(empty)");
			return;
		}
		for (const k of keys) console.log(`${k}=${brief(all[k], 80)}`);
	});
}

async function cmdDialog(action, text) {
	const st = readState();
	const wsUrl = await browserWsUrl(st.port);
	const b = await new CDP(wsUrl).open();
	const { targetInfos } = await b.send("Target.getTargets");
	for (const t of targetInfos) {
		if (t.type !== "page") continue;
		const r = await b.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
		try {
			await b.send(
				"Page.handleJavaScriptDialog",
				{ accept: action !== "dismiss", promptText: text },
				r.sessionId,
			);
		} catch {}
	}
	b.close();
	console.log(`ok dialog ${action}`);
}

/* ---------------- frames (iframe) ---------------- */

async function cmdFrames() {
	return withPage(async (cdp) => {
		const { frameTree } = await cdp.send("Page.getFrameTree");
		const cur = readState().frameUrl;
		// OOPIF 不在 frameTree 里，单独列出
		let oopifs = [];
		try {
			const { targetInfos } = await cdp.send("Target.getTargets");
			oopifs = targetInfos.filter((t) => t.type === "iframe");
		} catch {}
		const walk = (node, depth) => {
			const f = node.frame;
			const pad = "  ".repeat(depth);
			const isActive = depth === 0 ? !cur : cur && (f.url ?? "").includes(cur);
			console.log(`${pad}${isActive ? "*" : " "} ${depth === 0 ? "top" : "frame"} ${brief(f.url || "about:blank", 100)}`);
			for (const child of node.childFrames ?? []) walk(child, depth + 1);
		};
		walk(frameTree, 0);
		for (const o of oopifs) {
			const active = cur && (o.url ?? "").includes(cur);
			console.log(`${active ? "*" : " "} [oopif] ${brief(o.url || "about:blank", 100)}`);
		}
	});
}

/** 在指定 iframe（URL 子串匹配）里执行后续查询；用 frame top 回到顶层 */
async function cmdFrameSelect(urlPart) {
	if (!urlPart || urlPart === "top") {
		writeState({ frameUrl: null });
		console.log("ok frame top");
		return;
	}
	return withPage(async (cdp) => {
		const candidates = [];
		// 同进程 iframe
		const { frameTree } = await cdp.send("Page.getFrameTree");
		const walk = (node) => {
			candidates.push({ url: node.frame.url ?? "", kind: "same" });
			for (const c of node.childFrames ?? []) walk(c);
		};
		walk(frameTree);
		// OOPIF
		try {
			const { targetInfos } = await cdp.send("Target.getTargets");
			for (const t of targetInfos) {
				if (t.type === "iframe") candidates.push({ url: t.url ?? "", kind: "oopif" });
			}
		} catch {}
		const hit = candidates.find((c) => c.url.includes(urlPart));
		if (!hit) throw new Error(`找不到 iframe: ${urlPart}（用 frames 查看）`);
		writeState({ frameUrl: hit.url });
		console.log(`ok frame [${hit.kind}] ${brief(hit.url, 100)}`);
	});
}

/* ---------------- network detail / cache ---------------- */

async function cmdHeaders(idOrUrl) {
	const { events } = await daemonQuery("/events?kind=net&limit=800");
	const reqs = events.filter((e) => e.phase === "req");
	let hit = reqs.find((e) => e.requestId === idOrUrl);
	if (!hit) hit = [...reqs].reverse().find((e) => (e.url ?? "").includes(idOrUrl));
	if (!hit) throw new Error("找不到该请求");
	const res = events.find((e) => e.phase === "res" && e.requestId === hit.requestId);
	console.log(`> ${hit.method} ${hit.url}`);
	for (const [k, v] of Object.entries(hit.headers ?? {})) console.log(`  ${k}: ${v}`);
	if (res) {
		console.log(`< ${res.status} ${res.mime ?? ""}`);
		for (const [k, v] of Object.entries(res.headers ?? {})) console.log(`  ${k}: ${v}`);
	}
}

async function cmdHardReload() {
	return withPage(async (cdp) => {
		await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
		const loaded = waitLoad(cdp);
		await cdp.send("Page.reload", { ignoreCache: true });
		await loaded;
		await cdp.send("Network.setCacheDisabled", { cacheDisabled: false }).catch(() => {});
		const info = await pageInfo(cdp);
		console.log(`ok hard-reload ${info.url}`);
	});
}

async function cmdClearCache() {
	return withPage(async (cdp) => {
		await cdp.send("Network.clearBrowserCache");
		await cdp.send("Network.clearBrowserCookies").catch(() => {});
		console.log("ok clear-cache");
	});
}

async function cmdThrottle(opts) {
	return withPage(async (cdp) => {
		const presets = {
			off: { downloadThroughput: -1, uploadThroughput: -1, latency: 0 },
			slow3g: { downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8, latency: 400 },
			fast3g: { downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150 },
		};
		if (opts.offline) {
			await cdp.send("Network.emulateNetworkConditions", {
				offline: true,
				latency: 0,
				downloadThroughput: 0,
				uploadThroughput: 0,
			});
			console.log("ok offline");
			return;
		}
		const p = presets[opts.profile ?? "off"] ?? presets.off;
		await cdp.send("Network.emulateNetworkConditions", { offline: false, ...p });
		console.log(`ok throttle ${opts.profile ?? "off"}`);
	});
}

async function cmdCpuThrottle(rate) {
	return withPage(async (cdp) => {
		await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(rate ?? 1) });
		console.log(`ok cpu-throttle ${rate ?? 1}x`);
	});
}

/* ---------------- element highlight / outline ---------------- */

async function cmdHighlight(selector) {
	return withPage(async (cdp) => {
		await cdp.send("DOM.enable");
		const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
		const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
		if (!nodeId) throw new Error(`找不到元素: ${selector}`);
		await cdp.send("DOM.scrollIntoViewIfNeeded", { nodeId }).catch(() => {});
		const { model } = await cdp.send("DOM.getBoxModel", { nodeId });
		await cdp.send("Overlay.enable").catch(() => {});
		await cdp.send("Overlay.highlightNode", {
			nodeId,
			highlightConfig: {
				contentColor: { r: 124, g: 58, b: 237, a: 0.18 },
				paddingColor: { r: 124, g: 58, b: 237, a: 0.12 },
				borderColor: { r: 124, g: 58, b: 237, a: 0.5 },
				marginColor: { r: 124, g: 58, b: 237, a: 0.08 },
			},
		});
		console.log(`ok highlight ${selector} ${Math.round(model.width)}x${Math.round(model.height)}`);
	});
}

async function cmdHighlightClear() {
	return withPage(async (cdp) => {
		await cdp.send("Overlay.hideHighlight").catch(() => {});
		console.log("ok highlight-clear");
	});
}

/** 一次性框出页面上所有可交互元素（快速理解页面结构） */
async function cmdOutline(opts) {
	return withPage(async (cdp) => {
		await injectRuntime(cdp);
		const count = await evaluate(
			cdp,
			`(() => {
				const sel = 'a,button,input,select,textarea,[role=button],[onclick],[contenteditable=true]';
				const bw = window.__bw;
				let n = 0;
				for (const el of document.querySelectorAll(sel)) {
					if (!bw.visible(el)) continue;
					const r = el.getBoundingClientRect();
					if (r.width < 4 || r.height < 4) continue;
					bw.paint(el);
					bw.marks.push({ n: ++n, selector: bw.selector(el), note: '', el, badge: bw.badge(n, el) });
					if (n >= 120) break;
				}
				return n;
			})()`,
		);
		console.log(`ok outline ${count} interactive element(s)`);
	});
}

/* ---------------- dialog auto-handle policy ---------------- */

async function cmdDialogPolicy(policy) {
	if (!["accept", "dismiss", "manual"].includes(policy)) throw new Error("policy: accept|dismiss|manual");
	writeState({ dialogPolicy: policy });
	const st = readState();
	await daemonQuery(`/policy?dialog=${policy}`).catch(() => {});
	console.log(`ok dialog-policy ${policy}`);
}

/**
 * 查看或设置批注热键。
 *   bw hotkey            → 打印当前热键
 *   bw hotkey shift+a    → 设置
 * 设置后立即注入到当前页面，无需重开浏览器。
 */
async function cmdHotkey(hk) {
	if (!hk) {
		console.log(readSettings().hotkey);
		return;
	}
	const norm = hk.toLowerCase().replace(/cmd|ctrl|meta/g, "mod");
	writeSettings({ hotkey: norm });
	// 立刻热更新到活动页面
	const st = readState();
	if (await portAlive(st.port)) {
		try {
			const { cdp } = await connect(st.port);
			await evaluate(cdp, `(${__bwHotkeys.toString()})(${JSON.stringify(norm)})`);
			cdp.close();
		} catch {}
	}
	console.log(`ok hotkey ${norm}`);
}

/**
 * 查看或设置使用的浏览器。
 *   bw browser            → 打印当前配置 + 各浏览器安装状态
 *   bw browser chrome     → 设为 Google Chrome（下次启动生效）
 *   bw browser auto       → 自动选第一个已安装的
 */
async function cmdBrowser(id) {
	if (!id) {
		const cur = readSettings().browser ?? "auto";
		const lines = [`current: ${cur}`];
		for (const b of BROWSERS) {
			const p = browserPath(b.id);
			lines.push(`  ${p ? "✓" : "·"} ${b.id.padEnd(9)} ${b.name}${p ? "" : " (未安装)"}`);
		}
		console.log(lines.join("\n"));
		return;
	}
	const norm = String(id).toLowerCase().trim();
	if (norm !== "auto" && !BROWSERS.some((b) => b.id === norm)) {
		throw new Error(`未知浏览器 "${norm}"（可选：auto, ${BROWSERS.map((b) => b.id).join(", ")}）`);
	}
	if (norm !== "auto" && !browserPath(norm)) {
		throw new Error(`${norm} 未安装（找不到可执行文件）`);
	}
	writeSettings({ browser: norm });
	console.log(`ok browser ${norm}（下次启动生效，bw close 可立即重启）`);
}

/* ---------------- lifecycle ---------------- */



async function cmdStatus() {
	const st = readState();
	if (!(await portAlive(st.port))) {
		console.log("stopped");
		return;
	}
	const pages = await listTargets(st.port);
	const active = await activeTarget(st.port);
	const d = await daemonHealth(st.daemonPort);
	console.log(
		`running port=${st.port} tabs=${pages.length} active="${brief(active.title || "", 30)}" daemon=${d ? "on" : "off"} profile=${PROFILE_DIR}`,
	);
}

async function cmdClose() {
	const st = readState();
	killVerified(st.daemonPid, "__daemon");
	if (await portAlive(st.port)) {
		try {
			const wsUrl = await browserWsUrl(st.port);
			const b = await new CDP(wsUrl, { timeoutMs: 3000 }).open();
			await b.send("Browser.close").catch(() => {});
			b.close();
		} catch {}
		killVerified(st.pid, PROFILE_DIR);
	}
	writeState({ port: null, pid: null, daemonPort: null, daemonPid: null, activeTargetId: null });
	console.log("ok closed");
}

async function cmdDoctor() {
	const st = readState();
	const picked = resolveBrowser();
	console.log(`browser     ${picked ? `${picked.id} (${picked.path})` : "NOT FOUND"}`);
	console.log(`instance    ${(await portAlive(st.port)) ? `up :${st.port}` : "down"}`);
	console.log(`daemon      ${(await daemonHealth(st.daemonPort)) ? `up :${st.daemonPort}` : "down"}`);
	console.log(`session     ${SESSION_NAME}`);
	console.log(`profile     ${PROFILE_DIR}${existsSync(PROFILE_DIR) ? "" : " (not created)"}`);
	console.log(`shots       ${SHOT_DIR}`);
	console.log(`hotkey      ${readSettings().hotkey}`);
	console.log(`node        ${process.version}`);
}

/* ==================================================================== */
/* batch runner                                                          */
/* ==================================================================== */

function splitArgs(line) {
	const out = [];
	let cur = "";
	let quote = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quote) {
			if (c === quote) quote = null;
			else cur += c;
		} else if (c === '"' || c === "'") {
			quote = c;
		} else if (c === " " || c === "\t") {
			if (cur) {
				out.push(cur);
				cur = "";
			}
		} else {
			cur += c;
		}
	}
	if (cur) out.push(cur);
	return out;
}

async function cmdRun(script) {
	const lines = script
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"));
	let failed = 0;
	for (const line of lines) {
		const argv = splitArgs(line);
		const cmd = argv[0];
		console.log(`> ${line}`);
		try {
			await dispatch(cmd, argv.slice(1));
		} catch (err) {
			failed++;
			console.error(`! ${err.message}`);
			break;
		}
	}
	if (failed) process.exit(1);
}

/* ==================================================================== */
/* arg parsing + dispatch                                                */
/* ==================================================================== */

function parseFlags(args) {
	const flags = {};
	const rest = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--") {
			rest.push(...args.slice(i + 1));
			break;
		}
		if (a.startsWith("--")) {
			const [k, inline] = a.slice(2).split("=");
			if (inline !== undefined) flags[k] = inline;
			else if (args[i + 1] && !args[i + 1].startsWith("--")) {
				flags[k] = args[i + 1];
				i++;
			} else flags[k] = true;
		} else rest.push(a);
	}
	return { flags, rest };
}

const HELP = `bw — 浏览器调试 CLI（零依赖）

导航
  open <url> [--new-tab]     打开/导航，报告 console+网络问题
  reload                     重新加载
  back | forward             历史导航
  new-tab [url] [--window]   新建标签页（--window 建新窗口）
  new-window [url]           新建浏览器窗口
  tabs | use <n|url|title>   切换标签页（支持 URL/标题子串）
  close-tab <n|url|title>
  windows                    列出窗口及各自标签页
  window <tab> --width n --height n [--left n] [--top n] [--state maximized|fullscreen|minimized]
                             调整 OS 窗口尺寸/位置/状态
  frames                     列出 iframe 树
  frame <url子串> | frame top 后续操作限定在某 iframe

交互
  click <sel> [--js] [--count n] [--button left|right|middle]
  dblclick <sel>             双击
  hover <sel>                悬停
  focus <sel> | blur <sel>   聚焦/失焦
  type <sel> <text>          写入表单值（React/Vue 兼容）
  keys <text>                向焦点元素输入原始文本
  press <key> [--times n]    按键：Enter/Tab/Escape/Cmd+A/ArrowDown…
  select <sel> <value>       下拉选择
  check <sel> | uncheck <sel>
  scroll [sel|top|bottom|<y>]
  drag <from> <to>
  upload <sel> <file...>

等待 / 断言（失败退出码 1）
  wait <sel> [--timeout ms] [--visible] [--gone]
  wait-text <sel> <text> [--timeout ms]
  wait-idle [--timeout ms]   等网络空闲
  assert-visible <sel> | assert-hidden <sel>
  assert-text <sel> <text>
  assert-count <sel> <n>
  assert-value <sel> <value>

查询
  text [sel]                 可见文本
  html [sel] [--outer] [--max n]
  attr <sel> <name>
  style <sel> [prop]
  box <sel>                  位置尺寸
  count <sel>
  find <text>                按文本找元素 → selector
  eval <js>                  执行 JS
  title                      标题与 URL

日志（daemon 常驻收集）
  console [--errors] [--filter s] [--limit n]
  net [--fail] [--filter s] [--limit n]
  net-body <requestId|url子串>
  headers <requestId|url子串>  查看请求/响应头
  clear-logs

截图 / 导出
  shot [path] [--full] [--viewport] [--sel s] [--width n] [--png]
  pdf [path]
  outline                    框出所有可交互元素（快速看结构）

标注（风格对齐 Percho）
  pick [timeoutSec]          交互选元素
  mark <sel> [note]          标注（编号+accent 描边）
  marks                      列出标注
  clear                      清除标注

宿主补丁（可选：输入框上方的批注条）
  percho-status              补丁/备份/插件状态
  percho-patch [--force]     打补丁（--dry-run 只构建不换入；--from <asar> 打任意副本）
  percho-unpatch             从最近备份还原（重装 Percho 同样有效）

批注（用户驱动，跨标签页持久）
  annotate                   进入批注模式：点击元素→输入批注；点徽章可编辑
  annotate-done              退出批注模式（保留徽章）
  ann                        列出所有批注（按页面分组）
  ann-export                 导出 markdown（agent 可直接读）
  ann-shot                   对当前页所有批注整页截图
  ann-clear                  清空全部批注

设备 / 存储
  viewport <w> <h> [--mobile] [--dpr n]
  reset-viewport
  cookies [url]
  storage [local|session] [key]
  dialog accept|dismiss [text]
  dialog-policy accept|dismiss|manual
  hard-reload                忽略缓存重载
  clear-cache                清缓存+cookie
  throttle [off|slow3g|fast3g] [--offline]
  cpu-throttle [rate]        如 4 = 4x 降速
  highlight <sel> | highlight-clear   类似 DevTools 的 $0 高亮

批量
  run                        从 stdin 读取命令逐行执行（失败即停）

生命周期
  status | close | doctor

示例：
  bw open localhost:3000
  bw mark "#hero" 标题太小 && bw mark ".cta" 颜色不对 && bw shot
  bw wait ".list li" --visible && bw count ".list li"
  bw console --errors
  bw run <<'EOF'
  open localhost:3000
  wait-idle
  assert-visible "#app"
  shot
  EOF`;

async function dispatch(cmd, argv) {
	const { flags, rest } = parseFlags(argv);
	switch (cmd) {
		case "open":
		case "go":
			if (!rest[0]) throw new Error("用法: bw open <url>");
			return cmdOpen(rest[0], { newTab: !!flags["new-tab"] });
		case "reload":
			return cmdReload();
		case "back":
		case "forward":
			return cmdHistory(cmd);
		case "click":
			if (!rest[0]) throw new Error("用法: bw click <sel>");
			return cmdClick(rest[0], {
				js: !!flags.js,
				count: flags.count ? Number(flags.count) : 1,
				button: flags.button ?? "left",
			});
		case "dblclick":
			if (!rest[0]) throw new Error("用法: bw dblclick <sel>");
			return cmdClick(rest[0], { count: 2 });
		case "hover":
			return cmdHover(rest[0]);
		case "focus":
			return cmdFocus(rest[0], false);
		case "blur":
			return cmdFocus(rest[0], true);
		case "type":
		case "fill":
			if (!rest[0]) throw new Error("用法: bw type <sel> <text>");
			return cmdType(rest[0], rest.slice(1).join(" "));
		case "keys":
			return cmdKeys(rest.join(" "));
		case "press":
			return cmdPress(rest[0], { times: flags.times ? Number(flags.times) : 1 });
		case "select":
			return cmdSelect(rest[0], rest[1]);
		case "check":
			return cmdCheck(rest[0], true);
		case "uncheck":
			return cmdCheck(rest[0], false);
		case "scroll":
			return cmdScroll(rest[0]);
		case "drag":
			return cmdDrag(rest[0], rest[1]);
		case "upload":
			if (rest.length < 2) throw new Error("用法: bw upload <sel> <file...>");
			return cmdUpload(rest[0], rest.slice(1));
		case "wait":
			return cmdWait(rest[0], {
				timeout: flags.timeout ? Number(flags.timeout) : undefined,
				gone: !!flags.gone,
				visible: !!flags.visible,
			});
		case "wait-text":
			return cmdWaitText(rest[0], rest.slice(1).join(" "), {
				timeout: flags.timeout ? Number(flags.timeout) : undefined,
			});
		case "wait-idle":
			return cmdWaitIdle({ timeout: flags.timeout ? Number(flags.timeout) : undefined });
		case "assert-visible":
			return cmdAssert("visible", rest, flags);
		case "assert-hidden":
			return cmdAssert("hidden", rest, flags);
		case "assert-text":
			return cmdAssert("text", rest, flags);
		case "assert-count":
			return cmdAssert("count", rest, flags);
		case "assert-value":
			return cmdAssert("value", rest, flags);
		case "text":
			return cmdText(rest[0]);
		case "html":
			return cmdHtml(rest[0], { outer: !!flags.outer, max: flags.max ? Number(flags.max) : undefined });
		case "attr":
			return cmdAttr(rest[0], rest[1]);
		case "style":
			return cmdStyle(rest[0], rest[1]);
		case "box":
			return cmdBox(rest[0]);
		case "count":
			return cmdCount(rest[0]);
		case "find":
			return cmdFind(rest.join(" "));
		case "eval":
			return cmdEval(rest.join(" "));
		case "title":
			return cmdTitle();
		case "console":
		case "errors":
			return cmdConsole({
				errors: cmd === "errors" || !!flags.errors,
				filter: flags.filter,
				limit: flags.limit ? Number(flags.limit) : undefined,
			});
		case "net":
			return cmdNet({
				fail: !!flags.fail,
				filter: flags.filter,
				limit: flags.limit ? Number(flags.limit) : undefined,
			});
		case "net-body":
			return cmdNetBody(rest[0]);
		case "clear-logs":
			return cmdClearLogs();
		case "shot":
		case "screenshot":
			return cmdShot(rest[0], {
				full: !!flags.full,
				viewport: !!flags.viewport,
				selector: flags.sel,
				width: flags.width,
				height: flags.height,
				png: !!flags.png,
			});
		case "pdf":
			return cmdPdf(rest[0]);
		case "pick":
			return cmdPick(rest[0] ? Number(rest[0]) : 60);
		case "mark":
			return cmdMark(rest[0], rest.slice(1).join(" "));
		case "marks":
			return cmdMarks();
		case "annotate":
			return cmdAnnotate({});
		case "annotate-done":
			return cmdAnnotateDone();
		case "ann":
			return cmdAnnList();
		case "ann-export":
			return cmdAnnExport();
		case "ann-shot":
			return cmdAnnShot();
		case "ann-clear":
			return cmdAnnClear();
		case "percho-status":
			return cmdPerchoStatus();
		case "percho-patch":
			return cmdPerchoPatch(flags);
		case "percho-unpatch":
			return cmdPerchoUnpatch(flags);
		case "clear":
			return cmdClear();
		case "tabs":
			return cmdTabs();
		case "use":
			return cmdUse(rest[0]);
		case "new-tab":
			return cmdNewTab(rest[0], { newWindow: !!flags.window });
		case "new-window":
			return cmdNewTab(rest[0], { newWindow: true });
		case "close-tab":
			return cmdCloseTab(rest[0]);
		case "windows":
			return cmdWindows();
		case "window":
			return cmdWindow(rest[0], {
				width: flags.width,
				height: flags.height,
				left: flags.left,
				top: flags.top,
				state: flags.state,
			});
		case "frames":
			return cmdFrames();
		case "frame":
			return cmdFrameSelect(rest[0]);
		case "headers":
			return cmdHeaders(rest[0]);
		case "hard-reload":
			return cmdHardReload();
		case "clear-cache":
			return cmdClearCache();
		case "throttle":
			return cmdThrottle({ profile: rest[0], offline: !!flags.offline });
		case "cpu-throttle":
			return cmdCpuThrottle(rest[0]);
		case "highlight":
			return cmdHighlight(rest[0]);
		case "highlight-clear":
			return cmdHighlightClear();
		case "outline":
			return cmdOutline(flags);
		case "dialog-policy":
			return cmdDialogPolicy(rest[0]);
		case "hotkey":
			return cmdHotkey(rest[0]);
		case "browser":
			return cmdBrowser(rest[0]);
		case "viewport":
			if (!rest[0] || !rest[1]) throw new Error("用法: bw viewport <w> <h>");
			return cmdViewport(rest[0], rest[1], { mobile: !!flags.mobile, dpr: flags.dpr });
		case "reset-viewport":
			return cmdResetViewport();
		case "cookies":
			return cmdCookies(rest[0]);
		case "storage":
			return cmdStorage(rest[0] ?? "local", rest[1]);
		case "dialog":
			return cmdDialog(rest[0] ?? "accept", rest[1]);
		case "run": {
			// 工具调用拿不到 stdin（spawn 时 fd0 指向 /dev/null），所以脚本也接受
			// --script=<text> 或第一个位置参数；都没有才回退读 stdin。
			const inline = flags.script ?? flags.stdin ?? rest[0];
			if (inline !== undefined && String(inline).length) return cmdRun(String(inline));
			const piped = await readStdin();
			if (!piped.trim()) throw new Error('run: 需要脚本（--script="open x\\nclick y" 或 stdin）');
			return cmdRun(piped);
		}
		case "status":
			return cmdStatus();
		case "close":
			return cmdClose();
		case "doctor":
			return cmdDoctor();
		case "help":
		case "--help":
		case "-h":
			console.log(HELP);
			return;
		default:
			console.log(HELP);
	}
}

function readStdin() {
	return new Promise((resolve) => {
		let data = "";
		if (process.stdin.isTTY) return resolve("");
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (c) => (data += c));
		process.stdin.on("end", () => resolve(data));
	});
}

/* ==================================================================== */
/* entry                                                                 */
/* ==================================================================== */

const rawArgs = process.argv.slice(2).filter((a) => !a.startsWith("--session="));
const [first, ...argv] = rawArgs;

if (first === "__daemon") {
	await runDaemon(argv[0], Number(argv[1]));
} else {
	try {
		// 顺带清理过期截图（内部按小时节流）
		pruneShots();
		if (!["close", "status", "doctor", "__daemon", undefined, "help", "--help", "-h"].includes(first)) {
			if (await reapIfIdle()) {
				console.error("bw: 上次会话已回收，本次命令重新启动浏览器");
			}
			// 把页面里已保存但未落盘的批注取回来
			if (!["annotate"].includes(first)) {
				await flushAnnotationOutbox().catch(() => {});
			}
		}
		await dispatch(first, argv);
	} catch (err) {
		console.error(`bw: ${err.message}`);
		process.exit(1);
	}
	process.exit(0);
}

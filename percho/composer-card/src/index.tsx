import { memo, useEffect, useMemo, useRef, useState } from "react";

/**
 * 浏览器批注条：位于 Percho 输入框正上方。
 *
 * 数据来自宿主补丁 `window.PerchoUI.annotations`（见 pi-browserwire/percho/
 * patch-percho.py）：它读的是 `~/.pi/bw/sessions/<name>/annotations.json`，
 * 取最近改动过的那个会话。插件不碰文件系统，也不需要 window.pi。
 *
 * 视觉沿用宿主语言：胶囊 = 「回到底部」那种 `rounded-full border bg-surface/95
 * shadow-pop backdrop-blur`；弹层 = 模型选择器的 `rounded-xl bg-surface p-1
 * shadow-pop` + `fade-rule` 两端渐隐分割线 + `rounded-lg` 行。
 */

interface Ann {
	id: string;
	n?: number;
	selector?: string;
	note?: string;
	/** 已随某条消息发出（主进程读 sent.json 判断）：发过的从卡片里消失 */
	sent?: boolean;
}

interface Bridge {
	list(): Promise<{ file: string | null; items: Ann[] }>;
	remove(file: string | null, id: string): Promise<{ file: string | null; items: Ann[] }>;
}

function bridge(): Bridge | null {
	const ui = (window as unknown as { PerchoUI?: { annotations?: Bridge } }).PerchoUI;
	return ui?.annotations ?? null;
}

/** `div.a > ul > li:nth-of-type(2) > span` → `li > span` */
function shortSelector(selector?: string): string {
	if (!selector) return "";
	const parts = selector
		.split(">")
		.map((s) => s.trim().replace(/:nth-of-type\(\d+\)/g, ""))
		.filter(Boolean);
	return parts.slice(-2).join(" > ");
}

const sigOf = (list: Ann[]) => list.map((a) => `${a.id}:${a.sent ? 1 : 0}:${a.selector}:${a.note}`).join("|");

function PencilIcon({ size = 13, className }: { size?: number; className?: string }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden="true"
		>
			<path d="M12 20h9" />
			<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
		</svg>
	);
}

function ChevronDownIcon({ open }: { open: boolean }) {
	return (
		<svg
			width="13"
			height="13"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={open ? "rotate-180 transition-transform" : "transition-transform"}
			aria-hidden="true"
		>
			<path d="m6 9 6 6 6-6" />
		</svg>
	);
}

export const AnnotationBar = memo(function AnnotationBar() {
	const [items, setItems] = useState<Ann[]>([]);
	const [file, setFile] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const sig = useRef("");
	const box = useRef<HTMLDivElement | null>(null);

	const load = useMemo(
		() => async () => {
			const b = bridge();
			if (!b) return;
			try {
				const res = await b.list();
				const next = res?.items ?? [];
				const key = sigOf(next);
				if (key === sig.current) return;
				sig.current = key;
				setItems(next);
				setFile(res?.file ?? null);
				if (!next.length) setOpen(false);
			} catch {
				// 桥不在（未打补丁的宿主）时静默不显示
			}
		},
		[],
	);

	useEffect(() => {
		void load();
		const timer = window.setInterval(() => {
			if (!document.hidden) void load();
		}, 2000);
		return () => window.clearInterval(timer);
	}, [load]);

	const remove = async (id: string) => {
		const b = bridge();
		if (!b) return;
		try {
			const res = await b.remove(file, id);
			const next = res?.items ?? [];
			sig.current = sigOf(next);
			setItems(next);
			if (!next.length) setOpen(false);
		} catch {}
	};

	// 点开才展开（悬停展开太容易误触）；点外面或 Esc 收起
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDown, true);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("mousedown", onDown, true);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [open]);

	// 只显示还没发出去的：上一条消息已把批注带走，卡片就该空掉
	const pending = useMemo(() => items.filter((a) => !a.sent), [items]);

	if (!pending.length) return null;

	return (
		<div ref={box} className="relative mb-1.5 flex pointer-events-auto">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex items-center gap-1.5 rounded-full border border-border bg-surface/95 px-3 py-1.5 text-ui-12 leading-[calc(1_/_0.75)] text-ink-2 shadow-pop backdrop-blur transition-colors hover:bg-hover motion-reduce:transition-none"
				aria-expanded={open}
			>
				<PencilIcon className="shrink-0 text-ink-faint" />
				<span className="tabular-nums">{pending.length} 条批注</span>
				<ChevronDownIcon open={open} />
			</button>

			{open && (
				<div className="absolute bottom-full left-0 z-30 mb-1 w-[440px] rounded-xl bg-surface p-1 shadow-pop">
					<div className="flex items-center gap-1.5 px-2 py-1.5 pr-3 text-ui-12 leading-[calc(1_/_0.75)]">
						<PencilIcon className="shrink-0 text-ink-faint" />
						<span className="truncate text-ink-faint">页面批注</span>
						<span className="ml-auto tabular-nums text-ink-faint">{pending.length}</span>
					</div>

					<div className="fade-rule mb-1" />

					<div className="thin-scrollbar max-h-64 overflow-y-auto [scrollbar-gutter:stable]">
						{pending.map((a, i) => (
							<div
								key={a.id}
								className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-ui-12 leading-[calc(1_/_0.75)] transition-colors hover:bg-hover motion-reduce:transition-none"
							>
								<span className="w-3 shrink-0 tabular-nums text-ui-11 text-ink-faint">{i + 1}</span>
								<span className="max-w-[150px] shrink-0 truncate font-mono text-ui-11 text-ink-dim">
									{shortSelector(a.selector)}
								</span>
								<span className={a.note ? "flex-1 truncate text-ink" : "flex-1 truncate text-ink-faint"}>
									{a.note || "（仅样式修改）"}
								</span>
								<button
									type="button"
									onClick={() => void remove(a.id)}
									title="删除"
									aria-label="删除"
									className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-ink-faint opacity-0 transition-colors hover:bg-hover hover:text-red-500 group-hover:opacity-100 motion-reduce:transition-none"
								>
									×
								</button>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
});

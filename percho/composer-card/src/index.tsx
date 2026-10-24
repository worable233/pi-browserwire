import { memo, useEffect, useMemo, useRef, useState } from "react";

/**
 * 浏览器批注条：位于 Percho 输入框正上方。
 *
 * 数据来自宿主补丁 `window.PerchoUI.annotations`（见 pi-browserwire/percho/
 * patch-percho.py）：它读的是 `~/.pi/bw/sessions/<name>/annotations.json`，
 * 取最近改动过的那个会话。插件不碰文件系统，也不需要 window.pi。
 */

interface Ann {
	id: string;
	n?: number;
	selector?: string;
	note?: string;
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

function PencilIcon({ size = 12 }: { size?: number }) {
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
			aria-hidden="true"
		>
			<path d="M12 20h9" />
			<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
		</svg>
	);
}

function Chevron({ up }: { up: boolean }) {
	return (
		<svg
			width="10"
			height="10"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			className="text-ink-faint"
			aria-hidden="true"
		>
			<path d={up ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} />
		</svg>
	);
}

export const AnnotationBar = memo(function AnnotationBar() {
	const [items, setItems] = useState<Ann[]>([]);
	const [file, setFile] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const sig = useRef("");

	const load = useMemo(
		() => async () => {
			const b = bridge();
			if (!b) return;
			try {
				const res = await b.list();
				const next = res?.items ?? [];
				const key = next.map((a) => `${a.id}:${a.selector}:${a.note}`).join("|");
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
			sig.current = next.map((a) => `${a.id}:${a.selector}:${a.note}`).join("|");
			setItems(next);
			if (!next.length) setOpen(false);
		} catch {}
	};

	if (!items.length) return null;

	return (
		<div
			className="relative mb-1.5 flex pointer-events-auto"
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={() => setOpen(false)}
		>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="inline-flex h-7 items-center gap-1.5 rounded-full border-[0.5px] border-border bg-surface px-2 text-ui-12 text-ink-2 shadow-soft transition-colors hover:bg-hover motion-reduce:transition-none"
				aria-expanded={open}
			>
				<span className="text-ink-dim">
					<PencilIcon />
				</span>
				<span className="tabular-nums">{items.length} 条批注</span>
				<Chevron up={open} />
			</button>

			{open && (
				<div className="absolute bottom-full left-0 z-30 mb-1.5 w-[440px] overflow-hidden rounded-xl border-[0.5px] border-border bg-surface shadow-pop">
					<div className="px-3 py-2 text-ui-11 text-ink-faint">页面批注 · 悬停右侧 × 删除</div>
					<div className="max-h-[200px] overflow-y-auto thin-scrollbar pb-1">
						{items.map((a, i) => (
							<div
								key={a.id}
								className="group flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-hover motion-reduce:transition-none"
							>
								<span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/10 text-ui-11 leading-none text-accent tabular-nums">
									{i + 1}
								</span>
								<span className="max-w-[150px] shrink-0 truncate font-mono text-ui-11 text-ink-2">
									{shortSelector(a.selector)}
								</span>
								<span className="flex-1 truncate text-ui-12 text-ink">
									{a.note || <span className="text-ink-faint">（仅样式修改）</span>}
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

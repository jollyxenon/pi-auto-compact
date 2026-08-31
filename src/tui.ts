import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	type Component,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { CompressProgress } from "./compress.ts";
import type { CompactBlock, PluginState } from "./types.ts";

export interface ProjectedContextUsage {
	tokens: number;
	contextWindow: number;
}

const COMPRESSION_STATUS_KEY = "auto-compact-progress";

/** Render live compression progress in the same single-line area used by Pi loaders. */
export function showCompressionProgress(ctx: ExtensionContext, progress: CompressProgress): void {
	if (!ctx.hasUI) return;
	const total = Math.max(0, progress.totalTokens);
	const compressed = Math.max(0, Math.min(progress.compressedTokens, total));
	const fraction = total > 0 ? compressed / total : progress.phase === "completed" ? 1 : 0;
	const width = 20;
	const filled = Math.round(fraction * width);
	const bar = `[${"#".repeat(filled)}${".".repeat(width - filled)}]`;
	const counts = total > 0 ? `${formatTokens(compressed)}/${formatTokens(total)}` : "0/0";
	const latest = progress.latestBlocks?.at(-1);
	const block = latest ? ` 最新块 ${latest.blockId} [L${latest.level}]` : "";
	const label = progress.phase === "completed"
		? "auto-compact 压缩完成"
		: progress.phase === "error"
			? `auto-compact 压缩失败${progress.message ? `: ${progress.message}` : ""}`
			: progress.phase === "skipped"
				? `auto-compact 已跳过${progress.message ? `: ${progress.message}` : ""}`
				: "auto-compact 正在压缩";
	ctx.ui.setStatus(COMPRESSION_STATUS_KEY, `${label} ${bar} ${counts}${block}`);
	ctx.ui.setWidget(COMPRESSION_STATUS_KEY, undefined);
}

/** Install a compact native-style footer whose context figure uses the projected request. */
export function installAutoCompactFooter(
	ctx: ExtensionContext,
	getProjectedUsage: () => ProjectedContextUsage | undefined,
): { requestRender(): void; dispose(): void } {
	let requestRender = (): void => {};
	let unsubscribe: (() => void) | undefined;
	if (ctx.hasUI && ctx.mode === "tui") {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			unsubscribe = footerData.onBranchChange(requestRender);
			return {
				dispose: () => unsubscribe?.(),
				invalidate(): void {},
				render(width: number): string[] {
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					let cacheWrite = 0;
					let cost = 0;
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type !== "message" || entry.message.role !== "assistant") continue;
						const usage = entry.message.usage;
						if (!usage) continue;
						input += usage.input;
						output += usage.output;
						cacheRead += usage.cacheRead;
						cacheWrite += usage.cacheWrite;
						cost += usage.cost.total;
					}

					const branch = footerData.getGitBranch();
					const sessionName = ctx.sessionManager.getSessionName();
					let location = ctx.cwd;
					const home = process.env.HOME;
					if (home && (location === home || location.startsWith(`${home}/`))) location = `~${location.slice(home.length)}`;
					if (branch) location += ` (${branch})`;
					if (sessionName) location += ` | ${sessionName}`;

					const projected = getProjectedUsage();
					const native = ctx.getContextUsage();
					const contextWindow = projected?.contextWindow ?? native?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextTokens = projected?.tokens ?? native?.tokens ?? null;
					const percent = contextTokens === null || contextWindow <= 0 ? "?" : ((contextTokens / contextWindow) * 100).toFixed(1);
					const contextDisplay = percent === "?" ? "?" : `${percent}%`;
					const stats = [
						input > 0 ? `↑${formatTokens(input)}` : "",
						output > 0 ? `↓${formatTokens(output)}` : "",
						cacheRead > 0 ? `R${formatTokens(cacheRead)}` : "",
						cacheWrite > 0 ? `W${formatTokens(cacheWrite)}` : "",
						cost > 0 ? `$${cost.toFixed(3)}` : "",
						`${contextDisplay}/${formatTokens(contextWindow)} (auto-compact)`,
					].filter(Boolean).join(" ");
					const model = ctx.model?.id ?? "no-model";
					const padding = " ".repeat(Math.max(2, width - visibleWidth(stats) - visibleWidth(model)));
					const lines = [
						truncateToWidth(theme.fg("dim", location), width, theme.fg("dim", "...")),
						truncateToWidth(theme.fg("dim", `${stats}${padding}${model}`), width, ""),
					];
					const statuses = [...footerData.getExtensionStatuses().values()];
					if (statuses.length > 0) lines.push(truncateToWidth(theme.fg("dim", statuses.join(" | ")), width, ""));
					return lines;
				},
			};
		});
	}
	return { requestRender: () => requestRender(), dispose: () => unsubscribe?.() };
}

/** Format token counts using Pi's compact footer convention. */
function formatTokens(count: number): string {
	if (count < 1000) return String(Math.round(count));
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export interface BlockTreeRow {
	block: CompactBlock;
	parentId?: string;
	depth: number;
	isLast: boolean;
	ancestorHasNext: boolean[];
}

/** Return the currently selected children of a block in the active tree. */
export function activeChildIds(state: PluginState, block: CompactBlock): string[] {
	return state.childBlockIdsByParent[block.blockId] ?? block.childBlockIds;
}

/** Build the visible active forest while retaining child blocks in source order. */
export function visibleBlockTree(state: PluginState, collapsed: ReadonlySet<string>): BlockTreeRow[] {
	const byId = new Map(state.blocks.map((block) => [block.blockId, block] as const));
	const rows: BlockTreeRow[] = [];
	const visit = (blockId: string, parentId: string | undefined, depth: number, isLast: boolean, ancestorHasNext: boolean[]): void => {
		const block = byId.get(blockId);
		if (!block) return;
		rows.push({ block, parentId, depth, isLast, ancestorHasNext });
		if (collapsed.has(blockId)) return;
		const childIds = activeChildIds(state, block);
		childIds.forEach((childId, index) => {
			visit(childId, blockId, depth + 1, index === childIds.length - 1, [...ancestorHasNext, !isLast]);
		});
	};
	state.topLevelBlockIds.forEach((blockId, index) => {
		visit(blockId, undefined, 0, index === state.topLevelBlockIds.length - 1, []);
	});
	return rows;
}

/** Inspect the active block hierarchy with Pi-tree-style navigation and folding. */
export async function blockTree(ctx: ExtensionContext, state: PluginState): Promise<BlockTreeRow | undefined> {
	return ctx.ui.custom<BlockTreeRow | undefined>((tui, theme, _keybindings, done) => {
		const collapsed = new Set<string>();
		let cursor = 0;
		const pageSize = 16;
		const component: Component = {
			render(width: number): string[] {
				const rows = visibleBlockTree(state, collapsed);
				if (rows.length === 0) return [theme.fg("accent", theme.bold("压缩块树")), "", theme.fg("dim", "(当前分支没有压缩块)"), "", theme.fg("dim", "Esc 退出")];
				cursor = Math.min(cursor, rows.length - 1);
				const from = Math.max(0, Math.min(cursor - Math.floor(pageSize / 2), rows.length - pageSize));
				const shown = rows.slice(from, from + pageSize);
				const lines = [theme.fg("accent", theme.bold("压缩块树")), theme.fg("dim", `${rows.length} 个块，${state.topLevelBlockIds.length} 个当前顶层根`), ""];
				for (const [offset, row] of shown.entries()) {
					const index = from + offset;
					const indent = row.ancestorHasNext.slice(0, -1).map((hasNext) => hasNext ? "│  " : "   ").join("");
					const branch = row.depth === 0 ? "" : row.isLast ? "└─ " : "├─ ";
					const fold = activeChildIds(state, row.block).length === 0 ? "  " : collapsed.has(row.block.blockId) ? "▸ " : "▾ ";
					const marker = index === cursor ? "> " : "  ";
					const prefix = `${marker}${indent}${branch}${fold}${row.block.blockId} [L${row.block.level}] `;
					const overviewWidth = Math.max(8, width - visibleWidth(prefix));
					const overview = truncateToWidth(row.block.overview, overviewWidth, "...");
					lines.push(truncateToWidth(index === cursor ? theme.fg("accent", prefix + overview) : prefix + overview, width, "..."));
				}
				const current = rows[cursor].block;
				const first = current.sourceEntryIds[0] ?? "?";
				const last = current.sourceEntryIds.at(-1) ?? "?";
				lines.push("", theme.fg("muted", `${current.blockId} · L${current.level} · ${first}..${last} · ${current.sourceTokens} tokens`));
				lines.push(...wrapTextWithAnsi(current.overview, Math.max(1, width)).map((line) => theme.fg("text", line)));
				lines.push("", theme.fg("dim", "↑↓ 浏览  ← 折叠  → 展开  Enter 操作  Esc 退出"));
				return lines;
			},
			handleInput(data: string): void {
				const rows = visibleBlockTree(state, collapsed);
				if (rows.length === 0) {
					if (matchesKey(data, Key.escape) || data === "\u0003") done(undefined);
					return;
				}
				if (matchesKey(data, Key.up)) cursor = (cursor + rows.length - 1) % rows.length;
				else if (matchesKey(data, Key.down)) cursor = (cursor + 1) % rows.length;
				else if (matchesKey(data, Key.left)) collapsed.add(rows[cursor].block.blockId);
				else if (matchesKey(data, Key.right)) collapsed.delete(rows[cursor].block.blockId);
				else if (matchesKey(data, Key.enter)) done(rows[cursor]);
				else if (matchesKey(data, Key.escape) || data === "\u0003") done(undefined);
				tui.requestRender();
			},
			invalidate(): void {},
		};
		return component;
	});
}

export interface ChoiceItem {
	id: string;
	label: string;
	value: string;
	values?: string[];
	selected?: boolean;
	editable?: boolean;
	onChange?: (item: ChoiceItem, items: ChoiceItem[]) => void;
}

/** Multi-character key data can carry pasted digits, so accept runs of numeric input. */
function isNumericInput(data: string): boolean {
	return /^[0-9.]+$/.test(data);
}

/** Show a keyboard-driven form with temporary numeric editing and preset cycling. */
export async function choiceForm<T>(ctx: ExtensionContext, title: string, items: ChoiceItem[], finish: (items: ChoiceItem[]) => T): Promise<T | undefined> {
	return ctx.ui.custom<T | undefined>((tui, theme, _keybindings, done) => {
		if (items.length === 0) {
			done(undefined);
			return { render: () => [], handleInput: () => {}, invalidate: () => {} };
		}
		let cursor = 0;
		const customValues = new Set<string>();
		const component: Component = {
			render(width: number): string[] {
				const lines = [theme.fg("accent", theme.bold(title)), ""];
				for (const [index, item] of items.entries()) {
					const marker = index === cursor ? theme.fg("accent", "> ") : "  ";
					const check = item.selected === undefined ? "" : item.selected ? "[x] " : "[ ] ";
					const editing = item.editable && index === cursor ? " _" : "";
					lines.push(`${marker}${check}${item.label}: ${theme.fg(index === cursor ? "accent" : "text", item.value)}${editing}`.slice(0, width));
				}
				lines.push("", theme.fg("dim", "↑↓ 移动  空格/Tab 切换  Enter/Ctrl+S 保存  Ctrl+C/Esc 退出"));
				return lines;
			},
			handleInput(data: string): void {
				const item = items[cursor];
				if (matchesKey(data, Key.up)) cursor = (cursor + items.length - 1) % items.length;
				else if (matchesKey(data, Key.down)) cursor = (cursor + 1) % items.length;
				else if (matchesKey(data, Key.tab)) {
					if (item.values?.length) {
						item.value = item.values[(item.values.indexOf(item.value) + 1) % item.values.length] ?? item.value;
						customValues.delete(item.id);
						item.onChange?.(item, items);
					}
				} else if (itemIsEditable(item) && (isNumericInput(data) || data === "\u007f")) {
					if (data === "\u007f") item.value = item.value.slice(0, -1);
					else {
						item.value = customValues.has(item.id) ? item.value + data : data;
						customValues.add(item.id);
					}
				} else if (data === " ") {
					if (item.selected !== undefined) item.selected = !item.selected;
					else if (item.values?.length) {
						item.value = item.values[(item.values.indexOf(item.value) + 1) % item.values.length] ?? item.value;
						customValues.delete(item.id);
						item.onChange?.(item, items);
					}
				} else if (matchesKey(data, Key.escape) || data === "\u0003") {
					done(undefined);
				}
				tui.requestRender();
			},
			invalidate(): void {},
		};
		const originalHandleInput = component.handleInput;
		component.handleInput = (data: string) => {
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("s"))) done(finish(items));
			else originalHandleInput?.(data);
		};
		return component;
	});
}

function itemIsEditable(item: ChoiceItem): boolean {
	return item.editable === true;
}

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component, visibleWidth } from "@earendil-works/pi-tui";
import type { CompressProgress } from "./compress.ts";

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

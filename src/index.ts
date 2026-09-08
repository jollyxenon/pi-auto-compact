/** Pi extension entry point. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import {
	buildSessionContext,
	estimateTokens,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { makeAdjustTool } from "./adjustTool.ts";
import { makeCompactTool } from "./compactTool.ts";
import {
	runAutoCompression,
	runTreeMerge,
	runTreeSplit,
	isCompressionAborted,
	type CompressDeps,
	type CompressOutcome,
	type CompressProgress,
} from "./compress.ts";
import { defaultConfig, loadConfig, resolveTokenLimit, saveConfig, type AutoCompactConfig } from "./config.ts";
import { makeContextGetTool } from "./contextGet.ts";
import {
	activeChildFrontier,
	activeTopBlocks,
	buildMapping,
	projectMessages,
	projectSessionEntries,
	unmatchedMessagesOutsideBlocks,
} from "./mapping.ts";
import { loadState, saveState, statePathFor } from "./state.ts";
import { createSummarizeFn } from "./summaryClient.ts";
import { freshState, type PluginState } from "./types.ts";
import { messageToText, renderBlockCard } from "./util.ts";
import {
	blockTree,
	choiceForm,
	installAutoCompactFooter,
	showCompressionProgress,
	type ChoiceItem,
	type ProjectedContextUsage,
} from "./tui.ts";

export default function autoCompactExtension(pi: ExtensionAPI) {
	const cfg = defaultConfig();
	let sessionFile: string | null = null;
	let sessionId: string | null = null;
	let sessionLeafId: string | null = null;
	let contextOverhead = 0;
	let statePath: string | null = null;
	let state = freshState();
	let queue: Promise<void> = Promise.resolve();
	let projectedUsage: ProjectedContextUsage | undefined;
	let footer: { requestRender(): void; dispose(): void } | undefined;
	let renderFooter = (): void => {};
	let lastCompressionProgress: CompressProgress | undefined;
	interface ActiveCompression {
		controller: AbortController;
		cleanup: () => void;
	}
	let activeCompression: ActiveCompression | undefined;
	let shuttingDown = false;
	let inputGuardUnsubscribe: (() => void) | undefined;

	function debugLog(message: string, details?: unknown): void {
		if (!cfg.debug) return;
		const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
		try {
			fs.appendFileSync(path.join(getAgentDir(), "pi-debug.log"), `[auto-compact] ${new Date().toISOString()} ${message}${suffix}\n`, "utf8");
		} catch {
			// Diagnostics must never change compression behavior.
		}
	}

	/** Refresh state when Pi switches, forks, resumes, or reloads a session. */
	function ensureSession(ctx: ExtensionContext): void {
		const file = ctx.sessionManager.getSessionFile() ?? null;
		const id = ctx.sessionManager.getSessionId();
		const leaf = ctx.sessionManager.getLeafId();
		if (file === sessionFile && id === sessionId && leaf === sessionLeafId) return;
		if (file !== sessionFile || id !== sessionId) {
			debugLog("session changed", { file, id, previousFile: sessionFile, previousId: sessionId });
			sessionFile = file;
			sessionId = id;
			contextOverhead = 0;
			projectedUsage = undefined;
			statePath = file ? statePathFor(file) : null;
			state = statePath ? loadState(statePath) : freshState();
		}
		sessionLeafId = leaf;
		const visible = ctx.sessionManager.buildContextEntries();
		const activeIds = activeTopBlocks(visible, state).map((block) => block.blockId);
		const activeChildren = activeChildFrontier(visible, state);
		if (activeIds.length !== state.topLevelBlockIds.length
			|| activeIds.some((blockId, index) => blockId !== state.topLevelBlockIds[index])
			|| JSON.stringify(activeChildren) !== JSON.stringify(state.childBlockIdsByParent)) {
			const next = { ...state, topLevelBlockIds: activeIds, childBlockIdsByParent: activeChildren };
			if (statePath) saveState(statePath, next);
			state = next;
		}
	}

	/** Return a stable identity for the session path being compressed. */
	function currentSessionKey(ctx: ExtensionContext): string {
		const branch = ctx.sessionManager.getBranch();
		return JSON.stringify([
			ctx.sessionManager.getSessionFile() ?? null,
			ctx.sessionManager.getSessionId(),
			ctx.sessionManager.getLeafId(),
			branch.at(-1)?.id ?? null,
		]);
	}

	/** Persist only when the asynchronous operation still belongs to this session path. */
	function commitState(next: PluginState, ctx: ExtensionContext, expectedSessionKey?: string): void {
		if (expectedSessionKey !== undefined && currentSessionKey(ctx) !== expectedSessionKey) {
			throw new Error("Session changed while compression was running; discarded the old result.");
		}
		ensureSession(ctx);
		if (statePath) saveState(statePath, next);
		state = next;
		refreshProjectedUsage(ctx);
	}

	/** Inherit only blocks fully present on a newly forked active branch. */
	function inheritForkState(previousSessionFile: string, ctx: ExtensionContext): void {
		if (!statePath || fs.existsSync(statePath)) return;
		const parent = loadState(statePathFor(previousSessionFile));
		const branchEntries = ctx.sessionManager.getBranch();
		const branchIds = new Set(branchEntries.map((entry) => entry.id));
		const parentById = new Map(parent.blocks.map((block) => [block.blockId, block] as const));
		const valid = (blockId: string) => {
			const block = parentById.get(blockId);
			return block ? branchIds.has(block.startEntryId) && branchIds.has(block.endEntryId) : false;
		};
		const parentFrontiers = parent.topLevelBlockIdsByBranch ?? { __root__: parent.topLevelBlockIds };
		const childFrontierAt = (key: string): Record<string, string[]> => {
			if (key === "__root__") return activeChildFrontier([], parent);
			const index = branchEntries.findIndex((entry) => entry.id === key);
			return activeChildFrontier(index < 0 ? branchEntries : branchEntries.slice(0, index + 1), parent);
		};
		const descend = (blockId: string, children: Record<string, string[]>): string[] => {
			if (valid(blockId)) return [blockId];
			const block = parentById.get(blockId);
			return block ? (children[blockId] ?? block.childBlockIds).flatMap((childId) => descend(childId, children)) : [];
		};
		let seedFrontier = parent.topLevelBlockIds;
		let seedKey = "__root__";
		for (let index = branchEntries.length - 1; index >= 0; index--) {
			const key = branchEntries[index]?.id ?? "";
			const candidate = parentFrontiers[key];
			if (candidate) {
				seedFrontier = candidate;
				seedKey = key;
				break;
			}
		}
		const topLevelBlockIds = seedFrontier.flatMap((id) => descend(id, childFrontierAt(seedKey)));
		const blocks = parent.blocks.filter((block) => branchIds.has(block.startEntryId) && branchIds.has(block.endEntryId));
		const topLevelBlockIdsByBranch: Record<string, string[]> = {};
		for (const [key, ids] of Object.entries(parentFrontiers)) {
			if (key !== "__root__" && !branchIds.has(key)) continue;
			const children = childFrontierAt(key);
			const frontierIds = ids.flatMap((id) => descend(id, children));
			if (frontierIds.length > 0) topLevelBlockIdsByBranch[key] = frontierIds;
		}
		const leafId = ctx.sessionManager.getLeafId() ?? "__root__";
		topLevelBlockIdsByBranch[leafId] = [...topLevelBlockIds];
		const inheritedBlockIds = new Set(blocks.map((block) => block.blockId));
		const filterChildren = (frontier: Record<string, string[]>): Record<string, string[]> => Object.fromEntries(
			Object.entries(frontier).filter(([parentId, childIds]) =>
				inheritedBlockIds.has(parentId) && childIds.every((childId) => inheritedBlockIds.has(childId))),
		);
		const parentChildFrontiers = parent.childBlockIdsByParentByBranch
			?? { __root__: parent.childBlockIdsByParent };
		const childBlockIdsByParentByBranch: Record<string, Record<string, string[]>> = {};
		for (const [key, frontierValue] of Object.entries(parentChildFrontiers)) {
			if (key !== "__root__" && !branchIds.has(key)) continue;
			childBlockIdsByParentByBranch[key] = filterChildren(frontierValue);
		}
		const childBlockIdsByParent = filterChildren(activeChildFrontier(branchEntries, parent));
		childBlockIdsByParentByBranch[leafId] = childBlockIdsByParent;
		const inherited: PluginState = {
			schemaVersion: 4,
			blocks,
			topLevelBlockIds,
			childBlockIdsByParent,
			topLevelBlockIdsByBranch,
			childBlockIdsByParentByBranch,
			nextSeq: parent.nextSeq,
		};
		saveState(statePath, inherited);
		state = inherited;
	}

	/** Estimate the total size of the block cards the projection inserts. */
	function cardEstimate(blocks: ReturnType<typeof activeTopBlocks>): number {
		return blocks.reduce(
			(sum, block) => sum + estimateTokens({ role: "user", content: renderBlockCard(block), timestamp: 0 } as AgentMessage),
			0,
		);
	}

	/** The native usage already contains block cards; keep them out of the overhead so the
	 * footer does not count them once in the overhead and once in the projection. */
	function updateOverhead(blocks: ReturnType<typeof activeTopBlocks>, nativeTokens: number, mappedRawEstimate: number): void {
		contextOverhead = Math.max(contextOverhead, nativeTokens - mappedRawEstimate - cardEstimate(blocks));
	}

	/** Recalculate the footer's context usage from the messages actually projected to the model. */
	function refreshProjectedUsage(ctx: ExtensionContext, messages?: AgentMessage[]): void {
		const visible = ctx.sessionManager.buildContextEntries();
		const rawMessages = messages ?? buildSessionContext(visible).messages;
		const mapping = buildMapping(visible, rawMessages);
		const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		if (contextWindow <= 0) {
			projectedUsage = undefined;
			renderFooter();
			return;
		}
		const blocks = activeTopBlocks(visible, state);
		const rawEstimate = rawMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
		const projectedEstimate = messages && mapping
			? projectMessages(rawMessages, mapping, blocks).reduce((sum, message) => sum + estimateTokens(message), 0)
			: projectSessionEntries(visible, blocks).reduce((sum, message) => sum + estimateTokens(message), 0);
		const nativeTokens = ctx.getContextUsage()?.tokens;
		if (nativeTokens !== undefined && nativeTokens !== null) {
			const mappedRawEstimate = messages && mapping
				? rawMessages.reduce(
					(sum, message, index) => sum + (mapping.messageEntryIds[index] === null ? 0 : estimateTokens(message)),
					0,
				)
				: rawEstimate;
			updateOverhead(blocks, nativeTokens, mappedRawEstimate);
		}
		projectedUsage = {
			tokens: contextOverhead + projectedEstimate,
			contextWindow,
		};
		renderFooter();
	}

	/** Start, update, and finish the shared compression status line. */
	function beginCompression(ctx: ExtensionContext): void {
		lastCompressionProgress = { phase: "starting", compressedTokens: 0, totalTokens: 0 };
		refreshProjectedUsage(ctx);
		debugLog("compression started", { session: sessionId });
		showCompressionProgress(ctx, lastCompressionProgress);
	}

	function updateCompression(ctx: ExtensionContext, progress: CompressProgress): void {
		lastCompressionProgress = progress;
		debugLog("compression progress", progress);
		showCompressionProgress(ctx, progress);
	}

	function finishCompression(ctx: ExtensionContext, outcome: CompressOutcome): void {
		const previous = lastCompressionProgress;
		refreshProjectedUsage(ctx);
		const latestCreated = outcome.createdBlocks?.at(-1);
		const latestActive = outcome.state ? activeTopBlocks(ctx.sessionManager.buildContextEntries(), outcome.state).at(-1) : undefined;
		const latest = latestCreated ?? latestActive ?? previous?.latestBlocks?.at(-1);
		const failed = outcome.status === "error";
		const skipped = outcome.status === "skipped";
		debugLog("compression finished", {
			status: outcome.status,
			reason: outcome.reason,
			createdBlocks: outcome.createdBlocks?.map((block) => ({ blockId: block.blockId, level: block.level })),
		});
		showCompressionProgress(ctx, {
			phase: failed ? "error" : skipped ? "skipped" : "completed",
			compressedTokens: failed || skipped ? previous?.compressedTokens ?? 0 : previous?.totalTokens ?? 0,
			totalTokens: previous?.totalTokens ?? 0,
			latestBlocks: latest ? [{ blockId: latest.blockId, level: latest.level }] : undefined,
			message: failed || skipped ? outcome.reason : undefined,
		});
	}

	function failCompression(ctx: ExtensionContext, error: unknown): void {
		finishCompression(ctx, {
			status: "error",
			reason: error instanceof Error ? error.message : String(error),
		});
	}

	/** Combine several abort sources so any one of them cancels the operation. */
	function mergedSignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
		const present = signals.filter((item): item is AbortSignal => item !== undefined);
		if (present.length === 0) return undefined;
		return present.length === 1 ? present[0] : AbortSignal.any(present);
	}

	/** Serialize state-changing operations; each gets its own abort controller so
	 * session shutdown and session-interrupt events can cancel an in-flight summary. */
	function runExclusive<T>(operation: (signal: AbortSignal) => Promise<T>, externalSignal?: AbortSignal): Promise<T> {
		const controller = new AbortController();
		const record: ActiveCompression = {
			controller,
			cleanup: () => {
				if (activeCompression === record) activeCompression = undefined;
			},
		};
		const signal = mergedSignal(controller.signal, externalSignal) ?? controller.signal;
		const run = (): Promise<T> => {
			if (shuttingDown || controller.signal.aborted) throw new Error("compression aborted");
			activeCompression = record;
			return operation(signal);
		};
		const result = queue.then(run, run);
		queue = result.then(() => undefined, () => undefined);
		return result.finally(() => record.cleanup());
	}

	function buildCompressDeps(
		ctx: ExtensionContext,
		additionalMessages: AgentMessage[] = [],
		branchEntries: SessionEntry[] = ctx.sessionManager.getBranch(),
		signal: AbortSignal | undefined = ctx.signal,
		contextEntries: SessionEntry[] = ctx.sessionManager.buildContextEntries(),
	): CompressDeps | null {
		ensureSession(ctx);
		const usage = ctx.getContextUsage();
		const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const summarizeFn = createSummarizeFn(ctx, cfg, signal, debugLog);
		if (!summarizeFn || contextWindow <= 0) return null;
		return {
			cfg,
			sessionKey: currentSessionKey(ctx),
			branchEntries,
			contextEntries,
			contextWindow,
			referenceContext: additionalMessages
				.map((message, index) => `[visible message ${index} ${message.role}]\n${messageToText(message, true)}`)
				.join("\n\n"),
			systemPrompt: ctx.getSystemPrompt(),
			estimate: estimateTokens,
			onProgress: (progress) => updateCompression(ctx, progress),
			summarizeFn,
			signal,
		};
	}

	/** Run the complete automatic state machine and commit only its final state. */
	async function executeAutoCompression(
		ctx: ExtensionContext,
		branchEntries?: SessionEntry[],
		signal?: AbortSignal,
		additionalMessages: AgentMessage[] = [],
		contextEntries?: SessionEntry[],
		expectedSessionKey?: string,
	): Promise<CompressOutcome> {
		try {
			return await runExclusive(async (operationSignal) => {
				beginCompression(ctx);
				if (expectedSessionKey !== undefined && currentSessionKey(ctx) !== expectedSessionKey) {
					const outcome = { status: "skipped" as const, reason: "Session changed before compression started; discarded the stale request." };
					finishCompression(ctx, outcome);
					return outcome;
				}
				const deps = buildCompressDeps(ctx, additionalMessages, branchEntries, operationSignal, contextEntries);
				if (!deps) {
					const outcome = { status: "error" as const, reason: "No active model or context window is available." };
					finishCompression(ctx, outcome);
					return outcome;
				}
				try {
					const outcome = await runAutoCompression(deps, state);
					if (outcome.state) commitState(outcome.state, ctx, deps.sessionKey);
					finishCompression(ctx, outcome);
					return outcome;
				} catch (error) {
					if (isCompressionAborted(error, deps.signal)) {
						const outcome = { status: "skipped" as const, reason: "压缩已中断，未提交部分结果。" };
						finishCompression(ctx, outcome);
						return outcome;
					}
					throw error;
				}
			}, signal);
		} catch (error) {
			if (isCompressionAborted(error)) {
				const outcome = { status: "skipped" as const, reason: "压缩已中断，未提交部分结果。" };
				finishCompression(ctx, outcome);
				return outcome;
			}
			failCompression(ctx, error);
			throw error;
		}
	}

	function reloadConfig(ctx: ExtensionContext): void {
		const loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		Object.assign(cfg, loaded);
		debugLog("configuration loaded", loaded);
	}

	function notifyError(ctx: ExtensionContext, prefix: string, error: unknown): void {
		if (ctx.hasUI) ctx.ui.notify(`${prefix}: ${error instanceof Error ? error.message : String(error)}`, "error");
	}

	function limitMode(limit: { mode: "tokens" | "percent" }): string {
		return limit.mode === "percent" ? "百分比" : "绝对值";
	}

	pi.registerCommand("auto-compact", {
		description: "Compress all currently uncompressed complete ranges before the protected recent tail",
		handler: async (_args, ctx) => {
			try {
				const outcome = await executeAutoCompression(ctx);
				if (outcome.state) {
					ctx.ui.notify(`已完成自动压缩，生成或提升 ${outcome.createdBlocks?.length ?? 0} 个块`, "info");
				} else {
					ctx.ui.notify(outcome.reason ?? "没有可压缩内容", "info");
				}
			} catch (error) {
				failCompression(ctx, error);
				notifyError(ctx, "auto-compact", error);
			}
		},
	});

	pi.registerCommand("auto-compact-blocks", {
		description: "Inspect the active auto-compact block tree and split or merge its roots",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			ensureSession(ctx);
			const selected = await blockTree(ctx, state);
			if (!selected) return;
			const block = selected.block;
			const action = await ctx.ui.select(`${block.blockId} [L${block.level}]\n${block.overview}\n\n选择操作`, ["合并相邻兄弟块", "拆分此块", "返回"]);
			if (!action || action === "返回") return;
			const parent = selected.parentId
				? state.blocks.find((candidate) => candidate.blockId === selected.parentId)
				: undefined;
			const siblingIds = parent
				? state.childBlockIdsByParent[parent.blockId] ?? parent.childBlockIds
				: state.topLevelBlockIds;
			if (action === "合并相邻兄弟块") {
				const choices = siblingIds.map((id) => {
					const sibling = state.blocks.find((candidate) => candidate.blockId === id);
					return { id, label: `${id} [L${sibling?.level ?? 0}] ${sibling?.overview ?? ""}`, value: "选择", selected: id === block.blockId };
				});
				const selectedIds = await choiceForm(ctx, "选择要合并的连续同级兄弟块", choices, (items) => items.filter((item) => item.selected).map((item) => item.id));
				if (!selectedIds?.length) return;
				await runExclusive(async (operationSignal) => {
					beginCompression(ctx);
					const deps = buildCompressDeps(ctx, [], undefined, operationSignal);
					if (!deps) throw new Error("没有可用的模型或上下文窗口");
					try {
						const outcome = await runTreeMerge(deps, state, selected.parentId, selectedIds);
						if (!outcome.state) throw new Error(outcome.reason);
						commitState(outcome.state, ctx, deps.sessionKey);
						finishCompression(ctx, outcome);
					} catch (error) {
						if (isCompressionAborted(error, operationSignal)) {
							finishCompression(ctx, { status: "skipped", reason: "压缩已中断" });
							return;
						}
						failCompression(ctx, error);
						throw error;
					}
				}, ctx.signal);
				ctx.ui.notify(`已合并 ${selectedIds.join(", ")}`, "info");
				return;
			}
			await runExclusive(async (operationSignal) => {
				beginCompression(ctx);
				const deps = buildCompressDeps(ctx, [], undefined, operationSignal);
				if (!deps) throw new Error("没有可用的模型或上下文窗口");
				try {
					const outcome = await runTreeSplit(deps, state, selected.parentId, block.blockId);
					if (!outcome.state) throw new Error(outcome.reason);
					commitState(outcome.state, ctx, deps.sessionKey);
					finishCompression(ctx, outcome);
				} catch (error) {
					if (isCompressionAborted(error, operationSignal)) {
						finishCompression(ctx, { status: "skipped", reason: "压缩已中断" });
						return;
					}
					failCompression(ctx, error);
					throw error;
				}
			}, ctx.signal);
			ctx.ui.notify(`已拆分 ${block.blockId}`, "info");
		},
	});

	// Editing the configuration uses the same keyboard form: Space cycles values and Enter saves all changes.
	pi.registerCommand("auto-compact-config", {
		description: "Configure auto-compact settings",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			try {
				reloadConfig(ctx);
				const items: ChoiceItem[] = [
					{ id: "enabled", label: "自动压缩", value: cfg.enabled ? "开启" : "关闭", values: ["开启", "关闭"] },
					{ id: "triggerMode", label: "触发阈值单位", value: limitMode(cfg.trigger), values: ["百分比", "绝对值"], onChange: (item, all) => { const value = all.find((candidate) => candidate.id === "triggerValue"); if (value) { value.values = item.value === "百分比" ? ["60", "70", "80"] : ["100000", "150000", "200000"]; value.value = value.values[0] ?? value.value; } } },
					{ id: "triggerValue", label: "触发阈值数值", value: cfg.trigger.mode === "percent" ? String(Math.round(cfg.trigger.value * 100)) : String(cfg.trigger.value), values: cfg.trigger.mode === "percent" ? ["60", "70", "80"] : ["100000", "150000", "200000"], editable: true },
					{ id: "keepRecentMode", label: "保留最近内容单位", value: limitMode(cfg.keepRecent), values: ["百分比", "绝对值"], onChange: (item, all) => { const value = all.find((candidate) => candidate.id === "keepRecentValue"); if (value) { value.values = item.value === "百分比" ? ["5", "10", "15"] : ["5000", "10000", "15000"]; value.value = value.values[0] ?? value.value; } } },
					{ id: "keepRecentValue", label: "保留最近内容数值", value: cfg.keepRecent.mode === "percent" ? String(Math.round(cfg.keepRecent.value * 100)) : String(cfg.keepRecent.value), values: cfg.keepRecent.mode === "percent" ? ["5", "10", "15"] : ["5000", "10000", "15000"], editable: true },
					{ id: "blockTokenCeiling", label: "压缩块上限", value: String(cfg.blockTokenCeiling), values: ["1000", "2000", "4000", "8000"], editable: true },
					{ id: "blockMergeThreshold", label: "连续块合并数量", value: String(cfg.blockMergeThreshold), values: ["2", "3", "4", "5"], editable: true },
					{ id: "maxBlocksEnabled", label: "顶层块数量限制", value: cfg.maxBlocks.enabled ? "开启" : "关闭", values: ["开启", "关闭"] },
					{ id: "maxBlocksValue", label: "顶层块数量", value: String(cfg.maxBlocks.value), values: ["4", "8", "12", "16"], editable: true },
					{ id: "debug", label: "运行时调试日志", value: cfg.debug ? "开启" : "关闭", values: ["开启", "关闭"] },
				];
				const result = await choiceForm(ctx, "auto-compact 设置", items, (changed) => changed);
				if (!result) return;
				const get = (id: string) => result.find((item) => item.id === id)?.value ?? "";
				const mode = (id: string): "percent" | "tokens" => get(id) === "百分比" ? "percent" : "tokens";
				const next: AutoCompactConfig = {
					...cfg,
					enabled: get("enabled") === "开启",
					trigger: { mode: mode("triggerMode"), value: Number(get("triggerValue")) / (mode("triggerMode") === "percent" ? 100 : 1) },
					keepRecent: { mode: mode("keepRecentMode"), value: Number(get("keepRecentValue")) / (mode("keepRecentMode") === "percent" ? 100 : 1) },
					blockTokenCeiling: Number(get("blockTokenCeiling")),
					blockMergeThreshold: Number(get("blockMergeThreshold")),
					maxBlocks: { enabled: get("maxBlocksEnabled") === "开启", value: Number(get("maxBlocksValue")) },
					debug: get("debug") === "开启",
				};
				saveConfig(ctx.cwd, ctx.isProjectTrusted(), next);
				Object.assign(cfg, next);
				ctx.ui.notify("auto-compact 设置已保存并生效", "info");
			} catch (error) {
				ctx.ui.notify(`auto-compact 设置无效: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	// Native /compact is deliberately disabled for manual requests. Automatic
	// threshold and overflow requests run the same sliding plugin pass.
	pi.on("session_before_compact", async (event, ctx) => {
		if (!cfg.enabled && event.reason !== "manual") return;
		if (event.reason === "manual") {
			if (ctx.hasUI) ctx.ui.notify("Pi 原生 /compact 已禁用；请使用 /auto-compact 或 compact_context。", "warning");
			return { cancel: true };
		}
		// 插件始终接管 threshold/overflow 压缩；即使失败也取消原生行为，不回退原生 compact。
		try {
			const operationKey = currentSessionKey(ctx);
			const outcome = await executeAutoCompression(ctx, event.branchEntries, event.signal, [], ctx.sessionManager.buildContextEntries(), operationKey);
			if (outcome.status === "error" && ctx.hasUI) {
				ctx.ui.notify(`auto-compact: ${outcome.reason ?? "压缩失败"}，旧上下文保持不变`, "error");
			}
		} catch (error) {
			failCompression(ctx, error);
			if (ctx.hasUI) {
				ctx.ui.notify(`auto-compact: ${error instanceof Error ? error.message : String(error)}，旧上下文保持不变`, "error");
			}
		}
		return { cancel: true };
	});

	pi.on("session_tree", (_event, ctx) => {
		ensureSession(ctx);
		projectedUsage = undefined;
		refreshProjectedUsage(ctx);
	});

	/** Let Esc cancel idle-command compression, and block /reload while it runs. */
	function installCompressionInputGuard(ctx: ExtensionContext): void {
		inputGuardUnsubscribe?.();
		inputGuardUnsubscribe = undefined;
		if (!ctx.hasUI) return;
		inputGuardUnsubscribe = ctx.ui.onTerminalInput((data) => {
			if (!activeCompression) return undefined;
			if (matchesKey(data, Key.escape)) {
				activeCompression.controller.abort();
				return { consume: true };
			}
			if (!/[\r\n]/.test(data)) return undefined;
			if (ctx.ui.getEditorText().trim() !== "/reload") return undefined;
			ctx.ui.notify("压缩进行中，已取消 /reload。", "warning");
			return { consume: true };
		});
	}

	pi.on("session_before_tree", (_event, ctx) => {
		if (activeCompression) {
			activeCompression.controller.abort();
			if (ctx.hasUI) ctx.ui.notify("压缩进行中，已取消 tree 导航。", "warning");
			return { cancel: true };
		}
	});

	pi.on("session_before_fork", (_event, ctx) => {
		if (activeCompression) {
			activeCompression.controller.abort();
			if (ctx.hasUI) ctx.ui.notify("压缩进行中，已取消 fork/clone。", "warning");
			return { cancel: true };
		}
	});

	pi.on("session_before_switch", (_event, ctx) => {
		if (activeCompression) {
			activeCompression.controller.abort();
			if (ctx.hasUI) ctx.ui.notify("压缩进行中，已取消 new/resume。", "warning");
			return { cancel: true };
		}
	});

	pi.on("model_select", (_event, ctx) => {
		contextOverhead = 0;
		projectedUsage = undefined;
		refreshProjectedUsage(ctx);
	});

	pi.on("session_start", (event, ctx) => {
		shuttingDown = false;
		ensureSession(ctx);
		footer?.dispose();
		footer = installAutoCompactFooter(ctx, () => projectedUsage);
		renderFooter = () => footer?.requestRender();
		installCompressionInputGuard(ctx);
		if (event.reason === "fork" && event.previousSessionFile) {
			try {
				inheritForkState(event.previousSessionFile, ctx);
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`auto-compact fork 状态继承失败: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}
		try {
			reloadConfig(ctx);
			refreshProjectedUsage(ctx);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`auto-compact 配置无效: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	// Footer 在 session_start 重新安装；会话退出时释放订阅，避免渲染回调引用旧实例。
	pi.on("session_shutdown", (event) => {
		shuttingDown = true;
		activeCompression?.controller.abort();
		inputGuardUnsubscribe?.();
		inputGuardUnsubscribe = undefined;
		footer?.dispose();
		footer = undefined;
	});

	pi.on("context", async (event, ctx) => {
		ensureSession(ctx);
		const visible = ctx.sessionManager.buildContextEntries();
		const mapping = buildMapping(visible, event.messages);
		const unmatched = mapping.messageEntryIds.filter((id) => id === null).length;
		const blocks = activeTopBlocks(visible, state);
		const outsideInjected = unmatchedMessagesOutsideBlocks(event.messages, mapping, blocks);
		if (unmatched > 0) {
			debugLog("context mapping left unmatched messages", {
				unmatched,
				discardedInsideCompactEnvelope: unmatched - outsideInjected.length,
				total: event.messages.length,
			});
		}
		const projected = projectMessages(event.messages, mapping, blocks);
		if (!cfg.enabled) return { messages: projected };
		const usage = ctx.getContextUsage();
		const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		if (window <= 0) return { messages: projected };
		const mappedRawEstimate = event.messages.reduce(
			(sum, message, index) => sum + (mapping.messageEntryIds[index] === null ? 0 : estimateTokens(message)),
			0,
		);
		const projectedEstimate = projected.reduce((sum, message) => sum + estimateTokens(message), 0);
		const usageTokens = usage?.tokens;
		if (usageTokens !== undefined && usageTokens !== null) {
			updateOverhead(blocks, usageTokens, mappedRawEstimate);
		}
		projectedUsage = { tokens: contextOverhead + projectedEstimate, contextWindow: window };
		renderFooter();
		const projectedTokens = projectedUsage.tokens;
		const trigger = resolveTokenLimit(cfg.trigger, window);
		debugLog("context projected", { projectedTokens, trigger, window, messageCount: event.messages.length });
		if (projectedTokens < trigger && projectedTokens < window) return { messages: projected };

		const additionalMessages = outsideInjected;
		const operationKey = currentSessionKey(ctx);
		try {
			const outcome = await executeAutoCompression(ctx, undefined, ctx.signal, additionalMessages, visible, operationKey);
			if (outcome.status === "error" && ctx.hasUI) {
				ctx.ui.notify(`auto-compact: ${outcome.reason ?? "压缩失败"}，旧上下文保持不变`, "error");
			}
		} catch (error) {
			failCompression(ctx, error);
			if (ctx.hasUI) {
				ctx.ui.notify(`auto-compact: ${error instanceof Error ? error.message : String(error)}，旧上下文保持不变`, "error");
			}
		}

		try {
			if (currentSessionKey(ctx) !== operationKey) return;

			// The state may have changed while summaries were generated. Rebuild the
			// projection from the current branch before returning it to Pi.
			const refreshedVisible = ctx.sessionManager.buildContextEntries();
			const refreshedMapping = buildMapping(refreshedVisible, event.messages);
			const refreshedProjected = projectMessages(event.messages, refreshedMapping, activeTopBlocks(refreshedVisible, state));
			projectedUsage = {
				tokens: contextOverhead + refreshedProjected.reduce((sum, message) => sum + estimateTokens(message), 0),
				contextWindow: window,
			};
			renderFooter();
			return { messages: refreshedProjected };
		} catch (error) {
			// 投影失败时退回压缩前已算好的投影，而不是静默把未压缩原文交给模型。
			debugLog("context reprojection failed", { error: error instanceof Error ? error.message : String(error) });
			return { messages: projected };
		}
	});

	const shared = {
		beginCompression,
		getState: (ctx: ExtensionContext) => {

			ensureSession(ctx);
			return state;
		},
		commitState,
		buildCompressDeps,
		runExclusive,
		finishCompression,
		failCompression,
	};
	pi.registerTool(makeContextGetTool({ cfg, getState: shared.getState }));
	pi.registerTool(makeCompactTool(shared));
	pi.registerTool(makeAdjustTool({ cfg, ...shared }));
}

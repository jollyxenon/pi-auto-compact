/** Atomic hierarchical compaction operations. No function mutates its input state. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveTokenLimit, type AutoCompactConfig } from "./config.ts";
import { activeTopBlocks } from "./mapping.ts";
import {
	buildSummarizePrompt,
	cardTokensFor,
	rewriteInstruction,
	SUMMARIZER_SYSTEM_PROMPT,
	validateSummary,
} from "./summarizer.ts";
import type { CompactBlock, PluginState, SummarizeInput } from "./types.ts";
import { nextBlockId, renderBlockCard, serializeEntry, type TokenEstimator } from "./util.ts";

export interface CompressProgress {
	phase: "starting" | "compressing" | "completed" | "skipped" | "error";
	compressedTokens: number;
	totalTokens: number;
	latestBlocks?: Array<{ blockId: string; level: number }>;
	message?: string;
}

export interface CompressDeps {
	cfg: AutoCompactConfig;
	/** Session identity captured before asynchronous summary work begins. */
	sessionKey?: string;
	/** Full active branch, retained for goal identity and source provenance. */
	branchEntries: SessionEntry[];
	/** Current Pi context-visible entries; defaults to the full branch for tests/callers. */
	contextEntries?: SessionEntry[];
	/** Stable ID of the session's first user goal when older native compaction hid it. */
	goalEntryId?: string;
	contextWindow: number;
	referenceContext: string;
	estimate: TokenEstimator;
	onProgress?: (progress: CompressProgress) => void;
	summarizeFn: (prompt: string) => Promise<string>;
	/** Per-operation memo of serialized entry text and its token estimate; filled lazily. */
	entryCache?: Map<string, { text: string; tokens: number }>;
}

export interface CompressOutcome {
	status: "created" | "adjusted" | "skipped" | "error";
	state?: PluginState;
	createdBlocks?: CompactBlock[];
	reason?: string;
}

interface EntryIndex {
	positions: Map<string, number>;
	tokens: number[];
	cumulative: number[];
}

/** Serialize an entry once per operation; candidate searches reuse the same entries many times. */
function cachedEntry(deps: CompressDeps, entry: SessionEntry): { text: string; tokens: number } {
	if (!deps.entryCache) deps.entryCache = new Map();
	const cache = deps.entryCache;
	const existing = cache.get(entry.id);
	if (existing) return existing;
	const text = serializeEntry(entry, true).text;
	const tokens = deps.estimate({ role: "user", content: text, timestamp: 0 } as AgentMessage);
	const value = { text, tokens };
	cache.set(entry.id, value);
	return value;
}

function entryIndex(deps: CompressDeps, entries: SessionEntry[]): EntryIndex {
	const positions = new Map<string, number>();
	const tokens: number[] = [];
	const cumulative: number[] = [];
	let total = 0;
	entries.forEach((entry, index) => {
		positions.set(entry.id, index);
		const count = cachedEntry(deps, entry).tokens;
		tokens.push(count);
		total += count;
		cumulative.push(total);
	});
	return { positions, tokens, cumulative };
}

function rangeTokens(index: EntryIndex, from: number, to: number): number {
	return index.cumulative[to] - (from > 0 ? index.cumulative[from - 1] : 0);
}

interface ReferencePart {
	text: string;
	order: number;
	priority: number;
	rank: number;
}

interface PreparedInput {
	input: SummarizeInput;
	fits: boolean;
}

const SUMMARY_REWRITE_RESERVE = 256;

/** Return the context-visible path, reconstructing Pi's native compaction projection when needed. */
function currentContextEntries(deps: CompressDeps): SessionEntry[] {
	if (deps.contextEntries) return deps.contextEntries;
	const branch = deps.branchEntries;
	let compactionIndex = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		if (branch[index]?.type === "compaction") {
			compactionIndex = index;
			break;
		}
	}
	if (compactionIndex < 0) return branch;
	const compaction = branch[compactionIndex];
	if (compaction?.type !== "compaction") return branch;
	const firstKeptIndex = branch.findIndex((entry, index) => index < compactionIndex && entry.id === compaction.firstKeptEntryId);
	return [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
}

/** Select source entries that are currently visible and eligible for plugin compression. */
function sourceEntries(deps: CompressDeps): SessionEntry[] {
	return currentContextEntries(deps).filter((entry) => entry.type !== "compaction");
}

/** Resolve the immutable session goal even when a native compaction hid it. */
function sessionGoalId(deps: CompressDeps): string | undefined {
	return deps.goalEntryId ?? firstGoalEntryId(deps.branchEntries);
}

/** Estimate a plain text fragment with the same estimator used for messages. */
function estimateTextTokens(deps: CompressDeps, text: string): number {
	return deps.estimate({ role: "user", content: text, timestamp: 0 } as AgentMessage);
}

/** Reserve enough room for the generated card and one structural rewrite. */
function summaryRequestTokensForPrompt(deps: CompressDeps, prompt: string, budgetTokens: number): number {
	return estimateTextTokens(deps, SUMMARIZER_SYSTEM_PROMPT)
		+ estimateTextTokens(deps, prompt)
		+ Math.max(budgetTokens * 2, 2048)
		+ SUMMARY_REWRITE_RESERVE;
}

/** Estimate the complete request that would be sent to the summary model. */
function summaryRequestTokens(deps: CompressDeps, input: SummarizeInput): number {
	return summaryRequestTokensForPrompt(deps, buildSummarizePrompt(input), input.budgetTokens);
}

/** A cut point is immediately before the next user or assistant message. */
export function isTurnBoundary(entries: SessionEntry[], index: number): boolean {
	if (index < 0 || index >= entries.length - 1) return false;
	const next = entries[index + 1];
	return next.type === "message"
		&& (next.message.role === "user" || next.message.role === "assistant");
}

function firstGoalEntryId(entries: SessionEntry[]): string | undefined {
	return entries.find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
}

/** Collect complete reference entries and block cards without including the target.
 * The protected tail stays eligible as background; only the request budget shrinks it. */
function collectReferenceParts(
	deps: CompressDeps,
	state: PluginState,
	excludedSourceIds: Set<string>,
	excludedBlockIds: Set<string>,
): ReferencePart[] {
	const entries = sourceEntries(deps);
	const visibleEntries = currentContextEntries(deps);
	const positions = new Map(entries.map((entry, index) => [entry.id, index] as const));
	const visiblePositions = new Map(visibleEntries.map((entry, index) => [entry.id, index] as const));
	const topBlocks = activeTopBlocks(entries, state);
	const byFirstSource = new Map(topBlocks.map((block) => [block.sourceEntryIds[0], block] as const));
	const occupied = new Set(topBlocks.flatMap((block) => block.sourceEntryIds));
	const goalId = sessionGoalId(deps);
	const parts: ReferencePart[] = [];

	const add = (text: string, order: number, priority: number, rank: number): void => {
		if (text.trim()) parts.push({ text, order, priority, rank });
	};

	for (const entry of visibleEntries) {
		if (entry.type === "compaction") {
			add(cachedEntry(deps, entry).text, visiblePositions.get(entry.id) ?? 0, 0, 0);
			continue;
		}
		const order = positions.get(entry.id) ?? visiblePositions.get(entry.id) ?? 0;
		if (excludedSourceIds.has(entry.id)) continue;
		const block = byFirstSource.get(entry.id);
		if (block) {
			if (!excludedBlockIds.has(block.blockId)) add(renderBlockCard(block), order, 1, order);
			continue;
		}
		if (occupied.has(entry.id)) continue;

		let priority = 3;
		let rank = order;
		if (entry.id === goalId) {
			priority = 0;
			rank = 0;
		}
		add(cachedEntry(deps, entry).text, order, priority, rank);
	}

	if (!entries.some((entry) => entry.id === goalId)) {
		const hiddenGoal = deps.branchEntries.find((entry) => entry.id === goalId);
		if (hiddenGoal) add(cachedEntry(deps, hiddenGoal).text, -1, 0, -1);
	}

	if (deps.referenceContext.trim()) {
		add(deps.referenceContext, entries.length + 1, 0, 1);
	}
	return parts;
}

/** Join selected reference fragments back into their original source order. */
function joinReferenceParts(parts: ReferencePart[]): string {
	return [...parts]
		.sort((left, right) => left.order - right.order)
		.map((part) => part.text)
		.join("\n\n");
}

/** Keep reference context within the request budget at complete entry/card boundaries. */
function fitReferenceContext(
	deps: CompressDeps,
	state: PluginState,
	excludedSourceIds: Set<string>,
	excludedBlockIds: Set<string>,
	makeInput: (referenceContext: string) => SummarizeInput,
	boundReference = true,
): { text: string; fits: boolean } {
	const parts = collectReferenceParts(deps, state, excludedSourceIds, excludedBlockIds);
	const complete = joinReferenceParts(parts);
	if (!boundReference) {
		return {
			text: complete,
			fits: summaryRequestTokens(deps, makeInput(complete)) <= deps.contextWindow,
		};
	}
	if (summaryRequestTokens(deps, makeInput(complete)) <= deps.contextWindow) {
		return { text: complete, fits: true };
	}

	const empty = makeInput("");
	const emptyTokens = summaryRequestTokens(deps, empty);
	if (emptyTokens > deps.contextWindow) return { text: "", fits: false };

	const available = deps.contextWindow - emptyTokens;
	const ranked = [...parts].sort((left, right) =>
		left.priority - right.priority || left.rank - right.rank || left.order - right.order,
	);
	const selected: ReferencePart[] = [];
	let selectedTokens = 0;
	for (const part of ranked) {
		const partTokens = estimateTextTokens(deps, part.text) + 1;
		if (selectedTokens + partTokens > available) continue;
		selected.push(part);
		selectedTokens += partTokens;
	}

	let text = joinReferenceParts(selected);
	while (selected.length > 0 && summaryRequestTokens(deps, makeInput(text)) > deps.contextWindow) {
		selected.pop();
		text = joinReferenceParts(selected);
	}
	return { text, fits: summaryRequestTokens(deps, makeInput(text)) <= deps.contextWindow };
}

/** Build a summary input and bound only its non-target reference context. */
function prepareInput(
	deps: CompressDeps,
	state: PluginState,
	base: Omit<SummarizeInput, "referenceContext">,
	excludedSourceIds: Set<string>,
	excludedBlockIds: Set<string>,
	boundReference = true,
): PreparedInput {
	const makeInput = (referenceContext: string): SummarizeInput => ({ ...base, referenceContext });
	const reference = fitReferenceContext(deps, state, excludedSourceIds, excludedBlockIds, makeInput, boundReference);
	return { input: makeInput(reference.text), fits: reference.fits };
}


async function summarizeBlock(
	deps: CompressDeps,
	state: PluginState,
	input: SummarizeInput,
): Promise<{ block?: CompactBlock; error?: string }> {
	const prompt = buildSummarizePrompt(input);
	const firstRequestTokens = summaryRequestTokensForPrompt(deps, prompt, input.budgetTokens);
	if (firstRequestTokens > deps.contextWindow) {
		return { error: `summary request needs about ${firstRequestTokens} tokens, window is ${deps.contextWindow}` };
	}
	let summary = (await deps.summarizeFn(prompt)).trim();
	let cardTokens = cardTokensFor(state.nextSeq, input, summary, deps.estimate);
	let validation = validateSummary(summary, cardTokens, input.budgetTokens);
	if (!validation.ok) {
		const rewritePrompt = prompt + rewriteInstruction(validation);
		const rewriteRequestTokens = summaryRequestTokensForPrompt(deps, rewritePrompt, input.budgetTokens);
		if (rewriteRequestTokens > deps.contextWindow) {
			return { error: `summary rewrite needs about ${rewriteRequestTokens} tokens, window is ${deps.contextWindow}` };
		}
		summary = (await deps.summarizeFn(rewritePrompt)).trim();
		cardTokens = cardTokensFor(state.nextSeq, input, summary, deps.estimate);
		validation = validateSummary(summary, cardTokens, input.budgetTokens);
	}
	if (!validation.ok) return { error: validation.problems.join("; ") };
	return {
		block: {
			blockId: nextBlockId(state.nextSeq),
			level: input.level,
			sourceEntryIds: [...input.sourceEntryIds],
			childBlockIds: [...input.childBlockIds],
			summary,
			createdAt: new Date().toISOString(),
			sourceTokens: input.sourceTokens,
			cardTokens,
		},
	};
}

function addTopBlock(state: PluginState, block: CompactBlock, positions: Map<string, number>): PluginState {
	const byId = new Map(state.blocks.map((item) => [item.blockId, item] as const));
	const top = [...state.topLevelBlockIds, block.blockId].sort((left, right) => {
		const a = left === block.blockId ? block : byId.get(left);
		const b = right === block.blockId ? block : byId.get(right);
		return (positions.get(a?.sourceEntryIds[0] ?? "") ?? Number.MAX_SAFE_INTEGER)
			- (positions.get(b?.sourceEntryIds[0] ?? "") ?? Number.MAX_SAFE_INTEGER);
	});
	return {
		schemaVersion: 1,
		blocks: [...state.blocks, block],
		topLevelBlockIds: top,
		topLevelBlockIdsByBranch: state.topLevelBlockIdsByBranch,
		nextSeq: state.nextSeq + 1,
	};
}

function replaceTopGroup(state: PluginState, groupIds: string[], merged: CompactBlock): PluginState {
	const indexes = groupIds.map((id) => state.topLevelBlockIds.indexOf(id));
	const first = Math.min(...indexes);
	const last = Math.max(...indexes);
	const expected = state.topLevelBlockIds.slice(first, last + 1);
	if (expected.length !== groupIds.length || expected.some((id, index) => id !== groupIds[index])) {
		throw new Error("blocks to promote must be adjacent top-level blocks");
	}
	return {
		schemaVersion: 1,
		blocks: [...state.blocks, merged],
		topLevelBlockIds: [
			...state.topLevelBlockIds.slice(0, first),
			merged.blockId,
			...state.topLevelBlockIds.slice(last + 1),
		],
		topLevelBlockIdsByBranch: state.topLevelBlockIdsByBranch,
		nextSeq: state.nextSeq + 1,
	};
}

function validateMergeGroup(deps: CompressDeps, state: PluginState, groupIds: string[]): CompactBlock[] | string {
	const k = deps.cfg.blockMergeThreshold;
	if (groupIds.length < 1 || groupIds.length > k) return `choose between 1 and ${k} blocks`;
	const topIndexes = groupIds.map((id) => state.topLevelBlockIds.indexOf(id));
	if (topIndexes.some((index) => index < 0)) return "all blocks must be top-level";
	const first = Math.min(...topIndexes);
	if (topIndexes.some((index, offset) => index !== first + offset)) return "blocks must be adjacent and ordered";
	const byId = new Map(state.blocks.map((block) => [block.blockId, block] as const));
	const blocks = groupIds.map((id) => byId.get(id));
	if (blocks.some((block) => !block)) return "block not found";
	const concrete = blocks as CompactBlock[];
	if (concrete.some((block) => block.level !== concrete[0].level)) return "blocks must have the same level";
	const entries = sourceEntries(deps);
	const positions = new Map(entries.map((entry, index) => [entry.id, index] as const));
	for (let i = 1; i < concrete.length; i++) {
		const previous = positions.get(concrete[i - 1].sourceEntryIds.at(-1) ?? "");
		const current = positions.get(concrete[i].sourceEntryIds[0]);
		if (previous === undefined || current !== previous + 1) return "blocks must cover contiguous source entries";
	}
	return concrete;
}

async function promoteGroup(
	deps: CompressDeps,
	state: PluginState,
	groupIds: string[],
	focus?: string,
	boundReference = false,
): Promise<{ state?: PluginState; block?: CompactBlock; error?: string }> {
	const checked = validateMergeGroup(deps, state, groupIds);
	if (typeof checked === "string") return { error: checked };
	const sourceEntryIds = checked.flatMap((block) => block.sourceEntryIds);
	const sourceTokens = checked.reduce((sum, block) => sum + block.sourceTokens, 0);
	const base: Omit<SummarizeInput, "referenceContext"> = {
		targetRange: checked.map((block) => `[${block.blockId} level ${block.level}]\n${block.summary}`).join("\n\n"),
		sourceEntryIds,
		sourceTokens,
		level: checked[0].level + 1,
		childBlockIds: checked.map((block) => block.blockId),
		budgetTokens: deps.cfg.blockTokenCeiling,
		focus,
	};
	const prepared = prepareInput(
		deps,
		state,
		base,
		new Set(sourceEntryIds),
		new Set(checked.map((block) => block.blockId)),
		boundReference,
	);
	if (!prepared.fits) return { error: `summary request needs about more than the available context window (${deps.contextWindow} tokens)` };
	const result = await summarizeBlock(deps, state, prepared.input);
	if (!result.block) return { error: result.error ?? "summary failed" };
	return { state: replaceTopGroup(state, groupIds, result.block), block: result.block };
}

interface SameLevelRun {
	start: number;
	ids: string[];
	level: number;
}

function sameLevelRuns(state: PluginState, entries: SessionEntry[]): SameLevelRun[] {
	const byId = new Map(state.blocks.map((block) => [block.blockId, block] as const));
	const positions = new Map(entries.map((entry, index) => [entry.id, index] as const));
	const runs: SameLevelRun[] = [];
	let start = 0;
	while (start < state.topLevelBlockIds.length) {
		const firstBlock = byId.get(state.topLevelBlockIds[start]);
		if (!firstBlock) break;
		const level = firstBlock.level;
		let end = start + 1;
		let previous = firstBlock;
		while (end < state.topLevelBlockIds.length) {
			const current = byId.get(state.topLevelBlockIds[end]);
			const previousEnd = positions.get(previous.sourceEntryIds.at(-1) ?? "");
			const currentStart = positions.get(current?.sourceEntryIds[0] ?? "");
			if (!current || current.level !== level || previousEnd === undefined || currentStart !== previousEnd + 1) break;
			previous = current;
			end++;
		}
		runs.push({ start, level, ids: state.topLevelBlockIds.slice(start, end) });
		start = end;
	}
	return runs;
}

/** Apply k+1 cascading and optional maxBlocks pressure entirely in temporary state. */
async function stabilize(
	deps: CompressDeps,
	initial: PluginState,
	boundReference = false,
): Promise<{ state?: PluginState; blocks: CompactBlock[]; error?: string }> {
	let state = initial;
	const created: CompactBlock[] = [];
	const k = deps.cfg.blockMergeThreshold;
	if (k < 2) return { blocks: [], error: "blockMergeThreshold must be at least 2" };
	for (;;) {
		const automatic = sameLevelRuns(state, sourceEntries(deps)).find((run) => run.ids.length >= k + 1);
		if (automatic) {
			const promoted = await promoteGroup(deps, state, automatic.ids.slice(0, k), undefined, boundReference);
			if (!promoted.state || !promoted.block) return { blocks: created, error: promoted.error };
			state = promoted.state;
			created.push(promoted.block);
			continue;
		}
		const max = deps.cfg.maxBlocks;
		if (!max.enabled || state.topLevelBlockIds.length <= max.value) return { state, blocks: created };

		const runs = sameLevelRuns(state, sourceEntries(deps));
		const reducible = runs.find((run) => run.ids.length >= 2);
		if (reducible) {
			const promoted = await promoteGroup(deps, state, reducible.ids.slice(0, Math.min(k, reducible.ids.length)), undefined, boundReference);
			if (!promoted.state || !promoted.block) return { blocks: created, error: promoted.error };
			state = promoted.state;
			created.push(promoted.block);
			continue;
		}

		// Under maxBlocks pressure, promoting one lower adjacent block is legal and
		// eventually creates a reducible same-level pair (for example L3,L2,L1 -> L3,L2,L2).
		const layout = state.topLevelBlockIds.map((id) => {
			const block = state.blocks.find((candidate) => candidate.blockId === id);
			if (!block) throw new Error(`top-level block ${id} is missing`);
			return block;
		});
		let promoteIndex = -1;
		for (let i = 0; i < layout.length - 1; i++) {
			if (layout[i].level !== layout[i + 1].level) {
				promoteIndex = layout[i].level < layout[i + 1].level ? i : i + 1;
				break;
			}
		}
		if (promoteIndex < 0) return { blocks: created, error: `cannot satisfy maxBlocks=${max.value}` };
		const promoted = await promoteGroup(deps, state, [state.topLevelBlockIds[promoteIndex]], undefined, boundReference);
		if (!promoted.state || !promoted.block) return { blocks: created, error: promoted.error };
		state = promoted.state;
		created.push(promoted.block);
	}
}

function occupiedSourceIds(entries: SessionEntry[], state: PluginState): Set<string> {
	return new Set(activeTopBlocks(entries, state).flatMap((block) => block.sourceEntryIds));
}

interface ScopedState {
	state: PluginState;
	branchFrontiers: Record<string, string[]>;
}

/** Select the current branch frontier, then isolate the temporary operation state. */
function scopeToActiveBranch(
	entries: SessionEntry[],
	state: PluginState,
	frontierEntries: SessionEntry[] = entries,
): ScopedState {
	const activeIds = activeTopBlocks(frontierEntries, state).map((block) => block.blockId);
	return {
		state: { ...state, topLevelBlockIds: activeIds, topLevelBlockIdsByBranch: undefined },
		branchFrontiers: { ...(state.topLevelBlockIdsByBranch ?? {}) },
	};
}

function rememberBranchFrontier(
	deps: CompressDeps,
	state: PluginState,
	branchFrontiers: Record<string, string[]>,
): PluginState {
	const keys = new Set<string>();
	const addKey = (entry: SessionEntry | undefined): void => {
		keys.add(entry?.id ?? "__root__");
	};
	addKey(deps.branchEntries.at(-1));
	addKey(currentContextEntries(deps).at(-1));
	addKey(sourceEntries(deps).at(-1));
	const topLevelBlockIdsByBranch = { ...branchFrontiers };
	for (const key of keys) topLevelBlockIdsByBranch[key] = [...state.topLevelBlockIds];
	return { ...state, topLevelBlockIdsByBranch };
}

interface AutoCandidate {
	from: number;
	to: number;
	input: SummarizeInput;
}

interface AutoCandidateSearch {
	candidate?: AutoCandidate;
	boundaries: number;
	smallestTargetTokens?: number;
	minimumRequestTokens?: number;
}

/** Compute the first entry in the protected suffix and keep complete turns intact. */
function protectedStart(index: EntryIndex, entries: SessionEntry[], keepTokens: number): number {
	if (entries.length === 0) return 0;
	let start = entries.length - 1;
	let accumulated = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		accumulated += index.tokens[i];
		start = i;
		if (accumulated >= keepTokens) break;
	}
	while (start > 0 && !isTurnBoundary(entries, start - 1)) start--;
	return start;
}

/** Tool results are only valid when their matching tool call is in the same range.
 * Calls without results are allowed because an interrupted Pi turn can leave them pending. */
function hasOrphanToolResult(entries: SessionEntry[], from: number, to: number): boolean {
	const pendingToolCalls = new Set<string>();
	for (let i = from; i <= to; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant") {
			for (const block of entry.message.content) {
				if (block.type === "toolCall") pendingToolCalls.add(block.id);
			}
			continue;
		}
		if (entry.message.role !== "toolResult") continue;
		if (!pendingToolCalls.delete(entry.message.toolCallId)) return true;
	}
	return false;
}

/** Find the oldest contiguous uncompressed source run before the protected suffix. */
function nextUncompressedRun(
	entries: SessionEntry[],
	state: PluginState,
	goalIndex: number,
	protectedFrom: number,
): { from: number; to: number } | undefined {
	const occupied = occupiedSourceIds(entries, state);
	for (let from = Math.max(0, goalIndex + 1); from < protectedFrom; from++) {
		if (occupied.has(entries[from].id)) continue;
		let to = from;
		while (to + 1 < protectedFrom && !occupied.has(entries[to + 1].id)) to++;
		return { from, to };
	}
	return undefined;
}

/** Return true when any uncompressed source remains outside the protected suffix. */
function hasUncompressedSource(
	entries: SessionEntry[],
	state: PluginState,
	goalIndex: number,
	protectedFrom: number,
): boolean {
	const occupied = occupiedSourceIds(entries, state);
	for (let i = Math.max(0, goalIndex + 1); i < protectedFrom; i++) {
		if (!occupied.has(entries[i].id)) return true;
	}
	return false;
}

/** Return true when a protected tool result can pull its still-raw call into the candidate range. */
function canExtendThroughProtectedToolResult(
	entries: SessionEntry[],
	protectedFrom: number,
	occupied: Set<string>,
): boolean {
	const entry = entries[protectedFrom];
	if (entry?.type !== "message") return false;
	if (entry.message.role !== "toolResult") return false;
	const toolCallId = entry.message.toolCallId;
	for (let index = protectedFrom - 1; index >= 0; index--) {
		const candidate = entries[index];
		if (candidate.type !== "message" || candidate.message.role !== "assistant") continue;
		if (candidate.message.content.some((part) => part.type === "toolCall" && part.id === toolCallId)) {
			return !occupied.has(candidate.id);
		}
	}
	return false;
}

/** Serialize the target range through the per-operation entry cache. */
function serializeRangeCached(deps: CompressDeps, entries: SessionEntry[]): string {
	return entries.map((entry) => cachedEntry(deps, entry).text).join("\n\n");
}

/** Select the largest range ending immediately before a user or assistant message. */
function findAutoCandidate(
	deps: CompressDeps,
	state: PluginState,
	entries: SessionEntry[],
	index: EntryIndex,
	run: { from: number; to: number },
): AutoCandidateSearch {
	const boundaries: number[] = [];
	for (let end = run.to; end >= run.from; end--) {
		if (!isTurnBoundary(entries, end)) continue;
		if (hasOrphanToolResult(entries, run.from, end)) continue;
		boundaries.push(end);
	}
	if (boundaries.length === 0) return { boundaries: 0 };

	// Walk backward from the end of the oldest raw run. The request budget is
	// checked against the actual target, references, and summary output reserve;
	// an arbitrary half-window target cap breaks the sliding reconstruction pass.
	let smallestTargetTokens: number | undefined;
	let minimumRequestTokens: number | undefined;
	for (const end of boundaries) {
		const targetEntries = entries.slice(run.from, end + 1);
		const sourceEntryIds = targetEntries.map((entry) => entry.id);
		const sourceTokens = rangeTokens(index, run.from, end);
		const base: Omit<SummarizeInput, "referenceContext"> = {
			targetRange: serializeRangeCached(deps, targetEntries),
			sourceEntryIds,
			sourceTokens,
			level: 1,
			childBlockIds: [],
			budgetTokens: deps.cfg.blockTokenCeiling,
		};
		const prepared = prepareInput(
			deps,
			state,
			base,
			new Set(sourceEntryIds),
			new Set(),
			true,
		);
		const requestTokens = summaryRequestTokens(deps, prepared.input);
		minimumRequestTokens = minimumRequestTokens === undefined ? requestTokens : Math.min(minimumRequestTokens, requestTokens);
		if (smallestTargetTokens === undefined || sourceTokens < smallestTargetTokens) smallestTargetTokens = sourceTokens;
		if (prepared.fits) return { candidate: { from: run.from, to: end, input: prepared.input }, boundaries: boundaries.length, smallestTargetTokens, minimumRequestTokens };
	}
	return { boundaries: boundaries.length, smallestTargetTokens, minimumRequestTokens };
}

async function createLevelOne(
	deps: CompressDeps,
	state: PluginState,
	from: number,
	to: number,
	focus?: string,
	boundReference = false,
	preparedInput?: SummarizeInput,
): Promise<{ state?: PluginState; block?: CompactBlock; error?: string }> {
	const source = sourceEntries(deps);
	const index = entryIndex(deps, source);
	const entries = source.slice(from, to + 1);
	const sourceEntryIds = entries.map((entry) => entry.id);
	const sourceTokens = rangeTokens(index, from, to);
	const base: Omit<SummarizeInput, "referenceContext"> = {
		targetRange: serializeRangeCached(deps, entries),
		sourceEntryIds,
		sourceTokens,
		level: 1,
		childBlockIds: [],
		budgetTokens: deps.cfg.blockTokenCeiling,
		focus,
	};
	const prepared = preparedInput
		? { input: preparedInput, fits: summaryRequestTokens(deps, preparedInput) <= deps.contextWindow }
		: prepareInput(
			deps,
			state,
			base,
			new Set(sourceEntryIds),
			new Set(),
			boundReference,
		);
	if (!prepared.fits) {
		return { error: `summary request needs about more than the available context window (${deps.contextWindow} tokens)` };
	}
	const result = await summarizeBlock(deps, state, prepared.input);
	if (!result.block) return { error: result.error ?? "summary failed" };
	return { state: addTopBlock(state, result.block, index.positions), block: result.block };
}

/** Report token progress without coupling the compression state machine to Pi's UI. */
function reportProgress(
	deps: CompressDeps,
	compressedTokens: number,
	totalTokens: number,
	latestBlocks?: CompactBlock[],
): void {
	deps.onProgress?.({
		phase: "compressing",
		compressedTokens: Math.min(compressedTokens, totalTokens),
		totalTokens,
		latestBlocks: latestBlocks?.map(({ blockId, level }) => ({ blockId, level })),
	});
}

/** Net-gain gate shared by automatic and manual compression; splits are exempt. */
function netGainError(deps: CompressDeps, sourceTokens: number, cardTokens: number): string | undefined {
	return sourceTokens - cardTokens < deps.cfg.minNetGainTokens ? "estimated net gain is too small" : undefined;
}

/** Automatically normalize every complete uncompressed range before the protected suffix. */
export async function runAutoCompression(deps: CompressDeps, inputState: PluginState): Promise<CompressOutcome> {
	const source = sourceEntries(deps);
	const scoped = scopeToActiveBranch(source, inputState, currentContextEntries(deps));
	if (deps.contextWindow <= 0) return { status: "skipped", reason: "context window is unknown" };

	const entries = source;
	const index = entryIndex(deps, entries);
	const keep = resolveTokenLimit(deps.cfg.keepRecent, deps.contextWindow);
	const protectedFrom = protectedStart(index, entries, keep);
	const protectedEntry = entries[protectedFrom];
	const protectedMessage = protectedEntry?.type === "message" ? protectedEntry.message : undefined;
	const goalId = sessionGoalId(deps);
	const goalIndex = goalId ? index.positions.get(goalId) ?? -1 : -1;
	let working = scoped.state;
	const initiallyOccupied = occupiedSourceIds(entries, working);
	let protectedIncompleteTail = false;
	const adjustedProtectedFrom = protectedMessage?.role === "toolResult"
		&& canExtendThroughProtectedToolResult(entries, protectedFrom, initiallyOccupied)
		? protectedFrom + 1
		: protectedFrom;
	const createdBlocks: CompactBlock[] = [];
	let totalTokens = 0;
	let compressedTokens = 0;
	for (let position = Math.max(0, goalIndex + 1); position < adjustedProtectedFrom; position++) {
		const tokens = index.tokens[position] ?? 0;
		totalTokens += tokens;
		if (initiallyOccupied.has(entries[position].id)) compressedTokens += tokens;
	}
	reportProgress(deps, compressedTokens, totalTokens);

	// Normalize blocks that were already present before looking for raw source ranges.
	const initialStable = await stabilize(deps, working, true);
	if (!initialStable.state) return { status: "error", reason: initialStable.error, createdBlocks };
	working = initialStable.state;
	createdBlocks.push(...initialStable.blocks);
	if (initialStable.blocks.length > 0) reportProgress(deps, compressedTokens, totalTokens, initialStable.blocks);

	for (;;) {
		const run = nextUncompressedRun(entries, working, goalIndex, adjustedProtectedFrom);
		if (!run) break;
		const search = findAutoCandidate(deps, working, entries, index, run);
		if (!search.candidate) {
			if (search.boundaries === 0
				&& (run.to === entries.length - 1 || run.to + 1 === adjustedProtectedFrom)) {
				protectedIncompleteTail = true;
				break;
			}
			return {
				status: "error",
				reason: search.boundaries === 0
					? `no complete uncompressed range exists (run ${run.from}..${run.to})`
					: `no complete uncompressed range fits the summary request budget (run ${run.from}..${run.to}, boundaries ${search.boundaries}, smallest target about ${search.smallestTargetTokens} tokens, minimum request about ${search.minimumRequestTokens} tokens, window ${deps.contextWindow})`,
				createdBlocks,
			};
		}
		const candidate = search.candidate;
		const created = await createLevelOne(
			deps,
			working,
			candidate.from,
			candidate.to,
			undefined,
			true,
			candidate.input,
		);
		if (!created.state || !created.block) return { status: "error", reason: created.error, createdBlocks };
		const gainError = netGainError(deps, candidate.input.sourceTokens, created.block.cardTokens);
		if (gainError) return { status: "error", reason: gainError, createdBlocks };
		working = created.state;
		createdBlocks.push(created.block);
		compressedTokens += candidate.input.sourceTokens;
		reportProgress(deps, compressedTokens, totalTokens, [created.block]);

		// Rebalance after each source block, then rescan the branch from the beginning.
		const stable = await stabilize(deps, working, true);
		if (!stable.state) return { status: "error", reason: stable.error, createdBlocks };
		working = stable.state;
		createdBlocks.push(...stable.blocks);
		if (stable.blocks.length > 0) reportProgress(deps, compressedTokens, totalTokens, stable.blocks);
	}

	if (hasUncompressedSource(entries, working, goalIndex, adjustedProtectedFrom) && !protectedIncompleteTail) {
		return { status: "error", reason: "uncompressed content remains before the protected suffix", createdBlocks };
	}
	if (createdBlocks.length === 0) {
		const normalized = inputState.topLevelBlockIds.length !== working.topLevelBlockIds.length
			|| inputState.topLevelBlockIds.some((id, index) => id !== working.topLevelBlockIds[index]);
		return normalized
			? { status: "skipped", state: rememberBranchFrontier(deps, working, scoped.branchFrontiers), reason: "no compressible entries" }
			: { status: "skipped", reason: "no compressible entries" };
	}
	return {
		status: "created",
		state: rememberBranchFrontier(deps, working, scoped.branchFrontiers),
		createdBlocks,
	};
}

/** Manual compact always creates a level-1 block, then atomically stabilizes the forest. */
export async function runManualCompression(
	deps: CompressDeps,
	inputState: PluginState,
	startId: string,
	endId: string,
	focus?: string,
): Promise<CompressOutcome> {
	const source = sourceEntries(deps);
	const scoped = scopeToActiveBranch(source, inputState, currentContextEntries(deps));
	const state = scoped.state;
	const positions = new Map(source.map((entry, index) => [entry.id, index] as const));
	const start = positions.get(startId);
	let end = positions.get(endId);
	if (start === undefined || end === undefined || end < start) return { status: "error", reason: "invalid source range" };
	const goalId = sessionGoalId(deps);
	const goalIndex = goalId ? positions.get(goalId) ?? -1 : -1;
	while (end < source.length - 1 && !isTurnBoundary(source, end)) end++;
	const requestedEnd = end;
	if (start <= goalIndex && goalIndex <= end) return { status: "error", reason: "the session goal entry must remain uncompressed" };
	if (end >= source.length - 1) return { status: "error", reason: "the current incomplete tail cannot be compressed" };
	if (hasOrphanToolResult(source, start, end)) return { status: "error", reason: "the source range contains an orphan tool result" };
	const occupied = occupiedSourceIds(source, state);
	for (let i = start; i <= end; i++) {
		if (!occupied.has(source[i].id)) continue;
		return {
			status: "error",
			reason: i > requestedEnd
				? "extending the range to a turn boundary overlaps an existing top-level block"
				: "source range overlaps an existing top-level block",
		};
	}
	const index = entryIndex(deps, source);
	const sourceTokens = rangeTokens(index, start, end);
	reportProgress(deps, 0, sourceTokens);
	const created = await createLevelOne(deps, state, start, end, focus);
	if (!created.state || !created.block) return { status: "error", reason: created.error };
	const gainError = netGainError(deps, sourceTokens, created.block.cardTokens);
	if (gainError) return { status: "error", reason: gainError };
	reportProgress(deps, sourceTokens, sourceTokens, [created.block]);
	const stable = await stabilize(deps, created.state);
	if (!stable.state) return { status: "error", reason: stable.error };
	if (stable.blocks.length > 0) reportProgress(deps, sourceTokens, sourceTokens, stable.blocks);
	return {
		status: "created",
		state: rememberBranchFrontier(deps, stable.state, scoped.branchFrontiers),
		createdBlocks: [created.block, ...stable.blocks],
	};
}

/** Manually promote one through k adjacent same-level top blocks by exactly one level. */
export async function runManualAdjustment(
	deps: CompressDeps,
	inputState: PluginState,
	blockIds: string[],
	focus?: string,
): Promise<CompressOutcome> {
	const source = sourceEntries(deps);
	const scoped = scopeToActiveBranch(source, inputState, currentContextEntries(deps));
	const selected = scoped.state.blocks.filter((block) => blockIds.includes(block.blockId));
	const totalTokens = selected.reduce((sum, block) => sum + block.sourceTokens, 0);
	reportProgress(deps, 0, totalTokens);
	const promoted = await promoteGroup(deps, scoped.state, blockIds, focus);
	if (!promoted.state || !promoted.block) return { status: "error", reason: promoted.error };
	reportProgress(deps, totalTokens, totalTokens, [promoted.block]);
	const stable = await stabilize(deps, promoted.state);
	if (!stable.state) return { status: "error", reason: stable.error };
	if (stable.blocks.length > 0) reportProgress(deps, totalTokens, totalTokens, stable.blocks);
	return {
		status: "adjusted",
		state: rememberBranchFrontier(deps, stable.state, scoped.branchFrontiers),
		createdBlocks: [promoted.block, ...stable.blocks],
	};
}

/** Manually split a top-level block into its children, or split a level-1 source range at a turn boundary. */
export async function runManualSplit(
	deps: CompressDeps,
	inputState: PluginState,
	blockId: string,
	splitAt?: string,
): Promise<CompressOutcome> {
	const source = sourceEntries(deps);
	const scoped = scopeToActiveBranch(source, inputState, currentContextEntries(deps));
	const block = scoped.state.blocks.find((candidate) => candidate.blockId === blockId);
	if (!block || !scoped.state.topLevelBlockIds.includes(blockId)) {
		return { status: "error", reason: "block must be an active top-level block" };
	}
	const totalTokens = block.sourceTokens;
	reportProgress(deps, 0, totalTokens);
	if (block.childBlockIds.length > 0) {
		const childIds = block.childBlockIds.filter((id) => scoped.state.blocks.some((candidate) => candidate.blockId === id));
		if (childIds.length !== block.childBlockIds.length) return { status: "error", reason: "block children are missing" };
		const index = scoped.state.topLevelBlockIds.indexOf(blockId);
		const next: PluginState = {
			...scoped.state,
			topLevelBlockIds: [...scoped.state.topLevelBlockIds.slice(0, index), ...childIds, ...scoped.state.topLevelBlockIds.slice(index + 1)],
		};
		const adjusted = rememberBranchFrontier(deps, next, scoped.branchFrontiers);
		reportProgress(deps, totalTokens, totalTokens, childIds.map((id) => scoped.state.blocks.find((candidate) => candidate.blockId === id)).filter((candidate): candidate is CompactBlock => candidate !== undefined));
		return { status: "adjusted", state: adjusted, createdBlocks: [] };
	}
	if (!splitAt) return { status: "error", reason: "a split entry ID is required for a level-1 block" };
	const positions = new Map(source.map((entry, index) => [entry.id, index] as const));
	const from = positions.get(block.sourceEntryIds[0]);
	const boundary = positions.get(splitAt);
	const to = positions.get(block.sourceEntryIds.at(-1) ?? "");
	if (from === undefined || boundary === undefined || to === undefined || boundary < from || boundary >= to) {
		return { status: "error", reason: "split entry must be inside the block source range" };
	}
	if (!isTurnBoundary(source, boundary)) return { status: "error", reason: "split entry must end a complete turn" };
	const without: PluginState = {
		...scoped.state,
		topLevelBlockIds: scoped.state.topLevelBlockIds.filter((id) => id !== blockId),
	};
	const first = await createLevelOne(deps, without, from, boundary);
	if (!first.state || !first.block) return { status: "error", reason: first.error };
	reportProgress(deps, first.block.sourceTokens, totalTokens, [first.block]);
	const second = await createLevelOne(deps, first.state, boundary + 1, to);
	if (!second.state || !second.block) return { status: "error", reason: second.error };
	reportProgress(deps, totalTokens, totalTokens, [second.block]);
	return {
		status: "adjusted",
		state: rememberBranchFrontier(deps, second.state, scoped.branchFrontiers),
		createdBlocks: [first.block, second.block],
	};
}

/** Exported pure inspection helper for tests and UI. */
export function topLevelLayout(state: PluginState): Array<{ id: string; level: number }> {
	const byId = new Map(state.blocks.map((block) => [block.blockId, block] as const));
	return state.topLevelBlockIds.map((id) => ({ id, level: byId.get(id)?.level ?? 0 }));
}

/** Atomic hierarchical compaction operations. No function mutates its input state. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveTokenLimit, type AutoCompactConfig } from "./config.ts";
import { activeChildFrontier, activeTopBlocks } from "./mapping.ts";
import {
	SUMMARIZER_SYSTEM_PROMPT,
	buildSummarizeParts,
	cardTokensFor,
	parseSummaryResponse,
	rewriteInstruction,
	summaryOutputTokenLimit,
	validateSummary,
} from "./summarizer.ts";
import type { CompactBlock, PluginState, PromptPart, SummarizeInput } from "./types.ts";
import { SNAPSHOT_CUSTOM_TYPE } from "./types.ts";
import {
	entryToPromptParts,
	estimateEntryTokens,
	estimatePromptPartTokens,
	estimatePromptTokens,
	nextBlockId,
	renderBlockCard,
	renderPromptParts,
	type TokenEstimator,
} from "./util.ts";

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
	/** Full active branch, retained for source provenance. */
	branchEntries: SessionEntry[];
	/** Current Pi context-visible entries; defaults to the full branch for tests/callers. */
	contextEntries?: SessionEntry[];
	contextWindow: number;
	referenceContext: string;
	/** Active session system prompt; shown as read-only reference. */
	systemPrompt: string;
	/** Token rate for every plugin-side count: source weight, card budget, net gain and progress. */
	estimate: TokenEstimator;
	/** Whether the summary model accepts image input; otherwise images stay placeholders. */
	supportsImages: boolean;
	onProgress?: (progress: CompressProgress) => void;
	summarizeFn: (content: PromptPart[]) => Promise<string>;
	/** Per-operation memo of an entry's prompt parts and the tokens its messages cost. */
	entryCache?: Map<string, { parts: PromptPart[]; tokens: number }>;
	/** Abort signal shared by every model request in this operation. */
	signal?: AbortSignal;
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
function cachedEntry(deps: CompressDeps, entry: SessionEntry): { parts: PromptPart[]; tokens: number } {
	if (!deps.entryCache) deps.entryCache = new Map();
	const cache = deps.entryCache;
	const existing = cache.get(entry.id);
	if (existing) return existing;
	const messages = sessionEntryToContextMessages(entry);
	// System messages are prompt state: Pi replays the live prompt separately and a block only
	// replaces conversation with a card, so prompt state is never summary material or source
	// weight. Transcript-only records (extension state, model switches) stay inside block ranges
	// for context_get, but project no model message and contribute no tokens either.
	const conversation = messages.filter((message: AgentMessage) => message.role !== "system");
	const parts = conversation.length === 0 ? [] : entryToPromptParts(entry, true, deps.supportsImages);
	// Token accounting follows the conversation the block replaces, measured with the same
	// conservative prompt rate as the retained tail and the footer — images cost a fixed per-image
	// estimate, not the size of their base64.
	const tokens = conversation.reduce((sum, message) => sum + deps.estimate(message), 0);
	const value = { parts, tokens };
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
	parts: PromptPart[];
	region: "above" | "below";
	order: number;
	priority: number;
	rank: number;
}

interface PreparedInput {
	input: SummarizeInput;
	fits: boolean;
}

// Pi's streamSimple clamps maxTokens against contextWindow - CONTEXT_SAFETY_TOKENS, so every
// request estimate mirrors that 4096-token input margin. A first attempt additionally leaves room
// for the structural rewrite, because the rewrite resends the same content plus a longer
// instruction; the rewrite itself is the last request of the operation and needs no further room.
const SUMMARY_ADAPTER_MARGIN = 4096;
const SUMMARY_REWRITE_RESERVE = 256;

/** Stop an operation before it can produce or commit a result. */
function throwIfAborted(deps: CompressDeps): void {
	if (deps.signal?.aborted) throw new Error("compression aborted");
}

/** Identify cancellation separately from model and validation failures. */
export function isCompressionAborted(error: unknown, signal?: AbortSignal): boolean {
	return signal?.aborted === true
		|| (error instanceof Error && (error.name === "AbortError" || error.message === "compression aborted"));
}

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

/** Plugin display snapshots are transcript records: never summary targets, references, or context. */
export function isSnapshotEntry(entry: SessionEntry): boolean {
	return entry.type === "custom" && entry.customType === SNAPSHOT_CUSTOM_TYPE;
}

/** Context-visible entries eligible as plugin compression sources; display and native records excluded. */
export function sourceEntriesFor(entries: SessionEntry[]): SessionEntry[] {
	return entries.filter((entry) => entry.type !== "compaction" && !isSnapshotEntry(entry));
}

/** Select source entries that are currently visible and eligible for plugin compression. */
function sourceEntries(deps: CompressDeps): SessionEntry[] {
	return sourceEntriesFor(currentContextEntries(deps));
}

/** An entry contributes compressible content only through its non-system messages. */
function isCompressibleEntry(entry: SessionEntry): boolean {
	return sessionEntryToContextMessages(entry).some((message: AgentMessage) => message.role !== "system");
}

/** Return the first compressible entry at or after `from`, or entries.length when none exists. */
function firstCompressibleIndex(entries: SessionEntry[], from = 0): number {
	for (let index = Math.max(0, from); index < entries.length; index++) {
		if (isCompressibleEntry(entries[index])) return index;
	}
	return entries.length;
}

export interface CompactedPrefix {
	/** Index of the first retained entry; entries.length means the whole visible history is covered. */
	retainedFrom: number;
	/** First retained entry ID, or undefined when nothing is retained. */
	firstKeptEntryId?: string;
	/** Set when the active blocks cannot describe a complete prefix of the visible history. */
	reason?: string;
}

/**
 * Resolve where the compacted prefix ends. Active blocks cover one contiguous envelope, so the
 * retained pointer is the first entry after the last active block. The prefix must begin at the
 * earliest context-visible entry: raw history before the oldest block is a gap that has to be
 * compressed first, and the pointer must never advance over it.
 */
export function resolveCompactedPrefix(entries: SessionEntry[], state: PluginState): CompactedPrefix {
	const firstCompressible = firstCompressibleIndex(entries);
	const blocks = activeTopBlocks(entries, state);
	if (blocks.length === 0) {
		return { retainedFrom: firstCompressible, firstKeptEntryId: entries[firstCompressible]?.id };
	}
	const positions = new Map(entries.map((entry, index) => [entry.id, index] as const));
	const start = positions.get(blocks[0].startEntryId);
	const end = positions.get(blocks.at(-1)?.endEntryId ?? "");
	if (start === undefined || end === undefined || end < start) {
		return {
			retainedFrom: firstCompressible,
			firstKeptEntryId: entries[firstCompressible]?.id,
			reason: `active blocks ${blocks[0].blockId}..${blocks.at(-1)?.blockId} are not on the current path`,
		};
	}
	if (start > firstCompressible) {
		return {
			retainedFrom: firstCompressible,
			firstKeptEntryId: entries[firstCompressible]?.id,
			reason: `uncompressed history starts at ${entries[firstCompressible]?.id} but the oldest active block starts at ${blocks[0].startEntryId}; compress the leading range first`,
		};
	}
	const retainedFrom = end + 1;
	return { retainedFrom, firstKeptEntryId: entries[retainedFrom]?.id };
}

/** Estimate one summary request: the adapter margin always applies, and a first attempt also
 * carries the rewrite reserve so the follow-up request still fits the window. */
function summaryRequestTokensForParts(deps: CompressDeps, parts: PromptPart[], mayRewrite = true): number {
	return estimatePromptTokens(SUMMARIZER_SYSTEM_PROMPT)
		+ estimatePromptPartTokens(parts)
		+ summaryOutputTokenLimit(deps.cfg.blockTokenCeiling)
		+ SUMMARY_ADAPTER_MARGIN
		+ (mayRewrite ? SUMMARY_REWRITE_RESERVE : 0);
}

/** Estimate the complete request that would be sent to the summary model. */
function summaryRequestTokens(deps: CompressDeps, input: SummarizeInput): number {
	return summaryRequestTokensForParts(deps, buildSummarizeParts(input));
}

/** Message roles Pi may begin the retained tail with; tool results must stay with their tool call. */
const CUT_POINT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);

/** Whether Pi's cut-point policy accepts this entry as the start of the retained tail. */
function isCutPointEntry(entry: SessionEntry): boolean {
	return sessionEntryToContextMessages(entry).some((message: AgentMessage) => CUT_POINT_ROLES.has(message.role));
}

/** A cut point is the next entry Pi is allowed to keep verbatim, skipping metadata-only entries. */
export function isTurnBoundary(entries: SessionEntry[], index: number): boolean {
	for (let next = index + 1; next < entries.length; next++) {
		if (sessionEntryToContextMessages(entries[next]).length === 0) continue;
		return isCutPointEntry(entries[next]);
	}
	return false;
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
	const byFirstSource = new Map(topBlocks.map((block) => [block.startEntryId, block] as const));
	const occupied = occupiedSourceIds(entries, state);
	const parts: ReferencePart[] = [];

	const add = (part: PromptPart[], region: "above" | "below", order: number, priority: number, rank: number): void => {
		const hasContent = part.some((entry) => entry.type === "image") || renderPromptParts(part).trim().length > 0;
		if (hasContent) parts.push({ parts: part, region, order, priority, rank });
	};

	for (const entry of visibleEntries) {
		if (entry.type === "compaction" || isSnapshotEntry(entry)) continue;
		const order = positions.get(entry.id) ?? visiblePositions.get(entry.id) ?? 0;
		if (excludedSourceIds.has(entry.id)) continue;
		const block = byFirstSource.get(entry.id);
		if (block) {
			if (!excludedBlockIds.has(block.blockId)) add([{ type: "text", text: renderBlockCard(block) }], "above", order, 1, order);
			continue;
		}
		if (occupied.has(entry.id)) continue;

		const priority = 3;
		const rank = order;
		add(cachedEntry(deps, entry).parts, "below", order, priority, rank);
	}

	if (deps.referenceContext.trim()) {
		add([{ type: "text", text: deps.referenceContext }], "below", entries.length + 1, 0, 1);
	}
	return parts;
}

/** Join selected reference fragments back into their original source order per region. */
function joinReferenceParts(parts: ReferencePart[]): { above: PromptPart[]; below: PromptPart[] } {
	const byRegion = { above: [] as ReferencePart[], below: [] as ReferencePart[] };
	for (const part of parts) byRegion[part.region].push(part);
	const join = (list: ReferencePart[]): PromptPart[] => {
		const joined: PromptPart[] = [];
		[...list]
			.sort((left, right) => left.order - right.order)
			.forEach((part, index) => {
				if (index > 0) joined.push({ type: "text", text: "\n\n" });
				joined.push(...part.parts);
			});
		return joined;
	};
	return { above: join(byRegion.above), below: join(byRegion.below) };
}

/** Keep reference context within the request budget at complete entry/card boundaries. */
function fitReferenceContext(
	deps: CompressDeps,
	state: PluginState,
	excludedSourceIds: Set<string>,
	excludedBlockIds: Set<string>,
	makeInput: (referenceAbove: PromptPart[], referenceBelow: PromptPart[]) => SummarizeInput,
	boundReference = true,
): { above: PromptPart[]; below: PromptPart[]; fits: boolean } {
	const parts = collectReferenceParts(deps, state, excludedSourceIds, excludedBlockIds);
	const complete = joinReferenceParts(parts);
	if (!boundReference) {
		const input = makeInput(complete.above, complete.below);
		return { ...complete, fits: summaryRequestTokens(deps, input) <= deps.contextWindow };
	}
	const completeInput = makeInput(complete.above, complete.below);
	if (summaryRequestTokens(deps, completeInput) <= deps.contextWindow) {
		return { ...complete, fits: true };
	}

	const empty = makeInput([], []);
	const emptyTokens = summaryRequestTokens(deps, empty);
	if (emptyTokens > deps.contextWindow) return { above: [], below: [], fits: false };

	const available = deps.contextWindow - emptyTokens;
	const ranked = [...parts].sort((left, right) =>
		left.priority - right.priority || left.rank - right.rank || left.order - right.order,
	);
	const selected: ReferencePart[] = [];
	let selectedTokens = 0;
	for (const part of ranked) {
		const partTokens = estimatePromptPartTokens(part.parts) + 1;
		if (selectedTokens + partTokens > available) continue;
		selected.push(part);
		selectedTokens += partTokens;
	}

	let joined = joinReferenceParts(selected);
	while (selected.length > 0 && summaryRequestTokens(deps, makeInput(joined.above, joined.below)) > deps.contextWindow) {
		selected.pop();
		joined = joinReferenceParts(selected);
	}
	const input = makeInput(joined.above, joined.below);
	return { ...joined, fits: summaryRequestTokens(deps, input) <= deps.contextWindow };
}

/** Build a summary input and bound only its non-target reference context. */
function prepareInput(
	deps: CompressDeps,
	state: PluginState,
	base: Omit<SummarizeInput, "systemPrompt" | "referenceAbove" | "referenceBelow">,
	excludedSourceIds: Set<string>,
	excludedBlockIds: Set<string>,
	boundReference = true,
): PreparedInput {
	const makeInput = (referenceAbove: PromptPart[], referenceBelow: PromptPart[]): SummarizeInput => ({
		...base, systemPrompt: deps.systemPrompt, referenceAbove, referenceBelow,
	});
	const reference = fitReferenceContext(deps, state, excludedSourceIds, excludedBlockIds, makeInput, boundReference);
	return { input: makeInput(reference.above, reference.below), fits: reference.fits };
}


async function summarizeBlock(
	deps: CompressDeps,
	state: PluginState,
	input: SummarizeInput,
): Promise<{ block?: CompactBlock; error?: string }> {
	throwIfAborted(deps);
	const content = buildSummarizeParts(input);
	const firstRequestTokens = summaryRequestTokensForParts(deps, content);
	if (firstRequestTokens > deps.contextWindow) {
		return { error: `summary request needs about ${firstRequestTokens} tokens, window is ${deps.contextWindow}` };
	}
	let response = (await deps.summarizeFn(content)).trim();
	throwIfAborted(deps);
	let parsed = parseSummaryResponse(response);
	let cardTokens = cardTokensFor(state.nextSeq, input, parsed.summary, deps.estimate);
	let validation = validateSummary(parsed.summary, cardTokens, input.budgetTokens);
	let problems = [...parsed.problems, ...validation.problems];
	if (problems.length > 0) {
		const rewriteContent: PromptPart[] = [...content, { type: "text", text: rewriteInstruction({ problems }) }];
		const rewriteRequestTokens = summaryRequestTokensForParts(deps, rewriteContent, false);
		if (rewriteRequestTokens > deps.contextWindow) {
			return { error: `summary rewrite needs about ${rewriteRequestTokens} tokens, window is ${deps.contextWindow}` };
		}
		response = (await deps.summarizeFn(rewriteContent)).trim();
		throwIfAborted(deps);
		parsed = parseSummaryResponse(response);
		cardTokens = cardTokensFor(state.nextSeq, input, parsed.summary, deps.estimate);
		validation = validateSummary(parsed.summary, cardTokens, input.budgetTokens);
		problems = [...parsed.problems, ...validation.problems];
	}
	if (problems.length > 0) return { error: problems.join("; ") };
	return {
		block: {
			blockId: nextBlockId(state.nextSeq),
			level: input.level,
			overview: parsed.overview,
			startEntryId: input.sourceEntryIds[0] ?? "",
			endEntryId: input.sourceEntryIds.at(-1) ?? "",
			childBlockIds: [...input.childBlockIds],
			summary: parsed.summary,
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
		return (positions.get(a?.startEntryId ?? "") ?? Number.MAX_SAFE_INTEGER)
			- (positions.get(b?.startEntryId ?? "") ?? Number.MAX_SAFE_INTEGER);
	});
	return {
		...state,
		blocks: [...state.blocks, block],
		topLevelBlockIds: top,
		nextSeq: state.nextSeq + 1,
	};
}

function replaceTopGroup(
	state: PluginState,
	groupIds: string[],
	merged: CompactBlock,
	created: boolean,
): PluginState {
	const indexes = groupIds.map((id) => state.topLevelBlockIds.indexOf(id));
	const first = Math.min(...indexes);
	const last = Math.max(...indexes);
	const expected = state.topLevelBlockIds.slice(first, last + 1);
	if (expected.length !== groupIds.length || expected.some((id, index) => id !== groupIds[index])) {
		throw new Error("blocks to promote must be adjacent top-level blocks");
	}
	return {
		...state,
		blocks: created ? [...state.blocks, merged] : state.blocks,
		topLevelBlockIds: [
			...state.topLevelBlockIds.slice(0, first),
			merged.blockId,
			...state.topLevelBlockIds.slice(last + 1),
		],
		nextSeq: created ? state.nextSeq + 1 : state.nextSeq,
	};
}

function validateMergeGroup(
	deps: CompressDeps,
	state: PluginState,
	groupIds: string[],
	requireSameLevel = true,
): CompactBlock[] | string {
	const k = deps.cfg.blockMergeThreshold;
	if (groupIds.length < 2 || groupIds.length > k) return `choose between 2 and ${k} blocks`;
	const topIndexes = groupIds.map((id) => state.topLevelBlockIds.indexOf(id));
	if (topIndexes.some((index) => index < 0)) return "all blocks must be top-level";
	const first = Math.min(...topIndexes);
	if (topIndexes.some((index, offset) => index !== first + offset)) return "blocks must be adjacent and ordered";
	const byId = new Map(state.blocks.map((block) => [block.blockId, block] as const));
	const blocks = groupIds.map((id) => byId.get(id));
	if (blocks.some((block) => !block)) return "block not found";
	const concrete = blocks as CompactBlock[];
	if (requireSameLevel && concrete.some((block) => block.level !== concrete[0].level)) {
		return "blocks must have the same level";
	}
	return concrete;
}

/** Promote adjacent blocks, reusing the immutable node with the same ordered leaves. */
async function promoteGroup(
	deps: CompressDeps,
	state: PluginState,
	groupIds: string[],
	focus?: string,
	boundReference = false,
	requireSameLevel = true,
): Promise<{ state?: PluginState; block?: CompactBlock; created?: boolean; error?: string }> {
	const checked = validateMergeGroup(deps, state, groupIds, requireSameLevel);
	if (typeof checked === "string") return { error: checked };
	const leaves = groupIds.flatMap((id) => leafBlockIds(state, id));
	const reusable = state.blocks.find((block) => {
		const candidateLeaves = leafBlockIds(state, block.blockId);
		return candidateLeaves.length === leaves.length
			&& candidateLeaves.every((id, index) => id === leaves[index]);
	});
	if (reusable) {
		return { state: replaceTopGroup(state, groupIds, reusable, false), block: reusable, created: false };
	}

	const sourceEntryIds = [checked[0].startEntryId, checked.at(-1)?.endEntryId ?? checked[0].endEntryId];
	const sourceTokens = checked.reduce((sum, block) => sum + block.sourceTokens, 0);
	const base: Omit<SummarizeInput, "systemPrompt" | "referenceAbove" | "referenceBelow"> = {
		targetParts: [{ type: "text", text: checked.map((block) => `[${block.blockId} level ${block.level}]\n${block.summary}`).join("\n\n") }],
		sourceEntryIds,
		sourceTokens,
		level: Math.max(...checked.map((block) => block.level)) + 1,
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
	return { state: replaceTopGroup(state, groupIds, result.block, true), block: result.block, created: true };
}

interface SameLevelRun {
	start: number;
	ids: string[];
	level: number;
}

function sameLevelRuns(state: PluginState, _entries: SessionEntry[]): SameLevelRun[] {
	const byId = new Map(state.blocks.map((block) => [block.blockId, block] as const));
	const runs: SameLevelRun[] = [];
	let start = 0;
	while (start < state.topLevelBlockIds.length) {
		const firstBlock = byId.get(state.topLevelBlockIds[start]);
		if (!firstBlock) break;
		const level = firstBlock.level;
		let end = start + 1;
		while (end < state.topLevelBlockIds.length) {
			const current = byId.get(state.topLevelBlockIds[end]);
			if (!current || current.level !== level) break;
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
		throwIfAborted(deps);
		const automatic = sameLevelRuns(state, sourceEntries(deps)).find((run) => run.ids.length >= k + 1);
		if (automatic) {
			const promoted = await promoteGroup(deps, state, automatic.ids.slice(0, k), undefined, boundReference);
			if (!promoted.state || !promoted.block) return { blocks: created, error: promoted.error };
			state = promoted.state;
			if (promoted.created) created.push(promoted.block);
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
			if (promoted.created) created.push(promoted.block);
			continue;
		}

		// Mixed-level neighbors can share a parent; any messages later inserted
		// between their stable boundaries are deliberately absorbed by that parent.
		let pressureIds: string[] | undefined;
		for (let start = 0; start < state.topLevelBlockIds.length - 1 && !pressureIds; start++) {
			const ids = state.topLevelBlockIds.slice(start, Math.min(start + k, state.topLevelBlockIds.length));
			if (ids.length >= 2) pressureIds = ids;
		}
		if (!pressureIds) return { blocks: created, error: `cannot satisfy maxBlocks=${max.value}` };
		const promoted = await promoteGroup(deps, state, pressureIds, undefined, boundReference, false);
		if (!promoted.state || !promoted.block) return { blocks: created, error: promoted.error };
		state = promoted.state;
		if (promoted.created) created.push(promoted.block);
	}
}

function occupiedSourceIds(entries: SessionEntry[], state: PluginState): Set<string> {
	const positions = new Map(entries.map((entry, index) => [entry.id, index] as const));
	const blocks = activeTopBlocks(entries, state);
	const start = positions.get(blocks[0]?.startEntryId ?? "");
	const end = positions.get(blocks.at(-1)?.endEntryId ?? "");
	if (start === undefined || end === undefined || end < start) return new Set();
	return new Set(entries.slice(start, end + 1).map((entry) => entry.id));
}

interface ScopedState {
	state: PluginState;
	branchFrontiers: Record<string, string[]>;
	branchChildFrontiers: Record<string, Record<string, string[]>>;
	branchPointers: Record<string, string>;
}

/** Select the current branch frontier, then isolate the temporary operation state. */
function scopeToActiveBranch(
	entries: SessionEntry[],
	state: PluginState,
	frontierEntries: SessionEntry[] = entries,
): ScopedState {
	const activeIds = activeTopBlocks(frontierEntries, state).map((block) => block.blockId);
	const activeChildren = activeChildFrontier(frontierEntries, state);
	return {
		state: {
			...state,
			topLevelBlockIds: activeIds,
			childBlockIdsByParent: activeChildren,
			topLevelBlockIdsByBranch: undefined,
			childBlockIdsByParentByBranch: undefined,
			firstKeptEntryIdByBranch: undefined,
		},
		branchFrontiers: { ...(state.topLevelBlockIdsByBranch ?? {}) },
		branchChildFrontiers: { ...(state.childBlockIdsByParentByBranch ?? {}) },
		branchPointers: { ...(state.firstKeptEntryIdByBranch ?? {}) },
	};
}

/**
 * Record the committed frontier, internal edges, and retained pointer under every active-path
 * anchor. The pointer is derived from the committed envelope, so it always equals the first
 * entry the model still receives as raw history.
 */
function rememberBranchFrontier(deps: CompressDeps, state: PluginState, scoped: ScopedState): PluginState {
	const keys = new Set<string>();
	const addKey = (entry: SessionEntry | undefined): void => {
		keys.add(entry?.id ?? "__root__");
	};
	addKey(deps.branchEntries.at(-1));
	addKey(currentContextEntries(deps).at(-1));
	addKey(sourceEntries(deps).at(-1));
	const firstKeptEntryId = resolveCompactedPrefix(sourceEntries(deps), state).firstKeptEntryId;
	const topLevelBlockIdsByBranch = { ...scoped.branchFrontiers };
	const childBlockIdsByParentByBranch = { ...scoped.branchChildFrontiers };
	const firstKeptEntryIdByBranch = { ...scoped.branchPointers };
	for (const key of keys) {
		topLevelBlockIdsByBranch[key] = [...state.topLevelBlockIds];
		childBlockIdsByParentByBranch[key] = Object.fromEntries(
			Object.entries(state.childBlockIdsByParent).map(([parentId, childIds]) => [parentId, [...childIds]]),
		);
		if (firstKeptEntryId === undefined) delete firstKeptEntryIdByBranch[key];
		else firstKeptEntryIdByBranch[key] = firstKeptEntryId;
	}
	return { ...state, topLevelBlockIdsByBranch, childBlockIdsByParentByBranch, firstKeptEntryIdByBranch };
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

/** Start of the retained tail, using Pi's cut-point policy with the conservative prompt estimator.
 * Pi accumulates chars/4, which understates CJK and tool output by 2-4x, so a `keepRecent`
 * window measured that way retains far more real tokens than configured. The plugin summarizes the
 * same prefix Pi would, so a split turn's prefix is folded into the leading block instead of a
 * separate checkpoint. */
function protectedStart(entries: SessionEntry[], keepTokens: number): number {
	if (entries.length === 0) return 0;
	const cutPoints: number[] = [];
	for (let index = 0; index < entries.length; index++) {
		if (isCutPointEntry(entries[index])) cutPoints.push(index);
	}
	if (cutPoints.length === 0) return 0;
	let accumulated = 0;
	let cutIndex = cutPoints[0];
	for (let index = entries.length - 1; index >= 0; index--) {
		const tokens = estimateEntryTokens(entries[index]);
		if (tokens === 0) continue;
		accumulated += tokens;
		if (accumulated < keepTokens) continue;
		cutIndex = cutPoints.find((candidate) => candidate >= index) ?? cutPoints[cutPoints.length - 1];
		break;
	}
	// Metadata-only entries carry no model message, so the tail starts on the next real entry.
	while (cutIndex > 0 && sessionEntryToContextMessages(entries[cutIndex - 1]).length === 0) cutIndex--;
	return cutIndex;
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
	startIndex: number,
	protectedFrom: number,
): { from: number; to: number } | undefined {
	const occupied = occupiedSourceIds(entries, state);
	for (let from = Math.max(0, startIndex); from < protectedFrom; from++) {
		if (occupied.has(entries[from].id)) continue;
		let to = from;
		while (to + 1 < protectedFrom && !occupied.has(entries[to + 1].id)) to++;
		return { from, to };
	}
	return undefined;
}

/** Return true when any compressible conversation remains outside the protected suffix.
 * Prompt state and metadata never need coverage, so they do not count as residue. */
function hasUncompressedSource(
	entries: SessionEntry[],
	state: PluginState,
	startIndex: number,
	protectedFrom: number,
): boolean {
	const occupied = occupiedSourceIds(entries, state);
	for (let i = Math.max(0, startIndex); i < protectedFrom; i++) {
		if (!isCompressibleEntry(entries[i])) continue;
		if (!occupied.has(entries[i].id)) return true;
	}
	return false;
}

/** Serialize the target range through the per-operation entry cache. */
function serializeRangeCached(deps: CompressDeps, entries: SessionEntry[]): PromptPart[] {
	const parts: PromptPart[] = [];
	for (const entry of entries) {
		const entryParts = cachedEntry(deps, entry).parts;
		if (entryParts.length === 0) continue;
		if (parts.length > 0) parts.push({ type: "text", text: "\n\n" });
		parts.push(...entryParts);
	}
	return parts;
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

	// The reference regions must be disjoint from the target domain: every entry of
	// the run being compressed belongs to the content about to be compacted, so
	// none of it may appear as background. Excluding only the current candidate
	// leaks the not-yet-compressed segments into the reference, duplicates them,
	// and squeezes the target budget below the card structure cost.
	const runSourceIds = new Set(entries.slice(run.from, run.to + 1).map((entry) => entry.id));

	// Walk backward from the end of the oldest raw run. The request budget is
	// checked against the actual target, references, and summary output reserve;
	// an arbitrary half-window target cap breaks the sliding reconstruction pass.
	let smallestTargetTokens: number | undefined;
	let minimumRequestTokens: number | undefined;
	for (const end of boundaries) {
		const targetEntries = entries.slice(run.from, end + 1);
		const sourceEntryIds = targetEntries.map((entry) => entry.id);
		const sourceTokens = rangeTokens(index, run.from, end);
		const base: Omit<SummarizeInput, "systemPrompt" | "referenceAbove" | "referenceBelow"> = {
			targetParts: serializeRangeCached(deps, targetEntries),
			sourceEntryIds,
			sourceTokens,
			level: 1,
			childBlockIds: [],
			budgetTokens: levelOneBudget(deps, sourceTokens),
		};
		const prepared = prepareInput(
			deps,
			state,
			base,
			runSourceIds,
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

/** Limit a level-1 card by both the configured ceiling and the required net gain. */
function levelOneBudget(deps: CompressDeps, sourceTokens: number): number {
	return Math.max(1, Math.min(deps.cfg.blockTokenCeiling, sourceTokens - deps.cfg.minNetGainTokens));
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
	const base: Omit<SummarizeInput, "systemPrompt" | "referenceAbove" | "referenceBelow"> = {
		targetParts: serializeRangeCached(deps, entries),
		sourceEntryIds,
		sourceTokens,
		level: 1,
		childBlockIds: [],
		budgetTokens: levelOneBudget(deps, sourceTokens),
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
	const netGain = sourceTokens - cardTokens;
	return netGain < deps.cfg.minNetGainTokens
		? `estimated net gain is too small (source ${sourceTokens}, card ${cardTokens}, net ${netGain}, minimum ${deps.cfg.minNetGainTokens} tokens)`
		: undefined;
}

/** Automatically normalize every complete uncompressed range before the protected suffix. */
export async function runAutoCompression(deps: CompressDeps, inputState: PluginState): Promise<CompressOutcome> {
	const source = sourceEntries(deps);
	const scoped = scopeToActiveBranch(source, inputState, currentContextEntries(deps));
	if (deps.contextWindow <= 0) return { status: "skipped", reason: "context window is unknown" };

	const entries = source;
	const index = entryIndex(deps, entries);
	const protectedFrom = protectedStart(entries, resolveTokenLimit(deps.cfg.keepRecent, deps.contextWindow));
	const compressionStart = firstCompressibleIndex(entries);
	let working = scoped.state;
	// The prefix must already cover every compressible entry before the retained pointer. Raw
	// conversation at the head cannot be skipped, because advancing past it would drop content;
	// prompt state and metadata may precede the prefix because they are never block targets.
	const prefix = resolveCompactedPrefix(entries, working);
	if (prefix.reason) return { status: "error", reason: prefix.reason, createdBlocks: [] };
	const prefixStart = prefix.retainedFrom;
	const initiallyOccupied = occupiedSourceIds(entries, working);
	let protectedIncompleteTail = false;
	const createdBlocks: CompactBlock[] = [];
	let totalTokens = 0;
	let compressedTokens = 0;
	for (let position = compressionStart; position < protectedFrom; position++) {
		if (!isCompressibleEntry(entries[position])) continue;
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
		throwIfAborted(deps);
		const run = nextUncompressedRun(entries, working, prefixStart, protectedFrom);
		if (!run) break;
		const search = findAutoCandidate(deps, working, entries, index, run);
		if (!search.candidate) {
			if (search.boundaries === 0
				&& (run.to === entries.length - 1 || run.to + 1 === protectedFrom)) {
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

	if (hasUncompressedSource(entries, working, prefixStart, protectedFrom) && !protectedIncompleteTail) {
		return { status: "error", reason: "uncompressed content remains before the protected suffix", createdBlocks };
	}
	if (createdBlocks.length === 0) {
		const normalized = inputState.topLevelBlockIds.length !== working.topLevelBlockIds.length
			|| inputState.topLevelBlockIds.some((id, index) => id !== working.topLevelBlockIds[index]);
		return normalized
			? { status: "skipped", state: rememberBranchFrontier(deps, working, scoped), reason: "no compressible entries" }
			: { status: "skipped", reason: "no compressible entries" };
	}
	return {
		status: "created",
		state: rememberBranchFrontier(deps, working, scoped),
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
	// Only the leading uncompressed range may be compacted, so the compacted history always
	// stays one contiguous prefix and the retained tail is never reordered around a gap.
	const prefix = resolveCompactedPrefix(source, state);
	if (prefix.reason) return { status: "error", reason: prefix.reason };
	// Leading prompt state and metadata may be named explicitly, but no uncompressed conversation
	// may be skipped. A start inside an existing block is still reported by the overlap check below.
	const expectedStart = firstCompressibleIndex(source, prefix.retainedFrom);
	if (start > expectedStart) {
		return {
			status: "error",
			reason: expectedStart >= source.length
				? "the whole visible history is already compacted; nothing remains to compress"
				: `startId would skip uncompressed history; start at ${source[expectedStart]?.id}`,
		};
	}
	while (end < source.length - 1 && !isTurnBoundary(source, end)) end++;
	const requestedEnd = end;
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
		state: rememberBranchFrontier(deps, stable.state, scoped),
		createdBlocks: [created.block, ...stable.blocks],
	};
}

/** Manually merge two through k adjacent same-level top blocks. */
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
		state: rememberBranchFrontier(deps, stable.state, scoped),
		createdBlocks: [...(promoted.created ? [promoted.block] : []), ...stable.blocks],
	};
}

/** Return the ordered level-1 leaves covered by an immutable block. */
function leafBlockIds(state: PluginState, blockId: string, visiting = new Set<string>()): string[] {
	if (visiting.has(blockId)) throw new Error("block graph contains a cycle");
	const block = state.blocks.find((candidate) => candidate.blockId === blockId);
	if (!block) throw new Error(`block ${blockId} is missing`);
	if (block.level === 1) return [blockId];
	const next = new Set(visiting).add(blockId);
	return block.childBlockIds.flatMap((childId) => leafBlockIds(state, childId, next));
}

/** Resolve the currently selected children of a parent. */
function selectedChildIds(state: PluginState, parentId: string): string[] {
	const parent = state.blocks.find((block) => block.blockId === parentId);
	if (!parent) throw new Error(`parent block ${parentId} is missing`);
	return state.childBlockIdsByParent[parentId] ?? parent.childBlockIds;
}

/** Replace adjacent siblings while preserving their parent block and all immutable old nodes. */
function replaceTreeSiblings(
	state: PluginState,
	parentId: string | undefined,
	groupIds: string[],
	replacementIds: string[],
): PluginState | string {
	const siblings = parentId === undefined ? state.topLevelBlockIds : selectedChildIds(state, parentId);
	const first = siblings.indexOf(groupIds[0] ?? "");
	if (first < 0 || groupIds.some((id, offset) => siblings[first + offset] !== id)) {
		return "blocks must be adjacent siblings in their displayed order";
	}
	const next = [...siblings.slice(0, first), ...replacementIds, ...siblings.slice(first + groupIds.length)];
	if (parentId === undefined) return { ...state, topLevelBlockIds: next };
	return {
		...state,
		childBlockIdsByParent: { ...state.childBlockIdsByParent, [parentId]: next },
	};
}

/** Merge displayed siblings, reusing an immutable block with the same ordered leaves when possible. */
export async function runTreeMerge(
	deps: CompressDeps,
	inputState: PluginState,
	parentId: string | undefined,
	blockIds: string[],
	focus?: string,
): Promise<CompressOutcome> {
	const source = sourceEntries(deps);
	const scoped = scopeToActiveBranch(source, inputState, currentContextEntries(deps));
	const state = scoped.state;
	const checked = replaceTreeSiblings(state, parentId, blockIds, []);
	if (typeof checked === "string") return { status: "error", reason: checked };
	const selected = blockIds.map((id) => state.blocks.find((block) => block.blockId === id));
	if (selected.some((block) => !block)) return { status: "error", reason: "block not found" };
	const concrete = selected as CompactBlock[];
	if (concrete.length < 2 || concrete.length > deps.cfg.blockMergeThreshold) {
		return { status: "error", reason: `choose between 2 and ${deps.cfg.blockMergeThreshold} blocks` };
	}
	if (concrete.some((block) => block.level !== concrete[0].level)) {
		return { status: "error", reason: "blocks must have the same level" };
	}
	const parent = parentId === undefined ? undefined : state.blocks.find((block) => block.blockId === parentId);
	if (parentId !== undefined && (!parent || concrete[0].level + 1 >= parent.level)) {
		return { status: "error", reason: "merged block must remain below its parent level" };
	}
	const leaves = blockIds.flatMap((id) => leafBlockIds(state, id));
	if (parentId !== undefined) {
		const parentLeaves = leafBlockIds(state, parentId);
		if (parentLeaves.length === leaves.length && parentLeaves.every((id, index) => id === leaves[index])) {
			return { status: "error", reason: "cannot merge a parent's complete coverage into the parent itself" };
		}
	}
	const temporary = { ...state, topLevelBlockIds: blockIds };
	const promoted = await promoteGroup(deps, temporary, blockIds, focus);
	if (!promoted.state || !promoted.block) return { status: "error", reason: promoted.error };
	const merged = promoted.block;
	if (parent && merged.level >= parent.level) {
		return { status: "error", reason: "merged block must remain below its parent level" };
	}
	const repository = { ...state, blocks: promoted.state.blocks, nextSeq: promoted.state.nextSeq };
	const replaced = replaceTreeSiblings(repository, parentId, blockIds, [merged.blockId]);
	if (typeof replaced === "string") return { status: "error", reason: replaced };
	const totalTokens = concrete.reduce((sum, block) => sum + block.sourceTokens, 0);
	reportProgress(deps, totalTokens, totalTokens, [merged]);
	const stable = parentId === undefined ? await stabilize(deps, replaced) : { state: replaced, blocks: [] };
	if (!stable.state) return { status: "error", reason: stable.error };
	if (stable.blocks.length > 0) reportProgress(deps, totalTokens, totalTokens, stable.blocks);
	return {
		status: "adjusted",
		state: rememberBranchFrontier(deps, stable.state, scoped),
		createdBlocks: [...(promoted.created ? [merged] : []), ...stable.blocks],
	};
}

/** Expand any displayed non-leaf block without changing its parent or ancestors. */
export async function runTreeSplit(
	deps: CompressDeps,
	inputState: PluginState,
	parentId: string | undefined,
	blockId: string,
): Promise<CompressOutcome> {
	const source = sourceEntries(deps);
	const scoped = scopeToActiveBranch(source, inputState, currentContextEntries(deps));
	const state = scoped.state;
	const block = state.blocks.find((candidate) => candidate.blockId === blockId);
	if (!block) return { status: "error", reason: "block not found" };
	const childIds = selectedChildIds(state, blockId);
	if (childIds.length === 0) return { status: "error", reason: "level-1 leaves cannot be split in the tree editor" };
	const replaced = replaceTreeSiblings(state, parentId, [blockId], childIds);
	if (typeof replaced === "string") return { status: "error", reason: replaced };
	reportProgress(deps, block.sourceTokens, block.sourceTokens, childIds.map((id) =>
		state.blocks.find((candidate) => candidate.blockId === id)).filter((candidate): candidate is CompactBlock => candidate !== undefined));
	return {
		status: "adjusted",
		state: rememberBranchFrontier(deps, replaced, scoped),
		createdBlocks: [],
	};
}

/** Exported pure inspection helper for tests and UI. */
export function topLevelLayout(state: PluginState): Array<{ id: string; level: number }> {
	const byId = new Map(state.blocks.map((block) => [block.blockId, block] as const));
	return state.topLevelBlockIds.map((id) => ({ id, level: byId.get(id)?.level ?? 0 }));
}

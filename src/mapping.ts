/** Map Pi context messages back to session entries and project top-level blocks. */

import { sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactBlock, EntryMessageMapping, PluginState } from "./types.ts";
import { renderBlockCard } from "./util.ts";

/** Stringify each message object once; the walk may inspect the same message repeatedly. */
const messageSignatureCache = new WeakMap<object, string>();

function messageSignature(message: AgentMessage): string {
	let signature = messageSignatureCache.get(message);
	if (signature === undefined) {
		signature = JSON.stringify(message);
		messageSignatureCache.set(message, signature);
	}
	return signature;
}

/** Map intact entry messages in order; messages injected or changed by other extensions remain null. */
export function buildMapping(visibleEntries: SessionEntry[], messages: AgentMessage[]): EntryMessageMapping {
	const expected = visibleEntries.flatMap((entry) => {
		try {
			return sessionEntryToContextMessages(entry).map((message) => ({ entryId: entry.id, signature: messageSignature(message) }));
		} catch {
			return [];
		}
	});
	const messageEntryIds: Array<string | null> = Array(messages.length).fill(null);
	let cursor = 0;
	for (const item of expected) {
		let match = cursor;
		while (match < messages.length && messageSignature(messages[match]) !== item.signature) match++;
		if (match >= messages.length) continue;
		messageEntryIds[match] = item.entryId;
		cursor = match + 1;
	}
	return {
		entryPositions: new Map(visibleEntries.map((entry, index) => [entry.id, index])),
		messageEntryIds,
	};
}

/** Locate the stored branch anchor for the current path, or null when no branch index exists.
 * The root frontier, child frontier, and retained pointer are written under the same anchor,
 * so resolving the anchor once keeps selection, projection, and display consistent. */
function branchAnchorFor(entries: SessionEntry[], state: PluginState): string | null {
	const byBranch = state.topLevelBlockIdsByBranch;
	if (!byBranch || Object.keys(byBranch).length === 0) return null;
	for (let index = entries.length - 1; index >= 0; index--) {
		const key = entries[index]?.id ?? "";
		if (byBranch[key]) return key;
	}
	return "__root__";
}

/** Return the stored frontier for the current path, or null when no stored key matches. */
function frontierIdsForEntries(entries: SessionEntry[], state: PluginState): string[] | null {
	const anchor = branchAnchorFor(entries, state);
	if (anchor === null) return state.topLevelBlockIds;
	return state.topLevelBlockIdsByBranch?.[anchor] ?? null;
}

/** Return the internal edge selection stored for the current branch. */
export function activeChildFrontier(entries: SessionEntry[], state: PluginState): Record<string, string[]> {
	const anchor = branchAnchorFor(entries, state);
	if (anchor === null) return state.childBlockIdsByParent;
	return state.childBlockIdsByParentByBranch?.[anchor] ?? {};
}

/** First entry after the compacted prefix, resolved from the same anchor as the block frontier. */
export function activeFirstKeptEntryId(entries: SessionEntry[], state: PluginState): string | undefined {
	const anchor = branchAnchorFor(entries, state);
	if (anchor === null) return state.firstKeptEntryIdByBranch?.__root__;
	return state.firstKeptEntryIdByBranch?.[anchor];
}

interface EntrySpan {
	block: CompactBlock;
	start: number;
	end: number;
}

/** Resolve a block from its inclusive boundary IDs without validating interior entry identity. */
function entrySpan(block: CompactBlock, positions: Map<string, number>): EntrySpan | null {
	const start = positions.get(block.startEntryId);
	const end = positions.get(block.endEntryId);
	return start === undefined || end === undefined || end < start ? null : { block, start, end };
}

/** Return active top-level blocks in source order for the current branch. */
export function activeTopBlocks(entries: SessionEntry[], state: PluginState): CompactBlock[] {
	const positions = new Map(entries.map((entry, index) => [entry.id, index] as const));
	const byId = new Map(state.blocks.map((block) => [block.blockId, block] as const));
	const frontierIds = frontierIdsForEntries(entries, state) ?? state.blocks.map((block) => block.blockId);
	const topPosition = new Map(frontierIds.map((id, index) => [id, index] as const));
	const frontier = (blockId: string, visiting = new Set<string>()): CompactBlock[] => {
		if (visiting.has(blockId)) return [];
		const block = byId.get(blockId);
		if (!block) return [];
		if (entrySpan(block, positions)) return [block];
		const nextVisiting = new Set(visiting).add(blockId);
		return block.childBlockIds.flatMap((childId) => frontier(childId, nextVisiting));
	};
	const candidates = frontierIds.flatMap((id) => frontier(id));
	const unique = [...new Map(candidates.map((block) => [block.blockId, block] as const)).values()];
	const spans = unique
		.map((block) => entrySpan(block, positions))
		.filter((span): span is EntrySpan => span !== null)
		.sort((left, right) => left.start - right.start
			|| right.end - left.end
			|| right.block.level - left.block.level
			|| (topPosition.get(left.block.blockId) ?? Number.MAX_SAFE_INTEGER)
				- (topPosition.get(right.block.blockId) ?? Number.MAX_SAFE_INTEGER));
	const active: EntrySpan[] = [];
	for (const span of spans) {
		if (active.some((selected) => span.start <= selected.end && selected.start <= span.end)) continue;
		active.push(span);
	}
	return active.sort((left, right) => left.start - right.start).map(({ block }) => block);
}

/** System messages are Pi prompt state, not conversation; block projection must keep them. */
function promptStateMessages(entry: SessionEntry): AgentMessage[] {
	return sessionEntryToContextMessages(entry).filter((message) => message.role === "system");
}

/** Replace compact intervals with cards and keep their entire envelope free of raw entries. */
export function projectSessionEntries(visibleEntries: SessionEntry[], blocks: CompactBlock[]): AgentMessage[] {
	const positions = new Map(visibleEntries.map((entry, index) => [entry.id, index] as const));
	const spans = blocks
		.map((block) => entrySpan(block, positions))
		.filter((span): span is EntrySpan => span !== null)
		.sort((left, right) => left.start - right.start);
	const byStart = new Map(spans.map((span) => [span.start, span] as const));
	const envelopeStart = spans[0]?.start;
	const envelopeEnd = spans.at(-1)?.end;
	const messages: AgentMessage[] = [];
	for (let index = 0; index < visibleEntries.length; index++) {
		const span = byStart.get(index);
		if (span) {
			messages.push({ role: "user", content: renderBlockCard(span.block), timestamp: Date.now() });
			for (let inner = index; inner <= span.end; inner++) messages.push(...promptStateMessages(visibleEntries[inner]));
			index = span.end;
			continue;
		}
		if (envelopeStart !== undefined && envelopeEnd !== undefined && envelopeStart <= index && index <= envelopeEnd) {
			messages.push(...promptStateMessages(visibleEntries[index]));
			continue;
		}
		messages.push(...sessionEntryToContextMessages(visibleEntries[index]));
	}
	return messages;
}

interface MessageSpan {
	block: CompactBlock;
	start: number;
	end: number;
}

/** Resolve messages within inclusive entry boundaries, which may themselves have no messages. */
function messageSpans(mapping: EntryMessageMapping, blocks: CompactBlock[]): MessageSpan[] {
	const positions = mapping.messageEntryIds.map((id) => id === null ? undefined : mapping.entryPositions.get(id));
	const spans: MessageSpan[] = [];
	for (const block of blocks) {
		const sourceSpan = entrySpan(block, mapping.entryPositions);
		if (!sourceSpan) continue;
		let start = -1;
		let end = -1;
		for (let index = 0; index < positions.length; index++) {
			const position = positions[index];
			if (position === undefined || position < sourceSpan.start || position > sourceSpan.end) continue;
			if (start < 0) start = index;
			end = index;
		}
		if (start >= 0) spans.push({ block, start, end });
	}
	return spans.sort((left, right) => left.start - right.start);
}

/** Keep only unmatched messages outside the complete compact-block envelope. */
export function unmatchedMessagesOutsideBlocks(
	messages: AgentMessage[],
	mapping: EntryMessageMapping,
	blocks: CompactBlock[],
): AgentMessage[] {
	const spans = messageSpans(mapping, blocks);
	const envelopeStart = spans[0]?.start;
	const envelopeEnd = spans.at(-1)?.end;
	return messages.filter((_message, index) =>
		mapping.messageEntryIds[index] === null
		&& (envelopeStart === undefined || envelopeEnd === undefined || index < envelopeStart || index > envelopeEnd));
}

/** Replace complete mapped intervals and keep their entire envelope free of raw messages. */
export function projectMessages(
	messages: AgentMessage[],
	mapping: EntryMessageMapping,
	blocks: CompactBlock[],
): AgentMessage[] {
	if (blocks.length === 0) return messages;
	const spans = messageSpans(mapping, blocks);
	if (spans.some((span, index) => index > 0 && span.start <= spans[index - 1].end)) return messages;
	const byStart = new Map(spans.map((span) => [span.start, span] as const));
	const envelopeStart = spans[0]?.start;
	const envelopeEnd = spans.at(-1)?.end;
	const output: AgentMessage[] = [];
	for (let index = 0; index < messages.length; index++) {
		const span = byStart.get(index);
		if (span) {
			output.push({ role: "user", content: renderBlockCard(span.block), timestamp: Date.now() });
			for (let inner = index; inner <= span.end; inner++) {
				if (messages[inner].role === "system") output.push(messages[inner]);
			}
			index = span.end;
			continue;
		}
		if (envelopeStart !== undefined && envelopeEnd !== undefined && envelopeStart <= index && index <= envelopeEnd) {
			if (messages[index].role === "system") output.push(messages[index]);
			continue;
		}
		output.push(messages[index]);
	}
	return output;
}

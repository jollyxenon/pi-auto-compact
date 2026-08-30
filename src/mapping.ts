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

/** Best-effort mapping: entry messages that survive intact are matched in order;
 * messages mutated or injected by other extensions stay null instead of failing the whole projection. */
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
	return { messageEntryIds };
}

/** Return the stored frontier for the current path, or null when no stored key matches. */
function frontierIdsForEntries(entries: SessionEntry[], state: PluginState): string[] | null {
	const byBranch = state.topLevelBlockIdsByBranch;
	if (!byBranch || Object.keys(byBranch).length === 0) return state.topLevelBlockIds;
	for (let index = entries.length - 1; index >= 0; index--) {
		const ids = byBranch[entries[index]?.id ?? ""];
		if (ids) return ids;
	}
	return byBranch.__root__ ?? null;
}

/** Return active top-level blocks in source order for the current branch. */
export function activeTopBlocks(entries: SessionEntry[], state: PluginState): CompactBlock[] {
	const position = new Map(entries.map((entry, index) => [entry.id, index] as const));
	const byId = new Map(state.blocks.map((block) => [block.blockId, block] as const));
	// With no stored frontier for this path, reconstruct conservatively from the whole
	// block repository: invalid blocks descend to children, foreign-branch blocks vanish.
	const frontierIds = frontierIdsForEntries(entries, state) ?? state.blocks.map((block) => block.blockId);
	const topPosition = new Map(frontierIds.map((id, index) => [id, index] as const));
	const isValid = (block: CompactBlock): boolean => {
		if (block.sourceEntryIds.length === 0) return false;
		let previous = -1;
		for (const sourceId of block.sourceEntryIds) {
			const current = position.get(sourceId);
			if (current === undefined || current <= previous) return false;
			previous = current;
		}
		return true;
	};
	const frontier = (blockId: string, visiting = new Set<string>()): CompactBlock[] => {
		if (visiting.has(blockId)) return [];
		const block = byId.get(blockId);
		if (!block) return [];
		if (isValid(block)) return [block];
		const nextVisiting = new Set(visiting).add(blockId);
		return block.childBlockIds.flatMap((childId) => frontier(childId, nextVisiting));
	};
	const candidates = frontierIds.flatMap((id) => frontier(id));
	const unique = [...new Map(candidates.map((block) => [block.blockId, block] as const)).values()];
	const ordered = unique.sort((left, right) => {
		const leftStart = position.get(left.sourceEntryIds[0]) ?? Number.MAX_SAFE_INTEGER;
		const rightStart = position.get(right.sourceEntryIds[0]) ?? Number.MAX_SAFE_INTEGER;
		return leftStart - rightStart
			|| right.sourceEntryIds.length - left.sourceEntryIds.length
			|| right.level - left.level
			|| (topPosition.get(left.blockId) ?? Number.MAX_SAFE_INTEGER) - (topPosition.get(right.blockId) ?? Number.MAX_SAFE_INTEGER);
	});
	const occupied = new Set<string>();
	const active: CompactBlock[] = [];
	for (const block of ordered) {
		if (block.sourceEntryIds.some((sourceId) => occupied.has(sourceId))) continue;
		active.push(block);
		for (const sourceId of block.sourceEntryIds) occupied.add(sourceId);
	}
	return active.sort((left, right) =>
		(position.get(left.sourceEntryIds[0]) ?? 0) - (position.get(right.sourceEntryIds[0]) ?? 0),
	);
}

export function projectSessionEntries(visibleEntries: SessionEntry[], blocks: CompactBlock[]): AgentMessage[] {
	const covered = new Map<string, CompactBlock>();
	const insertAt = new Map<string, CompactBlock>();
	for (const block of blocks) {
		for (const sourceId of block.sourceEntryIds) covered.set(sourceId, block);
		insertAt.set(block.sourceEntryIds[0], block);
	}
	const messages: AgentMessage[] = [];
	for (const entry of visibleEntries) {
		const block = insertAt.get(entry.id);
		if (block) messages.push({ role: "user", content: renderBlockCard(block), timestamp: Date.now() });
		if (covered.has(entry.id)) continue;
		messages.push(...sessionEntryToContextMessages(entry));
	}
	return messages;
}

export function projectMessages(
	messages: AgentMessage[],
	mapping: EntryMessageMapping,
	blocks: CompactBlock[],
): AgentMessage[] {
	if (blocks.length === 0) return messages;
	const blockBySourceId = new Map<string, CompactBlock>();
	const insertAt = new Map<number, CompactBlock>();
	for (const block of blocks) {
		for (const sourceId of block.sourceEntryIds) {
			if (blockBySourceId.has(sourceId)) return messages;
			blockBySourceId.set(sourceId, block);
		}
		const firstIndex = mapping.messageEntryIds.findIndex((id) => id !== null && block.sourceEntryIds.includes(id));
		if (firstIndex >= 0) insertAt.set(firstIndex, block);
	}
	const output: AgentMessage[] = [];
	for (let index = 0; index < messages.length; index++) {
		const block = insertAt.get(index);
		if (block) output.push({ role: "user", content: renderBlockCard(block), timestamp: Date.now() });
		const entryId = mapping.messageEntryIds[index];
		if (entryId !== null && blockBySourceId.has(entryId)) continue;
		output.push(messages[index]);
	}
	return output;
}

/** Atomic sidecar persistence; original content remains in Pi's append-only session. */

import * as fs from "node:fs";
import type { PluginState } from "./types.ts";
import { freshState } from "./types.ts";

export function statePathFor(sessionFile: string): string {
	return `${sessionFile}.autocompact.json`;
}

/** Rename a corrupt sidecar out of the way instead of silently discarding block metadata. */
function quarantine(path: string, reason: string): void {
	try {
		fs.renameSync(path, `${path}.corrupt-${Date.now()}`);
	} catch {
		// Nothing to rename; the fresh state below is still the safe outcome.
	}
	console.error(`[auto-compact] sidecar state discarded (${reason}): ${path}`);
}

function validBlock(value: unknown): value is PluginState["blocks"][number] {
	if (!value || typeof value !== "object") return false;
	const block = value as Record<string, unknown>;
	return typeof block.blockId === "string"
		&& typeof block.level === "number" && Number.isInteger(block.level) && block.level >= 1
		&& typeof block.overview === "string" && block.overview.trim().length > 0
		&& !/[\r\n]/.test(block.overview)
		&& typeof block.startEntryId === "string" && block.startEntryId.length > 0
		&& typeof block.endEntryId === "string" && block.endEntryId.length > 0
		&& Array.isArray(block.childBlockIds) && block.childBlockIds.every((id) => typeof id === "string")
		&& typeof block.summary === "string"
		&& typeof block.createdAt === "string"
		&& typeof block.sourceTokens === "number"
		&& typeof block.cardTokens === "number";
}

/** Enforce the block-repository invariants once at load time. */
function validState(parsed: unknown): parsed is PluginState {
	if (!parsed || typeof parsed !== "object") return false;
	const state = parsed as Record<string, unknown>;
	if (state.schemaVersion !== 4
		|| !Array.isArray(state.blocks)
		|| !Array.isArray(state.topLevelBlockIds)
		|| typeof state.childBlockIdsByParent !== "object"
		|| state.childBlockIdsByParent === null
		|| Array.isArray(state.childBlockIdsByParent)
		|| !Number.isInteger(state.nextSeq)) return false;
	if (state.topLevelBlockIdsByBranch !== undefined
		&& (typeof state.topLevelBlockIdsByBranch !== "object"
			|| state.topLevelBlockIdsByBranch === null
			|| Array.isArray(state.topLevelBlockIdsByBranch))) return false;
	if (state.childBlockIdsByParentByBranch !== undefined
		&& (typeof state.childBlockIdsByParentByBranch !== "object"
			|| state.childBlockIdsByParentByBranch === null
			|| Array.isArray(state.childBlockIdsByParentByBranch))) return false;
	const blocks = state.blocks as unknown[];
	if (blocks.some((block) => !validBlock(block))) return false;
	const blockIds = (state.blocks as PluginState["blocks"]).map((block) => block.blockId);
	if (new Set(blockIds).size !== blockIds.length) return false;
	const blockById = new Map((state.blocks as PluginState["blocks"]).map((block) => [block.blockId, block] as const));
	// Every immutable edge must descend and preserve the parent's boundary IDs.
	const validChildren = (parentId: string, childIds: string[]): boolean => {
		const parent = blockById.get(parentId);
		if (!parent || childIds.length === 0) return false;
		const children = childIds.map((id) => blockById.get(id));
		return children.every((child) => child !== undefined && child.level < parent.level)
			&& children[0]?.startEntryId === parent.startEntryId
			&& children.at(-1)?.endEntryId === parent.endEntryId;
	};
	for (const block of state.blocks as PluginState["blocks"]) {
		if (block.level === 1 ? block.childBlockIds.length !== 0 : !validChildren(block.blockId, block.childBlockIds)) return false;
	}
	const leafKey = (blockId: string, visiting = new Set<string>()): string | null => {
		if (visiting.has(blockId)) return null;
		const block = blockById.get(blockId);
		if (!block) return null;
		if (block.level === 1) return block.blockId;
		const next = new Set(visiting).add(blockId);
		const leaves = block.childBlockIds.map((childId) => leafKey(childId, next));
		return leaves.some((value) => value === null) ? null : leaves.join("\u0000");
	};
	const leafKeys = blockIds.map((id) => leafKey(id));
	if (leafKeys.some((key) => key === null) || new Set(leafKeys).size !== leafKeys.length) return false;
	for (const id of blockIds) {
		const match = /^ac_(\d+)$/.exec(id);
		if (match && Number(match[1]) >= (state.nextSeq as number)) return false;
	}
	const ids = new Set(blockIds);
	if ((state.topLevelBlockIds as string[]).some((id) => !ids.has(id))
		|| new Set(state.topLevelBlockIds as string[]).size !== (state.topLevelBlockIds as string[]).length) return false;
	const validChildFrontier = (value: unknown): boolean => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		return Object.entries(value as Record<string, unknown>).every(([parentId, childIds]) =>
			ids.has(parentId)
			&& Array.isArray(childIds)
			&& new Set(childIds).size === childIds.length
			&& childIds.every((id) => typeof id === "string" && ids.has(id))
			&& validChildren(parentId, childIds as string[]));
	};
	if (!validChildFrontier(state.childBlockIdsByParent)) return false;
	if (state.topLevelBlockIdsByBranch) {
		const branches = state.topLevelBlockIdsByBranch as Record<string, unknown>;
		if (Object.values(branches).some((branchIds) =>
			!Array.isArray(branchIds)
			|| new Set(branchIds).size !== branchIds.length
			|| branchIds.some((id) => typeof id !== "string" || !ids.has(id)))) return false;
	}
	if (state.childBlockIdsByParentByBranch
		&& Object.values(state.childBlockIdsByParentByBranch as Record<string, unknown>)
			.some((frontier) => !validChildFrontier(frontier))) return false;
	return true;
}

/** Missing sidecars are normal; only malformed contents are quarantined. */
export function loadState(path: string): PluginState {
	let contents: string;
	try {
		contents = fs.readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return freshState();
		throw new Error(`[auto-compact] failed to read sidecar state: ${path}`, { cause: error });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch {
		quarantine(path, "unparseable");
		return freshState();
	}
	if (!validState(parsed)) {
		quarantine(path, "invalid structure");
		return freshState();
	}
	return parsed;
}

/** Write then rename. Callers replace in-memory state only after this succeeds. */
export function saveState(path: string, state: PluginState): void {
	const temporary = `${path}.tmp-${process.pid}`;
	try {
		fs.writeFileSync(temporary, JSON.stringify(state, null, "\t"), "utf8");
		fs.renameSync(temporary, path);
	} catch (error) {
		try {
			fs.unlinkSync(temporary);
		} catch {
			// Nothing to clean up.
		}
		throw error;
	}
}

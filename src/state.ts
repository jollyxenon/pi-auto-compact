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
		&& Array.isArray(block.sourceEntryIds) && block.sourceEntryIds.length > 0
		&& block.sourceEntryIds.every((id) => typeof id === "string")
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
	if (state.schemaVersion !== 1
		|| !Array.isArray(state.blocks)
		|| !Array.isArray(state.topLevelBlockIds)
		|| !Number.isInteger(state.nextSeq)) return false;
	if (state.topLevelBlockIdsByBranch !== undefined
		&& (typeof state.topLevelBlockIdsByBranch !== "object"
			|| state.topLevelBlockIdsByBranch === null
			|| Array.isArray(state.topLevelBlockIdsByBranch))) return false;
	const blocks = state.blocks as unknown[];
	if (blocks.some((block) => !validBlock(block))) return false;
	const blockIds = (state.blocks as PluginState["blocks"]).map((block) => block.blockId);
	if (new Set(blockIds).size !== blockIds.length) return false;
	const byId = new Set(blockIds);
	// Every referenced child must exist, and future block IDs must not collide with stored ones.
	const known = (state.blocks as PluginState["blocks"]).flatMap((block) => block.childBlockIds);
	if (known.some((id) => !byId.has(id))) return false;
	for (const id of blockIds) {
		const match = /^ac_(\d+)$/.exec(id);
		if (match && Number(match[1]) >= (state.nextSeq as number)) return false;
	}
	const ids = new Set(blockIds);
	if ((state.topLevelBlockIds as string[]).some((id) => !ids.has(id))
		|| new Set(state.topLevelBlockIds as string[]).size !== (state.topLevelBlockIds as string[]).length) return false;
	if (state.topLevelBlockIdsByBranch) {
		const branches = state.topLevelBlockIdsByBranch as Record<string, unknown>;
		if (Object.values(branches).some((branchIds) =>
			!Array.isArray(branchIds) || branchIds.some((id) => !ids.has(id)))) return false;
	}
	return true;
}

export function loadState(path: string): PluginState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(path, "utf8"));
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

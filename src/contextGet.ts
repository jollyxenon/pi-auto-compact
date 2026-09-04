/** Lossless source retrieval with branch validation and mandatory pagination. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AutoCompactConfig } from "./config.ts";
import type { PluginState } from "./types.ts";
import { serializeEntry, splitTextSafe } from "./util.ts";

export interface ContextGetDeps {
	cfg: AutoCompactConfig;
	getState: (ctx: ExtensionContext) => PluginState;
}

type PageQuery =
	| { kind: "block"; blockId: string; includeThinking: boolean; rawEntryJson: boolean }
	| { kind: "range"; startId: string; endId: string; includeThinking: boolean; rawEntryJson: boolean };

interface CursorPayload {
	query: PageQuery;
	index: number;
	offset: number;
}

function encodeCursor(payload: CursorPayload): string {
	return `acur_${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function decodeCursor(cursor: string): CursorPayload | null {
	try {
		if (!cursor.startsWith("acur_")) return null;
		const value = JSON.parse(Buffer.from(cursor.slice(5), "base64url").toString("utf8")) as CursorPayload;
		if (!value.query || !Number.isInteger(value.index) || value.index < 0 || !Number.isInteger(value.offset) || value.offset < 0) return null;
		return value;
	} catch {
		return null;
	}
}

export interface PageResult {
	text: string;
	truncated: boolean;
	nextIndex: number;
	nextOffset: number;
	lastReturnedId?: string;
}

/** Page complete entries when possible and split oversized entries at safe text boundaries. */
export function paginateEntryTexts(
	entries: { entryId: string; text: string }[],
	startIndex: number,
	startOffset: number,
	maxTokens: number,
): PageResult {
	if (startIndex > entries.length) return { text: "", truncated: false, nextIndex: entries.length, nextOffset: 0 };
	const budget = maxTokens * 4;
	const output: string[] = [];
	let chars = 0;
	let index = startIndex;
	let offset = startOffset;
	let lastReturnedId: string | undefined;
	while (index < entries.length) {
		if (offset > entries[index].text.length) break;
		const remaining = entries[index].text.slice(offset);
		const separator = output.length > 0 ? 2 : 0;
		if (chars + separator + remaining.length <= budget) {
			output.push(remaining);
			chars += separator + remaining.length;
			lastReturnedId = entries[index].entryId;
			index++;
			offset = 0;
			continue;
		}
		const room = budget - chars - separator;
		if (room > 0) {
			const { head } = splitTextSafe(remaining, room);
			output.push(head);
			offset += head.length;
			lastReturnedId = entries[index].entryId;
		}
		break;
	}
	return {
		text: output.join("\n\n"),
		truncated: index < entries.length,
		nextIndex: index,
		nextOffset: offset,
		lastReturnedId,
	};
}

export function makeContextGetTool(deps: ContextGetDeps) {
	const parameters = Type.Object({
		blockId: Type.Optional(Type.String({ description: "Historical block ID" })),
		startId: Type.Optional(Type.String({ description: "First Pi session entry ID" })),
		endId: Type.Optional(Type.String({ description: "Last Pi session entry ID, inclusive" })),
		cursor: Type.Optional(Type.String({ description: "Opaque cursor returned by the previous page" })),
		includeThinking: Type.Optional(Type.Boolean({ description: "Include archived assistant thinking; default false" })),
		rawEntryJson: Type.Optional(Type.Boolean({ description: "Return every complete Pi SessionEntry field as JSON; default false" })),
		maxTokens: Type.Optional(Type.Integer({ minimum: 256, description: "Page token limit; capped by the effective maxPageSize" })),
	});
	return {
		name: "context_get",
		label: "读取压缩历史原文",
		description:
			"Read original Pi session entries hidden by a historical block. Use blockId, startId+endId, or a returned cursor. Results are paged; assistant thinking is omitted unless includeThinking=true. Set rawEntryJson=true for every original SessionEntry field.",
		promptSnippet: "Retrieve exact original entries behind compact history blocks",
		promptGuidelines: [
			"Use context_get when a compact block lacks an exact command, error, code fragment, or decision needed for the current task.",
			"Continue context_get with its returned cursor while Truncated is true.",
		],
		parameters,
		async execute(
			_toolCallId: string,
			params: {
				blockId?: string;
				startId?: string;
				endId?: string;
				cursor?: string;
				includeThinking?: boolean;
				rawEntryJson?: boolean;
				maxTokens?: number;
			},
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const text = executeContextGet(deps, params, ctx);
			if (text.startsWith("Error:")) throw new Error(text.slice("Error:".length).trim());
			return { content: [{ type: "text" as const, text }], details: { ok: true } };
		},
	};
}

function executeContextGet(
	deps: ContextGetDeps,
	params: {
		blockId?: string;
		startId?: string;
		endId?: string;
		cursor?: string;
		includeThinking?: boolean;
		rawEntryJson?: boolean;
		maxTokens?: number;
	},
	ctx: ExtensionContext,
): string {
	const branch = ctx.sessionManager.getBranch();
	const positions = new Map(branch.map((entry, index) => [entry.id, index] as const));
	const state = deps.getState(ctx);
	let query: PageQuery;
	let startIndex = 0;
	let startOffset = 0;
	if (params.cursor) {
		const cursor = decodeCursor(params.cursor);
		if (!cursor) return "Error: invalid cursor";
		query = cursor.query;
		startIndex = cursor.index;
		startOffset = cursor.offset;
	} else if (params.blockId && !params.startId && !params.endId) {
		query = {
			kind: "block",
			blockId: params.blockId,
			includeThinking: params.includeThinking ?? false,
			rawEntryJson: params.rawEntryJson ?? false,
		};
	} else if (!params.blockId && params.startId && params.endId) {
		query = {
			kind: "range",
			startId: params.startId,
			endId: params.endId,
			includeThinking: params.includeThinking ?? false,
			rawEntryJson: params.rawEntryJson ?? false,
		};
	} else return "Error: provide blockId, startId+endId, or cursor";

	let ids: string[];
	let header: string;
	if (query.kind === "block") {
		const block = state.blocks.find((item) => item.blockId === query.blockId);
		if (!block) return `Error: block ${query.blockId} does not exist`;
		const first = positions.get(block.startEntryId);
		const last = positions.get(block.endEntryId);
		if (first === undefined || last === undefined || last < first) return `Error: block ${query.blockId} is not on the active branch`;
		ids = branch.slice(first, last + 1).map((entry) => entry.id);
		header = `Historical block ${block.blockId} (level ${block.level})`;
	} else {
		const first = positions.get(query.startId);
		const last = positions.get(query.endId);
		if (first === undefined || last === undefined || last < first) return "Error: invalid active-branch range";
		ids = branch.slice(first, last + 1).map((entry) => entry.id);
		header = `Historical range ${ids[0]}..${ids.at(-1)}`;
	}
	const entryTexts = ids.map((id) => {
		const entry = ctx.sessionManager.getEntry(id);
		if (!entry) throw new Error(`source entry ${id} disappeared`);
		return {
			entryId: id,
			text: query.rawEntryJson ? JSON.stringify(entry) : serializeEntry(entry, query.includeThinking).text,
		};
	});
	if (startIndex >= entryTexts.length && (startIndex !== entryTexts.length || startOffset !== 0)) return "Error: cursor is outside the requested range";
	const maxTokens = Math.min(params.maxTokens ?? deps.cfg.defaultPageSize, deps.cfg.maxPageSize);
	const page = paginateEntryTexts(entryTexts, startIndex, startOffset, maxTokens);
	const lines = [
		header,
		`Original range: ${ids[0]}..${ids.at(-1)} (${ids.length} entries)`,
		`Thinking included: ${query.includeThinking || query.rawEntryJson}`,
		`Raw entry JSON: ${query.rawEntryJson}`,
		`Truncated: ${page.truncated}`,
	];
	if (page.truncated) lines.push(`Next cursor: ${encodeCursor({ query, index: page.nextIndex, offset: page.nextOffset })}`);
	lines.push("", page.text);
	return lines.join("\n");
}

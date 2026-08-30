/** Session serialization, card rendering, and token helpers. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CompactBlock } from "./types.ts";

export type TokenEstimator = (message: AgentMessage) => number;

export interface EntryText {
	entryId: string;
	text: string;
}

/** Extract readable text without assuming every AgentMessage has content. */
export function messageToText(message: AgentMessage, includeThinking = true): string {
	if (message.role === "bashExecution") return `$ ${message.command}\n${message.output}`;
	if (message.role === "branchSummary" || message.role === "compactionSummary") return message.summary;
	if (message.role === "custom") return contentToText(message.content, includeThinking);
	if ("content" in message) return contentToText(message.content, includeThinking);
	return "";
}

/** Preserve all text/tool/image fields; thinking can be hidden for normal retrieval. */
function contentToText(content: unknown, includeThinking: boolean): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") {
			parts.push(JSON.stringify(block));
			continue;
		}
		const b = block as Record<string, unknown>;
		if (b.type === "thinking" && !includeThinking) continue;
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (b.type === "thinking" && typeof b.thinking === "string") {
			parts.push(`[thinking]\n${b.thinking}`);
		} else if (b.type === "toolCall") {
			parts.push(`[tool_call]\n${String(b.name ?? "") }(${JSON.stringify(b.arguments)})`);
		} else if (b.type === "image") {
			parts.push(`[image]\n${JSON.stringify(b)}`);
		} else parts.push(JSON.stringify(b));
	}
	return parts.join("\n");
}

/** Human-readable retrieval that retains stable entry IDs and complete source fields. */
export function serializeEntry(entry: SessionEntry, includeThinking = true): EntryText {
	if (entry.type === "message") {
		return {
			entryId: entry.id,
			text: `[${entry.id} ${entry.message.role}]\n${messageToText(entry.message, includeThinking)}`,
		};
	}
	if (entry.type === "custom_message") {
		return {
			entryId: entry.id,
			text: `[${entry.id} custom_message ${entry.customType}]\n${contentToText(entry.content, includeThinking)}`,
		};
	}
	if (entry.type === "compaction") return { entryId: entry.id, text: `[${entry.id} compaction]\n${entry.summary}` };
	if (entry.type === "branch_summary") return { entryId: entry.id, text: `[${entry.id} branch_summary]\n${entry.summary}` };
	return { entryId: entry.id, text: `[${entry.id} ${entry.type}]\n${JSON.stringify(entry)}` };
}

export function nextBlockId(sequence: number): string {
	return `ac_${sequence.toString().padStart(6, "0")}`;
}

export function renderBlockCard(block: Pick<CompactBlock, "blockId" | "level" | "sourceEntryIds" | "sourceTokens" | "summary">): string {
	const first = block.sourceEntryIds[0] ?? "?";
	const last = block.sourceEntryIds.at(-1) ?? "?";
	return [
		`[Historical block ${block.blockId} | level ${block.level} | ${first}..${last} | source ${block.sourceTokens} tokens]`,
		`Original context is available with context_get({"blockId":"${block.blockId}"}).`,
		block.summary,
	].join("\n");
}

/** Split at a nearby newline when possible; never return an empty head. */
export function splitTextSafe(text: string, maxChars: number): { head: string; tail: string } {
	if (text.length <= maxChars) return { head: text, tail: "" };
	let cut = text.lastIndexOf("\n", maxChars);
	if (cut < Math.floor(maxChars / 2)) cut = maxChars;
	const head = text.slice(0, Math.max(1, cut));
	return { head, tail: text.slice(head.length) };
}

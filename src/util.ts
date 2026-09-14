/** Session serialization, card rendering, and token helpers. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CompactBlock, PromptPart } from "./types.ts";

export type TokenEstimator = (message: AgentMessage) => number;

export interface EntryText {
	entryId: string;
	text: string;
}

/** Extract readable text without assuming every AgentMessage has content. */
export function messageToText(message: AgentMessage, includeThinking = true): string {
	return renderPromptParts(messageToPromptParts(message, includeThinking, false));
}

/** Describe an image without its payload; base64 is not text and must never reach a prompt. */
function imageToText(block: { mimeType?: unknown; data?: unknown }): string {
	const mime = typeof block.mimeType === "string" ? block.mimeType : "unknown";
	const data = typeof block.data === "string" ? block.data : "";
	if (!data) return `[image ${mime}]`;
	return `[image ${mime}, about ${Math.max(1, Math.round((data.length * 3) / 4 / 1024))}KB omitted]`;
}

/** A real image part when the reader accepts images, otherwise its placeholder text. */
function imagePart(block: { mimeType?: unknown; data?: unknown }, includeImages: boolean): PromptPart {
	const data = typeof block.data === "string" ? block.data : "";
	const mimeType = typeof block.mimeType === "string" ? block.mimeType : "";
	if (!includeImages || !data || !mimeType) return { type: "text", text: imageToText(block) };
	return { type: "image", data, mimeType };
}

/** Preserve all text/tool/image fields in order; thinking can be hidden for normal retrieval. */
function contentToPromptParts(content: unknown, includeThinking: boolean, includeImages: boolean): PromptPart[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return content === undefined ? [] : [{ type: "text", text: JSON.stringify(content) }];
	const parts: PromptPart[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") {
			parts.push({ type: "text", text: JSON.stringify(block) });
			continue;
		}
		const b = block as Record<string, unknown>;
		if (b.type === "thinking" && !includeThinking) continue;
		if (b.type === "text" && typeof b.text === "string") parts.push({ type: "text", text: b.text });
		else if (b.type === "thinking" && typeof b.thinking === "string") {
			parts.push({ type: "text", text: `[thinking]\n${b.thinking}` });
		} else if (b.type === "toolCall") {
			parts.push({ type: "text", text: `[tool_call]\n${String(b.name ?? "") }(${JSON.stringify(b.arguments)})` });
		} else if (b.type === "image") {
			parts.push(imagePart(b, includeImages));
		} else parts.push({ type: "text", text: JSON.stringify(b) });
	}
	return parts;
}

/** Prompt parts for one message, in content order. */
export function messageToPromptParts(message: AgentMessage, includeThinking = true, includeImages = true): PromptPart[] {
	if (message.role === "bashExecution") return [{ type: "text", text: `$ ${message.command}\n${message.output}` }];
	if (message.role === "branchSummary" || message.role === "compactionSummary") {
		return [{ type: "text", text: message.summary }];
	}
	if (message.role === "custom") return contentToPromptParts(message.content, includeThinking, includeImages);
	if ("content" in message) return contentToPromptParts(message.content, includeThinking, includeImages);
	return [];
}

/** Prefix a rendered body with its entry header, keeping the text form byte-identical. */
function withHeader(header: string, body: PromptPart[]): PromptPart[] {
	const parts: PromptPart[] = [{ type: "text", text: `${header}\n` }];
	body.forEach((part, index) => {
		if (index > 0) parts.push({ type: "text", text: "\n" });
		parts.push(part);
	});
	return parts;
}

/** One entry as ordered prompt parts; images stay where they were read. */
export function entryToPromptParts(entry: SessionEntry, includeThinking = true, includeImages = true): PromptPart[] {
	if (entry.type === "message") {
		return withHeader(`[${entry.id} ${entry.message.role}]`, messageToPromptParts(entry.message, includeThinking, includeImages));
	}
	if (entry.type === "custom_message") {
		return withHeader(`[${entry.id} custom_message ${entry.customType}]`, contentToPromptParts(entry.content, includeThinking, includeImages));
	}
	if (entry.type === "compaction") return withHeader(`[${entry.id} compaction]`, [{ type: "text", text: entry.summary }]);
	if (entry.type === "branch_summary") return withHeader(`[${entry.id} branch_summary]`, [{ type: "text", text: entry.summary }]);
	return withHeader(`[${entry.id} ${entry.type}]`, [{ type: "text", text: JSON.stringify(entry) }]);
}

/** Flatten prompt parts to text; image payloads never appear. */
export function renderPromptParts(parts: PromptPart[]): string {
	return parts.map((part) => (part.type === "text" ? part.text : imageToText(part))).join("");
}

/** Human-readable retrieval that retains stable entry IDs and complete source fields. */
export function serializeEntry(entry: SessionEntry, includeThinking = true): EntryText {
	return { entryId: entry.id, text: renderPromptParts(entryToPromptParts(entry, includeThinking, false)) };
}

export function nextBlockId(sequence: number): string {
	return `ac_${sequence.toString().padStart(6, "0")}`;
}

export function renderBlockCard(block: Pick<CompactBlock, "blockId" | "level" | "startEntryId" | "endEntryId" | "sourceTokens" | "summary">): string {
	return [
		`[Historical block ${block.blockId} | level ${block.level} | ${block.startEntryId}..${block.endEntryId} | source ${block.sourceTokens} tokens]`,
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

/** Strict summary protocol shared by automatic and manual operations. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SummarizeInput } from "./types.ts";
import { nextBlockId, renderBlockCard, type TokenEstimator } from "./util.ts";

export const SUMMARIZER_SYSTEM_PROMPT =
	"You are requested to compress the context of this session. Compress according to the format specifications provided below.";

/** Structural tags the compaction body must contain, in this exact order. */
export const REQUIRED_STRUCTURE_TAGS = [
	"<progress>",
	"<done>",
	"<doing>",
	"<todo>",
	"</progress>",
	"<blocked>",
	"<decision>",
	"<critical_content>",
	"<read_files>",
	"<modified_files>",
] as const;

/** One-sentence overview length limit used by the compaction protocol. */
export const OVERVIEW_MAX_CHARS = 50;

export function buildSummarizePrompt(input: SummarizeInput): string {
	return `# Context Compaction

## Compaction Specifications

- The reference context is ONLY used to understand the task situation and DOES NOT enter the generated compression block;
- When compressing, ONLY summarize the affairs that occur in the target compaction range and DO NOT expand the compression range outward;
- The compaction block structure MUST conform to the given format;
- Overview is limited to one sentence, not exceeding ${OVERVIEW_MAX_CHARS} characters;
- The compressed block output in the final format should not exceed ${input.budgetTokens} Token.

## Compaction Block Structure

The content you output should only have compaction blocks, starting from \`<overview>\` and ending at \`</modified_files>\`; STRICTLY follow the format specifications and DO NOT include ANY irrelevant content.

\`\`\`compaction_structure
<overview>
As a title display, a one sentence overview.
</overview>

<progress>
<done>
Completed affairs in the target compaction range. List by points.
</done>
<doing>
The last ongoing affair in the target compaction range. List by points.
</doing>
<todo>
The affair that should be carried out after the end of the last ongoing affair in the target compaction range. List by points.
</todo>
</progress>

<blocked>
A affair that was intended to be executed but could not be executed within the target compaction range due to certain reasons. List by points.
</blocked>

<decision>
Decisions made on open problems during task execution within the target compaction range. List by points. Please indicate whether the decision-maker is the user or the assistant.
</decision>

<critical_content>
The content that plays an important role in thinking and decision-making within the target compaction range. List by points.
</critical_content>

<read_files>
The file path read within the target compaction range. List by points.
</read_files>

<modified_files>
The file path for editing and writing within the target compaction range. List by points.
</modified_files>
\`\`\`

## Content that Needs to Be Compressed

You have been given the visible content of the entire session, including system prompt words, historical compaction blocks, target compaction range, and uncompressed reserved areas.

The system prompt words and historical compaction blocks are referenced in the previous text, and the uncompressed reserved area is referenced in the following text. Context reference is ONLY used to understand the task situation and DOES NOT enter the generated compression block.

You should only compress the target compaction range, which is the content enclosed by \`<target_compaction_range>\` and \`</target_compaction_range>\`.

The visible content of the entire session is as follows:

\`\`\`reference
<reference_above>
<system_prompt>
${input.systemPrompt}
</system_prompt>
<history_compaction_blocks>
${input.referenceAbove}
</history_compaction_blocks>
</reference_above>
\`\`\`

\`\`\`target
<target_compaction_range>
${input.targetRange}
</target_compaction_range>
\`\`\`

\`\`\`reference
<reference_below>
${input.referenceBelow}
</reference_below>
\`\`\`
`;
}

export interface ParsedSummaryResponse {
	overview: string;
	summary: string;
	problems: string[];
}

/** Split the model response into tree overview and context-card summary. */
export function parseSummaryResponse(response: string): ParsedSummaryResponse {
	const match = /^<overview>\s*\n([^\r\n]+)\n<\/overview>\s*\n([\s\S]+)$/.exec(response.trim());
	if (!match) return { overview: "", summary: response.trim(), problems: ["missing exact overview block"] };
	const overview = match[1].trim();
	const problems: string[] = [];
	if (!overview) problems.push("overview is empty");
	if (overview.length > OVERVIEW_MAX_CHARS) {
		problems.push(`overview exceeds ${OVERVIEW_MAX_CHARS} characters`);
	}
	if (/[\r\n]/.test(overview)) problems.push("overview must be one line");
	return { overview, summary: match[2].trim(), problems };
}

export interface SummaryValidation {
	ok: boolean;
	overBudget: boolean;
	problems: string[];
}

/** Validate structure, explicit Goal exclusion, and final card size. */
export function validateSummary(summary: string, cardTokens: number, budgetTokens: number): SummaryValidation {
	const problems: string[] = [];
	const trimmed = summary.trim();
	if (!trimmed) problems.push("summary is empty");
	if (/^\s{0,3}#{1,6}\s+Goal\b/im.test(trimmed)) problems.push("Goal is not allowed in compact blocks");
	if (trimmed && !trimmed.startsWith("<progress>")) problems.push("summary must start with <progress>");
	let lastIndex = -1;
	for (const tag of REQUIRED_STRUCTURE_TAGS) {
		const index = trimmed.indexOf(tag);
		if (index < 0) {
			problems.push(`missing ${tag}`);
			continue;
		}
		if (index < lastIndex) problems.push(`${tag} out of order`);
		lastIndex = Math.max(lastIndex, index + tag.length);
	}
	const modifiedEnd = trimmed.indexOf("</modified_files>");
	if (modifiedEnd >= 0 && trimmed.slice(modifiedEnd + "</modified_files>".length).trim()) {
		problems.push("content after </modified_files> is not allowed");
	}
	const overBudget = cardTokens > budgetTokens;
	if (overBudget) problems.push(`card uses ${cardTokens} tokens, limit is ${budgetTokens}`);
	return { ok: problems.length === 0, overBudget, problems };
}

export function rewriteInstruction(validation: SummaryValidation | { problems: string[] }): string {
	return `\n\nThe previous output was invalid (${validation.problems.join("; ")}). Rewrite the entire response once, including a one-line <overview> block and the exact compaction block structure; remove Goal and fit the card budget.`;
}

/** Estimate the final visible card using the real message estimator. */
export function cardTokensFor(
	sequence: number,
	input: SummarizeInput,
	summary: string,
	estimate: TokenEstimator,
): number {
	const card = renderBlockCard({
		blockId: nextBlockId(sequence),
		level: input.level,
		startEntryId: input.sourceEntryIds[0] ?? "?",
		endEntryId: input.sourceEntryIds.at(-1) ?? "?",
		sourceTokens: input.sourceTokens,
		summary,
	});
	return estimate({ role: "user", content: card, timestamp: 0 } as AgentMessage);
}

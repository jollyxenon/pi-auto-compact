/** Strict summary protocol shared by automatic and manual operations. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { PromptPart, SummarizeInput } from "./types.ts";
import { estimatePromptTokens, nextBlockId, renderBlockCard, type TokenEstimator } from "./util.ts";

export const SUMMARIZER_SYSTEM_PROMPT =
	"You are requested to compress the context of this session. Compress according to the format specifications provided below.";

/** Reserve one fixed output cap for both planning and provider requests. */
export function summaryOutputTokenLimit(blockTokenCeiling: number): number {
	return Math.max(blockTokenCeiling * 2, 2048);
}

/** One-sentence overview length limit used by the compaction protocol. */
export const OVERVIEW_MAX_CHARS = 50;

/**
 * JSON shape of one compaction block. There is no Goal field on purpose: a compact block
 * cannot carry a goal because goals belong to the live session, not to summarized history.
 * Only keywords every provider accepts are used, so the schema stays usable under strict
 * JSON-schema constrained sampling.
 */
export const SUMMARY_SCHEMA = Type.Object({
	overview: Type.String({ description: "One-line title of this block." }),
	progress: Type.Object({
		done: Type.Array(Type.String({ description: "One completed affair." })),
		doing: Type.Array(Type.String({ description: "The last ongoing affair." })),
		todo: Type.Array(Type.String({ description: "One affair to carry out after the ongoing one." })),
	}),
	blocked: Type.Array(Type.String({ description: "One affair that could not be executed." })),
	decision: Type.Array(Type.String({ description: "One decision on an open problem, naming its decision-maker." })),
	critical_content: Type.Array(Type.String({ description: "One fact important for later thinking and decisions." })),
	read_files: Type.Array(Type.String({ description: "One file path read in the target range." })),
	modified_files: Type.Array(Type.String({ description: "One file path edited or written in the target range." })),
});

export type CompactSummaryOutput = Static<typeof SUMMARY_SCHEMA>;

export const SUMMARY_TOOL_NAME = "emit_compaction_block";

/**
 * The summary arrives as one schema-constrained tool call instead of free text, so the
 * provider validates the shape before the plugin ever reads it. `prefer` keeps providers
 * without strict JSON-schema support working through the same tool.
 */
export const SUMMARY_TOOL: Tool = {
	name: SUMMARY_TOOL_NAME,
	description: "Emit the compaction block for the target range exactly once. Never answer with text.",
	parameters: SUMMARY_SCHEMA,
	constrainedSampling: { type: "json_schema", strict: "prefer" },
};

/** Input cost of the tool declaration, charged to every summary request budget. */
export const SUMMARY_TOOL_TOKENS = estimatePromptTokens(JSON.stringify(SUMMARY_TOOL));

/** Assemble the summary request; target and reference images stay in their positions. */
export function buildSummarizeParts(input: SummarizeInput): PromptPart[] {
	return [
		{ type: "text", text: instructionBlock(input) },
		...input.referenceAbove,
		{ type: "text", text: "\n</history_compaction_blocks>\n</reference_above>\n```\n\n```target\n<target_compaction_range>\n" },
		...input.targetParts,
		{ type: "text", text: "\n</target_compaction_range>\n```\n\n```reference\n<reference_below>\n" },
		...input.referenceBelow,
		{ type: "text", text: "\n</reference_below>\n```\n" },
	];
}

/** Fixed instructions plus the session system prompt and the reference container header. */
function instructionBlock(input: SummarizeInput): string {
	return `# Context Compaction

## Compaction Specifications

- The reference context is ONLY used to understand the task situation and DOES NOT enter the generated compression block;
- When compressing, ONLY summarize the affairs that occur in the target compaction range and DO NOT expand the compression range outward;
- Report the result by calling the \`${SUMMARY_TOOL_NAME}\` tool exactly once; NEVER answer with text and NEVER wrap the call in a code fence;
- \`overview\` is limited to one sentence, not exceeding ${OVERVIEW_MAX_CHARS} characters;
- The emitted compaction block should not exceed ${input.budgetTokens} Token.

## Compaction Block Structure

Call \`${SUMMARY_TOOL_NAME}\` once with these fields:

- \`overview\`: a title for this block, one sentence, at most ${OVERVIEW_MAX_CHARS} characters;
- \`progress.done\`: affairs completed in the target compaction range, one per item;
- \`progress.doing\`: the last ongoing affair in the target compaction range, one per item;
- \`progress.todo\`: affairs to carry out after that ongoing affair, one per item;
- \`blocked\`: affairs that were intended but could not be executed within the target compaction range due to certain reasons, one per item;
- \`decision\`: decisions made on open problems during task execution within the target compaction range, one per item, naming the user or the assistant as the decision-maker;
- \`critical_content\`: content that plays an important role in thinking and decision-making within the target compaction range, one per item;
- \`read_files\`: file paths read within the target compaction range, one per item;
- \`modified_files\`: file paths edited or written within the target compaction range, one per item.

Every field is required. Use an empty array when there is nothing to report, and never invent content that the target range does not contain.

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
`;
}

export interface ParsedSummaryOutput {
	output?: CompactSummaryOutput;
	problems: string[];
}

/** Read the schema-constrained tool call, falling back to a JSON object written as text. */
export function parseSummaryOutput(toolCalls: ToolCall[], text: string): ParsedSummaryOutput {
	const call = toolCalls.find((item) => item.name === SUMMARY_TOOL_NAME);
	if (call?.argumentsError) {
		return { problems: [`the ${SUMMARY_TOOL_NAME} call carried malformed JSON arguments`] };
	}
	const raw = call ? call.arguments : extractJsonObject(text);
	if (raw === undefined) {
		return {
			problems: [
				call
					? `the ${SUMMARY_TOOL_NAME} call carried no arguments`
					: `the response contains neither a ${SUMMARY_TOOL_NAME} call nor a JSON object`,
			],
		};
	}
	const problems: string[] = [];
	for (const error of Value.Errors(SUMMARY_SCHEMA, raw)) {
		problems.push(`${error.instancePath || "root"}: ${error.message}`);
		if (problems.length >= 5) break;
	}
	if (problems.length > 0) return { problems };
	const output = raw as CompactSummaryOutput;
	if (!output.overview.trim()) problems.push("overview is empty");
	if (output.overview.length > OVERVIEW_MAX_CHARS) problems.push(`overview exceeds ${OVERVIEW_MAX_CHARS} characters`);
	if (/[\r\n]/.test(output.overview)) problems.push("overview must be one line");
	return problems.length > 0 ? { problems } : { output, problems };
}

/** First `{` to last `}` of the response; the tolerant path for providers without tool support. */
function extractJsonObject(text: string): unknown {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return undefined;
	}
}

/** Render the fixed card text from the structured output; the shape is guaranteed here. */
export function renderSummaryCard(output: CompactSummaryOutput): string {
	const section = (tag: string, items: string[]): string[] => [`<${tag}>`, bulletList(items), `</${tag}>`];
	return [
		"<progress>",
		"<done>",
		bulletList(output.progress.done),
		"</done>",
		"<doing>",
		bulletList(output.progress.doing),
		"</doing>",
		"<todo>",
		bulletList(output.progress.todo),
		"</todo>",
		"</progress>",
		"",
		...section("blocked", output.blocked),
		"",
		...section("decision", output.decision),
		"",
		...section("critical_content", output.critical_content),
		"",
		...section("read_files", output.read_files),
		"",
		...section("modified_files", output.modified_files),
	].join("\n");
}

function bulletList(items: string[]): string {
	return (items.length > 0 ? items : ["(none)"]).map((item) => `- ${item}`).join("\n");
}

export interface SummaryValidation {
	ok: boolean;
	overBudget: boolean;
	problems: string[];
}

/** Validate the rendered card against its budget; the block shape is guaranteed by the schema. */
export function validateSummaryCard(cardTokens: number, budgetTokens: number): SummaryValidation {
	const overBudget = cardTokens > budgetTokens;
	return {
		ok: !overBudget,
		overBudget,
		problems: overBudget ? [`card uses ${cardTokens} tokens, limit is ${budgetTokens}`] : [],
	};
}

export function rewriteInstruction(problems: string[]): string {
	return `\n\nThe previous output was invalid (${problems.join("; ")}). Call the \`${SUMMARY_TOOL_NAME}\` tool once with the complete compaction block: fill every field, keep \`overview\` to one line of at most ${OVERVIEW_MAX_CHARS} characters, and stay inside the card budget. Do not answer with text.`;
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

/** Strict summary protocol shared by automatic and manual operations. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SummarizeInput } from "./types.ts";
import { nextBlockId, renderBlockCard, type TokenEstimator } from "./util.ts";

export const REQUIRED_HEADINGS = [
	"## Constraints & Preferences",
	"## Progress",
	"## Key Decisions",
	"## Next Steps",
	"## Critical Context",
] as const;

export const REQUIRED_PROGRESS_HEADINGS = ["### Done", "### In Progress", "### Blocked"] as const;

export const SUMMARIZER_SYSTEM_PROMPT =
	"You compress agent history. Follow the requested Markdown structure and source boundary exactly.";

const STRUCTURE = `Return only this Markdown structure. Do not add a Goal section.

## Constraints & Preferences
- ...

## Progress
### Done
- [x] ...
### In Progress
- [ ] ...
### Blocked
- None

## Key Decisions
- **Decision**: rationale

## Next Steps
1. ...

## Critical Context
- ...

<read-files>
path or (none)
</read-files>

<modified-files>
path or (none)
</modified-files>`;

/** Reference context may explain terms but only target events may enter the summary. */
export function buildSummarizePrompt(input: SummarizeInput): string {
	return `${STRUCTURE}

Hard rules:
- REFERENCE_CONTEXT is read-only background.
- Summarize only facts, actions, decisions, and progress present in TARGET_RANGE.
- Never output a Goal heading or restate the overall goal.
- Do not invent IDs, paths, commands, results, or decisions.
- The complete visible block card must fit within ${input.budgetTokens} tokens.
- Source entry IDs: ${input.sourceEntryIds.join(", ")}
- Direct child block IDs: ${input.childBlockIds.join(", ") || "(none)"}
- New block level: ${input.level}
- Source size: ${input.sourceTokens} tokens.${input.focus ? `\n- Requested focus: ${input.focus}` : ""}

===== REFERENCE_CONTEXT (READ ONLY) =====
${input.referenceContext}

===== TARGET_RANGE (ONLY SOURCE TO SUMMARIZE) =====
${input.targetRange}`;
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
	if (trimmed && !trimmed.startsWith(REQUIRED_HEADINGS[0])) problems.push("summary must start with Constraints & Preferences");
	const topLevelHeadings = [...trimmed.matchAll(/^##\s+[^#].*$/gm)].map((match) => match[0]);
	if (topLevelHeadings.length !== REQUIRED_HEADINGS.length
		|| topLevelHeadings.some((heading, index) => heading !== REQUIRED_HEADINGS[index])) {
		problems.push("top-level headings must appear exactly once in the required order");
	}
	for (const heading of REQUIRED_HEADINGS) {
		if (!trimmed.includes(heading)) problems.push(`missing heading ${heading}`);
	}
	const progressHeadings = [...trimmed.matchAll(/^###\s+.*$/gm)].map((match) => match[0]);
	if (progressHeadings.length !== REQUIRED_PROGRESS_HEADINGS.length
		|| progressHeadings.some((heading, index) => heading !== REQUIRED_PROGRESS_HEADINGS[index])) {
		problems.push("Progress subheadings must be Done, In Progress, and Blocked exactly once in that order");
	}
	for (const tag of ["<read-files>", "</read-files>", "<modified-files>", "</modified-files>"]) {
		if (!trimmed.includes(tag)) problems.push(`missing ${tag}`);
	}
	const modifiedEnd = trimmed.indexOf("</modified-files>");
	if (modifiedEnd >= 0 && trimmed.slice(modifiedEnd + "</modified-files>".length).trim()) {
		problems.push("content after </modified-files> is not allowed");
	}
	const overBudget = cardTokens > budgetTokens;
	if (overBudget) problems.push(`card uses ${cardTokens} tokens, limit is ${budgetTokens}`);
	return { ok: problems.length === 0, overBudget, problems };
}

export function rewriteInstruction(validation: SummaryValidation): string {
	return `\n\nThe previous output was invalid (${validation.problems.join("; ")}). Rewrite it once, preserve the exact structure, remove Goal, and shorten it to fit the card budget.`;
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
		sourceEntryIds: input.sourceEntryIds,
		sourceTokens: input.sourceTokens,
		summary,
	});
	return estimate({ role: "user", content: card, timestamp: 0 } as AgentMessage);
}

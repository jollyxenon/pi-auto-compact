import assert from "node:assert/strict";
import test from "node:test";
import {
	SUMMARY_TOOL_NAME,
	buildSummarizeParts,
	parseSummaryOutput,
	renderSummaryCard,
	validateSummaryCard,
} from "../src/summarizer.ts";
import type { SummarizeInput } from "../src/types.ts";
import { renderPromptParts } from "../src/util.ts";

const input: SummarizeInput = {
	systemPrompt: "You are the coding agent.",
	referenceAbove: [{ type: "text", text: "above fact: do not copy" }],
	referenceBelow: [{ type: "text", text: "below fact: do not copy either" }],
	targetParts: [{ type: "text", text: "inside fact: summarize this" }],
	sourceEntryIds: ["e1", "e2"],
	sourceTokens: 2000,
	level: 1,
	childBlockIds: [],
	budgetTokens: 500,
};

const output = {
	overview: "压缩所选历史工作并保留继续所需的信息。",
	progress: { done: ["[x] B"], doing: ["[ ] C"], todo: ["E"] },
	blocked: ["None"],
	decision: ["D (user)"],
	critical_content: ["F"],
	read_files: [],
	modified_files: [],
};

function toolCall(args: unknown) {
	return { type: "toolCall" as const, id: "call-1", name: SUMMARY_TOOL_NAME, arguments: args as never };
}

test("summary prompt requests one schema-constrained tool call", () => {
	const prompt = renderPromptParts(buildSummarizeParts(input));
	assert.match(prompt, /<reference_above>/);
	assert.match(prompt, /<target_compaction_range>/);
	assert.match(prompt, /<reference_below>/);
	assert.match(prompt, /DO NOT expand the compression range outward/);
	assert.match(prompt, new RegExp(SUMMARY_TOOL_NAME));
	assert.match(prompt, /<target_compaction_range>\ninside fact: summarize this\n<\/target_compaction_range>/);
});

test("summary prompt keeps images in place and never embeds their payload", () => {
	const image = { type: "image" as const, mimeType: "image/png", data: "AAAA" };
	const parts = buildSummarizeParts({
		...input,
		targetParts: [{ type: "text", text: "before\n" }, image, { type: "text", text: "\nafter" }],
	});
	const imageIndex = parts.indexOf(image);
	assert.ok(imageIndex > 0, "image part must survive in place");
	assert.equal(parts[imageIndex - 1].type, "text");
	assert.equal(parts[imageIndex + 1].type, "text");
	assert.match(renderPromptParts(parts), /before\n\[image image\/png, about 1KB omitted\]\nafter/);
});

test("summary output is validated against the JSON schema and rendered into the fixed card", () => {
	const ok = parseSummaryOutput([toolCall(output)], "");
	assert.deepEqual(ok.problems, []);
	assert.equal(ok.output?.overview, output.overview);

	const missing = parseSummaryOutput([toolCall({ ...output, modified_files: null })], "");
	assert.equal(missing.output, undefined);
	assert.match(missing.problems.join(" "), /modified_files/);

	const wrongType = parseSummaryOutput([toolCall({ ...output, blocked: "None" })], "");
	assert.match(wrongType.problems.join(" "), /blocked/);

	const longOverview = parseSummaryOutput([toolCall({ ...output, overview: "x".repeat(51) })], "");
	assert.match(longOverview.problems.join(" "), /overview exceeds/);

	const textFallback = parseSummaryOutput([], `\`\`\`json\n${JSON.stringify(output)}\n\`\`\``);
	assert.deepEqual(textFallback.problems, []);
	assert.match(parseSummaryOutput([], "no json here").problems.join(" "), /neither/);

	const card = renderSummaryCard(output);
	assert.match(card, /^<progress>/);
	assert.match(card, /<\/modified_files>$/);
	assert.match(card, /<blocked>\n- None\n<\/blocked>/);
	assert.doesNotMatch(card, /Goal/);
});

test("summary validation only guards the rendered card budget", () => {
	assert.deepEqual(validateSummaryCard(499, 500), { ok: true, overBudget: false, problems: [] });
	const overflow = validateSummaryCard(501, 500);
	assert.equal(overflow.overBudget, true);
	assert.equal(overflow.ok, false);
});

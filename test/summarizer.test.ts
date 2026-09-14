import assert from "node:assert/strict";
import test from "node:test";
import { resolveTokenLimit } from "../src/config.ts";
import { buildSummarizeParts, validateSummary } from "../src/summarizer.ts";
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

const valid = `<progress>
<done>
- [x] B
</done>
<doing>
- [ ] C
</doing>
<todo>
- E
</todo>
</progress>
<blocked>
- None
</blocked>
<decision>
- D (user)
</decision>
<critical_content>
- F
</critical_content>
<read_files>
(none)
</read_files>
<modified_files>
(none)
</modified_files>`;

test("summary prompt separates reference and target source boundaries", () => {
	const prompt = renderPromptParts(buildSummarizeParts(input));
	assert.match(prompt, /<reference_above>/);
	assert.match(prompt, /<target_compaction_range>/);
	assert.match(prompt, /<reference_below>/);
	assert.match(prompt, /DO NOT expand the compression range outward/);
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

test("summary validation rejects Goal and the complete-card token overflow", () => {
	assert.equal(validateSummary(valid, 499, 500).ok, true);
	const goal = validateSummary(`### Goal\nDo everything\n${valid}`, 499, 500);
	assert.equal(goal.ok, false);
	assert.match(goal.problems.join(" "), /Goal/);
	const preface = validateSummary(`outside fact\n${valid}`, 499, 500);
	assert.equal(preface.ok, false);
	const overflow = validateSummary(valid, 501, 500);
	assert.equal(overflow.overBudget, true);
});

test("token limits support absolute tokens and percentages", () => {
	assert.equal(resolveTokenLimit({ mode: "tokens", value: 1234.9 }, 10_000), 1234);
	assert.equal(resolveTokenLimit({ mode: "percent", value: 0.8 }, 10_000), 8000);
});

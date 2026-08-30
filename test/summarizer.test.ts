import assert from "node:assert/strict";
import test from "node:test";
import { resolveTokenLimit } from "../src/config.ts";
import { buildSummarizePrompt, validateSummary } from "../src/summarizer.ts";
import type { SummarizeInput } from "../src/types.ts";

const input: SummarizeInput = {
	referenceContext: "outside fact: do not copy",
	targetRange: "inside fact: summarize this",
	sourceEntryIds: ["e1", "e2"],
	sourceTokens: 2000,
	level: 1,
	childBlockIds: [],
	budgetTokens: 500,
};

const valid = `## Constraints & Preferences
- A
## Progress
### Done
- [x] B
### In Progress
- [ ] C
### Blocked
- None
## Key Decisions
- D
## Next Steps
1. E
## Critical Context
- F
<read-files>
(none)
</read-files>
<modified-files>
(none)
</modified-files>`;

test("summary prompt separates reference and target source boundaries", () => {
	const prompt = buildSummarizePrompt(input);
	assert.match(prompt, /REFERENCE_CONTEXT \(READ ONLY\)/);
	assert.match(prompt, /TARGET_RANGE \(ONLY SOURCE TO SUMMARIZE\)/);
	assert.match(prompt, /Never output a Goal heading/);
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

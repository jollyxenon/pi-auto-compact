import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	runAutoCompression,
	runManualAdjustment,
	runManualCompression,
	topLevelLayout,
	type CompressDeps,
} from "../src/compress.ts";
import type { AutoCompactConfig } from "../src/config.ts";
import { freshState, type PluginState } from "../src/types.ts";
import { messageToText, type TokenEstimator } from "../src/util.ts";

/** 与 Pi 的 estimateTokens 同规则（chars/4），内联以便测试自己掌握契约。 */
const testEstimator: TokenEstimator = (message) => Math.max(1, Math.ceil(messageToText(message).length / 4));

const VALID_SUMMARY = `## Constraints & Preferences
- Keep exact source boundaries.

## Progress
### Done
- [x] Completed the selected historical work.
### In Progress
- [ ] None
### Blocked
- None

## Key Decisions
- **Scope**: Only the target range was summarized.

## Next Steps
1. Continue with the recent context.

## Critical Context
- Original entries remain retrievable.

<read-files>
(none)
</read-files>

<modified-files>
(none)
</modified-files>`;

function entries(turns = 5): SessionEntry[] {
	const result: SessionEntry[] = [];
	let parent: string | null = null;
	const add = (id: string, role: "user" | "assistant", content: string) => {
		result.push({
			type: "message",
			id,
			parentId: parent,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role, content, timestamp: 0 },
		} as SessionEntry);
		parent = id;
	};
	add("e0", "user", "The immutable session goal");
	for (let turn = 1; turn <= turns; turn++) {
		add(`e${turn * 2 - 1}`, "assistant", `completed turn ${turn}\n${"x".repeat(8000)}`);
		add(`e${turn * 2}`, "user", `continue ${turn}`);
	}
	add(`e${turns * 2 + 1}`, "assistant", "current incomplete work");
	return result;
}

function config(overrides: Partial<AutoCompactConfig> = {}): AutoCompactConfig {
	return {
		enabled: true,
		trigger: { mode: "percent", value: 0.85 },
		keepRecent: { mode: "tokens", value: 100 },
		blockTokenCeiling: 1000,
		blockMergeThreshold: 3,
		maxBlocks: { enabled: false, value: 8 },
		defaultPageSize: 1000,
		maxPageSize: 4000,
		minNetGainTokens: 0,
		...overrides,
	};
}

function deps(
	cfg = config(),
	summarizeFn: (prompt: string) => Promise<string> = async () => VALID_SUMMARY,
	branchEntries = entries(),
): CompressDeps {
	return {
		cfg,
		branchEntries,
		contextWindow: 100_000,
		referenceContext: "complete visible projection",
		estimate: testEstimator,
		summarizeFn,
	};
}

async function compactTurns(count: number, cfg = config()): Promise<PluginState> {
	let state = freshState();
	for (let turn = 1; turn <= count; turn++) {
		const startId = turn === 1 ? "e1" : `e${turn * 2 - 2}`;
		const endId = `e${turn * 2 - 1}`;
		const outcome = await runManualCompression(deps(cfg), state, startId, endId);
		assert.ok(outcome.state, outcome.reason);
		state = outcome.state;
	}
	return state;
}

test("the kth same-level block remains and the k+1th merges the oldest k", async () => {
	const three = await compactTurns(3);
	assert.deepEqual(topLevelLayout(three).map((item) => item.level), [1, 1, 1]);

	const fourth = await runManualCompression(deps(), three, "e6", "e7");
	assert.ok(fourth.state, fourth.reason);
	assert.deepEqual(topLevelLayout(fourth.state).map((item) => item.level), [2, 1]);
	const promoted = fourth.createdBlocks?.at(-1);
	assert.equal(promoted?.level, 2);
	assert.equal(promoted?.childBlockIds.length, 3);
	assert.equal(fourth.state.blocks.length, 5, "immutable child blocks remain stored");
});

test("manual adjustment promotes one through k adjacent blocks by one level", async () => {
	const state = await compactTurns(2);
	const firstId = state.topLevelBlockIds[0];
	const outcome = await runManualAdjustment(deps(), state, [firstId]);
	assert.ok(outcome.state, outcome.reason);
	assert.deepEqual(topLevelLayout(outcome.state).map((item) => item.level), [2, 1]);
	assert.deepEqual(outcome.createdBlocks?.[0].childBlockIds, [firstId]);
});

test("maxBlocks is optional and constrains only the stable top-level layout", async () => {
	const cfg = config({ maxBlocks: { enabled: true, value: 2 } });
	const state = await compactTurns(3, cfg);
	assert.ok(state.topLevelBlockIds.length <= 2);
	assert.deepEqual(topLevelLayout(state).map((item) => item.level), [2]);
});

test("a merge summary failure leaves the input state unchanged", async () => {
	const state = await compactTurns(3);
	const before = JSON.stringify(state);
	let calls = 0;
	const failing = deps(config(), async () => {
		calls++;
		if (calls === 1) return VALID_SUMMARY;
		throw new Error("merge model failed");
	});
	await assert.rejects(runManualCompression(failing, state, "e6", "e7"), /merge model failed/);
	assert.equal(JSON.stringify(state), before);
});

test("automatic compaction preserves a goal preceded by metadata and accepts one-entry turns", async () => {
	const branch: SessionEntry[] = [
		{ type: "model_change", id: "meta", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "x", modelId: "y" } as SessionEntry,
		{ type: "message", id: "goal", parentId: "meta", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "SECRET GOAL", timestamp: 0 } } as SessionEntry,
		{ type: "message", id: "done", parentId: "goal", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: "x".repeat(8000), timestamp: 0 } } as unknown as SessionEntry,
		{ type: "message", id: "current", parentId: "done", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: "continue", timestamp: 0 } } as SessionEntry,
		{ type: "message", id: "tail", parentId: "current", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", content: "working", timestamp: 0 } } as unknown as SessionEntry,
	];
	let prompt = "";
	const operation = deps(config({ keepRecent: { mode: "tokens", value: 1 } }), async (value) => {
		prompt = value;
		return VALID_SUMMARY;
	}, branch);
	const automatic = await runAutoCompression(operation, freshState());
	assert.ok(automatic.state, automatic.reason);
	assert.deepEqual(automatic.createdBlocks?.[0].sourceEntryIds, ["done", "current"]);
	assert.doesNotMatch(prompt.split("TARGET_RANGE (ONLY SOURCE TO SUMMARIZE)")[1] ?? "", /SECRET GOAL/);

	const manual = await runManualCompression(operation, freshState(), "meta", "done");
	assert.match(manual.reason ?? "", /goal/);
});

test("summary request budget is checked before calling the model", async () => {
	let called = false;
	const operation = deps(config(), async () => {
		called = true;
		return VALID_SUMMARY;
	});
	operation.contextWindow = 3000;
	operation.referenceContext = "r".repeat(20_000);
	const outcome = await runManualCompression(operation, freshState(), "e1", "e1");
	assert.match(outcome.reason ?? "", /summary request needs/);
	assert.equal(called, false);
});

test("manual compaction rejects goal, overlap, and incomplete tail", async () => {
	const state = await compactTurns(1);
	assert.match((await runManualCompression(deps(), state, "e0", "e0")).reason ?? "", /goal/);
	assert.match((await runManualCompression(deps(), state, "e1", "e3")).reason ?? "", /overlaps/);
	assert.match((await runManualCompression(deps(), state, "e11", "e11")).reason ?? "", /incomplete/);
});

test("maxBlocks converges through mixed levels during long runs", async () => {
	const cfg = config({ maxBlocks: { enabled: true, value: 2 } });
	const branch = entries(12);
	let state = freshState();
	for (let turn = 1; turn <= 10; turn++) {
		const startId = turn === 1 ? "e1" : `e${turn * 2 - 2}`;
		const endId = `e${turn * 2 - 1}`;
		const outcome = await runManualCompression(deps(cfg, async () => VALID_SUMMARY, branch), state, startId, endId);
		assert.ok(outcome.state, `turn ${turn}: ${outcome.reason}`);
		state = outcome.state;
		assert.ok(state.topLevelBlockIds.length <= 2);
	}
	assert.ok(Math.max(...topLevelLayout(state).map((item) => item.level)) >= 3);
});

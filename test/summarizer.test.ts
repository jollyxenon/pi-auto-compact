import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../src/config.ts";
import {
	SUMMARY_THINKING_RESERVE,
	SUMMARY_TOOL_NAME,
	buildSummarizeParts,
	parseSummaryOutput,
	renderSummaryCard,
	resolveSummaryThinkingLevel,
	summaryOutputTokenLimit,
	validateSummaryCard,
} from "../src/summarizer.ts";
import { createSummarizeFn } from "../src/summaryClient.ts";
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

test("summary thinking level caps deep session thinking to low and reserves thinking tokens", () => {
	const geminiLike = {
		id: "group/gemini-4-hydrogen",
		name: "gemini-4-hydrogen",
		api: "openai-completions",
		provider: "magpie",
		baseUrl: "http://127.0.0.1:31110/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 262144,
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
	} as unknown as Model<"openai-completions">;
	assert.equal(resolveSummaryThinkingLevel(geminiLike, "xhigh"), "low");
	assert.equal(resolveSummaryThinkingLevel(geminiLike, "max"), "low");
	assert.equal(resolveSummaryThinkingLevel(geminiLike, "off"), undefined);
	assert.equal(resolveSummaryThinkingLevel({ ...geminiLike, reasoning: false }, "xhigh"), undefined);
	assert.equal(resolveSummaryThinkingLevel({ ...geminiLike, thinkingLevelMap: undefined }, "minimal"), "minimal");

	assert.equal(summaryOutputTokenLimit(2000, false), 6000);
	assert.equal(summaryOutputTokenLimit(2000, true), 6000 + SUMMARY_THINKING_RESERVE);
});

test("createSummarizeFn caps reasoning at low and reserves thinking tokens in streamSimple options", async () => {
	const selected = {
		id: "group/gemini-4-hydrogen",
		name: "gemini-4-hydrogen",
		api: "openai-completions",
		provider: "magpie",
		baseUrl: "http://127.0.0.1:31110/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 262144,
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
	} as unknown as Model<"openai-completions">;

	let capturedModelMaxTokens: number | undefined;
	let capturedOptions: { reasoning?: unknown; maxTokens?: number } | undefined;
	const ctx = {
		cwd: process.cwd(),
		model: selected,
		thinkingLevel: "xhigh",
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "test-session" },
		modelRegistry: {
			getProvider: () => ({
				streamSimple: (model: Model<any>, _context: unknown, options: { reasoning?: unknown; maxTokens?: number }) => {
					capturedModelMaxTokens = model.maxTokens;
					capturedOptions = options;
					const stream = createAssistantMessageEventStream();
					const msg = {
						role: "assistant" as const,
						api: model.api,
						provider: model.provider,
						model: model.id,
						stopReason: "toolUse" as const,
						timestamp: Date.now(),
						content: [toolCall(output)],
						usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					};
					stream.push({ type: "done", reason: "toolUse", message: msg });
					stream.end();
					return stream;
				},
			}),
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key", headers: {} }),
		},
	} as unknown as ExtensionContext;

	const cfg = { ...defaultConfig(), blockTokenCeiling: 2000 };
	const summarize = createSummarizeFn(ctx, cfg, undefined, () => {}, () => {});
	assert.ok(summarize);
	const result = await summarize([{ type: "text", text: "hello" }]);
	assert.equal(result.toolCalls[0]?.name, SUMMARY_TOOL_NAME);
	assert.equal(capturedOptions?.reasoning, "low");
	assert.equal(capturedOptions?.maxTokens, 6000 + SUMMARY_THINKING_RESERVE);
	assert.equal(capturedModelMaxTokens, 6000 + SUMMARY_THINKING_RESERVE);
});

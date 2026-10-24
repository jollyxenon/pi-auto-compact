/** Manual level-1 compaction tool. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isCompressionAborted, runManualCompression, type CompressDeps } from "./compress.ts";
import type { PluginState } from "./types.ts";

export interface CompactToolDeps {
	getState: (ctx: ExtensionContext) => PluginState;
	commitState: (state: PluginState, ctx: ExtensionContext, expectedSessionKey?: string) => void;
	/** Append the display-only snapshot for a committed state. */
	appendSnapshot: (state: PluginState, ctx: ExtensionContext) => void;
	/** Record provider usage from the summary requests this operation completed. */
	appendSummaryUsage: (ctx: ExtensionContext) => void;
	beginCompression: (ctx: ExtensionContext) => void;
	buildCompressDeps: (
		ctx: ExtensionContext,
		additionalMessages?: AgentMessage[],
		branchEntries?: SessionEntry[],
		signal?: AbortSignal,
		contextEntries?: SessionEntry[],
	) => CompressDeps | null;
	finishCompression: (ctx: ExtensionContext, outcome: Awaited<ReturnType<typeof runManualCompression>>) => void;
	failCompression: (ctx: ExtensionContext, error: unknown) => void;
	runExclusive: <T>(operation: (signal: AbortSignal) => Promise<T>, externalSignal?: AbortSignal) => Promise<T>;
}

export function makeCompactTool(deps: CompactToolDeps) {
	return {
		name: "compact_context",
		label: "手动压缩未压缩前缀",
		description:
			"Create a level-1 historical block from the earliest uncompressed prefix, startId..endId, before the automatic trigger. startId must be the first uncompressed source entry; earlier raw history cannot be skipped. The incomplete recent tail cannot be compressed.",
		promptSnippet: "Manually compact the earliest uncompressed prefix into a level-1 block",
		promptGuidelines: ["Use compact_context to release context early by compacting the earliest uncompressed prefix; startId must be the first uncompressed source entry."],
		parameters: Type.Object({
			startId: Type.String({ description: "First entry of the uncompressed prefix; must not skip earlier uncompressed source entries" }),
			endId: Type.String({ description: "Last source entry ID; advanced to a complete turn boundary when needed" }),
			focus: Type.Optional(Type.String({ description: "Facts from the target range that deserve extra summary attention" })),
		}),
		async execute(
			_toolCallId: string,
			params: { startId: string; endId: string; focus?: string },
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			return deps.runExclusive(async (operationSignal) => {
				try {
					deps.beginCompression(ctx);
					const operation = deps.buildCompressDeps(ctx, [], undefined, operationSignal);
					if (!operation) throw new Error("No active model or context window is available.");
					const outcome = await runManualCompression(operation, deps.getState(ctx), params.startId, params.endId, params.focus);
					if (!outcome.state) throw new Error(outcome.reason ?? "Compaction failed.");
					deps.commitState(outcome.state, ctx, operation.sessionKey);
					deps.appendSummaryUsage(ctx);
					deps.appendSnapshot(outcome.state, ctx);
					deps.finishCompression(ctx, outcome);
					return result(describe(outcome.createdBlocks ?? []));
				} catch (error) {
					if (isCompressionAborted(error, operationSignal)) {
						deps.finishCompression(ctx, { status: "skipped", reason: "压缩已中断" });
						return result("Compaction interrupted.");
					}
					deps.failCompression(ctx, error);
					throw error;
				}
			}, signal);
		},
	};
}

function describe(blocks: Array<{ blockId: string; level: number }>): string {
	return blocks.length === 0 ? "No block was created." : blocks.map((block) => `Created ${block.blockId} at level ${block.level}.`).join("\n");
}

function result(text: string) {
	return { content: [{ type: "text" as const, text }], details: { ok: true } };
}

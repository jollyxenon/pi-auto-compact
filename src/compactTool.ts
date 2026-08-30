/** Manual level-1 compaction tool. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runManualCompression, type CompressDeps } from "./compress.ts";
import type { PluginState } from "./types.ts";

export interface CompactToolDeps {
	getState: (ctx: ExtensionContext) => PluginState;
	commitState: (state: PluginState, ctx: ExtensionContext, expectedSessionKey?: string) => void;
	beginCompression: (ctx: ExtensionContext) => void;
	buildCompressDeps: (ctx: ExtensionContext) => CompressDeps | null;
	finishCompression: (ctx: ExtensionContext, outcome: Awaited<ReturnType<typeof runManualCompression>>) => void;
	failCompression: (ctx: ExtensionContext, error: unknown) => void;
	runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
}

export function makeCompactTool(deps: CompactToolDeps) {
	return {
		name: "compact_context",
		label: "手动压缩指定区间",
		description:
			"Create a level-1 historical block from a complete, uncompressed startId..endId range before the automatic trigger. The session goal and incomplete recent tail cannot be compressed.",
		promptSnippet: "Manually compact a completed source range into a level-1 block",
		promptGuidelines: ["Use compact_context to release context early when a completed historical range no longer needs to remain expanded."],
		parameters: Type.Object({
			startId: Type.String({ description: "First source session entry ID" }),
			endId: Type.String({ description: "Last source entry ID; advanced to a complete turn boundary when needed" }),
			focus: Type.Optional(Type.String({ description: "Facts from the target range that deserve extra summary attention" })),
		}),
		async execute(
			_toolCallId: string,
			params: { startId: string; endId: string; focus?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			return deps.runExclusive(async () => {
				try {
					deps.beginCompression(ctx);
					const operation = deps.buildCompressDeps(ctx);
					if (!operation) throw new Error("No active model or context window is available.");
					const outcome = await runManualCompression(operation, deps.getState(ctx), params.startId, params.endId, params.focus);
					if (!outcome.state) throw new Error(outcome.reason ?? "Compaction failed.");
					deps.commitState(outcome.state, ctx, operation.sessionKey);
					deps.finishCompression(ctx, outcome);
					return result(describe(outcome.createdBlocks ?? []));
				} catch (error) {
					deps.failCompression(ctx, error);
					throw error;
				}
			});
		},
	};
}

function describe(blocks: Array<{ blockId: string; level: number }>): string {
	return blocks.length === 0 ? "No block was created." : blocks.map((block) => `Created ${block.blockId} at level ${block.level}.`).join("\n");
}

function result(text: string) {
	return { content: [{ type: "text" as const, text }], details: { ok: true } };
}

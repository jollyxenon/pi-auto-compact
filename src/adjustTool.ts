/** Manual promotion tool for one through k adjacent same-level top blocks. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AutoCompactConfig } from "./config.ts";
import { runManualAdjustment, type CompressDeps } from "./compress.ts";
import type { PluginState } from "./types.ts";

export interface AdjustToolDeps {
	cfg: AutoCompactConfig;
	getState: (ctx: ExtensionContext) => PluginState;
	commitState: (state: PluginState, ctx: ExtensionContext, expectedSessionKey?: string) => void;
	beginCompression: (ctx: ExtensionContext) => void;
	buildCompressDeps: (ctx: ExtensionContext) => CompressDeps | null;
	finishCompression: (ctx: ExtensionContext, outcome: Awaited<ReturnType<typeof runManualAdjustment>>) => void;
	failCompression: (ctx: ExtensionContext, error: unknown) => void;
	runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
}

export function makeAdjustTool(deps: AdjustToolDeps) {
	return {
		name: "adjust_context_blocks",
		label: "手动提升压缩块",
		description:
			`Promote 1..${deps.cfg.blockMergeThreshold} adjacent, ordered, same-level top blocks into one block at the next level before automatic merging is due. The operation is atomic.`,
		promptSnippet: "Manually promote adjacent same-level compact blocks",
		promptGuidelines: [
			"Use adjust_context_blocks when visible historical blocks should be consolidated before the automatic k+1 merge condition.",
		],
		parameters: Type.Object({
			blockIds: Type.Array(Type.String(), {
				minItems: 1,
				description: "Adjacent top-level block IDs in oldest-to-newest order; effective maximum is blockMergeThreshold",
			}),
			focus: Type.Optional(Type.String({ description: "Facts from these blocks to emphasize" })),
		}),
		async execute(
			_toolCallId: string,
			params: { blockIds: string[]; focus?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			return deps.runExclusive(async () => {
				try {
					deps.beginCompression(ctx);
					const operation = deps.buildCompressDeps(ctx);
					if (!operation) throw new Error("No active model or context window is available.");
					const outcome = await runManualAdjustment(operation, deps.getState(ctx), params.blockIds, params.focus);
					if (!outcome.state) throw new Error(outcome.reason ?? "Adjustment failed.");
					deps.commitState(outcome.state, ctx, operation.sessionKey);
					deps.finishCompression(ctx, outcome);
					const blocks = outcome.createdBlocks ?? [];
					return result(blocks.map((block) => `Created ${block.blockId} at level ${block.level}.`).join("\n"));
				} catch (error) {
					deps.failCompression(ctx, error);
					throw error;
				}
			});
		},
	};
}

function result(text: string) {
	return { content: [{ type: "text" as const, text }], details: { ok: true } };
}

/** Model requests for summaries, using Pi's provider adapters and retry policy. */

import { retryAssistantCall } from "@earendil-works/pi-ai";
import { estimateTokens, getAgentDir, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoCompactConfig } from "./config.ts";
import { SUMMARIZER_SYSTEM_PROMPT, summaryOutputTokenLimit } from "./summarizer.ts";

/** Capture one operation's model settings; resolve authentication afresh on each attempt. */
export function createSummarizeFn(
	ctx: ExtensionContext,
	cfg: AutoCompactConfig,
	signal: AbortSignal | undefined,
	debugLog: (message: string, details?: unknown) => void,
): ((prompt: string) => Promise<string>) | null {
	const selected = ctx.model;
	if (!selected) return null;
	const provider = ctx.modelRegistry.getProvider(selected.provider);
	if (!provider) return null;
	const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
	const retry = settings.getRetrySettings();
	const providerRetry = settings.getProviderRetrySettings();
	const idleTimeout = settings.getHttpIdleTimeoutMs();
	const reasoning = ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel;
	const sessionId = ctx.sessionManager.getSessionId();
	// Some adapters add a thinking budget to maxTokens. Cap the request model too,
	// so reasoning and the final summary stay inside the planner's output reserve.
	const maxTokens = Math.min(selected.maxTokens, summaryOutputTokenLimit(cfg.blockTokenCeiling));
	const model = { ...selected, maxTokens };

	return async (prompt: string): Promise<string> => {
		const context = {
			systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
			messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }],
		};
		const inputTokens = estimateTokens({ role: "user", content: SUMMARIZER_SYSTEM_PROMPT, timestamp: 0 })
			+ estimateTokens(context.messages[0]);
		const request = { provider: model.provider, model: model.id, api: model.api, reasoning, inputTokens, maxTokens };
		let attempts = 0;
		const started = Date.now();
		try {
			const response = await retryAssistantCall(async () => {
				signal?.throwIfAborted();
				attempts++;
				debugLog("summary request started", { ...request, attempt: attempts });
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(selected);
				signal?.throwIfAborted();
				if (!auth.ok) throw new Error(auth.error);
				const result = await provider.streamSimple(
					auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
					context,
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						env: auth.env,
						reasoning,
						thinkingBudgets: settings.getThinkingBudgets(),
						maxTokens,
						sessionId,
						cacheRetention: "none",
						signal,
						timeoutMs: providerRetry.timeoutMs ?? (idleTimeout === 0 ? 2147483647 : idleTimeout),
						maxRetries: 0,
						maxRetryDelayMs: providerRetry.maxRetryDelayMs,
					},
				).result();
				debugLog("summary request finished", {
					...request, attempt: attempts, elapsedMs: Date.now() - started,
					stopReason: result.stopReason, usage: result.usage, error: result.errorMessage,
				});
				return result;
			}, retry, signal, {
				onRetryScheduled: (attempt, maxAttempts, delayMs, error) => {
					debugLog("summary retry scheduled", { ...request, attempt, maxAttempts, delayMs, error });
					if (ctx.hasUI) ctx.ui.notify(`auto-compact: 摘要请求暂时失败，${delayMs / 1000} 秒后重试（${attempt}/${maxAttempts}）`, "warning");
				},
			});
			if (signal?.aborted || response.stopReason === "aborted") throw new Error("compression aborted");
			if (response.stopReason !== "stop") {
				throw new Error(`summary model ended with ${response.stopReason}${response.errorMessage ? `: ${response.errorMessage}` : ""}`);
			}
			if (response.content.some((block) => block.type === "toolCall")) {
				throw new Error("summary model returned a tool call instead of a summary");
			}
			return response.content
				.filter((block): block is Extract<(typeof response.content)[number], { type: "text" }> => block.type === "text")
				.map((block) => block.text)
				.join("\n");
		} catch (error) {
			debugLog("summary request failed", {
				...request, attempts, elapsedMs: Date.now() - started,
				aborted: signal?.aborted || (error instanceof Error && error.message === "compression aborted"),
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	};
}

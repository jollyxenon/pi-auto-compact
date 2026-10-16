/** Configuration for hierarchical context compaction. */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, DEFAULT_COMPACTION_SETTINGS, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface AutoCompactConfig {
	/** Whether threshold and overflow requests should run automatic compaction. */
	enabled: boolean;
	/** Start automatic compaction once estimated context tokens exceed (window - reserveTokens). */
	reserveTokens: number;
	/** Recent conversation tokens kept verbatim; measured with Pi's estimateTokens. */
	keepRecentTokens: number;
	/** Maximum tokens in the complete card sent to the main model. */
	blockTokenCeiling: number;
	/** k: after the (k + 1)th same-level block appears, merge the oldest k. */
	blockMergeThreshold: number;
	/** Optional hard limit for stable, visible top-level blocks. */
	maxBlocks: { enabled: boolean; value: number };
	defaultPageSize: number;
	maxPageSize: number;
	minNetGainTokens: number;
	/** Write runtime diagnostics to Pi's debug log when enabled. */
	debug?: boolean;
}

export const DEFAULT_CONFIG: AutoCompactConfig = {
	enabled: true,
	// Compaction trigger and retained window follow Pi's own compaction settings.
	reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
	keepRecentTokens: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
	blockTokenCeiling: 2000,
	blockMergeThreshold: 3,
	maxBlocks: { enabled: true, value: 8 },
	defaultPageSize: 4000,
	maxPageSize: 16000,
	minNetGainTokens: 256,
	debug: false,
};

export const CONFIG_FILE_NAME = "auto-compact.json";

/** Return an independent mutable runtime copy. */
export function defaultConfig(): AutoCompactConfig {
	return structuredClone(DEFAULT_CONFIG);
}

/** Load global config, then trusted project overrides. Invalid files fail loudly. */
export function loadConfig(cwd: string, includeProject: boolean): AutoCompactConfig {
	let config = defaultConfig();
	const files = [path.join(getAgentDir(), CONFIG_FILE_NAME)];
	if (includeProject) files.push(path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME));
	for (const file of files) {
		if (!fs.existsSync(file)) continue;
		const override = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AutoCompactConfig>;
		config = {
			...config,
			...override,
			// Nested objects merge field-wise so a partial override never disables a flag silently.
			maxBlocks: override.maxBlocks === undefined ? config.maxBlocks : { ...config.maxBlocks, ...override.maxBlocks },
		};
	}
	validateConfig(config);
	return config;
}

/** Save a validated configuration to the project file when trusted, otherwise the global file. */
export function saveConfig(cwd: string, includeProject: boolean, config: AutoCompactConfig): void {
	validateConfig(config);
	const file = includeProject
		? path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME)
		: path.join(getAgentDir(), CONFIG_FILE_NAME);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** Enforce the state-machine invariants once at load time. */
export function validateConfig(config: AutoCompactConfig): void {
	if (typeof config.enabled !== "boolean") throw new Error("enabled must be a boolean");
	for (const [name, value] of [["reserveTokens", config.reserveTokens], ["keepRecentTokens", config.keepRecentTokens]] as const) {
		if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
	}
	if (!Number.isInteger(config.blockMergeThreshold) || config.blockMergeThreshold < 2) {
		throw new Error("blockMergeThreshold must be an integer >= 2");
	}
	if (!Number.isInteger(config.blockTokenCeiling) || config.blockTokenCeiling < 256) {
		throw new Error("blockTokenCeiling must be an integer >= 256");
	}
	if (!Number.isInteger(config.maxBlocks.value) || config.maxBlocks.value < 1) {
		throw new Error("maxBlocks.value must be an integer >= 1");
	}
	if (typeof config.maxBlocks.enabled !== "boolean") throw new Error("maxBlocks.enabled must be a boolean");
	if (!Number.isInteger(config.defaultPageSize) || !Number.isInteger(config.maxPageSize)
		|| config.defaultPageSize < 256 || config.maxPageSize < config.defaultPageSize) {
		throw new Error("page sizes must be integers with 256 <= defaultPageSize <= maxPageSize");
	}
	if (config.debug !== undefined && typeof config.debug !== "boolean") throw new Error("debug must be a boolean");
}

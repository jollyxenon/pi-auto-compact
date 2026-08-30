/** Immutable compact blocks plus the current top-level forest. */

export interface CompactBlock {
	blockId: string;
	level: number;
	/** Ordered original Pi session entry IDs covered by this block. */
	sourceEntryIds: string[];
	/** Direct children. Empty only for level-1 blocks. */
	childBlockIds: string[];
	summary: string;
	createdAt: string;
	sourceTokens: number;
	/** Token count of the complete visible card, not just its summary. */
	cardTokens: number;
}

export interface PluginState {
	schemaVersion: 1;
	/** Immutable block repository. Children remain available after promotion. */
	blocks: CompactBlock[];
	/** Ordered blocks currently projected into the model context. */
	topLevelBlockIds: string[];
	/** Stable frontiers keyed by active-path entry IDs; the current frontier remains above. */
	topLevelBlockIdsByBranch?: Record<string, string[]>;
	nextSeq: number;
}

export function freshState(): PluginState {
	return { schemaVersion: 1, blocks: [], topLevelBlockIds: [], nextSeq: 1 };
}

export interface EntryMessageMapping {
	/** null marks a message injected by another context extension. */
	messageEntryIds: Array<string | null>;
}

export interface SummarizeInput {
	referenceContext: string;
	targetRange: string;
	sourceEntryIds: string[];
	sourceTokens: number;
	level: number;
	childBlockIds: string[];
	budgetTokens: number;
	focus?: string;
}

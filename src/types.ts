/** Immutable compact blocks plus the current top-level forest. */

export interface CompactBlock {
	blockId: string;
	level: number;
	/** One-line description used by block-tree inspection. */
	overview: string;
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
	schemaVersion: 3;
	/** Immutable block repository. Children remain available after promotion. */
	blocks: CompactBlock[];
	/** Ordered blocks currently projected into the model context. */
	topLevelBlockIds: string[];
	/** Active child frontier for parents whose visible edges differ from their creation edges. */
	childBlockIdsByParent: Record<string, string[]>;
	/** Stable root frontiers keyed by active-path entry IDs. */
	topLevelBlockIdsByBranch?: Record<string, string[]>;
	/** Stable internal edge selections keyed by active-path entry IDs. */
	childBlockIdsByParentByBranch?: Record<string, Record<string, string[]>>;
	nextSeq: number;
}

export function freshState(): PluginState {
	return { schemaVersion: 3, blocks: [], topLevelBlockIds: [], childBlockIdsByParent: {}, nextSeq: 1 };
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

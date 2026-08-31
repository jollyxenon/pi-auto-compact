import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildMapping, projectMessages } from "../src/mapping.ts";
import type { CompactBlock } from "../src/types.ts";

const original = { role: "user", content: "original", timestamp: 0 } as AgentMessage;
const entry = {
	type: "message",
	id: "e1",
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: original,
} as SessionEntry;

const block: CompactBlock = {
	blockId: "ac_000001",
	level: 1,
	overview: "概括原始消息。",
	sourceEntryIds: ["e1"],
	childBlockIds: [],
	summary: "summary",
	createdAt: "2026-01-01T00:00:00.000Z",
	sourceTokens: 100,
	cardTokens: 20,
};

test("mapping preserves messages injected by another context extension", () => {
	const injected = {
		role: "custom",
		customType: "other-extension",
		content: "extra",
		display: false,
		timestamp: 0,
	} as AgentMessage;
	const messages = [injected, original];
	const mapping = buildMapping([entry], messages);
	assert.ok(mapping);
	assert.deepEqual(mapping.messageEntryIds, [null, "e1"]);
	const projected = projectMessages(messages, mapping, [block]);
	assert.equal(projected[0], injected);
	assert.match((projected[1] as { content: string }).content, /ac_000001/);
});

test("mapping preserves an injected message inside a compacted source span", () => {
	const secondMessage = { role: "user", content: "second", timestamp: 1 } as AgentMessage;
	const secondEntry = {
		type: "message",
		id: "e2",
		parentId: "e1",
		timestamp: "2026-01-01T00:00:01.000Z",
		message: secondMessage,
	} as SessionEntry;
	const injected = {
		role: "custom",
		customType: "other-extension",
		content: "must survive",
		display: false,
		timestamp: 0,
	} as AgentMessage;
	const mapping = buildMapping([entry, secondEntry], [original, injected, secondMessage]);
	assert.ok(mapping);
	const covering = { ...block, sourceEntryIds: ["e1", "e2"] };
	const projected = projectMessages([original, injected, secondMessage], mapping, [covering]);
	assert.equal(projected.length, 2);
	assert.match((projected[0] as { content: string }).content, /ac_000001/);
	assert.equal(projected[1], injected);
});

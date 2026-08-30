import assert from "node:assert/strict";
import test from "node:test";
import { paginateEntryTexts } from "../src/contextGet.ts";

const entries = [
	{ entryId: "a", text: "A".repeat(700) },
	{ entryId: "b", text: "B".repeat(900) },
	{ entryId: "c", text: "C".repeat(300) },
];

test("pagination can reconstruct every source entry without loss", () => {
	let index = 0;
	let offset = 0;
	let combined = "";
	for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
		const page = paginateEntryTexts(entries, index, offset, 256);
		combined += page.text.replaceAll("\n\n", "");
		index = page.nextIndex;
		offset = page.nextOffset;
		if (!page.truncated) break;
	}
	assert.equal(combined, entries.map((entry) => entry.text).join(""));
	assert.equal(index, entries.length);
	assert.equal(offset, 0);
});

test("pagination makes progress through one oversized entry", () => {
	const oversized = [{ entryId: "big", text: "z".repeat(5000) }];
	const first = paginateEntryTexts(oversized, 0, 0, 256);
	assert.equal(first.truncated, true);
	assert.ok(first.nextOffset > 0);
	const second = paginateEntryTexts(oversized, first.nextIndex, first.nextOffset, 256);
	assert.ok(second.nextOffset > first.nextOffset);
});

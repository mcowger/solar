import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "solar-pi-turns-test-"));
process.env.SOLAR_PI_AGENT_DIR = join(dir, "pi-agent");

const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { loadPiMessages, piLatestCompaction } = await import("./turns");
const { piSessionDir } = await import("./config");

const CONV = "conv-summary-marker";

import type { Message } from "@earendil-works/pi-ai";

type MessageParam = Message;

const userMsg = (text: string): MessageParam =>
	({
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	}) as MessageParam;

const usage = (output: number) => ({
	input: 100,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 100 + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistantMsg = (text: string, output = 2): MessageParam =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "mock-model",
		usage: usage(output),
		stopReason: "stop",
		timestamp: Date.now(),
	}) as MessageParam;

function seedSession(): { u2: string; u3: string } {
	const sessionDir = piSessionDir(CONV);
	mkdirSync(sessionDir, { recursive: true });
	const cwdDir = join(dir, "cwd", CONV);
	mkdirSync(cwdDir, { recursive: true });
	const manager = SessionManager.create(cwdDir, sessionDir);
	manager.appendMessage(userMsg("old question"));
	manager.appendMessage(assistantMsg("old answer"));
	const u2 = manager.appendMessage(userMsg("new question"));
	manager.appendMessage(assistantMsg("new answer"));
	// u1/a1 summarized; the kept region starts at u2.
	manager.appendCompaction(
		"summary of the old exchange",
		u2,
		272_000,
		undefined,
		false,
		usage(8_000),
	);
	const u3 = manager.appendMessage(userMsg("follow-up question"));
	manager.appendMessage(assistantMsg("follow-up answer"));
	return { u2, u3 };
}

describe("loadPiMessages compaction marker", () => {
	test("pins the summary badge to the turn containing firstKeptEntryId", async () => {
		const { u2 } = seedSession();
		const rows = await loadPiMessages("user-1", CONV);
		expect(rows.map((row) => row.text)).toEqual([
			"old question",
			"old answer",
			"new question",
			"new answer",
			"follow-up question",
			"follow-up answer",
		]);
		const markerRow = rows.find((row) => row.id === u2);
		expect(markerRow?.summaryEvent).toMatchObject({
			tokensBefore: 272_000,
			tokensAfter: 8_000,
			revision: 1,
			position: "before",
		});
		for (const row of rows) {
			if (row.id !== u2) expect(row.summaryEvent).toBeNull();
		}
		expect(piLatestCompaction(CONV)?.revision).toBe(1);
	});
});

describe("loadPiMessages stall errors", () => {
	test("shows Solar's stall reason, not pi's 'Request was aborted'", async () => {
		const conv = "conv-stall-reload";
		const sessionDir = piSessionDir(conv);
		mkdirSync(sessionDir, { recursive: true });
		const cwdDir = join(dir, "cwd", conv);
		mkdirSync(cwdDir, { recursive: true });
		const manager = SessionManager.create(cwdDir, sessionDir);
		manager.appendMessage(userMsg("build the homepage"));
		const aborted = manager.appendMessage({
			...assistantMsg(""),
			content: [],
			stopReason: "aborted",
			errorMessage: "Request was aborted",
		} as MessageParam);
		manager.appendCustomEntry("solar-turn-error", {
			assistantEntryId: aborted,
			errorMessage: "The model sent nothing for 90s",
		});

		const rows = await loadPiMessages("user-1", conv);
		expect(rows.map((row) => row.text)).toEqual([
			"build the homepage",
			"**Error:** The model sent nothing for 90s",
		]);
	});
});

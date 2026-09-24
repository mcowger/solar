import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_PATH = ":memory:";
process.env.SOLAR_PI_AGENT_DIR = join(
	mkdtempSync(join(tmpdir(), "solar-pi-stall-test-")),
	"pi-agent",
);

const { pumpGeneration } = await import("./engine");
const { piGenerations } = await import("./generation");
const { piSessionManager } = await import("./manager");
const { piConfig } = await import("./config");

// Set on the shared object rather than via env: another test file in the same
// run may already have loaded config.ts with the defaults.
const timings = piConfig as { stallTimeoutMs: number; abortGraceMs: number };
const saved = { ...timings };
beforeAll(() => {
	timings.stallTimeoutMs = 100;
	timings.abortGraceMs = 150;
});
afterAll(() => {
	timings.stallTimeoutMs = saved.stallTimeoutMs;
	timings.abortGraceMs = saved.abortGraceMs;
});

type Handler = (event: Record<string, unknown>) => void;

/** Stands in for pi's RpcClient: nothing arrives until the test says so. */
function fakeClient(onAbort: (emit: Handler) => void) {
	let emit: Handler = () => {};
	return {
		onEvent(handler: Handler) {
			emit = handler;
			return () => {};
		},
		prompt: async () => {},
		abort: async () => onAbort(emit),
	} as unknown as Parameters<typeof pumpGeneration>[1];
}

/** What pi does when an in-flight request is aborted. */
function settleAborted(emit: Handler) {
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "aborted",
			errorMessage: "Request was aborted",
			usage: { input: 71_000, output: 3, cacheRead: 0, cacheWrite: 0 },
		},
	});
	emit({ type: "agent_settled" });
}

function recordDrops(): string[] {
	const dropped: string[] = [];
	piSessionManager.drop = async (conversationId: string) => {
		dropped.push(conversationId);
	};
	return dropped;
}

const errorTexts = (generation: { chunks: { chunk: unknown }[] }) =>
	generation.chunks
		.map((buffered) => buffered.chunk as { type: string; errorText?: string })
		.filter((chunk) => chunk.type === "error")
		.map((chunk) => chunk.errorText);

describe("pi stall watchdog", () => {
	test("says the model went quiet instead of pi's 'Request was aborted'", async () => {
		const dropped = recordDrops();
		const generation = piGenerations.start({
			conversationId: "conv-stall-settles",
			userId: "user-1",
		});
		const result = await pumpGeneration(generation, fakeClient(settleAborted), {
			conversationId: "conv-stall-settles",
			userText: "build the homepage",
		});

		expect(generation.status).toBe("error");
		const [errorText] = errorTexts(generation);
		expect(errorText).toContain("SOLAR_PI_STALL_TIMEOUT_MS");
		expect(errorText).not.toContain("Request was aborted");
		expect(result.stallError).toBe(errorText ?? null);

		// pi settled cleanly, so its process is kept for the next turn.
		await Bun.sleep(300);
		expect(dropped).toEqual([]);
	});

	test("drops the pi process when it never settles after the abort", async () => {
		const dropped = recordDrops();
		const generation = piGenerations.start({
			conversationId: "conv-stall-hangs",
			userId: "user-1",
		});
		const result = await pumpGeneration(
			generation,
			fakeClient(() => {}),
			{ conversationId: "conv-stall-hangs", userText: "build the homepage" },
		);

		expect(generation.status).toBe("error");
		expect(errorTexts(generation)[0]).toContain("SOLAR_PI_STALL_TIMEOUT_MS");
		expect(result.stallError).toContain("SOLAR_PI_STALL_TIMEOUT_MS");
		expect(dropped).toEqual(["conv-stall-hangs"]);
	});

	test("a turn that keeps streaming is not a stall", async () => {
		recordDrops();
		const generation = piGenerations.start({
			conversationId: "conv-busy",
			userId: "user-1",
		});
		let emit: Handler = () => {};
		const client = {
			onEvent(handler: Handler) {
				emit = handler;
				return () => {};
			},
			prompt: async () => {
				// Deltas every 40ms for 300ms, well past the 100ms stall limit.
				for (let i = 0; i < 8; i++) {
					await Bun.sleep(40);
					emit({
						type: "message_update",
						assistantMessageEvent: { type: "toolcall_delta" },
					});
				}
				emit({ type: "agent_settled" });
			},
			abort: async () => {},
		} as unknown as Parameters<typeof pumpGeneration>[1];

		const result = await pumpGeneration(generation, client, {
			conversationId: "conv-busy",
			userText: "build the homepage",
		});
		expect(generation.status).toBe("done");
		expect(result.stallError).toBeNull();
	});
});

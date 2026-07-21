import { afterEach, describe, expect, mock, test } from "bun:test";

let resolveModelCalls = 0;
let streamModelCalls = 0;
let expectNoProviderCalls = true;
let providerStream: (...args: any[]) => AsyncIterable<any> = () => {
	throw new Error("provider streaming must not run for mock models");
};
const originalMockLlm = process.env.SOLAR_MOCK_LLM;

process.env.SOLAR_MOCK_LLM = "1";
mock.module("./catalog", () => ({
	MOCK: Boolean(process.env.SOLAR_MOCK_LLM),
	resolveModel: async () => {
		resolveModelCalls += 1;
		if (expectNoProviderCalls)
			throw new Error("provider resolution must not run for mock models");
		return { model: { contextWindow: 128_000 } };
	},
	streamModel: (...args: any[]) => {
		streamModelCalls += 1;
		return providerStream(...args);
	},
}));

const { MOCK, generateTitle, streamChat } = await import("./models");
const { modelCallTelemetry } = await import("../context/telemetry");

if (originalMockLlm === undefined) delete process.env.SOLAR_MOCK_LLM;
else process.env.SOLAR_MOCK_LLM = originalMockLlm;

const selection = {
	provider: "mock",
	endpointId: "mock",
	modelId: "mock-reasoning",
	api: "mock",
};

const replyFor = (prompt: string) =>
	`**Mock reply** (${selection.modelId}) to: ${prompt}\n\n` +
	"Inline code `x = 1`, a fenced block:\n\n" +
	'```js\nconsole.log("hello");\n```\n\n' +
	"And display math: $$E = mc^2$$\n\n" +
	"Sources: [React documentation](https://react.dev/), [MDN Web Docs](https://developer.mozilla.org/), [TypeScript handbook](https://www.typescriptlang.org/docs/), and [Bun documentation](https://bun.sh/docs).";

function contextFor(prompt: string) {
	return {
		messages: [
			{ role: "user", content: "Earlier request", timestamp: 1 },
			{ role: "assistant", content: [], timestamp: 2 },
			{ role: "user", content: prompt, timestamp: 3 },
		],
	} as never;
}

async function collect(prompt: string, params = {}) {
	const events = [] as Array<Record<string, unknown>>;
	for await (const event of streamChat(
		contextFor(prompt),
		selection,
		params,
		new AbortController().signal,
	)) {
		events.push(event as Record<string, unknown>);
	}
	return events;
}

afterEach(() => {
	if (expectNoProviderCalls) {
		expect(resolveModelCalls).toBe(0);
		expect(streamModelCalls).toBe(0);
	}
	resolveModelCalls = 0;
	streamModelCalls = 0;
	expectNoProviderCalls = true;
});

describe("mock model streaming", () => {
	test("is enabled from the controlled import environment", () => {
		expect(MOCK).toBe(true);
	});

	test("streams a complete deterministic reply for the last user message", async () => {
		const prompt = "Explain the latest request";
		const events = await collect(prompt);
		const textEvents = events.filter((event) => event.type === "text_delta");
		const done = events.at(-1)!;

		expect(events[0]?.type).toBe("start");
		expect(textEvents.length).toBeGreaterThan(1);
		expect(textEvents.map((event) => event.delta).join("")).toBe(
			replyFor(prompt),
		);
		expect(events.some((event) => event.type === "thinking_delta")).toBe(false);
		expect(done.type).toBe("done");
		expect(done.reason).toBe("stop");
		expect(done.message).toMatchObject({
			provider: "mock",
			model: "mock-reasoning",
			usage: { input: 0, output: 0 },
			stopReason: "stop",
			content: [{ type: "text", text: replyFor(prompt) }],
		});
	});

	test("streams reasoning before text when reasoning effort is requested", async () => {
		const prompt = "Plan a migration";
		const events = await collect(prompt, { reasoningEffort: "high" });
		const thinkingEvents = events.filter(
			(event) => event.type === "thinking_delta",
		);
		const firstTextIndex = events.findIndex(
			(event) => event.type === "text_delta",
		);
		const thinking = thinkingEvents.map((event) => event.delta).join("");
		const done = events.at(-1)!;

		expect(thinking).toBe(
			"Reasoning (high) about: Plan a migration. Step 1: parse. Step 2: consider options. Step 3: answer.",
		);
		expect(
			events.findIndex((event) => event.type === "thinking_delta"),
		).toBeLessThan(firstTextIndex);
		expect(thinkingEvents.at(-1)?.partial).toMatchObject({
			content: [
				{ type: "thinking", thinking },
				{ type: "text", text: "" },
			],
		});
		expect(done.message).toMatchObject({
			content: [
				{ type: "thinking", thinking },
				{ type: "text", text: replyFor(prompt) },
			],
		});
	});

	test("honors aborts before starting and between streamed tokens", async () => {
		const alreadyAborted = new AbortController();
		alreadyAborted.abort();
		await expect(
			streamChat(
				contextFor("Never start"),
				selection,
				{},
				alreadyAborted.signal,
			)
				[Symbol.asyncIterator]()
				.next(),
		).rejects.toMatchObject({ name: "AbortError" });

		const controller = new AbortController();
		const iterator = streamChat(
			contextFor("Stop midway"),
			selection,
			{},
			controller.signal,
		)[Symbol.asyncIterator]();
		expect((await iterator.next()).value.type).toBe("start");
		expect((await iterator.next()).value.type).toBe("text_delta");
		controller.abort();
		await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
	});

	test("generates titles through the same zero-cost mock stream", async () => {
		const prompt = "Draft a release announcement";
		await expect(generateTitle(prompt, selection)).resolves.toBe(
			replyFor(prompt),
		);
	});

	test("reports model-rate cost and safe context-overflow retry metadata without content", () => {
		const call = modelCallTelemetry(
			{
				provider: "provider",
				endpointId: "endpoint",
				modelId: "model",
				api: "test",
			},
			{
				api: "test",
				provider: "provider",
				model: "model",
				content: [],
				usage: {
					input: 100,
					output: 0,
					cacheRead: 20,
					cacheWrite: 10,
					totalTokens: 130,
					cost: {
						input: 1,
						output: 0,
						cacheRead: 0.2,
						cacheWrite: 0.1,
						total: 1.3,
					},
				},
				stopReason: "error",
				errorMessage: "request exceeds the context window",
				timestamp: 1,
			} as never,
			12,
			{},
			128_000,
		);

		expect(call).toMatchObject({
			estimatedCostMicros: 1_300_000,
			overflowed: true,
		});
		expect(call.error).toEqual({
			kind: "context_overflow",
			retrySafe: true,
			outputStarted: false,
			toolStepsCompleted: false,
		});
		expect(call).not.toHaveProperty("error.errorMessage");
	});

	test("labels calls after executing tools as tool-loop calls", async () => {
		expectNoProviderCalls = false;
		let callCount = 0;
		providerStream = async function* () {
			callCount += 1;
			if (callCount === 1) {
				yield {
					type: "done",
					reason: "toolUse",
					message: {
						api: "test",
						provider: "test",
						model: "model",
						content: [
							{
								type: "toolCall",
								id: "call-1",
								name: "weather",
								arguments: {},
							},
						],
						usage: { input: 3, output: 1 },
						stopReason: "toolUse",
						timestamp: 1,
					},
				};
				return;
			}
			yield {
				type: "done",
				reason: "stop",
				message: {
					api: "test",
					provider: "test",
					model: "model",
					content: [{ type: "text", text: "Sunny" }],
					usage: { input: 8, output: 2 },
					stopReason: "stop",
					timestamp: 2,
				},
			};
		};
		const calls: any[] = [];
		const providerSelection = {
			provider: "test",
			endpointId: "test",
			modelId: "model",
			api: "test",
		};

		for await (const _event of streamChat(
			contextFor("Weather"),
			providerSelection,
			{},
			new AbortController().signal,
			[
				{
					tool: { name: "weather" },
					execute: async () => ({ content: "sunny", isError: false }),
				},
			] as never,
			{ onProviderCall: (call) => calls.push(call) },
		)) {
			// Consume all provider and tool events.
		}

		expect(calls.map((call) => call.purpose)).toEqual(["chat", "tool_loop"]);
	});

	test("completes stream gracefully using last partial message when google-genai trailing segment error is caught", async () => {
		expectNoProviderCalls = false;
		const partialMsg = {
			role: "assistant",
			content: [{ type: "text", text: "Hello world" }],
			timestamp: Date.now(),
			errorMessage: "Incomplete JSON segment at the end",
		};
		providerStream = async function* () {
			yield {
				type: "start",
				partial: partialMsg,
			};
			yield {
				type: "text_delta",
				delta: "Hello world",
				partial: partialMsg,
			};
			yield {
				type: "error",
				error: partialMsg,
			};
		};

		const selectionWithRealProvider = {
			provider: "real-provider",
			endpointId: "endpoint-1",
			modelId: "model-1",
			api: "google-generative-ai",
		};

		const events: any[] = [];
		for await (const event of streamChat(
			contextFor("test"),
			selectionWithRealProvider,
			{},
			new AbortController().signal,
		)) {
			events.push(event);
		}

		expect(events.length).toBeGreaterThan(0);
		expect(events[0].type).toBe("start");
		expect(events[1].type).toBe("text_delta");
		expect(events[2]).toEqual({
			type: "done",
			reason: "stop",
			message: partialMsg,
		});
	});
});

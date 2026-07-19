import { beforeEach, describe, expect, mock, test } from "bun:test";

const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
const generationSteps: Array<{ messageId: string; steps: unknown[] }> = [];
const providerCalls: Array<Record<string, unknown>> = [];
let streamFactory: (...args: any[]) => AsyncIterable<any>;
let titleFactory: (...args: any[]) => Promise<string>;

mock.module("../db", () => ({
	db: {
		updateTable(table: string) {
			const query = {
				set(values: Record<string, unknown>) {
					updates.push({ table, values });
					return query;
				},
				where() {
					return query;
				},
				execute: async () => undefined,
				executeTakeFirst: async () => ({ numUpdatedRows: 0n }),
			};
			return query;
		},
	},
}));

const log = {
	withMetadata: () => log,
	withError: () => log,
	info: () => undefined,
	trace: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

mock.module("../logger", () => ({ logger: log }));
mock.module("../context/repository", () => ({
	ContextRepository: class {
		recordGenerationSteps(messageId: string, steps: unknown[]) {
			generationSteps.push({ messageId, steps });
			return Promise.resolve();
		}
		recordProviderCall(call: Record<string, unknown>) {
			providerCalls.push(call);
			return Promise.resolve();
		}
	},
}));
mock.module("./models", () => ({
	streamChat: (...args: any[]) => streamFactory(...args),
	generateTitle: (...args: any[]) => titleFactory(...args),
}));

const { GenerationManager } = await import("./generationManager");

type SseEvent = { id?: number; data: unknown };

async function readEvents(
	stream: ReadableStream<Uint8Array>,
): Promise<SseEvent[]> {
	return readReader(stream.getReader());
}

async function readReader(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<SseEvent[]> {
	const decoder = new TextDecoder();
	const events: SseEvent[] = [];

	while (true) {
		const { done, value } = await reader.read();
		if (done) return events;
		const fields = decoder.decode(value).trim().split("\n");
		const id = fields.find((field) => field.startsWith("id: "));
		const data = fields.find((field) => field.startsWith("data: "))?.slice(6);
		events.push({
			...(id ? { id: Number(id.slice(4)) } : {}),
			data: data === "[DONE]" ? data : JSON.parse(data ?? "null"),
		});
	}
}

async function* events(...values: any[]): AsyncGenerator<any> {
	yield* values;
}

function start(
	manager: InstanceType<typeof GenerationManager>,
	messageId = "message-1",
): void {
	manager.start({
		conversationId: "conversation-1",
		messageId,
		context: {} as never,
		selection: {
			provider: "test",
			endpointId: "test",
			modelId: "model",
			api: "test",
		},
		params: {} as never,
	});
}

const doneEvent = {
	type: "done",
	reason: "stop",
	message: { usage: { input: 3, output: 5 } },
};

describe("GenerationManager SSE lifecycle", () => {
	beforeEach(() => {
		updates.length = 0;
		generationSteps.length = 0;
		providerCalls.length = 0;
		streamFactory = () => events();
		titleFactory = async () => "";
	});

	test("streams start, chunks, finish, and completion to a live subscriber", async () => {
		streamFactory = () =>
			events(
				{ type: "text_delta", delta: "Hello" },
				{ type: "thinking_delta", delta: "Thinking" },
				doneEvent,
			);
		const manager = new GenerationManager();

		start(manager);

		expect(await readEvents(manager.subscribe("message-1"))).toEqual([
			{ id: 1, data: { type: "start", messageId: "message-1" } },
			{ id: 2, data: { type: "text-delta", textDelta: "Hello" } },
			{ id: 3, data: { type: "reasoning-delta", delta: "Thinking" } },
			{
				id: 4,
				data: {
					type: "finish",
					finishReason: "stop",
					usage: { inputTokens: 3, outputTokens: 5 },
				},
			},
			{ data: "[DONE]" },
		]);
		expect(manager.isActive("message-1")).toBe(false);
		expect(updates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					table: "message",
					values: expect.objectContaining({
						text: "Hello",
						status: "complete",
					}),
				}),
			]),
		);
	});

	test("replays only events after the requested SSE event id", async () => {
		streamFactory = () =>
			events({ type: "text_delta", delta: "Hello" }, doneEvent);
		const manager = new GenerationManager();

		start(manager);
		await readEvents(manager.subscribe("message-1"));

		expect(await readEvents(manager.subscribe("message-1", 1))).toEqual([
			{ id: 2, data: { type: "text-delta", textDelta: "Hello" } },
			{
				id: 3,
				data: {
					type: "finish",
					finishReason: "stop",
					usage: { inputTokens: 3, outputTokens: 5 },
				},
			},
			{ data: "[DONE]" },
		]);
	});

	test("ends an unknown generation subscription immediately", async () => {
		const manager = new GenerationManager();

		expect(await readEvents(manager.subscribe("missing"))).toEqual([
			{ data: "[DONE]" },
		]);
		expect(manager.stop("missing")).toBe(false);
	});

	test("explicit stop aborts the stream, persists partial text, and emits a stop finish", async () => {
		streamFactory = async function* (
			_context,
			_selection,
			_params,
			signal: AbortSignal,
		) {
			yield { type: "text_delta", delta: "Partial" };
			yield* awaitAbort(signal);
		};
		const manager = new GenerationManager();

		start(manager);
		const stream = manager.subscribe("message-1");
		const reader = stream.getReader();
		await reader.read();
		await reader.read();
		expect(manager.stop("message-1")).toBe(true);

		expect(await readReader(reader)).toEqual([
			{
				id: 3,
				data: {
					type: "finish",
					finishReason: "stop",
					usage: { inputTokens: 0, outputTokens: 0 },
				},
			},
			{ data: "[DONE]" },
		]);
		expect(updates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					table: "message",
					values: expect.objectContaining({
						text: "Partial",
						status: "complete",
					}),
				}),
			]),
		);
	});

	test("emits an error chunk, closes subscribers, and persists failure state", async () => {
		streamFactory = () =>
			events(
				{ type: "text_delta", delta: "Partial" },
				{ type: "error", error: { errorMessage: "provider unavailable" } },
			);
		const manager = new GenerationManager();

		start(manager);

		expect(await readEvents(manager.subscribe("message-1"))).toEqual([
			{ id: 1, data: { type: "start", messageId: "message-1" } },
			{ id: 2, data: { type: "text-delta", textDelta: "Partial" } },
			{ id: 3, data: { type: "error", errorText: "provider unavailable" } },
			{ data: "[DONE]" },
		]);
		expect(updates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					table: "message",
					values: expect.objectContaining({
						text: "Partial\n\n**Error:** provider unavailable",
						status: "error",
					}),
				}),
			]),
		);
	});

	test("persists native tool-loop steps and every provider call while aggregating usage", async () => {
		streamFactory = async function* (
			_context,
			_selection,
			_params,
			_signal,
			_tools,
			options,
		) {
			options.onGenerationStep({
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-1", name: "weather", arguments: {} },
				],
			});
			options.onGenerationStep({
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "weather",
				content: [{ type: "text", text: "sunny" }],
				isError: false,
			});
			options.onProviderCall({
				purpose: "chat",
				observation: {
					provider: "test",
					api: "test",
					modelId: "model",
					inputTokens: 3,
					outputTokens: 5,
					cacheReadTokens: 2,
					cacheWriteTokens: 1,
					estimatedCostMicros: 4,
					latencyMs: 10,
				},
			});
			options.onProviderCall({
				purpose: "tool_loop",
				observation: {
					provider: "test",
					api: "test",
					modelId: "model",
					inputTokens: 7,
					outputTokens: 11,
					latencyMs: 12,
				},
			});
			yield {
				...doneEvent,
				message: {
					...doneEvent.message,
					api: "test",
					provider: "test",
					model: "model",
				},
			};
		};
		const manager = new GenerationManager();

		start(manager);
		await readEvents(manager.subscribe("message-1"));

		expect(generationSteps).toEqual([
			{
				messageId: "message-1",
				steps: [
					expect.objectContaining({ role: "assistant" }),
					expect.objectContaining({ role: "toolResult" }),
				],
			},
		]);
		expect(providerCalls).toEqual([
			expect.objectContaining({
				purpose: "chat",
				inputTokens: 3,
				cacheReadTokens: 2,
				cacheWriteTokens: 1,
				estimatedCostMicros: 4,
			}),
			expect.objectContaining({
				purpose: "tool_loop",
				inputTokens: 7,
				latencyMs: 12,
			}),
		]);
		expect(updates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					table: "message",
					values: expect.objectContaining({
						inputTokens: 10,
						outputTokens: 16,
					}),
				}),
			]),
		);
	});

	test("records title calls with their originating conversation and message", async () => {
		titleFactory = async (_prompt, _selection, options) => {
			options.onProviderCall({
				purpose: "chat",
				observation: {
					provider: "title-provider",
					api: "test",
					modelId: "title-model",
					inputTokens: 2,
					outputTokens: 3,
					latencyMs: 4,
				},
			});
			return '{"title":"A title"}';
		};
		streamFactory = () => events(doneEvent);
		const manager = new GenerationManager();

		manager.start({
			conversationId: "conversation-1",
			messageId: "message-1",
			context: {} as never,
			selection: {
				provider: "test",
				endpointId: "test",
				modelId: "model",
				api: "test",
			},
			params: {} as never,
			titleGeneration: {
				firstMessage: "Hello",
				prompt: "{{first_message}}",
				selection: {
					provider: "title-provider",
					endpointId: "test",
					modelId: "title-model",
					api: "test",
				},
			},
		});
		await readEvents(manager.subscribe("message-1"));

		expect(providerCalls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					purpose: "title",
					conversationId: "conversation-1",
					messageId: "message-1",
					inputTokens: 2,
				}),
			]),
		);
	});

	test("persists overflow telemetry when a provider call fails", async () => {
		streamFactory = async function* (
			_context,
			_selection,
			_params,
			_signal,
			_tools,
			options,
		) {
			options.onProviderCall({
				purpose: "chat",
				observation: {
					provider: "test",
					api: "test",
					modelId: "model",
					inputTokens: 9,
					outputTokens: 0,
					cacheReadTokens: 4,
					cacheWriteTokens: 2,
					latencyMs: 10,
					overflowed: true,
					error: {
						kind: "context_overflow",
						retrySafe: true,
						outputStarted: false,
						toolStepsCompleted: false,
					},
				},
			});
			yield { type: "error", error: { errorMessage: "context exceeded" } };
		};
		const manager = new GenerationManager();

		start(manager);
		await readEvents(manager.subscribe("message-1"));

		expect(providerCalls).toEqual([
			expect.objectContaining({
				overflowed: true,
				cacheReadTokens: 4,
				cacheWriteTokens: 2,
			}),
		]);
		expect(providerCalls[0]).not.toHaveProperty("error");
		expect(updates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					table: "message",
					values: expect.objectContaining({
						inputTokens: 9,
						outputTokens: 0,
						status: "error",
					}),
				}),
			]),
		);
	});

	test("compacts and retries exactly once after safe overflow before output", async () => {
		let calls = 0;
		let rebuilt = 0;
		streamFactory = async function* (
			_context,
			_selection,
			_params,
			_signal,
			_tools,
			options,
		) {
			calls++;
			if (calls === 1) {
				options.onProviderCall({
					purpose: "chat",
					observation: {
						provider: "test",
						api: "test",
						modelId: "model",
						overflowed: true,
						retryAttempt: 0,
						error: {
							kind: "context_overflow",
							retrySafe: true,
							outputStarted: false,
							toolStepsCompleted: false,
						},
					},
				});
				yield { type: "error", error: { errorMessage: "context exceeded" } };
				return;
			}
			expect(options.telemetry.retryAttempt).toBe(1);
			yield { type: "text_delta", delta: "Recovered" };
			yield doneEvent;
		};
		const manager = new GenerationManager();
		manager.start({
			conversationId: "conversation-1",
			messageId: "message-1",
			context: {} as never,
			selection: {
				provider: "test",
				endpointId: "test",
				modelId: "model",
				api: "test",
			},
			params: {} as never,
			retryContext: async () => {
				rebuilt++;
				return { context: { messages: [] }, params: {} as never };
			},
		});
		expect(await readEvents(manager.subscribe("message-1"))).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					data: { type: "text-delta", textDelta: "Recovered" },
				}),
			]),
		);
		expect({ calls, rebuilt }).toEqual({ calls: 2, rebuilt: 1 });
		expect(providerCalls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ retryAttempt: 0, overflowed: true }),
			]),
		);
	});

	test("does not retry overflow after streamed output", async () => {
		let rebuilt = 0;
		streamFactory = async function* (
			_context,
			_selection,
			_params,
			_signal,
			_tools,
			options,
		) {
			options.onProviderCall({
				purpose: "chat",
				observation: {
					provider: "test",
					api: "test",
					modelId: "model",
					overflowed: true,
					error: {
						kind: "context_overflow",
						retrySafe: false,
						outputStarted: true,
						toolStepsCompleted: false,
					},
				},
			});
			yield { type: "text_delta", delta: "Partial" };
			yield { type: "error", error: { errorMessage: "context exceeded" } };
		};
		const manager = new GenerationManager();
		manager.start({
			conversationId: "conversation-1",
			messageId: "message-1",
			context: {} as never,
			selection: {
				provider: "test",
				endpointId: "test",
				modelId: "model",
				api: "test",
			},
			params: {} as never,
			retryContext: async () => {
				rebuilt++;
				return { context: { messages: [] }, params: {} as never };
			},
		});
		await readEvents(manager.subscribe("message-1"));
		expect(rebuilt).toBe(0);
	});
});

async function* awaitAbort(signal: AbortSignal): AsyncGenerator<never> {
	await new Promise<never>((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(new Error("aborted")), {
			once: true,
		});
	});
}

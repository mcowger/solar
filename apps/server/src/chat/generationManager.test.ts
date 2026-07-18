import { beforeEach, describe, expect, mock, test } from "bun:test";

const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
let streamFactory: (...args: any[]) => AsyncIterable<any>;

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
mock.module("./models", () => ({
  streamChat: (...args: any[]) => streamFactory(...args),
  generateTitle: async () => "",
}));

const { GenerationManager } = await import("./generationManager");

type SseEvent = { id?: number; data: unknown };

async function readEvents(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  return readReader(stream.getReader());
}

async function readReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<SseEvent[]> {
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

function start(manager: InstanceType<typeof GenerationManager>, messageId = "message-1"): void {
  manager.start({
    conversationId: "conversation-1",
    messageId,
    context: {} as never,
    selection: { provider: "test", modelId: "model", api: "test" },
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
    streamFactory = () => events();
  });

  test("streams start, chunks, finish, and completion to a live subscriber", async () => {
    streamFactory = () => events(
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
      { id: 4, data: { type: "finish", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 5 } } },
      { data: "[DONE]" },
    ]);
    expect(manager.isActive("message-1")).toBe(false);
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "message", values: expect.objectContaining({ text: "Hello", status: "complete" }) }),
    ]));
  });

  test("replays only events after the requested SSE event id", async () => {
    streamFactory = () => events({ type: "text_delta", delta: "Hello" }, doneEvent);
    const manager = new GenerationManager();

    start(manager);
    await readEvents(manager.subscribe("message-1"));

    expect(await readEvents(manager.subscribe("message-1", 1))).toEqual([
      { id: 2, data: { type: "text-delta", textDelta: "Hello" } },
      { id: 3, data: { type: "finish", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 5 } } },
      { data: "[DONE]" },
    ]);
  });

  test("ends an unknown generation subscription immediately", async () => {
    const manager = new GenerationManager();

    expect(await readEvents(manager.subscribe("missing"))).toEqual([{ data: "[DONE]" }]);
    expect(manager.stop("missing")).toBe(false);
  });

  test("explicit stop aborts the stream, persists partial text, and emits a stop finish", async () => {
    streamFactory = async function* (_context, _selection, _params, signal: AbortSignal) {
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
      { id: 3, data: { type: "finish", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0 } } },
      { data: "[DONE]" },
    ]);
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "message", values: expect.objectContaining({ text: "Partial", status: "complete" }) }),
    ]));
  });

  test("emits an error chunk, closes subscribers, and persists failure state", async () => {
    streamFactory = () => events(
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
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: "message",
        values: expect.objectContaining({ text: "Partial\n\n**Error:** provider unavailable", status: "error" }),
      }),
    ]));
  });
});

async function* awaitAbort(signal: AbortSignal): AsyncGenerator<never> {
  await new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

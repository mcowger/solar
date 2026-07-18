import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
} from "@earendil-works/pi-ai";
import {
  MOCK,
  resolveModel,
  streamModel,
  type ModelSelection,
} from "./catalog";

/**
 * Stream an assistant turn as pi-ai events for the chosen model.
 *
 * The `mock` provider (available when SOLAR_MOCK_LLM is set) is served by a
 * local echo generator so no provider API is called and nothing is billed —
 * used for local development and UI verification only. All other providers are
 * streamed through pi-ai with the DB-configured key/baseURL.
 */
export async function streamChat(
  context: Context,
  selection: ModelSelection,
  signal: AbortSignal,
): Promise<AsyncIterable<AssistantMessageEvent>> {
  if (selection.provider === "mock") return mockStream(context, selection, signal);
  const resolved = await resolveModel(selection);
  return streamModel(resolved, context, signal);
}

function mockMessage(text: string, selection: ModelSelection): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: selection.provider,
    model: selection.modelId,
    usage: { input: 0, output: 0 },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
}

async function* mockStream(
  context: Context,
  selection: ModelSelection,
  signal: AbortSignal,
): AsyncIterable<AssistantMessageEvent> {
  const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
  const prompt =
    lastUser && typeof lastUser.content === "string" ? lastUser.content : "";

  const reply =
    `**Mock reply** (${selection.modelId}) to: ${prompt}\n\n` +
    "Inline code `x = 1`, a fenced block:\n\n" +
    '```js\nconsole.log("hello");\n```\n\n' +
    "And display math: $$E = mc^2$$";

  const tokens = reply.match(/\S+\s*|\s+/g) ?? [reply];
  let acc = "";
  yield { type: "start", partial: mockMessage("", selection) } as AssistantMessageEvent;

  for (const tok of tokens) {
    if (signal.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    acc += tok;
    yield {
      type: "text_delta",
      contentIndex: 0,
      delta: tok,
      partial: mockMessage(acc, selection),
    } as AssistantMessageEvent;
    await new Promise((r) => setTimeout(r, 25));
  }

  yield { type: "done", reason: "stop", message: mockMessage(acc, selection) };
}

export { MOCK };

import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
} from "@earendil-works/pi-ai";
import {
  MOCK,
  resolveModel,
  streamModel,
  type GenerationParams,
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
  params: GenerationParams,
  signal: AbortSignal,
): Promise<AsyncIterable<AssistantMessageEvent>> {
  if (selection.provider === "mock") return mockStream(context, selection, params, signal);
  const resolved = await resolveModel(selection);
  return streamModel(resolved, context, signal, params);
}

function mockMessage(
  text: string,
  selection: ModelSelection,
  thinking?: string,
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (thinking) content.push({ type: "thinking", thinking });
  content.push({ type: "text", text });
  return {
    role: "assistant",
    content,
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
  params: GenerationParams,
  signal: AbortSignal,
): AsyncIterable<AssistantMessageEvent> {
  const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
  const prompt =
    lastUser && typeof lastUser.content === "string" ? lastUser.content : "";

  yield { type: "start", partial: mockMessage("", selection) } as AssistantMessageEvent;

  // When reasoning is requested, stream a canned "thinking" block first so the
  // reasoning UI can be exercised at zero cost.
  let thinkingAcc = "";
  if (params.reasoningEffort) {
    const thinking =
      `Reasoning (${params.reasoningEffort}) about: ${prompt}. ` +
      "Step 1: parse. Step 2: consider options. Step 3: answer.";
    const thoughtToks = thinking.match(/\S+\s*|\s+/g) ?? [thinking];
    for (const tok of thoughtToks) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      thinkingAcc += tok;
      yield {
        type: "thinking_delta",
        contentIndex: 0,
        delta: tok,
        partial: mockMessage("", selection, thinkingAcc),
      } as AssistantMessageEvent;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const reply =
    `**Mock reply** (${selection.modelId}) to: ${prompt}\n\n` +
    "Inline code `x = 1`, a fenced block:\n\n" +
    '```js\nconsole.log("hello");\n```\n\n' +
    "And display math: $$E = mc^2$$";

  const tokens = reply.match(/\S+\s*|\s+/g) ?? [reply];
  let acc = "";
  for (const tok of tokens) {
    if (signal.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    acc += tok;
    yield {
      type: "text_delta",
      contentIndex: 0,
      delta: tok,
      partial: mockMessage(acc, selection, thinkingAcc || undefined),
    } as AssistantMessageEvent;
    await new Promise((r) => setTimeout(r, 25));
  }

  yield {
    type: "done",
    reason: "stop",
    message: mockMessage(acc, selection, thinkingAcc || undefined),
  };
}

export { MOCK };

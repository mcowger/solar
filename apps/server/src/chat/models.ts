import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
} from "@earendil-works/pi-ai";
import type { ResolvedTool } from "./mcp";
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
export async function* streamChat(
  context: Context,
  selection: ModelSelection,
  params: GenerationParams,
  signal: AbortSignal,
  resolvedTools: ResolvedTool[] = [],
): AsyncIterable<AssistantMessageEvent> {
  if (selection.provider === "mock") {
    yield* mockStream(context, selection, params, signal);
    return;
  }
  const resolved = await resolveModel(selection);
  const executors = new Map(resolvedTools.map(({ tool, execute }) => [tool.name, execute]));
  let turnContext = context;
  while (true) {
    const events = streamModel(resolved, turnContext, signal, params);
    let message: AssistantMessage | undefined;
    let reason: string | undefined;
    for await (const event of events) {
      yield event;
      if (event.type === "done") {
        message = event.message;
        reason = event.reason;
      }
    }
    if (!message || reason !== "toolUse") return;
    const calls = message.content.filter((part) => part.type === "toolCall");
    if (calls.length === 0) return;
    const results = await Promise.all(calls.map(async (call) => {
      const execute = executors.get(call.name);
      if (!execute) return { role: "toolResult" as const, toolCallId: call.id, toolName: call.name, content: [{ type: "text" as const, text: "Tool is unavailable." }], isError: true, timestamp: Date.now() };
      try {
        const result = await execute(call.arguments);
        return { role: "toolResult" as const, toolCallId: call.id, toolName: call.name, content: [{ type: "text" as const, text: result.content }], isError: result.isError, timestamp: Date.now() };
      } catch (error) {
        return { role: "toolResult" as const, toolCallId: call.id, toolName: call.name, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true, timestamp: Date.now() };
      }
    }));
    turnContext = { ...turnContext, messages: [...turnContext.messages, message, ...results] };
  }
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

export async function generateTitle(
  prompt: string,
  selection: ModelSelection,
): Promise<string> {
  const context: Context = {
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  };
  let text = "";
  for await (const event of streamChat(context, selection, {}, new AbortController().signal)) {
    if (event.type === "error") {
      throw new Error(event.error.errorMessage ?? "Title generation failed");
    }
    if (event.type === "text_delta") text += event.delta;
  }
  return text;
}

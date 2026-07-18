import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

/**
 * pi-ai model registry. M1 ships a single hard-coded provider/model (OpenAI
 * gpt-4o-mini); API keys are read from the environment by pi-ai. Multi-provider
 * selection and DB-stored keys arrive in M3/M4.
 */
export const models = builtinModels();

export const DEFAULT_PROVIDER = "openai";
export const DEFAULT_MODEL_ID = "gpt-4o-mini";
export const DEFAULT_MODEL = `${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`;

/**
 * When `SOLAR_MOCK_LLM` is set, generation is served by a local echo model that
 * streams a canned Markdown/code/LaTeX response — no provider API calls, no
 * cost. Intended for local development and UI verification only.
 */
const MOCK = Boolean(process.env.SOLAR_MOCK_LLM);

export function getDefaultModel() {
  const model = models.getModel(DEFAULT_PROVIDER, DEFAULT_MODEL_ID);
  if (!model) {
    throw new Error(
      `Default model ${DEFAULT_MODEL} is unavailable (check pi-ai catalog / API key).`,
    );
  }
  return model;
}

/**
 * Stream an assistant turn as pi-ai events. Delegates to the real provider,
 * unless mock mode is on (see `MOCK`), in which case a deterministic local
 * generator is used so no tokens are ever billed.
 */
export function streamChat(
  context: Context,
  signal: AbortSignal,
): AsyncIterable<AssistantMessageEvent> {
  if (MOCK) return mockStream(context, signal);
  return models.stream(getDefaultModel(), context, { signal });
}

function mockMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL_ID,
    usage: { input: 0, output: 0 },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
}

async function* mockStream(
  context: Context,
  signal: AbortSignal,
): AsyncIterable<AssistantMessageEvent> {
  const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
  const prompt =
    lastUser && typeof lastUser.content === "string" ? lastUser.content : "";

  const reply =
    `**Mock reply** (SOLAR_MOCK_LLM) to: ${prompt}\n\n` +
    "Inline code `x = 1`, a fenced block:\n\n" +
    '```js\nconsole.log("hello");\n```\n\n' +
    "And display math: $$E = mc^2$$";

  const tokens = reply.match(/\S+\s*|\s+/g) ?? [reply];
  let acc = "";
  yield { type: "start", partial: mockMessage("") } as AssistantMessageEvent;

  for (const tok of tokens) {
    if (signal.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    acc += tok;
    yield {
      type: "text_delta",
      contentIndex: 0,
      delta: tok,
      partial: mockMessage(acc),
    } as AssistantMessageEvent;
    await new Promise((r) => setTimeout(r, 25));
  }

  yield { type: "done", reason: "stop", message: mockMessage(acc) };
}

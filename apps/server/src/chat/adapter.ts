import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

/**
 * UI stream chunk — the wire shape the frontend consumes. This is our own
 * lightweight take on the "UI message stream" (per Spike 1), decoupled from the
 * transport: the generation manager stores these chunks in a buffer and the SSE
 * subscriber serializes them. Kept intentionally small for M1 (text + finish +
 * error); reasoning/tool-call chunks are already representable for later.
 */
export type UiChunk =
  | { type: "start"; messageId: string }
  | { type: "text-delta"; textDelta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-call-start"; toolCallId: string; toolName: string }
  | { type: "tool-call-delta"; argsText: string }
  | { type: "tool-call-end" }
  | {
      type: "finish";
      finishReason: string;
      usage: { inputTokens: number; outputTokens: number };
    }
  | { type: "error"; errorText: string };

/**
 * Maps a single pi-ai event to zero or more UI chunks. The generation loop owns
 * iteration + buffering; this stays a pure mapping (per the Spike 1 adapter).
 */
export function piEventToUiChunks(event: AssistantMessageEvent): UiChunk[] {
  switch (event.type) {
    case "text_delta":
      return [{ type: "text-delta", textDelta: event.delta }];
    case "thinking_delta":
      return [{ type: "reasoning-delta", delta: event.delta }];
    case "toolcall_start": {
      const tool = event.partial.content[event.contentIndex];
      if (tool?.type === "toolCall") {
        return [
          {
            type: "tool-call-start",
            toolCallId: tool.id,
            toolName: tool.name,
          },
        ];
      }
      return [];
    }
    case "toolcall_delta":
      return [{ type: "tool-call-delta", argsText: event.delta }];
    case "toolcall_end":
      return [{ type: "tool-call-end" }];
    case "done":
      return [
        {
          type: "finish",
          finishReason: event.reason ?? "stop",
          usage: {
            inputTokens: event.message.usage.input,
            outputTokens: event.message.usage.output,
          },
        },
      ];
    case "error":
      return [{ type: "error", errorText: event.error.errorMessage ?? "error" }];
    default:
      return [];
  }
}

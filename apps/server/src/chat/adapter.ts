import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

/**
 * UI stream chunk — the wire shape the frontend consumes. This is our own
 * lightweight take on the "UI message stream" (per Spike 1), decoupled from the
 * transport: the generation manager stores these chunks in a buffer and the SSE
 * subscriber serializes them. Kept intentionally small for M1 (text + finish +
 * error); tool calls include their execution result so the client can render
 * their full lifecycle without affecting text or reasoning streams.
 */
export type UiChunk =
  | { type: "start"; messageId: string }
  | { type: "text-delta"; textDelta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-call-start"; toolCallId: string; toolName: string; serverName?: string; remoteName?: string }
  | { type: "tool-call-delta"; toolCallId: string; argsText: string }
  | { type: "tool-call-end"; toolCallId: string }
  | {
      type: "tool-call-result";
      toolCallId: string;
      output: string;
      isError: boolean;
    }
  | {
      type: "finish";
      finishReason: string;
      usage: { inputTokens: number; outputTokens: number };
    }
  | { type: "title-update"; title: string }
  | { type: "error"; errorText: string };

export interface ToolCallResultEvent {
  type: "tool-call-result";
  toolCallId: string;
  output: string;
  isError: boolean;
}

/**
 * Maps a single pi-ai event to zero or more UI chunks. The generation loop owns
 * iteration + buffering; this stays a pure mapping (per the Spike 1 adapter).
 */
export function piEventToUiChunks(event: AssistantMessageEvent | ToolCallResultEvent, toolDisplayNames: Map<string, { serverName: string; remoteName: string }>): UiChunk[] {
  if (event.type === "tool-call-result") return [event];
  switch (event.type) {
    case "text_delta":
      return [{ type: "text-delta", textDelta: event.delta }];
    case "thinking_delta":
      return [{ type: "reasoning-delta", delta: event.delta }];
    case "toolcall_start": {
      const tool = event.partial.content[event.contentIndex];
      if (tool?.type === "toolCall") {
        const displayName = toolDisplayNames.get(tool.name);
        return [
          {
            type: "tool-call-start",
            toolCallId: tool.id,
            toolName: tool.name,
            ...displayName,
          },
        ];
      }
      return [];
    }
    case "toolcall_delta": {
      const tool = event.partial.content[event.contentIndex];
      return tool?.type === "toolCall"
        ? [{ type: "tool-call-delta", toolCallId: tool.id, argsText: event.delta }]
        : [];
    }
    case "toolcall_end": {
      const tool = event.partial.content[event.contentIndex];
      return tool?.type === "toolCall"
        ? [{ type: "tool-call-end", toolCallId: tool.id }]
        : [];
    }
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

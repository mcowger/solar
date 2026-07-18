import { describe, expect, test } from "bun:test";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { piEventToUiChunks } from "./adapter";

const toolDisplayNames = new Map([
  ["mcp_weather", { serverName: "Weather", remoteName: "forecast" }],
]);

describe("piEventToUiChunks", () => {
  test("maps text, reasoning, result, completion, and error events", () => {
    expect(piEventToUiChunks({ type: "text_delta", delta: "Hello" } as AssistantMessageEvent, toolDisplayNames)).toEqual([
      { type: "text-delta", textDelta: "Hello" },
    ]);
    expect(piEventToUiChunks({ type: "thinking_delta", delta: "Consider" } as AssistantMessageEvent, toolDisplayNames)).toEqual([
      { type: "reasoning-delta", delta: "Consider" },
    ]);
    expect(piEventToUiChunks({ type: "tool-call-result", toolCallId: "call-1", output: "72F", isError: false }, toolDisplayNames)).toEqual([
      { type: "tool-call-result", toolCallId: "call-1", output: "72F", isError: false },
    ]);
    expect(piEventToUiChunks({ type: "done", reason: "length", message: { usage: { input: 12, output: 34 } } } as AssistantMessageEvent, toolDisplayNames)).toEqual([
      { type: "finish", finishReason: "length", usage: { inputTokens: 12, outputTokens: 34 } },
    ]);
    expect(piEventToUiChunks({ type: "error", error: {} } as AssistantMessageEvent, toolDisplayNames)).toEqual([
      { type: "error", errorText: "error" },
    ]);
  });

  test("maps tool lifecycle events using the resolved tool metadata", () => {
    const partial = { content: [{ type: "toolCall", id: "call-1", name: "mcp_weather" }] };
    expect(piEventToUiChunks({ type: "toolcall_start", contentIndex: 0, partial } as AssistantMessageEvent, toolDisplayNames)).toEqual([
      { type: "tool-call-start", toolCallId: "call-1", toolName: "mcp_weather", serverName: "Weather", remoteName: "forecast" },
    ]);
    expect(piEventToUiChunks({ type: "toolcall_delta", contentIndex: 0, delta: '{"city":"Austin"}', partial } as AssistantMessageEvent, toolDisplayNames)).toEqual([
      { type: "tool-call-delta", toolCallId: "call-1", argsText: '{"city":"Austin"}' },
    ]);
    expect(piEventToUiChunks({ type: "toolcall_end", contentIndex: 0, partial } as AssistantMessageEvent, toolDisplayNames)).toEqual([
      { type: "tool-call-end", toolCallId: "call-1" },
    ]);
  });

  test("ignores events without a matching tool-call content part", () => {
    const partial = { content: [{ type: "text", text: "not a tool" }] };
    expect(piEventToUiChunks({ type: "toolcall_start", contentIndex: 0, partial } as AssistantMessageEvent, toolDisplayNames)).toEqual([]);
    expect(piEventToUiChunks({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial } as AssistantMessageEvent, toolDisplayNames)).toEqual([]);
    expect(piEventToUiChunks({ type: "toolcall_end", contentIndex: 0, partial } as AssistantMessageEvent, toolDisplayNames)).toEqual([]);
  });
});

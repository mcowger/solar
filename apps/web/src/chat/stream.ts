/** Wire chunk shape emitted by the server (mirrors server chat/adapter.ts). */
export type UiChunk =
  | { type: "start"; messageId: string }
  | { type: "text-delta"; textDelta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-call-start"; toolCallId: string; toolName: string }
  | { type: "tool-call-delta"; argsText: string }
  | { type: "tool-call-end" }
  | { type: "finish"; finishReason: string; usage: { inputTokens: number; outputTokens: number } }
  | { type: "error"; errorText: string };

/**
 * Reads an SSE response body and invokes `onChunk` for each parsed data event.
 * Returns when the stream ends or `[DONE]` is received. Our SSE frames are
 * `id: N\nevent: message\ndata: <json|[DONE]>\n\n`.
 */
export async function readChunkStream(
  response: Response,
  onChunk: (chunk: UiChunk) => void,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const data = dataLine.slice(5).trim();
      if (data === "[DONE]") return;
      onChunk(JSON.parse(data) as UiChunk);
    }
  }
}

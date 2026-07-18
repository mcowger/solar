import { describe, expect, test } from "bun:test";
import { readChunkStream, type UiChunk } from "./stream";

function responseFrom(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  );
}

describe("readChunkStream", () => {
  test("parses frames split across transport chunks and stops at DONE", async () => {
    const received: UiChunk[] = [];
    const response = responseFrom([
      "id: 1\nevent: message\ndata: {\"type\":\"start\",\"messageId\":\"message-1\"}\n",
      "\nid: 2\nevent: message\ndata: {\"type\":\"text-delta\",\"textDelta\":\"Hello\"}\n\n",
      "id: 3\nevent: message\ndata: [DONE]\n\nid: 4\ndata: {\"type\":\"error\",\"errorText\":\"ignored\"}\n\n",
    ]);

    await readChunkStream(response, (chunk) => received.push(chunk));

    expect(received).toEqual([
      { type: "start", messageId: "message-1" },
      { type: "text-delta", textDelta: "Hello" },
    ]);
  });

  test("returns when the response has no body", async () => {
    const received: UiChunk[] = [];

    await readChunkStream(new Response(null), (chunk) => received.push(chunk));

    expect(received).toEqual([]);
  });
});

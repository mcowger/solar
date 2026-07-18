import {
  useExternalStoreRuntime,
  type ThreadMessageLike,
  type AppendMessage,
} from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { trpcClient } from "../trpcClient";
import { readChunkStream } from "./stream";

interface SolarMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

function convertMessage(m: SolarMessage): ThreadMessageLike {
  return { id: m.id, role: m.role, content: [{ type: "text", text: m.content }] };
}

function appendText(message: AppendMessage): string {
  return message.content
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("");
}

/**
 * External-store runtime backing assistant-ui with our DB-canonical,
 * decoupled-generation model. We own message state: history is loaded from the
 * server, sending POSTs to /api/chat and streams the reply, an in-progress
 * generation is resumed on load, and Stop hits the explicit stop endpoint.
 */
export function useSolarRuntime(conversationId: string) {
  const [messages, setMessages] = useState<SolarMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const assistantIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const upsertAssistant = useCallback((id: string, text: string) => {
    setMessages((prev) => {
      const exists = prev.some((m) => m.id === id);
      if (exists) {
        return prev.map((m) => (m.id === id ? { ...m, content: text } : m));
      }
      return [...prev, { id, role: "assistant", content: text }];
    });
  }, []);

  const consume = useCallback(
    async (response: Response, displayId: string) => {
      // The server's canonical message id (for Stop) comes from the response
      // header; the visible message keeps a stable `displayId` so assistant-ui
      // reconciliation isn't disrupted mid-stream. The assistant bubble is added
      // on first content (empty trailing assistant messages are not rendered).
      assistantIdRef.current =
        response.headers.get("x-message-id") ?? assistantIdRef.current;
      let text = "";
      setIsRunning(true);
      try {
        await readChunkStream(response, (chunk) => {
          if (chunk.type === "text-delta") {
            text += chunk.textDelta;
            upsertAssistant(displayId, text);
          } else if (chunk.type === "error") {
            text += `\n\n_Error: ${chunk.errorText}_`;
            upsertAssistant(displayId, text);
          }
        });
      } finally {
        setIsRunning(false);
        assistantIdRef.current = null;
        abortRef.current = null;
      }
    },
    [upsertAssistant],
  );

  // Load history; resume an in-progress generation if the server has one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await trpcClient.conversation.messages.query({ conversationId });
      if (cancelled) return;
      setMessages(rows.map((r) => ({ id: r.id, role: r.role, content: r.text })));

      const active = rows.find((r) => r.isActive);
      if (active) {
        assistantIdRef.current = active.id;
        const res = await fetch(
          `/api/chat/stream?messageId=${encodeURIComponent(active.id)}`,
        );
        if (!cancelled) await consume(res, active.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, consume]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = appendText(message).trim();
      if (!text) return;

      const userId = crypto.randomUUID();
      const placeholderId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        { id: userId, role: "user", content: text },
      ]);

      const abort = new AbortController();
      abortRef.current = abort;
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, text }),
        signal: abort.signal,
      });
      await consume(res, placeholderId);
    },
    [conversationId, consume],
  );

  const onCancel = useCallback(async () => {
    const messageId = assistantIdRef.current;
    // Explicit Stop: tell the server to abort (decoupled from the fetch), then
    // detach our reader.
    if (messageId) {
      await fetch("/api/chat/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId }),
      });
    }
    abortRef.current?.abort();
  }, []);

  return useExternalStoreRuntime({
    messages,
    isRunning,
    convertMessage,
    onNew,
    onCancel,
  });
}

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
  return { role: m.role, content: [{ type: "text", text: m.content }] };
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

  const updateAssistant = useCallback((id: string, text: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, content: text } : m)),
    );
  }, []);

  const consume = useCallback(
    async (response: Response, assistantId: string) => {
      let text = "";
      assistantIdRef.current = assistantId;
      setIsRunning(true);
      try {
        await readChunkStream(response, (chunk) => {
          if (chunk.type === "start") {
            // Server's canonical assistant message id; adopt it.
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, id: chunk.messageId } : m,
              ),
            );
            assistantId = chunk.messageId;
            assistantIdRef.current = chunk.messageId;
          } else if (chunk.type === "text-delta") {
            text += chunk.textDelta;
            updateAssistant(assistantId, text);
          } else if (chunk.type === "error") {
            text += `\n\n_Error: ${chunk.errorText}_`;
            updateAssistant(assistantId, text);
          }
        });
      } finally {
        setIsRunning(false);
        assistantIdRef.current = null;
        abortRef.current = null;
      }
    },
    [updateAssistant],
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
        { id: placeholderId, role: "assistant", content: "" },
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

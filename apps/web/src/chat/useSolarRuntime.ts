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
  reasoning?: string;
}

function convertMessage(m: SolarMessage): ThreadMessageLike {
  return {
    id: m.id,
    role: m.role,
    content: [
      ...(m.reasoning ? [{ type: "reasoning" as const, text: m.reasoning }] : []),
      { type: "text", text: m.content },
    ],
  };
}

function appendText(message: AppendMessage): string {
  return message.content
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("");
}

const jsonHeaders = { "content-type": "application/json" };

/**
 * External-store runtime backing assistant-ui with our DB-canonical,
 * decoupled-generation model. We own message state: history is loaded from the
 * server, sending POSTs to /api/chat and streams the reply, an in-progress
 * generation is resumed on load, and Stop hits the explicit stop endpoint.
 *
 * Edit and regenerate discard the affected tail server-side and stream a fresh
 * reply; after every turn we reload history so local ids match the DB (required
 * for subsequent edit/regenerate, which key off canonical message ids).
 */
export function useSolarRuntime(conversationId: string) {
  const [messages, setMessages] = useState<SolarMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const assistantIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const upsertAssistant = useCallback(
    (id: string, text: string, reasoning?: string) => {
      setMessages((prev) => {
        const exists = prev.some((m) => m.id === id);
        if (exists) {
          return prev.map((m) =>
            m.id === id ? { ...m, content: text, reasoning } : m,
          );
        }
        return [...prev, { id, role: "assistant", content: text, reasoning }];
      });
    },
    [],
  );

  const consume = useCallback(
    async (response: Response, displayId: string) => {
      // The server's canonical message id (for Stop) comes from the response
      // header; the visible message keeps a stable `displayId` so assistant-ui
      // reconciliation isn't disrupted mid-stream. The assistant bubble is added
      // on first content (empty trailing assistant messages are not rendered).
      assistantIdRef.current =
        response.headers.get("x-message-id") ?? assistantIdRef.current;
      let text = "";
      let reasoning = "";
      setIsRunning(true);
      try {
        await readChunkStream(response, (chunk) => {
          if (chunk.type === "text-delta") {
            text += chunk.textDelta;
            upsertAssistant(displayId, text, reasoning || undefined);
          } else if (chunk.type === "reasoning-delta") {
            reasoning += chunk.delta;
            upsertAssistant(displayId, text, reasoning);
          } else if (chunk.type === "error") {
            text += `\n\n_Error: ${chunk.errorText}_`;
            upsertAssistant(displayId, text, reasoning || undefined);
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

  // Reload the canonical history from the server, replacing local state so ids
  // stay in sync with the DB. Returns the rows (for the resume check).
  const loadHistory = useCallback(async () => {
    const rows = await trpcClient.conversation.messages.query({ conversationId });
    setMessages(
      rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.text,
        reasoning: r.reasoning ?? undefined,
      })),
    );
    return rows;
  }, [conversationId]);

  // Load history; resume an in-progress generation if the server has one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await loadHistory();
      if (cancelled) return;

      const active = rows.find((r) => r.isActive);
      if (active) {
        assistantIdRef.current = active.id;
        const res = await fetch(
          `/api/chat/stream?messageId=${encodeURIComponent(active.id)}`,
        );
        if (cancelled) return;
        await consume(res, active.id);
        if (!cancelled) await loadHistory();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, consume, loadHistory]);

  const streamTurn = useCallback(
    async (url: string, body: unknown) => {
      const abort = new AbortController();
      abortRef.current = abort;
      const res = await fetch(url, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      await consume(res, crypto.randomUUID());
      await loadHistory();
    },
    [consume, loadHistory],
  );

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = appendText(message).trim();
      if (!text) return;
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", content: text },
      ]);
      await streamTurn("/api/chat", { conversationId, text });
    },
    [conversationId, streamTurn],
  );

  const onEdit = useCallback(
    async (message: AppendMessage) => {
      const sourceId = message.sourceId;
      const text = appendText(message).trim();
      if (!sourceId || !text) return;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === sourceId);
        if (idx === -1) return prev;
        return prev
          .slice(0, idx + 1)
          .map((m, i) => (i === idx ? { ...m, content: text } : m));
      });
      await streamTurn("/api/chat/edit", { messageId: sourceId, text });
    },
    [streamTurn],
  );

  const onReload = useCallback(
    async (parentId: string | null) => {
      if (!parentId) return;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === parentId);
        return idx === -1 ? prev : prev.slice(0, idx + 1);
      });
      await streamTurn("/api/chat/regenerate", { messageId: parentId });
    },
    [streamTurn],
  );

  const onCancel = useCallback(async () => {
    const messageId = assistantIdRef.current;
    // Explicit Stop: tell the server to abort (decoupled from the fetch), then
    // detach our reader.
    if (messageId) {
      await fetch("/api/chat/stop", {
        method: "POST",
        headers: jsonHeaders,
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
    onEdit,
    onReload,
    onCancel,
  });
}

import type {
  AssistantMessage,
  Context as PiContext,
  Message as PiMessage,
} from "@earendil-works/pi-ai";
import { Hono } from "hono";
import { auth } from "../auth";
import { db } from "../db";
import { generationManager } from "./generationManager";

export const chatRoutes = new Hono();

async function requireUserId(req: Request): Promise<string | null> {
  const session = await auth.api.getSession({ headers: req.headers });
  return session?.user?.id ?? null;
}

async function ownsConversation(userId: string, conversationId: string) {
  const row = await db
    .selectFrom("conversation")
    .select("id")
    .where("id", "=", conversationId)
    .where("userId", "=", userId)
    .executeTakeFirst();
  return Boolean(row);
}

/** Reconstruct pi context from persisted messages (DB-canonical, per turn). */
async function buildContext(conversationId: string): Promise<PiContext> {
  const rows = await db
    .selectFrom("message")
    .select(["role", "text", "parts"])
    .where("conversationId", "=", conversationId)
    .where("status", "=", "complete")
    .orderBy("createdAt", "asc")
    .execute();

  const messages: PiMessage[] = [];
  for (const r of rows) {
    if (r.role === "user") {
      messages.push({ role: "user", content: r.text, timestamp: Date.now() });
    } else if (r.parts) {
      // Full pi assistant message was persisted — replay it verbatim.
      messages.push(JSON.parse(r.parts) as AssistantMessage);
    }
  }
  return { messages };
}

const sseHeaders = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

/** Look up a message with its owning user id (for authorization). */
async function getOwnedMessage(userId: string, messageId: string) {
  const row = await db
    .selectFrom("message")
    .innerJoin("conversation", "conversation.id", "message.conversationId")
    .select([
      "message.id",
      "message.conversationId",
      "message.role",
      "message.createdAt",
      "conversation.userId",
    ])
    .where("message.id", "=", messageId)
    .executeTakeFirst();
  return row && row.userId === userId ? row : null;
}

/**
 * Insert a fresh assistant placeholder, kick off a decoupled generation from
 * the current DB-canonical context, and return its SSE stream. Callers mutate
 * the message history first (send/edit/regenerate) so `buildContext` sees the
 * intended state.
 */
async function streamNewAssistantTurn(conversationId: string): Promise<Response> {
  const context = await buildContext(conversationId);
  const assistantMessageId = crypto.randomUUID();
  await db
    .insertInto("message")
    .values({
      id: assistantMessageId,
      conversationId,
      role: "assistant",
      text: "",
      status: "generating",
      createdAt: new Date().toISOString(),
    })
    .execute();

  generationManager.start({ conversationId, messageId: assistantMessageId, context });

  return new Response(generationManager.subscribe(assistantMessageId, 0), {
    headers: { ...sseHeaders, "x-message-id": assistantMessageId },
  });
}

// Send a message: persist user turn, start a decoupled generation, stream it.
chatRoutes.post("/", async (c) => {
  const userId = await requireUserId(c.req.raw);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const { conversationId, text } = (await c.req.json()) as {
    conversationId: string;
    text: string;
  };
  if (!conversationId || !text?.trim()) {
    return c.json({ error: "conversationId and text are required" }, 400);
  }
  if (!(await ownsConversation(userId, conversationId))) {
    return c.json({ error: "conversation not found" }, 404);
  }

  // Explicit ms-resolution timestamps guarantee stable ordering (SQLite's
  // CURRENT_TIMESTAMP is only second-resolution). User precedes assistant.
  await db
    .insertInto("message")
    .values({
      id: crypto.randomUUID(),
      conversationId,
      role: "user",
      text,
      status: "complete",
      createdAt: new Date().toISOString(),
    })
    .execute();

  return streamNewAssistantTurn(conversationId);
});

// Edit a user message: rewrite its text, discard everything after it, and
// regenerate the assistant reply from the amended history.
chatRoutes.post("/edit", async (c) => {
  const userId = await requireUserId(c.req.raw);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const { messageId, text } = (await c.req.json()) as {
    messageId: string;
    text: string;
  };
  if (!messageId || !text?.trim()) {
    return c.json({ error: "messageId and text are required" }, 400);
  }

  const msg = await getOwnedMessage(userId, messageId);
  if (!msg) return c.json({ error: "message not found" }, 404);
  if (msg.role !== "user") {
    return c.json({ error: "only user messages can be edited" }, 400);
  }

  await db
    .deleteFrom("message")
    .where("conversationId", "=", msg.conversationId)
    .where("createdAt", ">", msg.createdAt)
    .execute();
  await db
    .updateTable("message")
    .set({ text })
    .where("id", "=", messageId)
    .execute();

  return streamNewAssistantTurn(msg.conversationId);
});

// Regenerate a reply. `messageId` may be the assistant message to replace
// (discard it and anything after) or its parent user message (assistant-ui's
// onReload passes the parent — discard everything after it). Either way, a
// fresh reply is generated from the resulting history.
chatRoutes.post("/regenerate", async (c) => {
  const userId = await requireUserId(c.req.raw);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const { messageId } = (await c.req.json()) as { messageId: string };
  if (!messageId) return c.json({ error: "messageId required" }, 400);

  const msg = await getOwnedMessage(userId, messageId);
  if (!msg) return c.json({ error: "message not found" }, 404);

  const q = db
    .deleteFrom("message")
    .where("conversationId", "=", msg.conversationId);
  await (msg.role === "assistant"
    ? q.where("createdAt", ">=", msg.createdAt)
    : q.where("createdAt", ">", msg.createdAt)
  ).execute();

  return streamNewAssistantTurn(msg.conversationId);
});

// Resume streaming an in-progress (or just-finished) generation after reconnect.
chatRoutes.get("/stream", async (c) => {
  const userId = await requireUserId(c.req.raw);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const messageId = c.req.query("messageId");
  if (!messageId) return c.json({ error: "messageId required" }, 400);

  const lastEventId = Number(
    c.req.header("last-event-id") ?? c.req.query("lastEventId") ?? 0,
  );

  return new Response(generationManager.subscribe(messageId, lastEventId), {
    headers: sseHeaders,
  });
});

// Explicit user Stop — the only signal that cancels a generation.
chatRoutes.post("/stop", async (c) => {
  const userId = await requireUserId(c.req.raw);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const { messageId } = (await c.req.json()) as { messageId: string };
  const stopped = generationManager.stop(messageId);
  return c.json({ stopped });
});

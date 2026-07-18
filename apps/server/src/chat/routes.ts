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

import type {
  AssistantMessage,
  Context as PiContext,
  Message as PiMessage,
} from "@earendil-works/pi-ai";
import { Hono } from "hono";
import { auth } from "../auth";
import { db, sqlite } from "../db";
import { logger } from "../logger";
import {
  deleteAttachmentFilesForMessages,
  linkAttachments,
  loadAttachmentContentParts,
} from "./attachments";
import { resolveSelection, type GenerationParams } from "./catalog";
import { generationManager } from "./generationManager";
import { toolProvider } from "./tools";

export const chatRoutes = new Hono();

interface AuthenticatedUser {
  id: string;
  isAdmin: boolean;
}

async function requireUser(req: Request): Promise<AuthenticatedUser | null> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return null;
  const user = sqlite.query("SELECT role, isDisabled FROM user WHERE id = ?").get(session.user.id) as
    | { role: string; isDisabled: number }
    | null;
  if (!user || user.isDisabled) return null;
  return { id: session.user.id, isAdmin: user.role === "admin" };
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
async function buildContext(
  conversationId: string,
  systemPrompt?: string | null,
): Promise<PiContext> {
  const rows = await db
    .selectFrom("message")
    .select(["id", "role", "text", "parts"])
    .where("conversationId", "=", conversationId)
    .where("status", "=", "complete")
    .orderBy("createdAt", "asc")
    .execute();

  const messages: PiMessage[] = [];
  for (const r of rows) {
    if (r.role === "user") {
      const attachmentParts = await loadAttachmentContentParts(r.id);
      const content =
        attachmentParts.length === 0
          ? r.text
          : [
              ...(r.text ? [{ type: "text" as const, text: r.text }] : []),
              ...attachmentParts,
            ];
      messages.push({ role: "user", content, timestamp: Date.now() });
    } else if (r.parts) {
      // Full pi assistant message was persisted — replay it verbatim.
      messages.push(JSON.parse(r.parts) as AssistantMessage);
    }
  }
  return systemPrompt ? { systemPrompt, messages } : { messages };
}

const sseHeaders = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

/** Deletes messages matching the predicate, freeing their attachments' on-disk
 * files first (SQLite's ON DELETE CASCADE only removes the DB rows). */
async function deleteMessages(
  conversationId: string,
  createdAt: string,
  op: ">" | ">=",
): Promise<void> {
  const toDelete = await db
    .selectFrom("message")
    .select("id")
    .where("conversationId", "=", conversationId)
    .where("createdAt", op, createdAt)
    .execute();
  await deleteAttachmentFilesForMessages(toDelete.map((m) => m.id));
  await db
    .deleteFrom("message")
    .where("conversationId", "=", conversationId)
    .where("createdAt", op, createdAt)
    .execute();
}

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
async function streamNewAssistantTurn(
  conversationId: string,
  userId: string,
  isAdmin: boolean,
): Promise<Response> {
  // Resolve the model for this turn, then persist it so the conversation
  // remembers the effective selection (defaults are resolved lazily).
  const convo = await db
    .selectFrom("conversation")
    .select([
      "provider",
      "modelId",
      "modelApi",
      "systemPrompt",
      "reasoningEffort",
      "reasoningSummary",
      "verbosity",
    ])
    .where("id", "=", conversationId)
    .executeTakeFirst();
  const selection = await resolveSelection(
    {
      provider: convo?.provider ?? undefined,
      modelId: convo?.modelId ?? undefined,
      api: convo?.modelApi ?? undefined,
    },
    userId,
    isAdmin,
  );
  const context = await buildContext(conversationId, convo?.systemPrompt);
  context.tools = await toolProvider.resolve({ userId, conversationId });
  const prompt = [...context.messages].reverse().find((message) => message.role === "user");
  if (prompt && typeof prompt.content === "string") {
    logger.withMetadata({ conversationId, userId }).trace(prompt.content);
  }
  const params: GenerationParams = {
    systemPrompt: convo?.systemPrompt ?? undefined,
    reasoningEffort: convo?.reasoningEffort ?? undefined,
    reasoningSummary: Boolean(convo?.reasoningSummary),
    verbosity: convo?.verbosity ?? undefined,
  };
  await db
    .updateTable("conversation")
    .set({
      provider: selection.provider,
      modelId: selection.modelId,
      modelApi: selection.api,
    })
    .where("id", "=", conversationId)
    .execute();

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

  generationManager.start({
    conversationId,
    messageId: assistantMessageId,
    context,
    selection,
    params,
  });

  return new Response(generationManager.subscribe(assistantMessageId, 0), {
    headers: { ...sseHeaders, "x-message-id": assistantMessageId },
  });
}

// Send a message: persist user turn, start a decoupled generation, stream it.
chatRoutes.post("/", async (c) => {
  const user = await requireUser(c.req.raw);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const { conversationId, text, attachmentIds } = (await c.req.json()) as {
    conversationId: string;
    text: string;
    attachmentIds?: string[];
  };
  const hasAttachments = Boolean(attachmentIds?.length);
  if (!conversationId || (!text?.trim() && !hasAttachments)) {
    return c.json(
      { error: "conversationId and text or an attachment are required" },
      400,
    );
  }
  if (!(await ownsConversation(user.id, conversationId))) {
    return c.json({ error: "conversation not found" }, 404);
  }

  // Explicit ms-resolution timestamps guarantee stable ordering (SQLite's
  // CURRENT_TIMESTAMP is only second-resolution). User precedes assistant.
  const userMessageId = crypto.randomUUID();
  await db
    .insertInto("message")
    .values({
      id: userMessageId,
      conversationId,
      role: "user",
      text: text ?? "",
      status: "complete",
      createdAt: new Date().toISOString(),
    })
    .execute();
  if (attachmentIds?.length) {
    await linkAttachments(attachmentIds, user.id, userMessageId);
  }

  return streamNewAssistantTurn(conversationId, user.id, user.isAdmin);
});

// Edit a user message: rewrite its text, discard everything after it, and
// regenerate the assistant reply from the amended history.
chatRoutes.post("/edit", async (c) => {
  const user = await requireUser(c.req.raw);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const { messageId, text } = (await c.req.json()) as {
    messageId: string;
    text: string;
  };
  if (!messageId || !text?.trim()) {
    return c.json({ error: "messageId and text are required" }, 400);
  }

  const msg = await getOwnedMessage(user.id, messageId);
  if (!msg) return c.json({ error: "message not found" }, 404);
  if (msg.role !== "user") {
    return c.json({ error: "only user messages can be edited" }, 400);
  }

  await deleteMessages(msg.conversationId, msg.createdAt, ">");
  await db
    .updateTable("message")
    .set({ text })
    .where("id", "=", messageId)
    .execute();

  return streamNewAssistantTurn(msg.conversationId, user.id, user.isAdmin);
});

// Regenerate a reply. `messageId` may be the assistant message to replace
// (discard it and anything after) or its parent user message (assistant-ui's
// onReload passes the parent — discard everything after it). Either way, a
// fresh reply is generated from the resulting history.
chatRoutes.post("/regenerate", async (c) => {
  const user = await requireUser(c.req.raw);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const { messageId } = (await c.req.json()) as { messageId: string };
  if (!messageId) return c.json({ error: "messageId required" }, 400);

  const msg = await getOwnedMessage(user.id, messageId);
  if (!msg) return c.json({ error: "message not found" }, 404);

  await deleteMessages(
    msg.conversationId,
    msg.createdAt,
    msg.role === "assistant" ? ">=" : ">",
  );

  return streamNewAssistantTurn(msg.conversationId, user.id, user.isAdmin);
});

// Resume streaming an in-progress (or just-finished) generation after reconnect.
chatRoutes.get("/stream", async (c) => {
  if (!(await requireUser(c.req.raw))) return c.json({ error: "unauthorized" }, 401);

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
  if (!(await requireUser(c.req.raw))) return c.json({ error: "unauthorized" }, 401);

  const { messageId } = (await c.req.json()) as { messageId: string };
  const stopped = generationManager.stop(messageId);
  return c.json({ stopped });
});

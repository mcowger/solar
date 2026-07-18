import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { db } from "../db";
import { generationManager } from "../chat/generationManager";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

/** Gate: requires an authenticated Better Auth session. */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/** Asserts the conversation exists and belongs to the user; else NOT_FOUND. */
async function assertOwnsConversation(userId: string, conversationId: string) {
  const convo = await db
    .selectFrom("conversation")
    .select("id")
    .where("id", "=", conversationId)
    .where("userId", "=", userId)
    .executeTakeFirst();
  if (!convo) throw new TRPCError({ code: "NOT_FOUND" });
}

const conversationRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const conversations = await db
      .selectFrom("conversation")
      .select(["id", "title", "folderId", "createdAt", "updatedAt"])
      .where("userId", "=", ctx.user.id)
      .orderBy("updatedAt", "desc")
      .execute();

    const tagRows = await db
      .selectFrom("conversation_tag")
      .innerJoin("tag", "tag.id", "conversation_tag.tagId")
      .select(["conversation_tag.conversationId", "tag.id as tagId", "tag.name"])
      .where("tag.userId", "=", ctx.user.id)
      .execute();

    const tagsByConversation = new Map<string, { id: string; name: string }[]>();
    for (const r of tagRows) {
      const list = tagsByConversation.get(r.conversationId) ?? [];
      list.push({ id: r.tagId, name: r.name });
      tagsByConversation.set(r.conversationId, list);
    }

    return conversations.map((c) => ({
      ...c,
      tags: tagsByConversation.get(c.id) ?? [],
    }));
  }),

  create: protectedProcedure
    .input(
      z.object({
        title: z.string().trim().min(1).max(200).optional(),
        folderId: z.string().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const id = crypto.randomUUID();
      await db
        .insertInto("conversation")
        .values({
          id,
          userId: ctx.user.id,
          title: input.title ?? "New conversation",
          folderId: input.folderId ?? null,
        })
        .execute();
      return { id };
    }),

  rename: protectedProcedure
    .input(z.object({ id: z.string(), title: z.string().trim().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      await assertOwnsConversation(ctx.user.id, input.id);
      await db
        .updateTable("conversation")
        .set({ title: input.title })
        .where("id", "=", input.id)
        .execute();
    }),

  remove: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertOwnsConversation(ctx.user.id, input.id);
      await db.deleteFrom("conversation").where("id", "=", input.id).execute();
    }),

  move: protectedProcedure
    .input(z.object({ id: z.string(), folderId: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
      await assertOwnsConversation(ctx.user.id, input.id);
      await db
        .updateTable("conversation")
        .set({ folderId: input.folderId })
        .where("id", "=", input.id)
        .execute();
    }),

  setTags: protectedProcedure
    .input(z.object({ id: z.string(), tagIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      await assertOwnsConversation(ctx.user.id, input.id);
      // Only accept tags the user actually owns.
      const owned = input.tagIds.length
        ? await db
            .selectFrom("tag")
            .select("id")
            .where("userId", "=", ctx.user.id)
            .where("id", "in", input.tagIds)
            .execute()
        : [];
      await db
        .deleteFrom("conversation_tag")
        .where("conversationId", "=", input.id)
        .execute();
      if (owned.length) {
        await db
          .insertInto("conversation_tag")
          .values(owned.map((t) => ({ conversationId: input.id, tagId: t.id })))
          .execute();
      }
    }),

  search: protectedProcedure
    .input(z.object({ query: z.string().trim().min(1) }))
    .query(async ({ ctx, input }) => {
      const like = `%${input.query.replace(/[%_]/g, "\\$&")}%`;
      const rows = await db
        .selectFrom("conversation")
        .leftJoin("message", "message.conversationId", "conversation.id")
        .select(["conversation.id", "conversation.title", "conversation.updatedAt"])
        .where("conversation.userId", "=", ctx.user.id)
        .where((eb) =>
          eb.or([
            eb("conversation.title", "like", like),
            eb("message.text", "like", like),
          ]),
        )
        .groupBy("conversation.id")
        .orderBy("conversation.updatedAt", "desc")
        .execute();
      return rows;
    }),

  messages: protectedProcedure
    .input(z.object({ conversationId: z.string() }))
    .query(async ({ ctx, input }) => {
      await assertOwnsConversation(ctx.user.id, input.conversationId);

      const messages = await db
        .selectFrom("message")
        .select(["id", "role", "text", "status", "createdAt"])
        .where("conversationId", "=", input.conversationId)
        .orderBy("createdAt", "asc")
        .execute();

      return messages.map((m) => ({
        ...m,
        isActive: m.status === "generating" && generationManager.isActive(m.id),
      }));
    }),
});

const folderRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return db
      .selectFrom("folder")
      .select(["id", "name", "createdAt"])
      .where("userId", "=", ctx.user.id)
      .orderBy("name", "asc")
      .execute();
  }),

  create: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const id = crypto.randomUUID();
      await db
        .insertInto("folder")
        .values({ id, userId: ctx.user.id, name: input.name })
        .execute();
      return { id };
    }),

  rename: protectedProcedure
    .input(z.object({ id: z.string(), name: z.string().trim().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      await db
        .updateTable("folder")
        .set({ name: input.name })
        .where("id", "=", input.id)
        .where("userId", "=", ctx.user.id)
        .execute();
    }),

  remove: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .deleteFrom("folder")
        .where("id", "=", input.id)
        .where("userId", "=", ctx.user.id)
        .execute();
    }),
});

const tagRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return db
      .selectFrom("tag")
      .select(["id", "name", "createdAt"])
      .where("userId", "=", ctx.user.id)
      .orderBy("name", "asc")
      .execute();
  }),

  create: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(50) }))
    .mutation(async ({ ctx, input }) => {
      // Reuse an existing tag of the same name (unique per user).
      const existing = await db
        .selectFrom("tag")
        .select("id")
        .where("userId", "=", ctx.user.id)
        .where("name", "=", input.name)
        .executeTakeFirst();
      if (existing) return { id: existing.id };
      const id = crypto.randomUUID();
      await db
        .insertInto("tag")
        .values({ id, userId: ctx.user.id, name: input.name })
        .execute();
      return { id };
    }),

  remove: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .deleteFrom("tag")
        .where("id", "=", input.id)
        .where("userId", "=", ctx.user.id)
        .execute();
    }),
});

export const appRouter = router({
  health: publicProcedure.query(async () => {
    const row = await db
      .selectFrom("app_meta")
      .select("value")
      .where("key", "=", "schema_version")
      .executeTakeFirst();
    return { ok: true, service: "solar-server", schemaVersion: row?.value ?? null };
  }),

  me: publicProcedure.query(({ ctx }) => ({ user: ctx.user })),

  conversation: conversationRouter,
  folder: folderRouter,
  tag: tagRouter,
});

/** Exported for the web app's type-only tRPC client. */
export type AppRouter = typeof appRouter;

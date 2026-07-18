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

const conversationRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return db
      .selectFrom("conversation")
      .select(["id", "title", "createdAt", "updatedAt"])
      .where("userId", "=", ctx.user.id)
      .orderBy("updatedAt", "desc")
      .execute();
  }),

  create: protectedProcedure
    .input(z.object({ title: z.string().trim().min(1).max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const id = crypto.randomUUID();
      await db
        .insertInto("conversation")
        .values({ id, userId: ctx.user.id, title: input.title ?? "New conversation" })
        .execute();
      return { id };
    }),

  messages: protectedProcedure
    .input(z.object({ conversationId: z.string() }))
    .query(async ({ ctx, input }) => {
      const convo = await db
        .selectFrom("conversation")
        .select("id")
        .where("id", "=", input.conversationId)
        .where("userId", "=", ctx.user.id)
        .executeTakeFirst();
      if (!convo) throw new TRPCError({ code: "NOT_FOUND" });

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
});

/** Exported for the web app's type-only tRPC client. */
export type AppRouter = typeof appRouter;

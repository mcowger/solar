import { initTRPC } from "@trpc/server";
import { db } from "../db";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const appRouter = router({
  health: publicProcedure.query(async () => {
    // Touch the DB so the round-trip proves API + Kysely + SQLite together.
    const row = await db
      .selectFrom("app_meta")
      .select("value")
      .where("key", "=", "schema_version")
      .executeTakeFirst();
    return {
      ok: true,
      service: "solar-server",
      schemaVersion: row?.value ?? null,
    };
  }),

  me: publicProcedure.query(({ ctx }) => {
    return { user: ctx.user };
  }),
});

/** Exported for the web app's type-only tRPC client. */
export type AppRouter = typeof appRouter;

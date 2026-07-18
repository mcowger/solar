import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config";
import { auth } from "./auth";
import { db, sqlite } from "./db";
import { migrateAuth } from "./db/migrate-auth";
import { migrateToLatest } from "./db/migrate";
import { seedDevUser } from "./db/seed-dev";
import { chatRoutes } from "./chat/routes";
import { createContext } from "./trpc/context";
import { appRouter } from "./trpc/router";
import index from "@solar/web/index.html";

// Provision the single solar.db: our app migrations + Better Auth's own tables.
await migrateToLatest();
await migrateAuth();
await db
  .insertInto("app_meta")
  .values({ key: "schema_version", value: "1" })
  .onConflict((oc) => oc.column("key").doUpdateSet({ value: "1" }))
  .execute();
await seedDevUser();

const app = new Hono();

// Dev-only permissive CORS: accept any origin. We reflect the request origin
// (rather than a literal "*") so credentialed requests — cookie-based Better
// Auth sessions — keep working. Never enabled in production.
if (process.env.NODE_ENV !== "production") {
  app.use(
    "*",
    cors({
      origin: (origin) => origin ?? "*",
      credentials: true,
    }),
  );
}

app.get("/healthz", (c) => c.json({ ok: true }));

// Better Auth handles all of /api/auth/*.
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Decoupled chat streaming (SSE) — see chat/generationManager.ts.
app.route("/api/chat", chatRoutes);

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    endpoint: "/trpc",
    createContext: (opts, c) => createContext(opts, c),
  }),
);

// Bun's fullstack server bundles and serves the React app (with HMR in dev)
// from the HTML entrypoint. No Vite. More-specific API routes are matched before
// the "/*" HTML catch-all and delegate to Hono.
const server = Bun.serve({
  port: config.port,
  routes: {
    "/trpc/*": (req) => app.fetch(req),
    "/api/auth/*": (req) => app.fetch(req),
    "/api/chat/*": (req) => app.fetch(req),
    "/api/chat": (req) => app.fetch(req),
    "/healthz": (req) => app.fetch(req),
    "/*": index,
  },
  development: process.env.NODE_ENV !== "production" ? { hmr: true } : false,
});

console.log(`solar server listening on ${server.url}`);

// Graceful shutdown (Bun exits immediately on SIGTERM by default, dropping
// in-flight requests). Stop accepting connections, drain, close the DB, exit.
const shutdown = async (signal: string) => {
  console.log(`received ${signal}, shutting down`);
  await server.stop();
  sqlite.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { config } from "./config";
import { auth } from "./auth";
import { db } from "./db";
import { migrateAuth } from "./db/migrate-auth";
import { migrateToLatest } from "./db/migrate";
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

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));

// Better Auth handles all of /api/auth/*.
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

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
    "/healthz": (req) => app.fetch(req),
    "/*": index,
  },
  development: process.env.NODE_ENV !== "production" ? { hmr: true } : false,
});

console.log(`solar server listening on ${server.url}`);

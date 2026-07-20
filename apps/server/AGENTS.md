# Server guidance

See the root `AGENTS.md` for how to start the server, run scripts, and the
mock-LLM rule.

## Entrypoint & routing

- **Server is started with an explicit `Bun.serve(...)` call**, not a
  `export default { fetch, routes }`. A default-export server object did **not**
  keep the process alive here — it started and immediately exited. If you
  refactor the entrypoint, keep the explicit `Bun.serve` call.
- **Route precedence in `Bun.serve`.** More-specific route patterns are matched
  before the `"/*"` HTML catch-all, so API routes (`/trpc/*`, `/api/auth/*`,
  `/healthz`) must be registered as their own routes that delegate to Hono
  (`(req) => app.fetch(req)`). If you rely on Hono's top-level `fetch` with a
  `"/*"` HTML route present, the catch-all swallows the API routes.
- **HTML entrypoint is imported as a module:** the server does
  `import index from "@solar/web/index.html"` and passes it to `Bun.serve`
  `routes`. Bun's `*.html` type declaration comes from `@types/bun`, so no
  `@ts-expect-error` is needed.

## Default dev login

In development (`NODE_ENV !== "production"`) with an empty database, the server
seeds a convenience account (`src/db/seed-dev.ts`):

| Field | Value |
| --- | --- |
| Email | `admin@solar.local` |
| Password | `password` |
| API key | Generated once and printed as `seeded dev API key: <key>` |

Because it is the first account created, it becomes the **admin** (first user
is admin). The API key persists in the development database. The seed never
runs in production and never runs if any user already exists. Delete
`apps/server/solar.db*` only when an intentional reset is required.

## Database & migrations

The server auto-runs both migration owners at boot, so a fresh `solar.db`
needs no manual migrate.

- **Two migration owners, one `solar.db`.** Our Kysely migrations
  (`bun run migrate`) own app tables; Better Auth owns its own tables
  (`bun run migrate:auth`, via `getMigrations` from `better-auth/db/migration`
  — note the subpath, `better-auth/db` does **not** export it). Both run at
  server boot.
- **Shared SQLite connection.** `db/index.ts` creates one `bun:sqlite` Database
  + `BunSqliteDialect`; the *same* dialect is passed to Better Auth
  (`database: { dialect, type: "sqlite" }`) so auth and app tables can be joined.
- **`kysely-codegen` needs `better-sqlite3`.** Its SQLite introspector requires
  `better-sqlite3` even though our runtime uses `bun:sqlite`. It's a
  **dev-only** dependency, never imported at runtime. Run codegen with
  `--dialect sqlite` (not `bun-sqlite`/`kysely-bun-sqlite`, which fail to load
  their introspector). Regenerate against a DB where *both* migration owners
  have run, or auth tables won't appear in `types.generated.ts`. Migrations +
  codegen run against `apps/server/solar.db` (the server's cwd).
- **`solar.db` and its `-wal`/`-shm` sidecars are gitignored.** So is the
  generated `dist/`. `types.generated.ts` *is* committed.
- Set a real `BETTER_AUTH_SECRET` (≥32 chars) in `.env`; the dev fallback logs
  low-entropy warnings.
- **`defaultTo("CURRENT_TIMESTAMP")` stores the literal string** in Kysely. Use
  ``defaultTo(sql`CURRENT_TIMESTAMP`)`` for a real SQL default.
- **SQLite `CURRENT_TIMESTAMP` is second-resolution**, so rows inserted in the
  same second collide and can't be ordered. For anything order-sensitive
  (message sequence), write an explicit ms-resolution ISO timestamp from the app
  at insert time.

## Chat / generation

- **Generation is decoupled from the request** (`chat/generationManager.ts`):
  the pi stream runs on the generation's *own* `AbortController`, never the HTTP
  request signal. A client disconnect only detaches an SSE subscriber; the
  message still completes and persists. Only `POST /api/chat/stop` (explicit
  Stop) aborts.
- **Resume** replays buffered chunks after `Last-Event-ID` then attaches live;
  finished generations stay in memory for `RETENTION_MS` so a reload can still
  replay. Buffers are in-memory/single-node — they don't survive a restart.
- **pi context reconstruction:** assistant history items must be full pi
  `AssistantMessage` objects (role/api/provider/model/usage/stopReason), not
  `{role, content}`. We persist the *entire* pi assistant message JSON in
  `message.parts` and replay it verbatim on later turns; user turns are rebuilt
  from `text`.
- pi-ai reads provider API keys from the environment (e.g. `OPENAI_API_KEY`),
  so the server must run with the root `.env` loaded (see root `AGENTS.md`).

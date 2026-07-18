# Agent Guidelines

Guidance for AI agents and contributors working in this repository. See
`docs/planning/` for product, architecture, and milestone context.

## Current phase: experimentation

We are in an early, exploratory build phase. To keep iteration fast, the
following are **explicitly not desired right now** — do not add them unless
asked:

- **Tests.** No unit/integration/e2e tests while we are experimenting. Do not
  scaffold test runners or write test files.
- **Localization / i18n.** Hard-code user-facing strings in English. No
  translation frameworks, message catalogs, or locale plumbing.
- **Accessibility (a11y).** Do not spend effort on ARIA attributes, a11y audits,
  or related tooling at this stage.

These will be revisited once the architecture stabilizes. Revisit this note
before treating any of them as permanent policy.

## Stack (see `docs/planning/ARCHITECTURE.md`)

- **Bun** runtime, **TypeScript** end-to-end, **Bun workspaces** monorepo.
- Server: **Hono** on `Bun.serve`, **tRPC**, SSE streaming.
- Data: **Kysely** + **SQLite** (`solar.db`), hand-written migrations +
  `kysely-codegen`.
- Auth: **Better Auth** (Kysely adapter).
- Frontend: **React + assistant-ui**, **tRPC + TanStack Query**.

## Build, run & dev workflow

- **Single process for everything.** `bun run dev` (root) runs *only*
  `apps/server` via `bun run --hot`. That one `Bun.serve` process serves the
  API *and* bundles/serves the React app with HMR. There is **no separate web
  dev server and no Vite** — don't add one. `apps/web` has no `dev` script by
  design.
- **Server is started with an explicit `Bun.serve(...)` call**, not a
  `export default { fetch, routes }`. A default-export server object did **not**
  keep the process alive here — it started and immediately exited. If you
  refactor the entrypoint, keep the explicit `Bun.serve` call.
- **Route precedence in `Bun.serve`.** More-specific route patterns are matched
  before the `"/*"` HTML catch-all, so API routes (`/trpc/*`, `/api/auth/*`,
  `/healthz`) must be registered as their own routes that delegate to Hono
  (`(req) => app.fetch(req)`). If you rely on Hono's top-level `fetch` with a
  `"/*"` HTML route present, the catch-all swallows the API routes.
- **Production web build:** `bun run build` → `bun build ./index.html` into
  `apps/server/dist/web`. In dev the HTML is bundled on the fly; `dist/` is
  gitignored.
- **Typecheck:** `bun run typecheck` runs `tsc` per package. Do this before
  committing.

## Imports & workspace gotchas

- **Cross-package deps must be declared.** Bun only symlinks a workspace package
  into another's `node_modules` if it's listed in that package's
  dependencies. `apps/server` depends on `@solar/web` (for the HTML import) and
  `apps/web` depends on `@solar/server` (for the `AppRouter` type). Omitting
  these gives "Cannot find module '@solar/...'" at runtime/typecheck. Re-run
  `bun install` after adding a workspace dep.
- **HTML entrypoint is imported as a module:** the server does
  `import index from "@solar/web/index.html"` and passes it to `Bun.serve`
  `routes`. `@solar/web` exposes it via `exports: { "./index.html": ... }`.
  Bun's `*.html` type declaration comes from `@types/bun`, so no
  `@ts-expect-error` is needed.
- **`AppRouter` type lives in `@solar/server`, not `@solar/shared`.** The web
  app imports it **type-only**. `@solar/shared` holds framework-agnostic domain
  types shared by both sides. (This intentionally differs from an earlier note
  in `ARCHITECTURE.md` that placed the router type in shared — the router's
  natural home is the server package.)
- **Web transitively typechecks server source.** Because web imports a type from
  `@solar/server`, `tsc` loads the server's `.ts` files under the web project.
  So `apps/web/tsconfig.json` must **not** strip ambient types (no
  `"types": []`); it inherits `types: ["bun"]` from the base config so the
  server's `bun:sqlite`/`process` references resolve. Keep `@types/bun`
  installed at the root.

## Database & migrations gotchas

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
  have run, or auth tables won't appear in `types.generated.ts`.
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

## Chat / generation gotchas (M1)

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
- **Frontend uses `useExternalStoreRuntime`, not the data-stream runtime.** We
  own message state (load history via tRPC, stream via `fetch` + our SSE parser,
  Stop via the stop endpoint, resume on load). The data-stream runtime can't
  seed persisted history, which our reload/resume flow needs.
- pi-ai reads provider API keys from the environment (M1: `OPENAI_API_KEY`).
  Run the server with `bun --env-file=../../.env run dev`.

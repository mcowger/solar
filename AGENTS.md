# Agent Guidelines

Guidance for AI agents and contributors working in this repository. See
`docs/planning/` for product, architecture, and milestone context.

## Current phase: experimentation

We are in an early, exploratory build phase. To keep iteration fast, the
following are **explicitly not desired right now** — do not add them unless
asked:

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
- Frontend: **React + assistant-ui**, **tRPC + TanStack Query**, **Tailwind CSS
  4 + DaisyUI 5**.

## Command reference

All commands are run from the **repo root** unless noted. The server auto-runs
both migration owners at boot, so a fresh `solar.db` needs no manual migrate.

### Start the server

**Agents and background use: use the managed dev-server scripts.** They detach
the server into its own session with `setsid`, track it via a pidfile, and log
to a file — no `nohup`/`disown`, no blocked shells, and a clean group-kill on
stop (the server installs a `SIGTERM` graceful-shutdown handler). Never start
the server with raw `... &`/`nohup` from an agent shell.

```bash
bun run dev:start     # start detached (waits ~3s, fails fast with logs)
bun run dev:status    # running / stopped (+ pid)
bun run dev:logs      # last 80 log lines (bun run dev:logs 200 for more)
bun run dev:restart   # stop + start
bun run dev:stop      # SIGTERM the process group, clean up pidfile
```

Pidfile/logfile live at `.dev-server.pid` / `.dev-server.log` (gitignored).

For an interactive foreground run (your own terminal), the server's cwd is
`apps/server`, so Bun won't auto-load the root `.env` — pass it explicitly:

```bash
bun --env-file=.env run --cwd apps/server dev          # from repo root
cd apps/server && bun --env-file=../../.env run dev     # equivalent

# Production-style run (no HMR; same single process).
cd apps/server && NODE_ENV=production bun --env-file=../../.env run start
```

For real deployments prefer a supervisor (systemd `Restart=always` or PM2) —
`bun run` itself does not restart on crash or rotate logs.

Then open the URL printed by the command. `bun run dev:start` selects a stable
worktree-specific port in the 3000–3999 range; set `PASEO_PORT` to override it.
Override the server port directly with `PORT`, or the DB path with
`DATABASE_PATH` (see `apps/server/src/config.ts`).

### Default dev login

In development (`NODE_ENV !== "production"`) with an empty database, the server
seeds a convenience account (`apps/server/src/db/seed-dev.ts`):

| Field | Value |
| --- | --- |
| Email | `admin@solar.local` |
| Password | `password` |

Because it is the first account created, it becomes the **admin** (see the
first-user-admin rule below). The seed never runs in production and never runs
if any user already exists. Delete `apps/server/solar.db*` to reset.

Root convenience script `bun run dev` also starts the server, but it does **not**
load `.env` (so pi-ai has no API key) — prefer the `--env-file` forms above when
you need model calls.

### Root scripts (`package.json`)

| Command | What it does |
| --- | --- |
| `bun run dev:start` / `dev:stop` / `dev:status` / `dev:logs` / `dev:restart` | Managed detached dev server (preferred; see above) |
| `bun run dev` | Foreground server (hot reload) — no `.env`; see above |
| `bun run build` | Production bundle of the web app → `apps/server/dist/web` |
| `bun run migrate` | Run app (Kysely) migrations against `solar.db` |
| `bun run migrate:auth` | Run Better Auth's own migrations |
| `bun run codegen` | Regenerate `src/db/types.generated.ts` from `solar.db` |
| `bun run chat-history -- --help` | Admin CLI for chat inspection and history import/export |
| `bun run sync-staging-history -- --help` | Export staging history and restore it locally |
| `bun run dev:load-history -- --help` | Start the local dev server and import a saved history bundle |
| `bun run typecheck` | `tsc` for server, web, shared, and Playwright tests |
| `bun run test` | Run server and frontend Bun unit tests |
| `bun run test:server` / `test:web` | Run one Bun unit-test suite |
| `bun run test:e2e` | Run Playwright E2E tests in Chromium (default) |
| `bun run test:e2e:all` | Run Playwright E2E tests in Chromium, Firefox, and WebKit |
| `bun run test:e2e:install` | Install all three Playwright browser binaries for the current user |

Migrations + codegen run against `apps/server/solar.db` (the server's cwd). To
capture *all* tables in codegen, run `migrate` **and** `migrate:auth` first.

### Admin chat-history debugging

`bun run chat-history` calls the admin-only tRPC debugging and history APIs on
the running server. When the seeded development login is available, prefer it:
`SOLAR_ADMIN_EMAIL=admin@solar.local SOLAR_ADMIN_PASSWORD=password`. Otherwise,
authenticate with an existing admin session cookie via `SOLAR_SESSION_COOKIE`,
or set `SOLAR_ADMIN_EMAIL` and `SOLAR_ADMIN_PASSWORD` for another admin.
Override the target with `SOLAR_URL` (defaults to `http://localhost:3000`).
Prefer environment variables over credential flags so passwords do not appear
in shell history.

For live staging information, set `SOLAR_URL=https://solar.home.cowger.us` and
`SOLAR_ADMIN_EMAIL=devuser@cowger.us`.   For staging only, you may user the staging (non secret) password: "password".

```bash
# List a user's chat IDs, then inspect the raw database rows for one chat.
bun run chat-history -- list --user <user-id>
bun run chat-history -- inspect --chat <chat-id>

# Download or upload a versioned Solar JSON history bundle.
bun run chat-history -- export --user <user-id> --output history.json
bun run chat-history -- import --user <user-id> --input history.json

bun run chat-history -- --help
```

Imports merge without overwriting and reject ID or tag-name conflicts. History
bundles include attachment metadata but not the underlying attachment files.

To start the local server and restore a saved bundle in one command, run:

```bash
bun run dev:load-history
bun run dev:load-history -- --input history.json
```

It defaults to `.staging-history.json` and imports into `admin@solar.local`.
Use `--user`, `--url`, and the standard `SOLAR_*` authentication variables to
override the destination.

### Staging history sync

With a running local dev server and an empty local chat history, run:

```bash
bun run sync-staging-history
```

This calls the existing staging export and local restore APIs, writes the
gitignored `.staging-history.json` bundle, and restores staging's
`devuser@cowger.us` history into local `admin@solar.local`. Override URLs,
users, and credentials with command options or the `SOLAR_STAGING_*` and
`SOLAR_*` environment variables. Repeat imports require a clean local history
because the restore API rejects conflicts.

## Build, run & dev workflow

- **Single process for everything.** `bun run dev` (root) runs *only*
  `apps/server` via `bun run --hot`. That one `Bun.serve` process serves the
  API *and* bundles/serves the React app with HMR. There is **no separate web
  dev server and no Vite** — don't add one. `apps/web` has no `dev` script by
  design.
- **Tailwind + DaisyUI are compiled by Bun.** Keep
  `apps/server/bunfig.toml` with its `[serve.static]` `bun-plugin-tailwind`
  entry: Bun resolves `bunfig.toml` from the server's cwd, not the workspace
  root. The web HTML imports `src/app.css` directly; do not add a Tailwind CLI
  watcher, generated stylesheet, or a separate frontend dev server. CSS saves
  trigger Bun HMR; `apps/web/src/main.tsx` reloads the page after an update as
  a compatibility fallback for CSS plugin updates.
- **Server is started with an explicit `Bun.serve(...)` call**, not a
  `export default { fetch, routes }`. A default-export server object did **not**
  keep the process alive here — it started and immediately exited. If you
  refactor the entrypoint, keep the explicit `Bun.serve` call.
- **Route precedence in `Bun.serve`.** More-specific route patterns are matched
  before the `"/*"` HTML catch-all, so API routes (`/trpc/*`, `/api/auth/*`,
  `/healthz`) must be registered as their own routes that delegate to Hono
  (`(req) => app.fetch(req)`). If you rely on Hono's top-level `fetch` with a
  `"/*"` HTML route present, the catch-all swallows the API routes.
- **Production web build:** `bun run build` runs `apps/web/build.ts`, which
  passes `bun-plugin-tailwind` to `Bun.build` and writes to
  `apps/server/dist/web`. In dev the HTML is bundled on the fly; `dist/` is
  gitignored.
- **Typecheck:** `bun run typecheck` runs `tsc` per package. Do this before
  committing.


## Confirming Functionality

- **Testing stack.** Frontend unit tests use Bun's test runner, React Testing
  Library, and Happy DOM (`apps/web/bunfig.toml`). Browser E2E tests use
  Playwright (`playwright.config.ts`). `bun run test:e2e` intentionally runs
  Chromium only for the fast default; use `bun run test:e2e:all` when
  cross-browser coverage is needed. The E2E server uses port 3100, resets its
  isolated `.e2e.db`, seeds the development admin, and forces
  `SOLAR_MOCK_LLM=1` automatically.

  On a new Linux machine, install Playwright's host packages once, then install
  browser binaries as the regular user (do not run the second command with
  `sudo`, or the browsers land in root's cache):

  ```bash
  sudo node ./node_modules/@playwright/test/cli.js install-deps chromium firefox webkit
  bun run test:e2e:install
  ```

- **NEVER verify against the live model.** Real provider calls cost money. For
  any UI/flow verification, run with `SOLAR_MOCK_LLM=1`, which swaps in a local
  echo generator (`streamChat`/`mockStream` in `apps/server/src/chat/models.ts`)
  that streams a canned Markdown + code + `$$…$$` LaTeX reply — zero API calls,
  zero cost. Start it with the env var inherited by the managed script:

  ```bash
  SOLAR_MOCK_LLM=1 bun run dev:start
  ```

  Only exercise the real provider when explicitly validating provider wiring.
- **Logging** It is often more efficient to place logging statements and log to console and stdout rather than guessing at code.  Logging costs nothing.   
- **Make extensive use of the agent-browser skill and CLI** - its an effective way to test.  If you cannot initiall find a skill, manually search in .agents/skills/.   DO NOT use agent-browser for general searching.  Agent browser is for local verifications.   
- **Use Search and Web Resources** - rather than guess or infer behaviors of libraries and tools, use their help and your web searching tools to verify.

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

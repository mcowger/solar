# Agent Guidelines

Guidance for AI agents and contributors working in this repository. See
`docs/planning/` for product, architecture, and milestone context.

Domain-specific guidance lives next to the code:

- `apps/server/AGENTS.md` — server entrypoint, database/migrations, chat/generation
- `apps/web/AGENTS.md` — frontend styling, build, runtime, and test notes
- `docs/chat-history.md` — chat-history CLI, staging sync, history import/export

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

## Start the server

**Agents and background use: use the managed dev-server scripts.** They detach
the server into its own session with `setsid`, track it via a pidfile, and log
to a file — no `nohup`/`disown`, no blocked shells, and a clean group-kill on
stop. Never start the server with raw `... &`/`nohup` from an agent shell.

```bash
bun run dev:start     # start detached (waits ~3s, fails fast with logs)
bun run dev:status    # running / stopped (+ pid)
bun run dev:logs      # last 80 log lines (bun run dev:logs 200 for more)
bun run dev:restart   # stop + start
bun run dev:stop      # SIGTERM the process group, clean up pidfile
```

Pidfile/logfile live at `.dev-server.pid` / `.dev-server.log` (gitignored).
`dev:start` selects a stable worktree-specific port in the 3000–3999 range;
see `apps/server/src/config.ts` for `PASEO_PORT`, `PORT`, and `DATABASE_PATH`
overrides.

**`.env` loading:** the server's cwd is `apps/server`, so Bun does not
auto-load the root `.env` (which holds provider API keys). The managed scripts
handle this; for a foreground run pass it explicitly:

```bash
bun --env-file=.env run --cwd apps/server dev
```

In development with an empty database, the server seeds a convenience admin
login: `admin@solar.local` / `password` (details in `apps/server/AGENTS.md`).

**Single process for everything.** The server serves the API *and*
bundles/serves the React app with HMR. There is **no separate web dev server
and no Vite** — don't add one.

## Root scripts (`package.json`)

| Command | What it does |
| --- | --- |
| `bun run dev:start` / `dev:stop` / `dev:status` / `dev:logs` / `dev:restart` | Managed detached dev server (preferred; see above) |
| `bun run build` | Production bundle of the web app → `apps/server/dist/web` |
| `bun run migrate` / `migrate:auth` | App (Kysely) / Better Auth migrations against `solar.db` |
| `bun run codegen` | Regenerate `src/db/types.generated.ts` from `solar.db` |
| `bun run chat-history` / `sync-staging-history` / `dev:load-history` | History tooling — see `docs/chat-history.md` |
| `bun run typecheck` | `tsc` for server, web, shared, and Playwright tests |
| `bun run test` | Run server and frontend Bun unit tests (`test:server` / `test:web` for one) |
| `bun run test:e2e` | Playwright E2E in Chromium (`test:e2e:all` for all three browsers) |

Run `bun run typecheck` before committing.

## Confirming functionality

- **NEVER verify against the live model.** Real provider calls cost money. For
  any UI/flow verification, run with `SOLAR_MOCK_LLM=1`, which swaps in a local
  echo generator (`streamChat`/`mockStream` in `apps/server/src/chat/models.ts`)
  that streams a canned Markdown + code + LaTeX reply — zero API calls, zero
  cost:

  ```bash
  SOLAR_MOCK_LLM=1 bun run dev:start
  ```

  Only exercise the real provider when explicitly validating provider wiring.
- **Testing stack.** Frontend unit tests use Bun's test runner; browser E2E
  tests use Playwright (`playwright.config.ts`). The E2E server uses port 3100,
  resets its isolated `.e2e.db`, seeds the development admin, and forces
  `SOLAR_MOCK_LLM=1` automatically. One-time Playwright machine setup is in the
  README's Development section.
- **Logging.** It is often more efficient to place logging statements and log to
  console and stdout rather than guessing at code. Logging costs nothing.
- **Make extensive use of the agent-browser skill and CLI** — it's an effective
  way to test. If you cannot initially find a skill, manually search in
  `.agents/skills/`. Do NOT use agent-browser for general searching; it is for
  local verifications.
- **Use search and web resources.** Rather than guess or infer behaviors of
  libraries and tools, use their help and your web-search tools to verify.

## Imports & workspace gotchas

- **Cross-package deps must be declared.** Bun only symlinks a workspace package
  into another's `node_modules` if it's listed in that package's dependencies.
  `apps/server` depends on `@solar/web` (HTML import) and `apps/web` depends on
  `@solar/server` (the `AppRouter` type). Omitting these gives "Cannot find
  module '@solar/...'". Re-run `bun install` after adding a workspace dep.
- **`AppRouter` type lives in `@solar/server`, not `@solar/shared`.** The web
  app imports it **type-only**. `@solar/shared` holds framework-agnostic domain
  types shared by both sides.
- **Web transitively typechecks server source.** Because web imports a type from
  `@solar/server`, `tsc` loads the server's `.ts` files under the web project.
  So `apps/web/tsconfig.json` must **not** strip ambient types (no
  `"types": []`); it inherits `types: ["bun"]` from the base config. Keep
  `@types/bun` installed at the root.

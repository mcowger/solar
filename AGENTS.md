# Agent Guidelines

Guidance for AI agents working in this repository.

## Sub-domain Context
- `apps/server/AGENTS.md` — Server entrypoint, Kysely/Better Auth DB, chat generation & streaming.
- `apps/web/AGENTS.md` — Frontend styling, assistant-ui, Bun HMR, web tests.
- `scripts/solar.ts` — History CLI (`solar history`) and development server CLI.
- `scripts/deploy.ts` — Staging and production deployment workflow.

## Current Constraints (Exploratory Phase)
Do **not** add unless explicitly requested:
- **i18n / Localization**: Hard-code user-facing strings in English.
- **Accessibility (a11y)**: Do not spend effort on ARIA attributes, audits, or a11y tooling.

## Stack Overview
- **Monorepo**: Bun workspaces + TypeScript.
- **Backend**: Hono on `Bun.serve`, tRPC, Kysely + SQLite (`solar.db`), Better Auth.
- **Frontend**: React, assistant-ui, tRPC + TanStack Query, Tailwind CSS 4 + DaisyUI 5.
- **Chat persistence**: `pi-coding-agent` owns canonical conversation JSONL under
  `${SOLAR_PI_AGENT_DIR}/sessions/<conversationId>`; SQLite retains Solar-owned
  metadata, configuration, and attachment records.
- **Single Process**: Server serves API and React app with HMR (no separate web dev server or Vite).

## Dev Server & LLM Mocking
- **Mock LLM (Mandatory)**: Always run dev/tests with `SOLAR_MOCK_LLM=1` to avoid live LLM provider costs:
  ```bash
  SOLAR_MOCK_LLM=1 bun run solar dev start
  ```
- **Dev Server CLI**: `bun run solar dev <start|stop|restart|status|logs>`
- **Foreground Run**: `bun --env-file=.env run --cwd apps/server dev`
- **Dev Seed**: On fresh DB, auto-seeds `admin@solar.local` / `password` + Dev API key (printed in startup log).

## Core Scripts
| Command | Action |
| --- | --- |
| `bun run typecheck` | Run `tsc` across all workspaces (required before commit) |
| `bun run test` | Run server and frontend unit tests (`test:server` / `test:web`) |
| `bun run test:server` | Server unit tests (**MUST** use script; bare `bun test` skips `--isolate`) |
| `bun run test:e2e` | Run Playwright E2E tests |
| `bun run build` | Production web bundle → `apps/server/dist/web` |
| `bun run package` | Build the publishable Bun package |
| `bun run migrate` / `migrate:auth` | App (Kysely) / Better Auth DB migrations |
| `bun run codegen` | Regenerate `src/db/types.generated.ts` from `solar.db` |
| `bun run solar history …` | Investigate local or remote server instance |
| `bun run deploy:staging` | Build and deploy the staging target |
| `bun run deploy:production` | Build and deploy the production target |

Canonical conversation history is not contained in SQLite alone. Persist and
back up `${SOLAR_PI_AGENT_DIR}` alongside the database and attachment directory.

## Verification & Tools
- **Confirming functionality**: Stop when the baseline is verified. Use `agent-browser` for local browser verification.
- **Logging**: Use console/stdout logging freely when debugging.

## Workspace Gotchas
- **Cross-package deps**: Must be declared in `package.json`; re-run `bun install` after adding workspace deps.
- **`AppRouter` location**: Imported from `@solar/server` as type-only. Shared domain types belong in `@solar/shared`.
- **Transitive typechecking**: Web transitively typechecks server source; do not remove ambient types from `apps/web/tsconfig.json`.

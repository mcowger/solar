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

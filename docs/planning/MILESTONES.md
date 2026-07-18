# Implementation Milestones

Status: **Draft — agreed plan**  ·  Companion to
[`ARCHITECTURE.md`](./ARCHITECTURE.md), [`PRODUCT_DIRECTION.md`](./PRODUCT_DIRECTION.md),
and [`SPIKES.md`](./SPIKES.md)

This is an **outcome-based** milestone plan. Each milestone is a demonstrable
capability with explicit **exit criteria** — no dates, no time estimates.

**Sequencing philosophy: walking skeleton first.** Milestone 1 builds the
thinnest end-to-end slice that touches every layer (auth → send message →
streamed reply → persisted). Every milestone after that thickens the skeleton
while keeping the app runnable and demoable at all times.

Scope is bounded by `PRODUCT_DIRECTION` (v1 in-scope only; non-goals excluded).

---

## Milestone 0 — Foundations & Validation

**Goal:** a running, empty single-process app and confirmation the risky
integrations hold, before building features on them.

**Includes:**
- Bun workspaces monorepo scaffold (`apps/server`, `apps/web`, `packages/shared`).
- Hono on `Bun.serve` serving a placeholder React (assistant-ui) build.
- Kysely wired to `solar.db` with `kysely-codegen`; first hand-written migration;
  WAL mode.
- Better Auth mounted with its built-in Kysely adapter against `solar.db`.
- tRPC mounted over Hono with one trivial procedure consumed by the web app.
- Resolve **open validation items** from `ARCHITECTURE.md` §13:
  Kysely + `bun:sqlite` + Better Auth Kysely adapter smoke-check.

**Exit criteria:**
- `bun` starts one process serving API + static web.
- A tRPC call round-trips typed data to the React app.
- Better Auth and app tables coexist in one `solar.db`; both migration owners run.
- Validation items pass or their risks are documented and accepted.

---

## Milestone 1 — Walking Skeleton (end-to-end streamed chat) — ✅ Complete

**Goal:** a single authenticated user can send a message and watch a streamed
reply that persists — the thinnest vertical slice through every layer.

**Includes:**
- **Auth (minimum):** local email/password login/logout via Better Auth; a
  protected route; session in the React app.
- **Conversation + message model:** minimal Kysely schema — `conversation`,
  `message` (with `text` + `parts` JSON + usage columns), FK to Better Auth
  `user`.
- **Generation manager:** decoupled, transport-independent generation task
  driving `pi-agent-core`/`pi-ai` for one provider; in-memory buffer keyed by
  message id; persists final message on completion.
- **SSE `/api/chat`:** subscribes to the buffer, emits the UI Message Stream;
  `pi ⇄ assistant-ui` adapter from Spike 1.
- **Frontend chat:** assistant-ui `Thread` on the custom data-stream runtime;
  send + stream + render.

**Exit criteria:**
- Log in, send a message, see tokens stream incrementally into the thread.
- The assistant reply is persisted and reloads correctly.
- **Client disconnect mid-generation still persists** the completed reply.
- Reconnect/reload re-subscribes and shows the in-progress or finished response.
- Explicit **Stop** aborts generation.

---

## Milestone 2 — Conversation Experience (core set) — 🚧 In progress

**Goal:** the chat feels complete for day-to-day use.

**Includes:**
- Multi-turn context reconstruction from DB rows each turn.
- Conversation list, rename, delete; new conversation.
- Message **edit & regenerate**; copy; stop already present.
- Markdown, code highlighting, LaTeX rendering (assistant-ui).
- **Search** across conversations/messages (DB `LIKE`/FTS on `text`).
- **Folders/tags** for organization.
- Resumable-stream polish (reconnect replay via `Last-Event-ID`) verified in UI.

**Exit criteria:**
- All core-set conversation features usable end-to-end.
- Search returns relevant conversations.
- Edit/regenerate produces correct new message rows and history.

---

## Milestone 3 — Multi-Provider & Presets

**Goal:** users choose models and save reusable assistants.

**Includes:**
- Multiple providers via `pi-ai` (OpenAI, Anthropic, Google, Bedrock, Mistral)
  selectable per conversation.
- **Saved presets** (model + system prompt + params): create, edit, use.
- Preset **sharing within the team** (personal vs shared scope).
- **Image input (vision)** for capable models via attachments.
- **File attachments** stored through Mirage (local-disk resource) and passed
  into model context.

**Exit criteria:**
- Switching provider/model mid-app works and streams correctly.
- A saved preset drives a conversation; a shared preset is usable by another user.
- An image attachment is understood by a vision-capable model.

---

## Milestone 4 — Multi-User, Roles & Admin

**Goal:** ready for a team to self-host.

**Includes:**
- **OAuth** provider(s) via Better Auth, in addition to local accounts.
- **Roles:** `admin` and `user`; route/procedure guards.
- **Full admin UI:** manage users, enable/disable models, edit provider/API-key
  config (stored plaintext in DB per decision), view settings.
- **Basic usage/cost tracking:** tokens + estimated cost per message; per
  user/model aggregation via SQL (single-DB join with `user`).

**Exit criteria:**
- OAuth login works alongside local login.
- Admin can manage users, models, and provider keys from the UI.
- Non-admins are correctly restricted.
- Admin can view per-user/per-model usage.

---

## Milestone 5 — Extension Seams & Hardening

**Goal:** lock in the architected-for seams and make it deployable.

**Includes:**
- **MCP boundary:** tool-provider interface resolved per agent turn (returns
  empty toolset); tool-call parts already representable in `parts` JSON. No MCP
  client/config UI.
- **WS-ready subscriber abstraction** confirmed (SSE remains the only transport).
- **Postgres seam** sanity-checked at the Kysely dialect layer (not shipped).
- **Deployment:** single Docker container (SQLite + attachments volume) with
  compose; runnable npm/binary for local installs.
- Baseline error handling, logging, and config via env.

**Exit criteria:**
- Agent turn calls through the tool-provider boundary with an empty toolset,
  proving the seam without shipping tools.
- `docker compose up` yields a working instance with persistent data.
- Local `bun`/npm run works for a single-user install.

---

## Cross-Cutting (throughout, not a separate milestone)

- Type-safety end-to-end (tRPC router + Kysely codegen types in `packages/shared`).
- Tests at the risky boundaries (generation lifecycle, pi⇄assistant-ui adapter,
  auth guards, migrations).
- Keep the app runnable and demoable at every milestone boundary.

## Explicitly Not in This Plan (v1 non-goals)

RAG/vector search · voice (STT/TTS) · image generation · channels/notes/calendar/
automations/memory · LDAP/SCIM/enterprise IdP · model arena/evals · horizontal
scale (Redis/multi-node). See `PRODUCT_DIRECTION` §7.

---

*Outcome-based, walking-skeleton-first plan captured after architecture
agreement. Revisit if scope or architecture decisions change.*

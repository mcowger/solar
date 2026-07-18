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

## Milestone 3 — Multi-Provider & Presets — ✅ Complete

**Goal:** users choose models and save reusable assistants.

**Includes:**
- Multiple providers via `pi-ai` (this slice: **OpenAI, Anthropic, OpenRouter**),
  selectable per conversation, each with a **custom baseURL**.
- **Saved presets** (model + system prompt + capability-gated reasoning params):
  create, edit, use.
- Preset **sharing within the team** (personal vs shared scope).
- **Image input (vision)** for capable models via attachments.
- **File attachments** stored through Mirage (local-disk resource) and passed
  into model context.

**Exit criteria:**
- Switching provider/model mid-app works and streams correctly.
- A saved preset drives a conversation; a shared preset is usable by another user.
- An image attachment is understood by a vision-capable model.

### Locked decisions (grilling session)

**Providers & credentials**
- This slice: **OpenAI, Anthropic, OpenRouter**. Every provider config supports a
  **custom baseURL** (proxies / gateways / OpenAI-compatible endpoints).
- **OpenAI supports both APIs.** Each OpenAI allowlist entry chooses its `api`:
  **`openai-completions`** or **`openai-responses`** (same key/baseURL, different
  transport). The same model id may be enabled under either API. Anthropic uses
  `anthropic-messages`; OpenRouter uses `openai-completions`.
- Credentials are **global, admin-owned**: one `provider_config` per provider —
  `{ apiKey, baseURL, enabledModels[] }` — stored **plaintext in DB** (per §8).
  A **minimal admin-only settings page ships in M3** to edit it (the full admin
  UI remains M4). Providers are constructed from DB config via pi-ai
  `createModels`/`setProvider`.

**Models**
- **Admin-curated allowlist per provider** (seedable from pi-ai's catalog,
  free-form to allow custom-baseURL model ids). Users pick from enabled models.
- Selection is stored **per conversation** (`provider` + `modelId` + `api`) and is
  **switchable at any time**; each turn uses the current selection. Cross-provider
  history replay is safe — pi-ai `transform-messages` sanitizes prior assistant
  turns for the target model (drops provider-specific encrypted reasoning, swaps
  images for placeholders on non-vision models).
- **Default model resolution:** user's personal default → admin default → first
  enabled model. A user sets their personal default via a "make default" action
  in the model picker (per-user setting).

**Presets**
- Fields: `name`, `model` (provider+id+api), `systemPrompt`, plus **capability-
  gated** fields shown only when the selected model/api supports them:
  - **Reasoning Effort** → pi `ThinkingLevel`, gated by `model.reasoning` /
    `thinkingLevelMap`; applied via `streamSimple`.
  - **Reasoning Output** → request a provider **reasoning summary** (OpenAI
    responses / Anthropic thinking) via per-API `onPayload`.
  - **Verbosity** → **`openai-responses` only** (`textVerbosity`), via `onPayload`.
- **Scope/permissions:** anyone creates personal or shared presets; a **shared
  preset is editable/deletable only by its owner or an admin**.
- **Application:** a preset is chosen **only at conversation start**, snapshotting
  model + system prompt + reasoning/verbosity onto the new conversation. After
  start, the **system prompt stays fixed**; model, reasoning effort, and verbosity
  are switchable conversation settings.

**Attachments & vision**
- **Images + plain-text** in v1 (extensible later). **No local extraction, ever**
  — text files are read as UTF-8 into a text part; future binary types will use
  provider-native file passthrough, never local parsing.
- Stored via **Mirage DiskResource** under a configurable data dir. A custom
  assistant-ui **AttachmentAdapter** POSTs to `POST /api/attachments`; an
  `attachment` row FKs the message and **cascade-deletes** with it (disk object
  too). Limits: **~20 MB/file**, a few per message, mime-validated
  (`image/*`, `text/*`).
- **Vision** gated by `model.input.includes("image")`; images sent as image parts.

**Reasoning display**
- Collapsible **"Thinking"** box above the answer — fixed-height **live-tailing**
  while streaming (not infinitely growing), collapsible with a **full-expand**
  option. Reasoning persisted in the message `parts`.

**Cost-free verification**
- Register a **"Mock" provider** in the catalog/allowlist (backed by pi-ai `faux`
  or the existing echo generator) exposing a reasoning model and a vision model,
  gated by `SOLAR_MOCK_LLM`, so model selection, presets, reasoning display, and
  vision all exercise the real code paths at **zero API cost**. **UI verification
  must never hit a live provider.**

### Build order (walking-skeleton-first)

1. **Model-selection backbone** — `provider_config` table + provider construction
   from DB (key/baseURL/api); per-conversation `provider`+`modelId`+`api`; route
   generation off the selection instead of the hard-coded default; register the
   Mock provider. Refactors the current single-model seam (`models.ts`,
   `generationManager`, `SOLAR_MOCK_LLM`).
2. **Admin settings page** (minimal) — configure providers + enabled-model
   allowlists; admin-gated.
3. **Model picker + defaults** — per-conversation switch; user/admin default
   resolution.
4. **Presets** — `preset` table + CRUD + scope/permissions; choose-at-start flow;
   capability-gated reasoning fields; wire `streamSimple`/`onPayload`.
5. **Reasoning display** — live-tailing collapsible Thinking box; persist parts.
6. **Attachments** — Mirage disk, `POST /api/attachments`, AttachmentAdapter,
   `attachment` table + cascade; text→text-part injection.
7. **Vision** — route image parts to vision-capable models.

---

## Milestone 4 — Multi-User, Roles & Admin — ✅ Complete

**Goal:** ready for a team to self-host.

**Includes:**
- **Roles:** `admin` and `user`; route/procedure guards.
- **Full admin UI:** manage users, enable/disable models, edit provider/API-key
  config (stored plaintext in DB per decision), view settings.

**Exit criteria:**
- Admin can manage local accounts, including roles and account access.
- Admin can manage users, models, and provider keys from the UI.
- Non-admins are correctly restricted.

---

## Milestone 5 — Extension Seams & Hardening

**Goal:** lock in the architected-for seams and make it deployable.

**Includes:**
- **MCP boundary:** tool-provider interface resolved per agent turn (returns
  empty toolset); tool-call parts already representable in `parts` JSON. No MCP
  client/config UI.
- **Deployment:** single Docker container (SQLite + attachments volume) with
  compose; published Bun bundle runnable with `bunx @mcowger/solar`.
- Baseline error handling, structured logging, and config via env.

**Exit criteria:**
- Agent turn calls through the tool-provider boundary with an empty toolset,
  proving the seam without shipping tools.
- `docker compose up` yields a working instance with persistent data.
- `bunx @mcowger/solar` runs a local single-user install.

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

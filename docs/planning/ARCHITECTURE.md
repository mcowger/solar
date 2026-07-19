# Architecture

Status: **Draft — agreed architecture**  ·  Companion to
[`PRODUCT_DIRECTION.md`](./PRODUCT_DIRECTION.md) and [`SPIKES.md`](./SPIKES.md)

This document describes the system architecture for the chat application. It
captures the technical decisions reached through a structured grilling session,
grounded in the completed spikes. It defines the shape of the system, not an
implementation plan or milestones.

Design ethos (from `PRODUCT_DIRECTION`): **simplicity, library-first,
single-node by default, architected for extension but not pre-built.**

---

## 1. Topology

A **single Bun process** serves everything:

- the **tRPC API** (all non-streaming operations),
- the **SSE chat stream** endpoint,
- the **built React static assets**.

One container, one deployable, single node. No separate frontend host, no edge
runtime, no meta-framework SSR.

```
┌──────────────────────────── Bun process ────────────────────────────┐
│  Hono (Bun.serve)                                                     │
│   ├── /trpc/*      → tRPC router (auth, conversations, presets, admin)│
│   ├── /api/chat    → SSE UI Message Stream (subscribe to generation)  │
│   ├── /api/auth/*  → Better Auth handler                              │
│   └── /*           → static React (assist­ant-ui) build               │
│                                                                       │
│  Generation manager (in-process)   pi-agent-core / pi-ai             │
│  Kysely  ──────────────────────────►  solar.db (SQLite)             │
│  Mirage  ──────────────────────────►  local disk (attachments)      │
└──────────────────────────────────────────────────────────────────────┘
```

## 2. Stack Summary

| Concern | Choice |
|---|---|
| Runtime | **Bun** |
| Language | **TypeScript** end-to-end |
| HTTP server | **Hono** on `Bun.serve` |
| API layer | **tRPC** (typed, no codegen) |
| Streaming | **SSE / UI Message Stream** (WS-ready via abstracted subscriber) |
| Agent / LLM | **`@earendil-works/pi-agent-core`** + **`@earendil-works/pi-ai`** |
| Frontend chat | **React + assistant-ui** (custom data-stream runtime) |
| Frontend data | **tRPC + TanStack Query** |
| Data layer | **Kysely** (query builder) + `kysely-codegen` |
| Database | **SQLite**, single `solar.db` |
| Auth | **Better Auth** (built-in Kysely adapter) |
| Attachments | **Mirage** (local-disk resource now, S3-compatible later) |
| Repo | **Bun workspaces monorepo** |

## 3. Frontend

- **React + assistant-ui** for the chat surface. assistant-ui provides streaming,
  autoscroll, retries, interruptions, attachments, markdown/code rendering, and
  generative tool-call UI out of the box.
- The chat connects to our Bun backend via assistant-ui's **custom data-stream
  runtime** (`useDataStreamRuntime({ protocol: "ui-message-stream" })`) — no
  Vercel AI SDK dependency. Validated in Spike 1.
- **All non-chat server state** (conversation list, presets, admin, auth state)
  goes through **tRPC + TanStack Query** for typed queries/mutations, caching,
  and invalidation.
- Context management is nearly invisible while idle. When background compaction
  is active, the chat clearly reports that it is summarizing history so the
  added latency is not mistaken for a stalled generation. Summaries are not
  inserted as ordinary chat messages.
- Served as static assets by the same Bun/Hono process.

## 4. API Layer

- **tRPC** over Hono (`@hono/trpc-server`) for auth-gated procedures:
  conversations CRUD, messages, presets, folders/tags, admin (users, model
  enablement, provider config, usage).
- Streaming is deliberately **out-of-band** from tRPC and runs over SSE (see §5).
- The tRPC router type (`AppRouter`) is exported from `apps/server`
  (`@solar/server`) and consumed type-only by the web app for end-to-end type
  safety. `packages/shared` holds framework-agnostic domain types.

## 5. Streaming & Generation Lifecycle

The single most important runtime design, driven by the requirement that an
in-progress response must **complete and persist even if the client disconnects
and never returns**.

**Decoupled generation task.** When a user sends a message, the server starts a
**generation task that is independent of the HTTP request**:

1. The task drives `pi-agent-core` / `pi-ai` for the model call.
2. It writes deltas into an **in-memory buffer** keyed by message id, held by an
   in-process **generation manager** (a registry of active generations).
3. On completion (or error), it **persists the final message to `solar.db`** and
   releases the buffer — regardless of whether any client is attached.

**Transport = SSE (now), WS-ready.** The `/api/chat` endpoint is a **subscriber**
to the generation buffer, emitting the assistant-ui **UI Message Stream**
protocol as Server-Sent Events. A **subscriber abstraction** sits between the
generation manager and the transport so a WebSocket transport can be added later
for multi-device push without touching generation logic.

**Reconnect / resume.** A dropped SSE connection reconnects and replays missed
chunks via `Last-Event-ID` against the still-live in-memory buffer. Reload on
the same node re-subscribes to the same generation.

**Cancellation semantics.** A transport disconnect does **not** cancel
generation. Only an explicit user **Stop** — a separate signal — aborts the task
(passed through as `pi-ai`'s `signal`; per Spike 1).

**Scope note.** Buffers are in-memory and single-node; they do **not** survive a
process restart mid-generation. This is an accepted single-node tradeoff, not a
Redis/multi-node design.

### 5.1 pi ⇄ assistant-ui adapter (Spike 1)

The generation task maps pi events to the UI Message Stream:

```ts
function piEventsToUiMessageStream(
  events: AsyncIterable<AssistantMessageEvent>,
  messageId: string,
): ReadableStream<Uint8Array>;
```

Emitting `start`, `text-delta`, `reasoning-delta`, `tool-call-start`,
`tool-call-delta`, `tool-call-end`, `finish` | `error`, `[DONE]`. No assistant-ui
fork or Vercel AI SDK required.

## 6. Data Layer & Persistence

- **Kysely** is the single data layer for the whole app (supersedes Spike 2's
  MikroORM — see `SPIKES.md`). Rationale: unifies with Better Auth (also Kysely),
  enables real auth⇄app SQL joins in one file, avoids the Bun
  decorator-metadata caveat, and fits the transparent-SQL simplicity ethos.
- **Migrations** are hand-written TypeScript (Kysely schema builder);
  **`kysely-codegen`** regenerates DB types from the schema so query types stay
  in sync. (Trade accepted: "write migration + codegen types" instead of
  "autogenerate + review".)
- **Single `solar.db`** SQLite file holds both Better Auth's tables and app
  tables. WAL mode. Backup = copy one file.
- **Postgres-later seam:** Kysely supports a Postgres dialect; queries are
  written against the Kysely schema, so a future move is a dialect + migration
  concern, not a query rewrite.

### 6.1 Conversation State Model

Canonical conversation state lives in **our DB**, not in pi's internal state
(pi is reconstructed per turn from our records).

- **One row per visible message**, containing:
  - `text` — plain text, for simple DB search (`LIKE`/FTS).
  - `parts` — **pi's native message parts stored as JSON** (text, reasoning,
    tool calls/results, attachment refs) for full fidelity on reload.
  - token/usage columns for basic per-message accounting.
- Intermediate assistant tool-call messages and tool results are persisted as
  ordered, opaque **native generation steps** associated with the visible
  assistant turn. This preserves provider protocol fidelity across turns while
  avoiding a schema that normalizes every pi part type. Raw tool payloads live
  for the lifetime of the conversation and cascade-delete with it.
- We **do not** otherwise normalize part types into separate tables. If richer
  querying becomes necessary, normalization remains an additive change.
- Search, edit/regenerate, folders/tags, and usage tracking all operate on these
  addressable per-message rows.
- **Conversation-level settings (M3):** the conversation row carries its selected
  `provider` + `modelId` + `api` (switchable) plus a snapshot of the applied
  preset's `systemPrompt` and reasoning/verbosity params (fixed after start).
  See §6.3.

### 6.2 Attachments

- **Mirage** provides the storage interface. **Local-disk resource** in v1;
  **S3-compatible resource** later — same application API, no storage-layer
  rewrite (Spike 3).
- v1 accepts **images and plain-text** files (extensible later). **No local
  extraction, ever** — text files are read as UTF-8 into a text part; future
  binary types use provider-native file passthrough, never local parsing.
- Upload path: a custom assistant-ui **AttachmentAdapter** POSTs to
  `POST /api/attachments`; files are written to Mirage under a configurable data
  dir and an `attachment` row FKs the owning message. Attachments (and their disk
  objects) **cascade-delete** with the message/conversation. Limits: **~20 MB per
  file**, a few per message, mime-validated (`image/*`, `text/*`).
- **Vision** is gated by the model catalog (`model.input` includes `"image"`);
  images are sent as image parts. pi-ai swaps images for a placeholder when the
  target model is not vision-capable.

### 6.3 Provider, Model & Preset Configuration (M3)

- **Providers (M3 slice):** OpenAI, Anthropic, OpenRouter. **OpenAI supports
  both APIs** — each allowlist entry selects `openai-completions` or
  `openai-responses` (pi-ai dispatches transport off `model.api`). Anthropic uses
  `anthropic-messages`; OpenRouter uses `openai-completions`.
- **Model allowlist:** admin-curated per provider (seedable from pi-ai's catalog,
  free-form for custom-baseURL model ids). Model selection is stored **per
  conversation** (`provider` + `modelId` + `api`) and is **switchable anytime**;
  cross-provider replay is handled by pi-ai `transform-messages`.
- **Default model:** user's personal default → admin default → first enabled
  model.
- **Presets:** named, owned, `scope ∈ {personal, shared}` (shared editable only
  by owner/admin). Capture model + system prompt + **capability-gated** fields —
  **Reasoning Effort** (`ThinkingLevel` via `streamSimple`), **Reasoning Output**
  (provider reasoning summary via `onPayload`), and **Verbosity**
  (`openai-responses` only, via `onPayload`). A preset is applied **only at
  conversation start** (snapshot); afterward its system prompt stays fixed while
  the model, reasoning effort, and verbosity remain conversation settings.
- **Reasoning** streams as pi `thinking`/reasoning content (our
  `reasoning-delta` UI chunk), rendered in a live-tailing, collapsible "Thinking"
  box and persisted in the message `parts`.
- **Cost-free verification:** a **Mock provider** (pi-ai `faux` / echo) is
  registered in the allowlist under `SOLAR_MOCK_LLM` with reasoning and vision
  models, so all M3 paths verify at zero cost. UI verification never hits a live
  provider.

### 6.4 Context Management

Context capacity is not treated as reliable memory. Models differ in hard
window size, quality at long lengths, prompt-cache behavior, and pricing
thresholds. Solar therefore assembles a bounded working context for each turn
instead of filling the advertised model window or retaining a fixed number of
messages.

#### Policy resolution

Context policy is **admin-owned** and resolves in this order:

1. an override stored with the exact provider/endpoint/API/model configuration,
2. an immutable model-family default,
3. a conservative fallback derived from the declared context window.

The model configuration modal shows the effective context window, supports an
optional context-window override, and can reset the complete policy override to
built-in defaults. The provider save transaction persists model and context
changes together. Each policy defines:

```ts
type ContextPolicy = {
  enabled: boolean;
  softTriggerTokens: number;
  targetTokens: number;
  hardInputTokens: number;
  maxPinnedAttachmentTokens: number;
  outputReserveTokens: number;
};
```

Curated policies use absolute token values because model quality curves and
pricing discontinuities are absolute rather than proportional to advertised
window size. Initial defaults are:

| Model family | Soft trigger | Compact to | Hard input limit | First-turn attachment cap |
|---|---:|---:|---:|---:|
| GPT-5.6 family | ~272K | 180K | 600K | 64K |
| Modern 1M-context Claude | 500K | 300K | 900K | 64K |
| Uncatalogued model | 70% of window | 45% of window | window minus reserves | derived |

The GPT-5.6 trigger is deliberately soft: an occasional request above its 272K
premium-pricing boundary is acceptable, but Solar should not sustain a long
conversation in that band. A model's effective trigger, target, and hard limit
are bounded by its context window minus the requested output reserve and
provider framing. Policies are enabled by default, with a global admin kill
switch and summary prompt in provider settings.

#### Request assembly

The model context is assembled in this order:

1. system/developer instructions and stable tool instructions,
2. the first user request,
3. the current rolling structured summary, if any,
4. the largest suffix of complete recent conversational turns that fits the
   policy target,
5. the current user message and current tool definitions.

The first user's typed text remains verbatim. First-turn attachment contents
remain verbatim up to `maxPinnedAttachmentTokens`; an oversized attachment is
summarized as a whole rather than sliced at an arbitrary byte boundary. A
message count is never used as the budget: turns vary too widely in size.
Tool-call/result sequences are atomic and cannot be split by a cut point.

Between compactions, this arrangement keeps the prefix stable enough to benefit
from provider prompt caching. A compaction intentionally changes the prefix
once, then leaves the replacement summary stable until the next compaction.

#### Staged compaction

When the soft trigger is reached, Solar starts non-blocking background
compaction and applies the least lossy reductions first:

1. omit completed old reasoning traces from future model requests,
2. replace bulky completed tool transactions outside the protected recent tail
   with concise outcomes,
3. summarize older conversational turns only if the context still exceeds the
   target.

Reasoning remains available in persisted history and the UI. Provider-native or
signed reasoning is replayed unchanged while an active tool transaction
requires it, then omitted once that cycle is complete. A tool call and all of
its results are always retained or compacted together.

Conversation summaries are structured working memory with sections for goal,
constraints, decisions, durable facts, progress, unresolved questions,
critical excerpts, and tool outcomes. Repeated compaction is rolling: the
configured **task model** receives the previous summary plus newly evicted
complete turns and rewrites the summary. The chat model is the fallback if the
task model is unavailable, and large source spans are chunked to the task
model's safe working limit. Solar ships a versioned default summary prompt;
admins may override it and reset to the default.

The raw transcript remains authoritative and unchanged. Summary state stores a
retained-message boundary and conversation revision, not audit-oriented source
references. An edit or regeneration that touches summarized history invalidates
the artifact and rebuilds it from the surviving raw transcript. In-flight work
uses the revision to reject stale results. Switching models recomputes the
effective context under the destination model's policy, compacting further or
restoring more raw recent history as appropriate.

#### Failure and overflow behavior

A completed summary is activated atomically. Failed or partial summaries never
replace the last valid context. Background failure retries with bounded backoff
and does not block chat merely because the soft limit was crossed. At the hard
limit, successful synchronous compaction is required before another model call;
the UI offers retry, model switching, or starting a new conversation if it
cannot complete.

A provider context-overflow response permits one compact-and-retry attempt only
when no output has streamed and no tool side effect has occurred. This prevents
automatic recovery from duplicating externally visible actions.

#### pi reuse and extension boundary

Solar pins `@earendil-works/pi-agent-core` to the same exact release as
`@earendil-works/pi-ai` and reuses its public token-estimation, turn-boundary,
cut-point, and summary primitives where compatible. Solar owns policy
resolution, SQLite persistence, request assembly, first-message pinning,
provider-aware reasoning handling, tool compaction, and background job
orchestration. The complete `pi-agent-core` compactor assumes pi's session-tree
model and is not adopted wholesale; `pi-coding-agent` is not added for this
feature.

The first implementation deliberately excludes lexical or semantic retrieval
of old raw turns. The retained canonical transcript leaves retrieval as a later,
independent extension if summary quality measurements justify it.

## 7. Authentication & Identity

- **Better Auth** provides local email/password, sessions, and
  admin/user roles, via its **built-in Kysely adapter** against `solar.db`.
- Better Auth **owns and migrates its own tables** (`user`, `session`, `account`,
  `verification`) through its adapter; our Kysely migrations own the app tables.
  One file, two migration owners — accepted.
- Because everything is in one `solar.db`, app tables use a **managed foreign
  key** to the Better Auth `user` table (e.g. `conversation.userId → user.id`),
  and admin views (users + usage) are a single SQL join.
- **Roles:** two roles — `admin` and `user`. The `role` is a server-assigned
  field on the user (never accepted from client input).
- **First-user bootstrap (deployment):** on a fresh deployment there is **no
  default account and no default password**. The **first user to register**
  through the sign-up form is automatically made the **admin**; every subsequent
  registration is a normal `user`. Operators should register their own admin
  account as the very first action after standing up the server. (In
  development only, an empty DB is seeded with a known admin account for
  convenience — see `AGENTS.md`; this seed never runs in production.)

## 8. Secrets & Configuration

- Runtime config (DB path, port, Better Auth secret) via
  **environment variables**.
- **Provider configuration** is **global and admin-owned**, stored **in
  `solar.db` as plaintext**: one `provider_config` row per provider holding
  `{ apiKey, baseURL, enabledModels[] }`. Keys as plaintext is a deliberate,
  accepted simplicity tradeoff (documented; may be revisited). A **custom
  baseURL** is supported per provider (proxies / gateways / OpenAI-compatible
  endpoints). Providers are constructed from these rows via pi-ai
  `createModels`/`setProvider`. Editing lands as a minimal admin settings page in
  M3 and the full admin UI in M4.

## 9. Admin & Usage

- **Full admin UI** (tRPC procedures): manage users, enable/disable models, edit
  provider/API-key config, edit inherited context policies and the summary
  prompt, select the task model, and view usage.
- **Per-call usage tracking:** every provider call — chat, tool-loop continuation,
  title task, and compaction — records provider/API/model, purpose, input and
  output tokens, cache reads/writes, estimated cost, latency, context-policy
  state, overflow/retry outcome, and compaction tokens before/after. Prompt
  content is not copied into telemetry.
- Conversation/message totals are aggregates over call records rather than the
  final call in a tool loop. This makes model-specific context thresholds and
  cache behavior measurable and tunable from production evidence.

## 10. Extension Seams (architected, not built)

Per `PRODUCT_DIRECTION`, seams exist but are not implemented in v1:

- **MCP tools — boundary only.** A **tool-provider interface** is resolved at the
  start of each agent turn and returns an **empty toolset** in v1. Tool-call
  message parts are already representable in the `parts` JSON. No MCP client and
  no config UI ship yet; both **global (admin)** and **per-user** MCP servers can
  be added behind this boundary later.
- **Cloud/object storage** — via Mirage's S3-compatible resource (§6.2).
- **Postgres** — via Kysely's Postgres dialect (§6).
- **WebSocket transport** — via the subscriber abstraction (§5).

## 11. Repository Structure

**Bun workspaces monorepo:**

```
apps/
  server/   # Hono + tRPC + generation manager + Kysely + pi integration
  web/      # React + assistant-ui + tRPC/TanStack Query client
packages/
  shared/   # framework-agnostic domain types shared by server and web
```

The server serves `web`'s build output for single-process deployment.

## 12. Deployment

- **Single Docker container** (SQLite volume for `solar.db` + attachments dir),
  with compose for the common case.
- Also runnable as a published Bun bundle via **`bunx @mcowger/solar`** for local
  installs.
- Single-node target; horizontal scale is explicitly out of scope for v1.

## 13. Open Validation Items

- **Kysely + `bun:sqlite` + Better Auth Kysely adapter** smoke-check early in the
  build (Spike 2's ORM validation was for MikroORM, now superseded).
- Confirm assistant-ui data-stream runtime attachment + tool-call rendering in
  the browser (Spike 1 verified the stream at the shell level; browser Thread
  rendering and Stop were noted as pending).

---

*Captured via a structured "grilling" session over the product scope and spike
findings. Revisit before defining implementation milestones.*

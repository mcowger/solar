# iOS Client Execution Plan

Status: **Draft — execution plan**  ·  Derived from [`IOS.md`](./IOS.md)  ·
Companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md),
[`MILESTONES.md`](./MILESTONES.md), and [`PRODUCT_DIRECTION.md`](./PRODUCT_DIRECTION.md)

This is the actionable execution plan for the native iOS client scoped in
[`IOS.md`](./IOS.md). It is **outcome-based and walking-skeleton-first**, mirroring
the delivery structure in `MILESTONES.md`. Each phase lists concrete tasks,
touched code paths, dependencies, verification, and exit criteria. It does not
re-argue scope; where this plan and `IOS.md` disagree, `IOS.md` governs intent.

**How to read the tables:** `S` = server/backend work, `C` = native client work,
`X` = cross-cutting (contract, tooling, test). Task IDs are stable references
(e.g. `M1-S3`) usable in commits and issue tracking.

---

## 0. Current-State Findings (grounding)

These were verified against the repository before planning; they refine some
assumptions in `IOS.md`:

| Assumption in `IOS.md` | Verified state in repo | Impact on plan |
|---|---|---|
| Ownership checks missing on `/api/chat/stream` and `/stop` | **Already present** via `getOwnedMessage` (`apps/server/src/chat/routes.ts:523`, `:542`) | Downgrade from "fix" to "add regression tests + two-user isolation coverage" |
| `AppRouter` exported from `apps/server` | Confirmed — router in `apps/server/src/trpc/router.ts`, imported type-only by web | Contract-extraction task (M1-X1) is required as scoped |
| `@solar/shared` exists but thin | Confirmed — only placeholder types (`packages/shared/src/index.ts`) | Expand `@solar/shared` rather than create new package |
| Better Auth `^1.2.0` mounted with Kysely adapter, email/password only | Confirmed (`apps/server/src/auth.ts`) | Validate bearer plugin against 1.2.x (M0-S1) |
| Chat HTTP endpoints exist: `POST /`, `/edit`, `/regenerate`, `GET /stream`, `POST /stop` | Confirmed (`apps/server/src/chat/routes.ts`) | Harden (Zod, bearer, idempotency, status) rather than build |
| `Last-Event-ID` replay | Header + query already parsed (`routes.ts:526`) | Validate replay semantics; add heartbeat |
| `requireUser` uses `auth.api.getSession` (cookie) | Confirmed (`routes.ts:43`) | Must additionally accept `Authorization: Bearer` (M1-S2) |

Any further divergence discovered during a spike updates this table, not the
milestone commitments.

---

## 1. Workstreams

Five parallelizable tracks run across the milestones. Each milestone slices all
relevant tracks to a demonstrable outcome.

1. **Contract** (`X`) — platform-neutral `@solar/shared` boundary: type-only
   router, domain types, chat request schemas, versioned stream-event union,
   attachment/MIME + generation-status types.
2. **Server hardening** (`S`) — bearer auth, Zod validation, ownership tests,
   pagination, idempotency, generation-status contract, heartbeat, download
   metadata.
3. **Native app** (`C`) — Expo custom dev build, navigation, auth, TanStack Query
   layer, chat store + stream transport, screens, rendering, attachments.
4. **Testing** (`X`) — server integration, native unit/component, Detox/E2E, and
   physical-device validation.
5. **Distribution** (`C`) — build profiles, signing, TestFlight, redaction, cache
   lifecycle.

---

## 2. Phased Execution

### Phase 0 — Risk Validation (iOS Milestone 0)

**Goal:** prove every platform-dependent boundary before product surface work.
Output is throwaway spikes + a findings doc, not shippable UI.

| ID | Track | Task | Touches |
|---|---|---|---|
| M0-C1 | C | Scaffold `apps/ios` as an **Expo custom dev build** (not Expo Go); wire into Bun workspace + `tsconfig.base.json` paths; confirm Metro resolves workspace packages | `apps/ios/`, root `package.json`, `tsconfig.base.json` |
| M0-X1 | X | **Metro/Bun packaging spike**: import a *type-only* symbol from `@solar/shared` (and a router type) into `apps/ios` and confirm Metro does not resolve `bun:*`/Hono/db | `packages/shared`, `apps/ios/src/api` |
| M0-S1 | S | **Better Auth bearer spike**: enable/validate the maintained bearer or session-token mechanism in Better Auth `^1.2.0` against existing Kysely sessions; confirm token issuance, inspection, revocation | `apps/server/src/auth.ts` |
| M0-C2 | C | **Authenticated tRPC spike**: minimal tRPC client with absolute base URL + bearer `fetch` adapter hitting an existing procedure | `apps/ios/src/api` |
| M0-C3 | C | **Streaming fetch spike**: authenticated incremental response-body read of `GET /api/chat/stream` on **simulator and physical device**; prove cancellation + `Last-Event-ID` resume | `apps/ios/src/chat` |
| M0-C4 | C | **Multipart upload spike**: native file URI → multipart `file` field → confirm Hono/Bun parses it as a standards `File` (`apps/server/src/chat/attachmentRoutes.ts`) | `apps/ios/src/attachments` |
| M0-C5 | C | **Rich-content spike**: pick + prove a maintained RN Markdown/code renderer (no hidden WebView); render streamed deltas incrementally | `apps/ios/src/components` |
| M0-C6 | C | **Math fallback spike**: recognize inline/display delimiters, render readable selectable monospace with horizontal scroll | `apps/ios/src/components` |
| M0-C7 | C | **Adaptive navigation spike**: stack (iPhone) + split view (iPad) with compact-collapse; confirm state restoration | `apps/ios/src/navigation` |
| M0-X2 | X | Write `SPIKE_IOS_FINDINGS.md` recording outcomes + accepted alternatives for any failure | `docs/planning/` |

**Dependencies:** M0-C2/C3/C4 depend on M0-S1 (bearer). M0-X1 gates all client
imports of shared types.

**Exit criteria (from `IOS.md` §14 M0):**
- All load-bearing transports work with **no WebView**.
- Bearer credential persists in Keychain and reaches tRPC, chat, stream, attachments.
- Stream deltas render incrementally on a **physical device**.
- A native-picked file reaches the existing attachment service.
- Every failed spike has an accepted alternative documented in `SPIKE_IOS_FINDINGS.md`.

---

### Phase 1 — Service Hardening & Walking Skeleton (iOS Milestone 1)

**Goal:** one mobile user signs in, opens a conversation, sends text, and watches
a safe streamed reply reload canonically.

#### 1a. Contract boundary (`X`)

| ID | Task | Touches |
|---|---|---|
| M1-X1 | Establish `@solar/shared` as the platform-neutral contract: re-export **type-only** `AppRouter`; move/define shared domain types, chat request Zod schemas, the versioned **stream-event union**, attachment metadata + MIME capability types, and generation status/error types. Enforce no `bun:*`/Hono/db imports (lint rule or dep-cruiser check) | `packages/shared/src`, `apps/server/src/trpc/router.ts`, `apps/server/src/chat/*` |
| M1-X2 | Add a **stream-event protocol version** constant + typed union shared by server emitter and client parser | `packages/shared/src`, `apps/server/src/chat/generationManager.ts` |

#### 1b. Server hardening (`S`)

| ID | Task | Touches |
|---|---|---|
| M1-S1 | Add **Zod request validation** for `POST /api/chat`, `/edit`, `/regenerate`, `/stop` (replace unchecked JSON casts, e.g. `routes.ts:540`) using shared schemas | `apps/server/src/chat/routes.ts` |
| M1-S2 | Make `requireUser` accept `Authorization: Bearer <token>` in addition to cookie sessions, consistently across tRPC context, chat, stream, attachments; keep disabled-user + revocation checks | `apps/server/src/chat/routes.ts:43`, `apps/server/src/trpc/context.ts`, `apps/server/src/chat/attachmentRoutes.ts` |
| M1-S3 | **Generation status contract**: expose active / completed / stopped / expired-replay / interrupted-after-restart / inaccessible-or-nonexistent, with non-enumerating responses for unauthorized IDs; ensure expired replay is **not** reported as empty success | `apps/server/src/chat/generationManager.ts`, `routes.ts` |
| M1-S4 | Verify + add **two-user isolation** regression tests for existing ownership checks on `/stream` and `/stop` (`getOwnedMessage`) | `apps/server/src/chat/*.test.ts` |
| M1-S5 | Stable, documented **status/error response** shapes for chat endpoints | `apps/server/src/chat/routes.ts` |

#### 1c. Native app (`C`)

| ID | Task | Touches |
|---|---|---|
| M1-C1 | API layer: absolute base-URL config, authenticated `fetch`, tRPC client, TanStack Query provider | `apps/ios/src/api` |
| M1-C2 | Auth: Keychain-backed session store; sign-in/register screens; session restore on launch; sign-out clears Keychain; service-URL selection | `apps/ios/src/auth` |
| M1-C3 | Chat store (reducer): canonical messages, optimistic user message, active assistant id, text/reasoning accumulation, SSE event id, stream connection state, cancellation, recoverable error | `apps/ios/src/chat` |
| M1-C4 | Stream transport: authenticated streaming fetch + SSE parser (split chunks, LF/CRLF, multi-data lines, completion marker, final unterminated frame) exposing event IDs to the store | `apps/ios/src/chat` |
| M1-C5 | Minimal screens: conversation list, single thread, composer with Send/Stop; text send → stream → **canonical reload** | `apps/ios/src/conversations`, `apps/ios/src/chat` |
| M1-C6 | Stop: send authenticated `POST /stop` first, then detach reader (transport cancel ≠ Stop) | `apps/ios/src/chat` |

**Dependencies:** M1-C* depend on M1-X1/X2 and M1-S1/S2/S3.

**Exit criteria (`IOS.md` §14 M1):**
- User signs in and restores session after relaunch.
- Text streams incrementally under `SOLAR_MOCK_LLM=1`.
- Stop aborts only that user's generation.
- A second user cannot inspect or stop the first user's generation (M1-S4 tests).
- Completed history reloads with canonical IDs.

---

### Phase 2 — Native Conversation Experience (iOS Milestone 2)

**Goal:** day-to-day text chat + organization on iPhone and iPad.

#### 2a. Server (`S`)

| ID | Task | Touches |
|---|---|---|
| M2-S1 | **Cursor-based pagination** (or bounded-history contract) for `conversation.messages` incl. parts; document cursor shape in `@solar/shared` | `apps/server/src/trpc/router.ts`, `packages/shared/src` |
| M2-S2 | Stream **heartbeat** comments/events so clients + intermediaries detect dead connections | `apps/server/src/chat/generationManager.ts`, `routes.ts` |
| M2-S3 | Validate `Last-Event-ID` **replay semantics** (apply-after-ID, expired-buffer signaling) end to end | `apps/server/src/chat/generationManager.ts` |

#### 2b. Native (`C`)

| ID | Task | Touches |
|---|---|---|
| M2-C1 | Adaptive navigation: iPhone stack + iPad split view; compact multitasking collapse; coherent column state on select/delete | `apps/ios/src/navigation` |
| M2-C2 | Paginated + virtualized message history consuming M2-S1 | `apps/ios/src/chat` |
| M2-C3 | Conversation CRUD: create, open, rename, move, delete via `conversation.*`; swipe actions + context menus | `apps/ios/src/conversations` |
| M2-C4 | Organization: search, folders (create/rename/delete/move), tags + tag filters, unfiled section via `folder.*`/`tag.*`; native sheets | `apps/ios/src/conversations` |
| M2-C5 | Chat actions: queue follow-ups, edit (tail replace), regenerate (tail replace), copy user/assistant text; canonical reload after each | `apps/ios/src/chat` |
| M2-C6 | Lifecycle: reconnect with bounded backoff + `Last-Event-ID`; background detach (no Stop, no hidden regen); foreground restore→validate session→reload history→inspect status→reconnect or show interrupted/expired | `apps/ios/src/chat` |
| M2-C7 | Drafts + failure states per `IOS.md` §11 table (offline, timeout, expired session, disabled, replay expired, restart, mutation conflict) | `apps/ios/src/chat`, `apps/ios/src/components` |

**Exit criteria (`IOS.md` §14 M2):**
- All included conversation actions work on iPhone and iPad.
- Long histories load incrementally.
- Active response resumes after backgrounding when replay remains available.
- Server restart produces an interrupted state with **no** automatic generation.

---

### Phase 3 — Models, Presets & MCP Controls (iOS Milestone 3)

**Goal:** configure a conversation natively without the web client.

#### 3a. Server (`S`)

| ID | Task | Touches |
|---|---|---|
| M3-S1 | Confirm `model.*`, `preset.*`, and conversation-facing `mcp.*` expose all metadata mobile needs (capability flags, unavailable-model state, ownership/sharing); fill gaps type-first in `@solar/shared` | `apps/server/src/trpc/router.ts`, `apps/server/src/chat/catalog.ts`, `apps/server/src/chat/mcp.ts` |

#### 3b. Native (`C`)

| ID | Task | Touches |
|---|---|---|
| M3-C1 | Model discovery + per-conversation selection + personal default; unavailable-model display | `apps/ios/src/models` |
| M3-C2 | Capability-gated reasoning effort + answer verbosity controls | `apps/ios/src/models` |
| M3-C3 | Presets: list personal/shared, create/edit/delete per server permissions, start-from-preset | `apps/ios/src/presets` |
| M3-C4 | Conversation MCP: list available servers, show/toggle enabled per conversation, automatic-execution control where supported (no server config/credentials) | `apps/ios/src/mcp` |
| M3-C5 | Tool-call rendering cards: preparing/streaming args, awaiting/performing, completion, failure, server/tool names, expandable input/output — tolerant even without MCP management UI | `apps/ios/src/mcp`, `apps/ios/src/components` |

**Exit criteria (`IOS.md` §14 M3):**
- Capability-gated controls match server model metadata.
- Presets honor ownership + sharing rules.
- MCP settings affect subsequent turns.
- Streamed + persisted tool calls render through completion or failure.

---

### Phase 4 — Attachments & Rich Content (iOS Milestone 4)

**Goal:** multimodal chat + assistant content feel complete natively.

#### 4a. Server (`S`)

| ID | Task | Touches |
|---|---|---|
| M4-S1 | **Idempotency key** on upload + chat mutations so a lost response can't create duplicate orphans; cleanup of unsent attachments | `apps/server/src/chat/attachmentRoutes.ts`, `routes.ts` |
| M4-S2 | Download metadata: content-length, filename/content-disposition, safe cache headers (range only if a chosen preview lib requires it) | `apps/server/src/chat/attachmentRoutes.ts` |
| M4-S3 | Enforce/advertise size + MIME limits (20 MB/file) consistently to the client | `apps/server/src/chat/attachments.ts` |

#### 4b. Native (`C`)

| ID | Task | Touches |
|---|---|---|
| M4-C1 | Attachment sources: camera, photo library, document picker; availability gated by selected model vision/document MIME capability | `apps/ios/src/attachments` |
| M4-C2 | Upload: native URI → multipart `file`, filename+MIME, progress/cancel/failure, idempotent retry, removable-before-send | `apps/ios/src/attachments` |
| M4-C3 | Download/preview: bearer-authenticated image render + temp-URI download; document metadata + platform preview/share | `apps/ios/src/attachments` |
| M4-C4 | Rich rendering: Markdown/GFM, tables/task-lists where practical, inline/fenced code with horizontal scroll + native syntax spans, copy actions; scheme-validated link opening | `apps/ios/src/components` |
| M4-C5 | Reasoning panel (collapsible, bounded live-tail, expandable) + distinct context summarization/failure states | `apps/ios/src/components` |
| M4-C6 | Citations: `Sources:` → expandable native cards (title, host, external-link); optional non-blocking favicons | `apps/ios/src/components` |
| M4-C7 | Math fallback: recognize delimiters, preserve source, distinct selectable monospace with horizontal scroll (no WebView) | `apps/ios/src/components` |

**Exit criteria (`IOS.md` §14 M4):**
- Vision/document capability gates match the selected model.
- Supported attachments survive send + history reload.
- Unsupported/oversized files fail clearly before generation.
- Markdown, code, citations, reasoning, math fallback render acceptably at phone
  and tablet widths.
- All validation uses the mock provider.

---

### Phase 5 — Production Hardening & Distribution (iOS Milestone 5)

**Goal:** a release candidate reliable for normal self-hosted use.

| ID | Track | Task | Touches |
|---|---|---|---|
| M5-C1 | C | Bounded retry + timeout policies across reads/mutations (idempotent-only mutation retry) | `apps/ios/src/api` |
| M5-C2 | C | Secure log/crash/analytics redaction: authorization headers, attachment contents, prompts, responses by default | `apps/ios/src` |
| M5-C3 | C | Cache + sign-out cleanup: bounded, removable caches; Keychain-only credentials; discard on sign-out | `apps/ios/src/auth`, `apps/ios/src/api` |
| M5-C4 | C | Build profiles: dev/staging/prod; no production credentials compiled in; TLS required outside explicit local-dev | `apps/ios/` (EAS/app config) |
| M5-C5 | C | Signing + **TestFlight** distribution | `apps/ios/` |
| M5-X1 | X | Native E2E (Detox or equivalent) covering `IOS.md` §13.3 flows; all chat via `SOLAR_MOCK_LLM=1` | `e2e/`, `apps/ios/` |
| M5-X2 | X | Physical-device validation: multipart upload, camera/library permissions, Keychain, streaming fetch, suspension, reconnection | (manual + device lab) |

**Exit criteria (`IOS.md` §14 M5):**
- Required automated suites pass.
- Security-critical ownership + credential tests pass.
- Supported iPhone/iPad layouts pass the device matrix.
- Foreground/background + network-transition scenarios pass on hardware.
- A TestFlight build connects to an explicitly configured Solar deployment.

---

## 3. Testing Strategy (cross-cutting)

Mapped from `IOS.md` §13; land tests alongside the phase that introduces the
behavior, not at the end.

- **Server (§13.1):** mobile sign-in/inspect/expiry/revocation/sign-out (M1);
  bearer across tRPC/chat/SSE/attachments (M1); disabled-user across transports
  (M1); two-user isolation for stream/Stop/messages/MCP/attachments (M1-S4, M3,
  M4); chat Zod validation (M1-S1); pagination (M2-S1); idempotent retries
  (M4-S1); SSE replay/heartbeat/expiry/interrupted status (M2-S2/S3); RN-shaped
  multipart + download metadata (M4).
- **Native unit/component (§13.2):** auth restore/clear; base-URL handling; SSE
  parser across chunk boundaries; chat reducer transitions; optimistic→canonical
  reconciliation; reconnect/Stop/interruption/queue; query invalidation;
  attachment selection/upload failures; model capability gating; MCP toggles;
  Markdown/reasoning/citations/tool-calls/math rendering.
- **Device + E2E (§13.3):** M5-X1/X2.

**Hard rule:** all chat-flow verification uses `SOLAR_MOCK_LLM=1`; automated and
exploratory UI testing must never call a paid provider.

---

## 4. Dependency & Sequencing Graph

```text
M0 (spikes, all boundaries)
  └─▶ M1-X1/X2 (contract) ──▶ M1-S1..S5 (server hardening)
                                   └─▶ M1-C1..C6 (walking skeleton)
                                         └─▶ M2 (nav, pagination, lifecycle, org)
                                               └─▶ M3 (models, presets, MCP)
                                                     └─▶ M4 (attachments, rich content)
                                                           └─▶ M5 (hardening, TestFlight)
```

Critical-path gates:
- **Contract before client** — no `apps/ios` domain code lands before M1-X1 lints
  clean against `bun:*` leakage (M0-X1 proves feasibility).
- **Bearer before transports** — M0-S1/M1-S2 precede any authenticated client call.
- **Pagination before large-thread UI** — M2-S1 precedes M2-C2.
- **Idempotency before retry UX** — M4-S1 precedes M4-C2 retry.

---

## 5. Risk Register (from `IOS.md` §16)

| # | Risk | Mitigation task | Fallback trigger |
|---|---|---|---|
| 1 | Better Auth bearer support | M0-S1 | If maintained mechanism insufficient, design a revocable token table before M1-S2 |
| 2 | Streaming on iOS (incremental/cancel/suspend/replay) | M0-C3, M2-S2/S3 | Change transport lib; never fall back to WebView |
| 3 | Multipart interoperability | M0-C4 | Adjust client encoder to produce a Hono-parseable `File` |
| 4 | Contract packaging (Metro vs Bun-only) | M0-X1, M1-X1 | Split a dedicated `@solar/api-contract` if `@solar/shared` can't stay clean |
| 5 | Large-thread performance | M0-C7, M2-S1/C2 | Tighten page size + virtualization budget |
| 6 | Native rich content without WebView | M0-C5/C6, M4-C4..C7 | Swap renderer; keep math on readable fallback |
| 7 | Adaptive navigation restoration | M0-C7, M2-C1 | Simplify iPad split-state model |
| 8 | Self-hosted connectivity (bad URL/TLS/host/local-dev) | M1-C2 URL selection + §11 failure states | Explicit error UX; never weaken production TLS |

**Governing rule (`IOS.md` §16):** a failed validation item changes the
implementation choice — it never causes a silent fall back to an embedded web
experience.

---

## 6. Explicit Non-Goals (carried from `IOS.md` §15)

Not in this plan: Android; shared web/native presentation layer; embedded web
client/general WebView UI; full admin management; MCP server
create/edit/credentials/test/defaults/delete; full native LaTeX layout; push
notifications; offline send/mutation queues; on-device models; voice/TTS; image
generation; device-side background generation; durable restart-surviving
generation jobs; automatic regeneration after interruption; changes to the
single-node deployment model.

---

*Execution plan derived from the agreed `IOS.md` scope. Revisit when a spike
invalidates a locked assumption (update §0 findings) or when a deferred
capability is promoted into a milestone.*

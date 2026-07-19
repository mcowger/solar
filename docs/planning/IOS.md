# iOS Client Scope

Status: **Draft — agreed scope**  ·  Companion to
[`PRODUCT_DIRECTION.md`](./PRODUCT_DIRECTION.md),
[`ARCHITECTURE.md`](./ARCHITECTURE.md), and
[`MILESTONES.md`](./MILESTONES.md)

This document defines the product and technical scope for a native iOS client
for Solar. It describes the intended experience, platform architecture, server
work, delivery sequence, and explicit non-goals. It does not replace Solar's web
client or change the single-node service architecture.

The iOS app is a **React Native + TypeScript client** of the existing Solar
service. Its interface is implemented locally with native React Native controls;
it does not embed or remotely render the Solar web application. It preserves the
web client's information hierarchy and core behavior while adapting navigation,
input, files, and lifecycle handling to iPhone and iPad.

---

## 1. Goals

The iOS client should provide the same coherent day-to-day chat experience as
the Solar web client:

- authenticate against a self-hosted Solar service;
- browse, organize, search, create, and manage conversations;
- send messages and watch assistant responses stream incrementally;
- stop, edit, regenerate, queue, and copy messages;
- reconnect to an active generation after transient network loss or app
  backgrounding;
- choose models and generation settings;
- use presets;
- attach photos, camera captures, and documents;
- render reasoning, Markdown, code, citations, and MCP tool activity; and
- use a layout designed for both iPhone and iPad.

The service remains authoritative for identity, conversations, messages,
configuration, generations, and attachments. The app may cache data for a fast
native experience, but it does not introduce an independent synchronization
model or an authoritative local database in the first release.

## 2. Guiding Principles

1. **Native experience, shared behavior.** Preserve Solar's concepts and flows,
   but use platform-appropriate navigation and controls rather than reproducing
   browser-specific UI.
2. **One service contract.** The web and iOS clients use the same Solar service
   and authorization rules. Mobile-specific transport support must not fork the
   domain model.
3. **Server-canonical chat.** Optimistic and streamed state is temporary. The
   persisted server history is reloaded after operations that change a thread.
4. **Explicit recovery.** Network loss, expired streams, and server restarts
   produce understandable states and user-directed recovery. The app never
   silently regenerates a model response.
5. **Library-first.** Prefer maintained React Native and Expo libraries for
   navigation, secure storage, file access, and device integration.
6. **Focused first release.** Core chat parity takes priority over mobile admin
   surfaces, push infrastructure, offline mutation queues, and feature breadth.

## 3. Locked Decisions

The following decisions were resolved before defining this scope:

- **Framework:** React Native + TypeScript using an **Expo custom development
  build**, not Expo Go. Native modules and generated iOS projects remain
  available when the app needs capabilities outside Expo's standard modules.
- **Rendering:** all primary UI is local React Native UI. The app does not host
  the Solar web application in a WebView.
- **Devices:** iPhone and iPad are first-release targets. iPhone uses stack-based
  navigation; iPad uses an adaptive split view where space permits.
- **Authentication:** the mobile client uses bearer-based sessions stored in the
  iOS Keychain. The web app retains its cookie-based Better Auth sessions.
- **API:** tRPC remains the transport for non-streaming operations. Chat
  generation and attachment transfer remain purpose-built HTTP APIs.
- **Streaming:** the app consumes Solar's SSE generation stream using an
  authenticated streaming HTTP client and supports `Last-Event-ID` replay.
- **LaTeX:** full native LaTeX rendering is deferred. The first release preserves
  and displays math source readably without using a WebView renderer.
- **MCP:** users can enable or disable available MCP servers/tools for a
  conversation and can control automatic execution where supported. MCP server
  creation, credentials, endpoint configuration, testing, defaults, and deletion
  remain web-only.
- **Push:** response-completion push notifications are deferred.
- **Server restart:** if the Solar server restarts during generation, the
  response is interrupted and shown as an error. The app does not automatically
  regenerate or attempt to continue that exact model call.

## 4. Functional Scope

### 4.1 First-release parity

| Area | Capability | Scope |
|---|---|---|
| Account | Sign in, register, inspect session, sign out | Included |
| Conversations | List, create, open, rename, move, delete | Included |
| Organization | Search, folders, tags, tag filters | Included |
| Chat | History, send, queue, stop, edit, regenerate, copy | Included |
| Streaming | Text, reasoning, title updates, errors, reconnect | Included |
| Models | Select per conversation and set personal default | Included |
| Generation | Reasoning effort and answer verbosity controls | Included |
| Presets | List, create, edit, delete, and start a chat from one | Included |
| Attachments | Camera, photo library, files, previews, removal | Included |
| Rich content | Markdown, GFM, code highlighting, citations | Included |
| Math | Readable source fallback | Included |
| Math | Full native LaTeX layout | Deferred |
| MCP | Conversation enable/disable and automatic-execution controls | Included |
| MCP | Tool-call progress and result rendering | Included |
| MCP | Server configuration and credentials | Deferred |
| Administration | Users, providers, usage, global context policies | Deferred |
| Notifications | Response-completion push | Deferred |
| Offline | Cached reading of recently loaded data | Best effort |
| Offline | Queueing new messages or mutations for later delivery | Deferred |

### 4.2 Authentication experience

The first release supports the local email/password capabilities currently
offered by Solar:

- sign in with email and password;
- register with name, email, and password;
- restore a valid session on app launch;
- handle expiry, revocation, and disabled accounts;
- sign out and remove credentials from the device; and
- select or configure the target Solar service URL for self-hosted deployments.

OAuth, password recovery, enterprise identity, and device/session-management UI
are outside this scope unless those capabilities are first added to the Solar
service independently.

### 4.3 Conversation organization

The app exposes the existing tRPC-backed organization model:

- conversations ordered by recent activity;
- conversation creation, including creation from a preset;
- rename and delete;
- folders, including create, rename, delete, and move conversation;
- tags and tag assignment;
- title/message-text search; and
- tag filtering and an unfiled section.

Platform-appropriate interactions should replace browser menus. Examples include
swipe actions for common row operations, context menus for destructive or less
frequent actions, and native sheets for folder and tag selection.

### 4.4 Chat behavior

The native thread supports:

- canonical persisted history;
- optimistic insertion of a submitted user message;
- incremental assistant text and reasoning;
- queued follow-up messages while a response is running;
- explicit Stop, which aborts the server generation rather than only detaching
  the local stream;
- user-message editing with tail replacement;
- assistant regeneration with tail replacement;
- copying user and assistant text;
- context-management progress and failure states;
- MCP tool-call preparation, execution, completion, and failure states; and
- replacement of optimistic identifiers with canonical server history after a
  turn completes.

The behavior in `apps/web/src/chat/useSolarRuntime.ts` is the initial reference
for state transitions, but the native app owns its own store and UI. It does not
depend on assistant-ui or web React components.

### 4.5 Models, generation controls, and presets

The app supports:

- available-model discovery;
- per-conversation model selection;
- a user-selected default model;
- unavailable-model display when a persisted model is no longer configured;
- capability-gated reasoning effort;
- capability-gated answer verbosity;
- listing personal and shared presets;
- creating, editing, and deleting presets according to server permissions; and
- starting a conversation from a preset snapshot.

Provider credentials, model allowlists, context policies, and other global admin
configuration remain in the web administration interface.

### 4.6 MCP

MCP support deliberately stops at the conversation boundary. The app can:

- list MCP servers made available to the current user;
- show which servers are enabled for the current conversation;
- enable or disable a server for that conversation;
- enable or disable automatic tool execution if the server exposes that option;
- display streamed and persisted tool-call state; and
- display tool errors and textual results.

The app does not create, update, test, delete, or set defaults for MCP server
configurations. Those operations may contain endpoint credentials and remain in
the web configuration surface.

## 5. Native Experience and Layout

### 5.1 iPhone

The iPhone layout uses native stack navigation:

1. The authenticated root shows the conversation list and organization tools.
2. Selecting a conversation pushes a full-screen thread.
3. The thread header exposes conversation and model controls without crowding
   the composer.
4. Model selection, generation settings, presets, tags, folders, and MCP controls
   use sheets or dedicated pushed screens based on complexity.
5. Conversation management uses row swipe actions and context menus.
6. Attachment selection uses a native action sheet with Camera, Photos, and
   Files choices.

The composer remains anchored above the keyboard and accounts for safe areas,
multiline growth, queued messages, attachment chips, and the Send/Stop state.

### 5.2 iPad

The iPad layout uses an adaptive split view:

- the primary column contains search, folders/tags, presets entry points, and the
  conversation list;
- the secondary column contains the selected conversation and composer;
- compact multitasking widths collapse to the iPhone navigation model; and
- selecting or deleting a conversation keeps both columns in a coherent state.

The first release does not reproduce the web sidebar's pointer-driven resize
handle. Native column sizing and adaptive breakpoints determine the layout.

### 5.3 Visual system

The app defines React Native design tokens derived from Solar's existing visual
identity:

- semantic light and dark colors;
- typography roles for wordmark, navigation, body, code, and metadata;
- spacing, corner radius, divider, and elevation tokens;
- message and reasoning treatments; and
- semantic states for running, complete, interrupted, failed, and disabled.

The goal is recognizable Solar continuity, not CSS-level reproduction. DaisyUI,
Tailwind utility classes, browser tooltips, drawers, and resize behavior are not
shared with the native app.

## 6. Client Architecture

### 6.1 Repository placement

The client lives in the existing monorepo as `apps/ios`:

```text
apps/
  ios/
    app/                 # Expo Router or application entry routes
    src/
      api/               # Base URL, authenticated fetch, tRPC client
      auth/              # Session state and Keychain integration
      conversations/     # List, search, folders, tags
      chat/              # Store, stream transport, thread, composer
      attachments/       # Pickers, upload, download, previews
      models/            # Model and generation controls
      presets/           # Preset screens and forms
      mcp/               # Conversation-level MCP controls and rendering
      navigation/        # Adaptive iPhone/iPad navigation
      theme/             # Native Solar tokens
      components/        # Native shared presentation components
```

The exact navigation filesystem depends on the selected Expo navigation layer,
but domain and transport code must not depend on route components.

### 6.2 Shared contracts

The native app must not import Bun server implementation as a runtime dependency.
The current `@solar/server` package exports `AppRouter` directly from
`apps/server/src/trpc/router.ts`; that is tolerable for web typechecking but is
an unsuitable long-term mobile package boundary.

Before substantial client work, introduce a platform-neutral contract boundary.
It should expose:

- the type-only tRPC router contract;
- shared domain types needed by more than one client;
- chat request schemas;
- the versioned stream-event union;
- attachment metadata and MIME capability types; and
- generation status/error types.

This can be an expanded `@solar/shared` package or a dedicated
`@solar/api-contract` package. It must not import `bun:*`, Hono handlers, database
code, provider implementations, or filesystem adapters.

### 6.3 Server-backed state

TanStack Query owns durable query and mutation state:

- session metadata;
- conversations and search results;
- folders and tags;
- messages;
- models and defaults;
- presets; and
- conversation MCP configuration.

The tRPC client uses an absolute service URL and an authenticated fetch adapter.
Query retry behavior may retry safe, idempotent reads after transient failures.
Mutations are not automatically retried unless the operation is idempotent or
uses a server-recognized idempotency key.

### 6.4 Chat state

A dedicated reducer or small store owns transient chat state:

- canonical messages loaded from the service;
- optimistic user messages;
- active assistant message and canonical message ID;
- accumulated text and reasoning;
- tool-call state;
- queue contents;
- current SSE event ID;
- stream connection state;
- active request cancellation; and
- recoverable error state.

After send, edit, regenerate, Stop, or normal stream completion, the client
reloads canonical history. This keeps message IDs and server-side tail mutations
correct for later operations.

### 6.5 Local persistence

The app persists only client-owned or reconnect-oriented state:

- selected Solar service URL;
- bearer credential in Keychain;
- selected conversation ID;
- theme preference;
- current generation/message ID and last processed SSE event ID; and
- an optional bounded cache of recently loaded query data.

Credentials are never stored in AsyncStorage or plaintext files. Cached message
history is not authoritative and can be discarded or replaced by server data.
Offline creation, editing, deletion, and send queues are not part of the first
release.

## 7. Service and API Requirements

### 7.1 Base URL

Unlike the same-origin web client, the native app requires an absolute Solar
service URL. From one configured base URL it derives:

```text
<baseURL>/trpc
<baseURL>/api/auth
<baseURL>/api/chat
<baseURL>/api/attachments
```

Development, staging, and production builds may provide different defaults, but
self-hosted users must be able to select their service. Production credentials
and provider secrets are never compiled into the app.

### 7.2 Mobile authentication

The service must issue and validate bearer-based mobile sessions. Before adding
a custom token system, verify the bearer/session facilities supported by the
installed Better Auth version and prefer its maintained mechanism if it meets
the requirements.

The resulting contract must support:

- email/password sign-in and registration;
- session inspection;
- expiration and revocation;
- sign-out;
- disabled-user enforcement; and
- consistent `Authorization: Bearer <token>` handling across tRPC, chat,
  streaming, and attachments.

The web client's cookie session remains supported. Mobile bearer tokens must be
revocable, must not be logged, and must not grant broader access than an
equivalent browser session.

### 7.3 tRPC

Most durable functionality already maps to the current router:

- `conversation.*`;
- `folder.*`;
- `tag.*`;
- `model.*`;
- `preset.*`; and
- the conversation-facing portion of `mcp.*`.

The mobile client does not call `admin.*` in the first release.

Before release, `conversation.messages` needs cursor-based pagination or an
equivalent bounded-history contract. Loading every message and all associated
parts for an indefinitely large conversation is not acceptable on mobile.

### 7.4 Chat HTTP API

The existing operation split remains:

| Endpoint | Purpose |
|---|---|
| `POST /api/chat` | Persist a user turn and start generation |
| `POST /api/chat/edit` | Replace a user turn and regenerate its tail |
| `POST /api/chat/regenerate` | Regenerate from an existing turn |
| `GET /api/chat/stream` | Subscribe or resume by assistant message ID |
| `POST /api/chat/stop` | Explicitly abort a generation |

Before supporting a mobile client, these endpoints require:

- shared Zod request validation rather than unchecked JSON casts;
- bearer authentication;
- disabled-user checks consistent with tRPC;
- ownership checks before subscribing to or stopping a message;
- stable, documented status and error responses;
- idempotency support for operations that mobile networking may retry; and
- a versioned stream-event contract shared with clients.

The missing ownership checks on stream and Stop are security fixes independent
of the iOS project and must be completed before release.

### 7.5 Generation status

The service must let the client distinguish:

- an active generation;
- a completed generation;
- an explicitly stopped generation;
- an expired in-memory replay buffer;
- an interrupted generation after server restart; and
- an inaccessible or nonexistent message.

Unauthorized resources should appear nonexistent to the caller. Expired replay
state must not be reported as a successful empty completion. The client uses
canonical message history and generation status to decide whether to subscribe,
reload, or offer Regenerate.

## 8. Streaming and App Lifecycle

### 8.1 Stream contract

The native transport uses authenticated streaming HTTP rather than browser
`EventSource`, because it must attach bearer headers. Each stream event carries
or is associated with:

- a protocol version;
- monotonically increasing SSE event ID;
- assistant message ID;
- event type; and
- typed event payload.

The event union covers the current Solar events:

- `start`;
- `text-delta`;
- `reasoning-delta`;
- `tool-call-start`;
- `tool-call-delta`;
- `tool-call-end`;
- `tool-call-result`;
- `finish`;
- `title-update`; and
- `error`.

The parser handles split network chunks, LF and CRLF delimiters, multiple SSE
data lines, completion markers, and a final unterminated frame. It exposes event
IDs to the chat store rather than discarding them.

### 8.2 Reconnect

For a transient disconnect while the app remains active:

1. retain the assistant message ID and last successfully applied event ID;
2. retry with bounded backoff while network connectivity is available;
3. request replay with `Last-Event-ID`;
4. apply only events after the retained ID; and
5. reload canonical history after completion.

The service should emit periodic heartbeat comments or events so the client and
intermediaries can identify dead connections.

### 8.3 Background and foreground

iOS may suspend the process and its network requests at any time. Backgrounding
does not mean Stop:

- detach or allow the stream to close without aborting server generation;
- persist the message ID and last event ID;
- do not promise indefinite background execution; and
- do not schedule hidden regeneration.

On foreground:

1. restore and validate the session;
2. reload canonical conversation history;
3. inspect generation status;
4. reconnect with the saved event ID when the generation remains active;
5. use persisted history if the generation completed while suspended; and
6. show an explicit interrupted or expired state when replay is unavailable.

### 8.4 Stop and interruption

Stop sends the authenticated server request first, then detaches the local
reader. A transport cancellation alone never implies Stop.

If the Solar process restarts during generation, the exact model call is not
resumed. The UI reports that the response was interrupted. The user can choose
Regenerate, but the app never invokes it automatically because regeneration can
cost money, produce different content, or repeat tool side effects.

## 9. Attachments

### 9.1 Sources

The native composer supports:

- camera capture;
- photo library selection; and
- document selection from the iOS file picker and document providers.

Availability remains gated by the selected model's vision and document MIME
capabilities.

### 9.2 Upload

The app uploads a native file URI as multipart form data under the existing
`file` field. The upload layer supplies filename and MIME type, enforces the
server-advertised size and type limits, and reports progress, cancellation, and
failure.

The current server limit is 20 MB per file. Uploads are initially whole-file,
not chunked or resumable. Mobile-safe retry requires an idempotency key so a
lost response cannot create duplicate orphan attachments.

An attachment remains removable before send. Once sent, its lifecycle follows
the associated message and conversation on the server.

### 9.3 Download and preview

Authenticated attachment requests include the bearer token. Images are rendered
from authenticated native requests or downloaded to a temporary local URI;
documents expose metadata and platform-appropriate preview/share actions where
supported.

The server should add appropriate download metadata, including content length,
filename/content disposition, and safe cache behavior. Range support is not
required for the first release unless the selected preview library requires it.

### 9.4 Validation

The attachment boundary requires a physical-device integration test proving
that Expo/React Native multipart output is parsed by Hono/Bun as expected. Tests
also cover ownership, disabled users, unsupported MIME types, size limits,
idempotent retry, and cleanup of unsent attachments.

## 10. Native Message Rendering

### 10.1 Markdown and code

Assistant text is parsed into a React Native render tree supporting:

- paragraphs and inline emphasis;
- headings, lists, blockquotes, and links;
- GFM tables and task-list syntax where practical on a narrow screen;
- inline and fenced code;
- horizontal scrolling for code and wide tables;
- syntax highlighting with native text spans; and
- copy actions for messages and code blocks.

Remote links open through the platform URL handler after validating their
scheme.

### 10.2 Reasoning and context state

Reasoning appears in a collapsible Thinking panel above the answer. While
streaming it live-tails within a bounded region; completed reasoning can be
expanded. Context summarization and failure states remain visually distinct from
assistant prose.

### 10.3 Tool calls

Tool-call cards show:

- preparing/streaming arguments;
- awaiting or performing execution;
- completion;
- failure;
- server and tool names; and
- expandable textual input and output.

The renderer tolerates tool activity even when the app does not expose MCP
server management.

### 10.4 Citations

The current Solar `Sources:` convention maps to native expandable source cards
with title, host, and an external-link action. Remote favicons are optional and
must not block or destabilize source rendering.

### 10.5 Math

The first release recognizes inline and display math delimiters and preserves
the source exactly. Until a native renderer passes the validation spike, math is
shown in a distinct, readable, selectable monospace treatment with horizontal
scrolling for long expressions.

No WebView is introduced solely to run KaTeX or MathJax. Full native formula
layout is deferred work.

## 11. Failure and Recovery Behavior

Failure states should explain what happened and expose only safe recovery
actions:

| Failure | Required behavior |
|---|---|
| Device offline | Preserve draft; retry reads when online; do not queue send |
| Request timeout | Offer retry when safe; avoid duplicate mutation |
| Session expired/revoked | Return to sign-in without exposing cached credentials |
| Account disabled | End the session and explain that access is disabled |
| Stream disconnected | Reconnect with backoff and `Last-Event-ID` |
| Replay buffer expired | Reload canonical history and report unavailable replay |
| Server restarted mid-generation | Mark interrupted; offer explicit Regenerate |
| Generation failed | Preserve persisted partial/error state and offer safe actions |
| Attachment upload failed | Keep draft and permit retry or removal |
| Mutation conflict | Reload canonical server state before another action |

Draft text and selected, still-readable local files should survive ordinary
navigation and recoverable transport failures during the active app session.

## 12. Security and Privacy

The native client and supporting server changes must satisfy these boundaries:

- bearer credentials are stored only in iOS Keychain;
- TLS is required outside explicit local-development configurations;
- provider API keys and global server secrets are never sent to the app;
- logs, crash reports, and analytics redact authorization headers, attachment
  contents, prompts, and model responses by default;
- every conversation, message, generation, MCP, and attachment operation checks
  ownership and current account status;
- mobile tokens expire and can be revoked;
- inaccessible identifiers return non-enumerating responses;
- app configuration contains no production credentials; and
- local caches are bounded and removable on sign-out.

The app does not add client-side encryption or end-to-end encryption in this
scope. Data remains governed by the self-hosted Solar service and normal iOS
device protections.

## 13. Testing and Verification

### 13.1 Server tests

Add automated coverage for:

- mobile sign-in, session inspection, expiry, revocation, and sign-out;
- bearer authentication across tRPC, chat, SSE, and attachments;
- disabled-user behavior across every transport;
- two-user isolation for stream, Stop, messages, MCP state, and attachments;
- Zod validation of chat operations;
- message-history pagination;
- idempotent send and attachment retries;
- SSE replay, heartbeat, expiry, and interrupted-generation status; and
- React Native-shaped multipart upload and authenticated download metadata.

### 13.2 Native unit and component tests

Cover:

- auth state restoration and clearing;
- API base URL handling;
- SSE parsing across arbitrary network chunk boundaries;
- chat reducer transitions;
- optimistic-to-canonical message reconciliation;
- reconnect, Stop, interruption, and queue behavior;
- query invalidation after mutations;
- attachment selection and upload failures;
- model capability gating;
- MCP enable/disable state; and
- Markdown, reasoning, citations, tool calls, and math fallback rendering.

### 13.3 Device and end-to-end tests

Automated native E2E tests cover:

- registration, login, session restoration, and logout;
- creating and organizing conversations;
- mock streamed chat;
- queue, Stop, edit, and regenerate;
- background/foreground resume;
- loss and restoration of connectivity;
- model, preset, generation, and MCP controls;
- camera/photo/file attachments where automation permits; and
- adaptive iPhone and iPad layouts.

Multipart upload, camera/library permissions, Keychain persistence, streaming
fetch, suspension, and reconnection must also be validated on physical iOS
hardware.

All chat-flow verification uses `SOLAR_MOCK_LLM=1`. Automated and exploratory UI
testing must never call a paid model provider.

## 14. Delivery Milestones

The sequence is outcome-based and keeps a demonstrable client at every boundary.

### iOS Milestone 0 — Risk validation

**Goal:** prove the platform-dependent boundaries before building the product
surface.

**Includes:**
- Expo custom development build in the monorepo;
- Better Auth bearer mechanism validation;
- authenticated tRPC request;
- authenticated streaming fetch on simulator and physical hardware;
- native multipart upload to Hono/Bun;
- native Markdown/code rendering proof;
- math fallback proof; and
- adaptive navigation proof on iPhone and iPad.

**Exit criteria:**
- all load-bearing transports work without embedding a WebView;
- bearer credentials persist securely and reach every API transport;
- stream deltas render incrementally on a physical device;
- a native-picked file reaches the existing attachment service; and
- unresolved failures have an accepted alternative before feature work begins.

### iOS Milestone 1 — Service hardening and walking skeleton

**Goal:** one mobile user can authenticate, open a conversation, send a message,
and receive a safe streamed response.

**Includes:**
- platform-neutral contracts;
- bearer auth across service routes;
- stream/Stop ownership fixes;
- validated chat inputs;
- generation status contract;
- minimal auth and conversation screens; and
- text send, stream, Stop, and canonical reload.

**Exit criteria:**
- a user signs in and restores the session after relaunch;
- text streams incrementally from `SOLAR_MOCK_LLM=1`;
- Stop aborts only that user's generation;
- a second user cannot inspect or stop the first user's generation; and
- completed history reloads with canonical IDs.

### iOS Milestone 2 — Native conversation experience

**Goal:** the app supports day-to-day text chat and organization.

**Includes:**
- iPhone navigation and iPad split view;
- paginated message history;
- conversation CRUD;
- search, folders, and tags;
- queue, edit, regenerate, and copy;
- background/foreground reconnection; and
- drafts and failure states.

**Exit criteria:**
- all included conversation actions work on iPhone and iPad;
- long histories load incrementally;
- an active response resumes after app backgrounding when replay remains
  available; and
- a server restart produces an interrupted state without automatic generation.

### iOS Milestone 3 — Models, presets, and MCP controls

**Goal:** native users can configure a conversation without visiting the web
client for ordinary chat choices.

**Includes:**
- model selection and personal default;
- reasoning and verbosity controls;
- preset CRUD and create-from-preset;
- conversation MCP enable/disable;
- automatic-execution control; and
- tool-call rendering.

**Exit criteria:**
- capability-gated controls match server model metadata;
- presets honor ownership and sharing rules;
- MCP settings affect subsequent turns; and
- streamed and persisted tool calls render through completion or failure.

### iOS Milestone 4 — Attachments and rich content

**Goal:** multimodal conversations and assistant content feel complete natively.

**Includes:**
- camera, photos, and files;
- upload progress, retry, removal, and authenticated previews;
- Markdown and GFM;
- code highlighting;
- reasoning panels;
- citations; and
- math fallback.

**Exit criteria:**
- vision and document capability gates match the selected model;
- supported attachments survive send and history reload;
- unsupported or oversized files fail clearly before generation;
- Markdown, code, citations, reasoning, and math fallback render acceptably at
  phone and tablet widths; and
- all validation uses the mock provider.

### iOS Milestone 5 — Production hardening and distribution

**Goal:** a release candidate is reliable enough for normal self-hosted use.

**Includes:**
- bounded retry and timeout policies;
- secure log redaction;
- cache and sign-out cleanup;
- native E2E coverage;
- physical-device lifecycle testing;
- development, staging, and production build configuration; and
- signing and TestFlight distribution.

**Exit criteria:**
- required automated suites pass;
- security-critical ownership and credential tests pass;
- supported iPhone and iPad layouts pass the device matrix;
- foreground/background and network-transition scenarios pass on hardware; and
- a TestFlight build connects successfully to an explicitly configured Solar
  deployment.

## 15. Explicit Non-Goals

The first iOS release does not include:

- Android;
- a shared web/native presentation component layer;
- an embedded Solar web client or general WebView UI;
- full admin management for users, providers, models, usage, or context policy;
- MCP server creation, editing, credentials, testing, defaults, or deletion;
- full native LaTeX formula layout;
- push notifications;
- offline send or mutation queues;
- on-device model execution;
- voice input or text-to-speech;
- image generation;
- background generation performed by the device;
- durable server-side generation jobs that survive a Solar process restart;
- automatic regeneration after interruption; or
- changes to Solar's single-node deployment model.

Android should be treated as a later client project that may reuse
platform-neutral React Native code. It is not a reason to weaken or delay the
first-release iOS experience.

## 16. Validation Items and Known Risks

The following items must be proven early:

1. **Better Auth bearer support.** Confirm the maintained Better Auth mechanism,
   its session lifecycle, and compatibility with the existing Kysely-backed
   sessions before defining custom endpoints or token tables.
2. **Streaming on iOS.** Verify incremental authenticated response-body access,
   cancellation, background suspension, and replay on simulator and physical
   devices.
3. **Multipart interoperability.** Verify Expo/React Native file URI uploads
   become a standards-compatible `File` through Hono's multipart parser.
4. **Contract packaging.** Ensure Metro can consume tRPC types without resolving
   Bun-only server implementation.
5. **Large-thread performance.** Validate pagination, list virtualization,
   streamed updates, code blocks, and attachment previews with representative
   histories.
6. **Native rich content.** Select maintained renderers that support the required
   Markdown/code behavior without a hidden WebView dependency.
7. **Adaptive navigation.** Confirm split-view state restoration and compact
   collapse behavior across iPad multitasking sizes.
8. **Self-hosted connectivity.** Define clear handling for invalid URLs, TLS
   failures, unavailable hosts, and local-development servers without weakening
   production transport security.

Failure of a validation item should change the implementation choice, not cause
the client to silently fall back to an embedded web experience.

---

*This scope records the agreed iOS direction and should be revisited when a
validation spike changes a locked assumption or when deferred capabilities are
promoted into a release milestone.*

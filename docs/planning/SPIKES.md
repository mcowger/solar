# Technical Spikes

Status: **Draft**  ·  Companion to [`PRODUCT_DIRECTION.md`](./PRODUCT_DIRECTION.md)

Before writing architecture or milestones, we validate the load-bearing
assumptions in our stack. Each spike below is a **throwaway, time-boxed
experiment** whose only job is to answer a specific question with a clear
pass/fail. Spike code is **not** production code and should be deleted or
quarantined after we capture the findings.

Guiding rule: **prefer running code over reading docs.** These questions look
answerable on paper but the value is in proving them end-to-end.

Priority order: **Spike 1 → Spike 2** (parallelizable) → then Spike 3 only if 1
surfaces concerns.

---

## Spike 1 — assistant-ui ⇄ pi-agent-core streaming bridge

**Why:** Highest-risk unknown in the whole stack. assistant-ui is designed
around the Vercel AI SDK; we are committed to `pi-agent-core` / `pi-ai`. If the
custom data-stream runtime cannot cleanly consume pi's event stream, it affects
both frontend and backend design.

**Question:** Can a React + assistant-ui frontend render a live chat driven by a
Bun backend using `pi-ai` for model calls, without adopting the Vercel AI SDK?

**Build (minimum):**
- A Bun HTTP server exposing a single chat endpoint.
- Backend calls `pi-ai` (any one provider) and streams tokens.
- Frontend uses `@assistant-ui/react` with the custom data-stream runtime
  (`@assistant-ui/react-data-stream`) or a hand-written custom runtime.
- A single `<Thread />` renders streamed assistant output.

**Must prove (success criteria):**
1. Tokens stream incrementally into the assistant-ui thread (no wait-for-full).
2. The pi event stream maps to assistant-ui message parts without lossy hacks.
3. Stop/interrupt from the UI cancels the in-flight pi generation.
4. A basic multi-turn exchange works (history sent back correctly).
5. We can articulate the shape of the adapter layer between pi events and the
   assistant-ui runtime (rough interface, not final).

**Stretch (nice signal, not required to pass):**
- An **attachment** (image) sent from the composer reaches the model.
- A **tool call** part renders as generative UI (validates future MCP path).
- **Resumability**: a mid-stream reload recovers the in-progress response.

**Fail / escalate if:** the mapping requires forking assistant-ui, adopting the
Vercel AI SDK wholesale, or reimplementing the runtime from scratch. Any of
these changes the frontend recommendation and must be raised before proceeding.

**Output:** a short findings note (works / works-with-caveats / blocked) plus the
sketched adapter interface.

---

## Spike 2 — Persistence stack: Bun + ORM + SQLite

> **Superseded by an architecture decision (see `ARCHITECTURE.md`).** Spike 2
> passed (MikroORM + SQLite runs on Bun), but during architecture grilling we
> chose **Kysely** as the single data layer instead of MikroORM — to unify with
> Better Auth (which uses Kysely), enable real auth⇄app SQL joins in a single
> `solar.db`, avoid the Bun decorator-metadata caveat, and better fit the
> simplicity/library-first ethos. Migrations are hand-written with
> `kysely-codegen` for type sync. The MikroORM finding stands as valid but is no
> longer the chosen path. A quick Kysely + `bun:sqlite` + Better Auth adapter
> smoke-check is tracked as a build-time validation item.

**Why:** SQLite-via-ORM is the backbone of the "simple, single-file" promise. We
need to confirm the ORM runs cleanly on **Bun** (not just Node) and models our
data comfortably.

**Question:** Does MikroORM (or a chosen alternative) run reliably on Bun with
SQLite, and support the swap-to-Postgres-later seam we promised?

**Build (minimum):**
- Bun project with MikroORM + SQLite driver.
- Entities for a representative slice: `User`, `Conversation`, `Message`,
  `Preset`.
- Run migrations; perform CRUD; stream-append messages to a conversation.

**Must prove (success criteria):**
1. MikroORM initializes and runs migrations under the Bun runtime (no
   Node-only native-module blockers).
2. CRUD + relations work for the representative entities.
3. Migration workflow is viable (generate + apply) under Bun.
4. The data layer is abstracted such that switching the driver to Postgres is a
   config/driver change, not an entity rewrite.
5. Message-append performance is acceptable for streaming writes (qualitative).

**Fail / escalate if:** MikroORM has hard Bun incompatibilities. Fallback
candidates to evaluate in that case: Drizzle ORM, Kysely, or Prisma — capture
which and why.

**Output:** go/no-go on MikroORM+Bun, plus the fallback recommendation if no-go.

---

## Spike 3 — Mirage for attachment storage (conditional / exploratory)

**Why:** [Mirage](https://github.com/strukto-ai/mirage) offers a unified virtual
filesystem over local disk, S3-compatible object stores, and other backends.
Its stable resource API avoids a costly application storage-layer migration when
attachments move from local disk to object storage.

**Question:** Does Mirage provide a viable, Bun-compatible attachment-storage
interface that can begin with a filesystem backend and later use an
S3-compatible backend? Application data remains in SQLite via the ORM; this
spike concerns uploaded files only.

**Build (minimum):**
- Stand up Mirage in a Bun context using its RAM filesystem.
- Store, retrieve, and delete one binary attachment through it.
- Confirm the resource API used by the proof is the same API Mirage exposes for
  filesystem and S3-compatible resources.

**Must prove (success criteria):**
1. It runs under Bun with acceptable setup effort.
2. It supports the attachment lifecycle we need (write, read, existence check,
   and delete) through Mirage's resource API.
3. Its API is shared by filesystem and S3-compatible resources, without forcing
   us to introduce an application-specific storage adapter.

**Decision rule:** adopt if the shared resource API removes the need to own and
migrate an application-specific attachment-storage layer. Package weight alone
is not a reason to reject it when the alternative creates a future migration.

**Output:** keep-default vs. adopt-Mirage recommendation with rationale.

---

## Exit Criteria for the Spike Phase

We are ready to write `ARCHITECTURE.md` when:

- Spike 1 is **pass** or **pass-with-known-caveats**, with the pi ⇄ assistant-ui
  adapter shape understood.
- Spike 2 has a **committed ORM choice** that runs on Bun.
- Spike 3 has a **storage decision** (default confirmed or Mirage adopted).

Anything still red blocks architecture and must be escalated as a scope or stack
question.

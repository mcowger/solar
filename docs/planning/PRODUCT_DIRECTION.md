# Product Direction & Scope

Status: **Draft — agreed scope**  ·  Companion to [`COMPETITION.md`](./COMPETITION.md)

This is a high-level *scope* document. It defines what we are building, what we
are deliberately not building, and the foundational choices behind those
decisions. It intentionally contains **no milestones, timelines, or build
steps** — those come later.

---

## 1. Vision

A **deliberately simple, self-hosted web chat application for teams**. Where
LibreChat and Open WebUI compete on breadth (RAG matrices, channels, calendars,
evals, enterprise IdPs), we compete on **simplicity and coherence**: a single
SQLite file, a lean and polished UI, a small number of well-chosen features
that work well out of the box, and a codebase that leans on good libraries
rather than reinventing them.

## 2. Positioning & Differentiator

- **Primary audience:** small-to-mid teams self-hosting their own AI chat.
- **Reason to exist:** *simplicity*. Simple to run (SQLite, single container),
  simple to use (no RAG/feature sprawl), simple to maintain (library-first).
- **We are not** trying to match the full feature surface of the incumbents.
  We pick a focused set and do it cleanly.

## 3. Guiding Principles

1. **Simplicity over breadth.** Every feature must earn its place. Sprawl is the
   thing we are reacting against.
2. **Library-first.** Prefer well-maintained libraries over bespoke code. This
   is core to the simplicity story — less code to own and debug.
3. **Simple defaults, single node.** SQLite + local files; works great on one
   box. Scale-out is a later, optional concern.
4. **Architected for extension, not pre-built.** Where we defer a capability
   (MCP tools, cloud storage), we leave clean seams so it can be added later
   without a rewrite — but we don't build it speculatively.

## 4. Technical Foundation

- **Runtime:** **Bun** (not Node) across the stack.
- **Language:** **TypeScript** end-to-end (backend and frontend).
- **Agent / LLM core:** **`@earendil-works/pi-agent-core`** (agent runtime, tool
  calling, state management, attachments) on top of **`@earendil-works/pi-ai`**
  (unified multi-provider LLM API: OpenAI, Anthropic, Google, AWS Bedrock,
  Mistral). This does much of the heavy lifting and is a hard requirement.
- **Frontend:** **React + assistant-ui** (MIT TS/React chat-UI library) for
  turnkey, production-grade chat UX — streaming, autoscroll, retries,
  interruptions, attachments, markdown/code rendering, generative tool-call UI.
  Bridged to our pi-based backend via assistant-ui's **custom data-stream
  runtime** (integration to validate early).
- **Data layer:** **SQLite** via an ORM (evaluate **MikroORM**) so the store is
  swappable later (e.g. Postgres). Attachments use
  [**Mirage**](https://github.com/strukto-ai/mirage): begin with its local-disk
  resource and switch to an S3-compatible resource without changing the
  application storage API.
- **Deployment:** a **single Docker container** (SQLite volume, compose for the
  common case) **plus an npm/binary** for local installs. Single-node target.

## 5. In Scope (v1)

**Model access**
- Multi-provider chat via pi-ai (OpenAI, Anthropic, Google, Bedrock, Mistral).

**Conversation experience (core set)**
- Streaming responses; markdown, code highlighting, LaTeX.
- Edit & regenerate; stop; copy.
- Conversation search; rename/delete; folders/tags.
- **Persisted + resumable responses** — an in-progress response is persisted so
  it survives page reload / reconnect on the same node.

**Multimodal**
- **Image input (vision)** for models that support it.
- **File attachments** passed into model context — **no RAG, no embeddings**.

**Assistants**
- **Saved presets**: named configs (model + system prompt + params), personal
  and shareable within the team.

**Multi-user & access**
- Auth: **local email/password + OAuth** (e.g. Google/GitHub).
- Roles: **admin + user** (two roles).

**Administration**
- **Full admin UI**: manage users, enable models, edit provider/API-key config
  and other settings live in-app.
- **Basic usage/cost tracking**: tokens and estimated cost per message / user /
  model, surfaced in the admin panel.

## 6. Architected-For (not built in v1)

Design clean seams now; implement later:

- **MCP tools** — support planned for both **global (admin-configured)** and
  **per-user** MCP servers. No tools ship in v1, but the agent/data model and
  config surface must not preclude them.
- **Cloud / object storage** for attachments (S3-compatible), beyond local disk.
- **Alternative database** (e.g. Postgres) via the ORM abstraction.

## 7. Explicit Non-Goals (v1)

We deliberately **do not** build:

- **RAG / vector search** — no embeddings, no vector databases (attachments only).
- **Voice** — no speech-to-text or text-to-speech.
- **Image generation** — vision input only, no text-to-image.
- **Team-collaboration surfaces** — no channels, notes, calendar, automations,
  or persistent cross-conversation memory.
- **Enterprise identity** — no LDAP / SCIM / SSO-only provisioning.
- **Model arena / evaluations** — no A/B testing, ELO leaderboards, or eval
  tooling.

## 8. Open Questions / To Validate

- assistant-ui ⇄ pi-agent-core bridge via the custom data-stream runtime
  (confirm streaming, attachments, tool-call rendering, and resumability map
  cleanly).
- MikroORM + Bun + SQLite compatibility; suitability of Turso agentfs.
- Exact React app shell (plain Vite vs. a light meta-framework) — deferred, not
  blocking scope.

---

*This document captures agreed scope reached via a structured "grilling"
session. It should be revisited before planning milestones or implementation.*

# Competitive Landscape: Self-Hosted Web Chat Applications

This document surveys the two leading open-source, self-hosted AI chat
platforms — **LibreChat** and **Open WebUI** — to understand the current
landscape before we design our own application. The focus is on *capabilities*
(what problems they solve for users), not on each project's specific naming
conventions. Where the two projects use different words for the same underlying
idea (e.g. "functions"/"plugins"/"tools"), we treat them as one concept.

---

## 1. Executive Summary

Both projects are mature, actively developed, self-hostable, multi-user chat
front-ends that sit in front of many LLM providers. They have converged on a
very similar feature surface: multi-provider model access, RAG over user
documents, web search, tool/plugin extensibility, image generation, voice I/O,
agents, and enterprise auth. They differ mainly in **technology stack**,
**extensibility philosophy**, and **breadth vs. depth** of certain features.

| Dimension | LibreChat | Open WebUI |
|---|---|---|
| Backend | Node.js / Express, MongoDB, Meilisearch, LangChain | Python / FastAPI, SQLite or Postgres, built-in vector DBs |
| Frontend | React 18 + Vite + Recoil + TanStack Query | Svelte 5 / SvelteKit |
| Primary positioning | "All-in-one" multi-provider ChatGPT-like UI | "Extensible AI platform that runs fully offline" |
| Local model story | Via OpenAI-compatible endpoints (Ollama etc.) | First-class Ollama integration + built-in inference |
| Extensibility model | MCP servers, agents, actions, skills | Plugins (filters/actions/pipes/tools), MCP/OpenAPI, skills |
| License | MIT | Open WebUI License (BSD-based, with branding clause) |

Both are strong. The takeaway for us: the "table stakes" bar is high, and
differentiation will come from **focus, UX quality, and a coherent
extensibility story** rather than from inventing net-new categories.

---

## 2. LibreChat

**Repo:** github.com/danny-avila/LibreChat · **License:** MIT
**Stack:** Express 5 + Mongoose/MongoDB, Meilisearch for search, LangChain for
agents/tools; React 18 client (Vite, Recoil, TanStack Query, i18n). Monorepo
with `api`, `client`, and shared `packages` (api, client, data-provider,
data-schemas).

### Capabilities

- **Multi-provider model access.** Anthropic, OpenAI, Azure OpenAI, Google,
  Vertex AI, AWS Bedrock, plus the OpenAI Responses API. Any OpenAI-compatible
  API works as a "custom endpoint" with no proxy (Ollama, Mistral, Groq,
  Cohere, OpenRouter, Perplexity, Deepseek, Qwen, etc.).
- **Agents & tools.** No-code custom assistants with tools, file search, and
  code execution; an agent marketplace for community-built agents; sharing with
  specific users/groups; subagents (isolated child runs with their own
  context); reusable instruction bundles ("skills"). Full **MCP** support.
- **Code interpreter.** Sandboxed multi-language execution (Python, Node,
  Go, C/C++, Java, PHP, Rust, Fortran) with file upload/download.
- **Generative UI / artifacts.** In-chat rendering of React, HTML, and Mermaid
  diagrams.
- **Web search.** Pluggable search providers + scrapers + rerankers (incl.
  configurable Jina reranking) to inject fresh context.
- **Image generation & editing.** GPT-Image-1, DALL·E 2/3, Stable Diffusion,
  Flux, or via MCP servers.
- **Multimodal & file chat.** Image understanding and chat-with-files across
  providers.
- **Conversation management.** Presets (save/share), switch endpoint or preset
  mid-chat, edit/resubmit/continue, **conversation branching**, forking for
  context control, prompt library with sharing.
- **Resumable streams.** Responses reconnect/resume on dropped connections;
  multi-tab and multi-device sync; scales single-server → Redis-backed cluster.
- **Speech & audio.** STT and TTS (OpenAI, Azure, ElevenLabs), auto send/play.
- **Import/export.** Import from LibreChat, ChatGPT, Chatbot UI; export as
  screenshot, markdown, text, JSON.
- **Search & discovery.** Full-text search over all messages/conversations
  (Meilisearch).
- **Reasoning UI.** Dedicated chain-of-thought display for reasoning models.
- **Multi-user & security.** OAuth2, LDAP, email login; moderation; token-spend
  tracking and balance limits.
- **Admin panel.** Browser UI to manage users, groups, roles, and live config
  overrides without redeploy.
- **Deployment.** Docker Compose stacks, Helm chart, reverse-proxy configs,
  S3+CloudFront media, OpenTelemetry hooks; fully local or cloud.
- **Internationalization.** ~30+ UI languages.

### Character
Polished ChatGPT-style UX with deep multi-provider and enterprise-auth support.
Extensibility centers on **agents + MCP + actions**. Search-first (Meilisearch)
and strong on conversation ergonomics (branching, forking, presets).

---

## 3. Open WebUI

**Repo:** github.com/open-webui/open-webui · **License:** Open WebUI License
(BSD-3 derivative with a branding-preservation clause — note: *not* pure OSI
MIT/BSD; worth reviewing before reuse).
**Stack:** FastAPI (Python 3.11) backend, SQLite or Postgres, wide vector-DB
support, built-in RAG inference engine; SvelteKit / Svelte 5 frontend. Router
modules reveal the surface: chats, models, tools, functions, pipelines,
knowledge, retrieval, memories, notes, channels, calendar, automations,
evaluations, analytics, groups, scim, skills, terminals, images, audio.

### Capabilities

- **Broad model & API integration.** First-class Ollama plus any
  OpenAI-compatible API (LMStudio, Groq, Mistral, OpenRouter, vLLM, …); mix
  providers freely.
- **Granular RBAC & user groups.** Admin-defined roles, groups, per-group
  permissions; secure-by-default with tailored per-group experiences.
- **Plugin system (extensibility).** Filters, Actions, Pipes, Tools, and Skills;
  external integration via MCP, MCPO, and OpenAPI tool servers. Enables custom
  integrations, rate limits, approval flows, data connections.
- **Models & agents.** Wrap any base model with custom instructions + tools +
  knowledge to build agents; dynamic variables; per-user/group access;
  community preset imports.
- **Notes.** A dedicated writing workspace (rich editor + AI rewrite) separate
  from chat; notes can be attached to a chat for full-context injection.
- **Channels.** Real-time shared spaces where team + models collaborate in one
  timeline; threads, reactions, pins, access control.
- **Persistent memory.** AI remembers user facts across conversations.
- **Live workflow / message flow.** Watch the model work through checklists in
  real time; queue messages while it responds.
- **Calendar & AI scheduling.** Personal/shared calendars (month/week/day),
  recurring events, reminders; models manage schedule via function calling.
- **Automations.** Scheduled recurring prompts, surfaced on the calendar,
  linking back to produced chats.
- **Responsive design & PWA.** Desktop/mobile, offline-capable PWA.
- **Markdown & LaTeX.** Full rendering support.
- **Voice/video call.** Hands-free calls; multiple STT (Whisper, OpenAI,
  Deepgram, Azure) and TTS (Azure, ElevenLabs, OpenAI, Transformers, WebAPI).
- **Persistent artifact storage.** Built-in key-value store for artifacts
  (journals, trackers, leaderboards) with personal/shared scopes.
- **Local RAG.** 9 vector DBs (ChromaDB, PGVector, Qdrant, Milvus,
  Elasticsearch, OpenSearch, Pinecone, S3Vector, Oracle 23ai); multiple
  extraction engines (Tika, Docling, Document Intelligence, Mistral OCR,
  PaddleOCR, external loaders); hybrid search (BM25 + vector) + reranking +
  full-context mode; load docs with `#` command.
- **Web search for RAG.** ~20+ providers (SearXNG, Google PSE, Brave, Kagi,
  Tavily, Perplexity, Firecrawl, DuckDuckGo, Bing, Jina, Exa, …).
- **Web browsing.** Pull a URL into chat with `#`, or let the model fetch.
- **Image generation & editing.** DALL·E, Gemini, ComfyUI (local),
  AUTOMATIC1111 (local).
- **Multi-model conversations.** Query several models in parallel.
- **Usage analytics & model evaluation.** Admin dashboards (messages, tokens,
  cost per user/model); built-in model arena, A/B testing, ELO leaderboards.
- **Flexible database & storage.** SQLite (optional encryption) or Postgres;
  files local or S3 / GCS / Azure Blob.
- **Enterprise auth & provisioning.** LDAP/AD, SSO (trusted headers + OAuth),
  SCIM 2.0 automated provisioning (Okta, Azure AD, Google Workspace).
- **Cloud file integration.** Google Drive and OneDrive/SharePoint pickers.
- **Observability.** Built-in OpenTelemetry traces/metrics/logs.
- **Horizontal scalability.** Redis-backed sessions + WebSockets for
  multi-worker/multi-node behind load balancers.
- **Ecosystem.** Companion apps: hosted terminals / computer-use agent
  (Open Terminal, Terminals, cptr), knowledge sync from 45+ sources (oikb),
  native desktop app with system-wide chat bar and local llama.cpp inference.

### Character
Broadest feature surface of the two — pushing beyond chat into notes, channels,
calendar, automations, memory, and a computer-use ecosystem. Deep, self-hosted
RAG (many vector DBs, built-in inference) and strong enterprise
auth/provisioning. Extensibility is a first-class Python plugin runtime plus
MCP/OpenAPI.

---

## 4. Shared "Table Stakes" (what users now expect)

Any serious entrant is expected to ship most of this:

1. Multi-provider model access via OpenAI-compatible endpoints + local models.
2. Streaming chat with markdown, code highlighting, LaTeX.
3. RAG over uploaded documents (chat-with-files) and a knowledge base.
4. Web search injection.
5. Tool/plugin extensibility, increasingly standardized on **MCP**.
6. Agents (a model + instructions + tools + knowledge), shareable.
7. Image generation, image understanding (multimodal).
8. Voice: STT + TTS, ideally hands-free call mode.
9. Multi-user auth with OAuth/LDAP/SSO and role/group RBAC.
10. Conversation management: search, presets/prompts, edit/branch/fork,
    import/export.
11. Prompt/preset library with sharing.
12. Admin panel, usage/cost tracking, observability.
13. Docker/Helm deployment; horizontal scaling (Redis + WebSockets).
14. Responsive UI / PWA; i18n.

## 5. Points of Differentiation Between Them

- **Stack & extension language.** Node/React (LibreChat) vs. Python/Svelte
  (Open WebUI). Open WebUI's Python plugin runtime lets extensions run in-process;
  LibreChat leans on MCP/agents and external services.
- **RAG depth.** Open WebUI ships a self-contained RAG engine with many vector
  DBs and extractors; LibreChat uses a separate RAG API service.
- **Scope creep vs. focus.** Open WebUI extends into notes, channels, calendar,
  automations, memory, arena/evals, and a computer-use ecosystem. LibreChat
  stays closer to a focused, highly-polished chat + agents experience.
- **Conversation ergonomics.** LibreChat emphasizes branching/forking, presets,
  resumable streams, and full-text search.
- **Licensing.** LibreChat is MIT (permissive). Open WebUI's license adds a
  branding-preservation clause — relevant if we ever borrow code or fork.

---

## 6. Implications for What We Build

**Likely must-haves (don't skip):** multi-provider + local model access,
streaming chat with rich rendering, RAG/chat-with-files, MCP-based tool
extensibility, agents, multi-user auth with RBAC, conversation search/export,
admin + usage tracking, and clean Docker deployment.

**Likely out-of-scope / defer (avoid over-building):** calendar/scheduling,
channels/team timelines, model arena/ELO evals, computer-use terminals, a
9-vector-DB matrix, and 20+ web-search providers. These are breadth features
that Open WebUI already covers exhaustively; matching them is low-leverage.

**Where differentiation is realistic:** UX quality and coherence, a focused and
well-documented extensibility model (standardize on MCP rather than a bespoke
plugin API), strong defaults so it works well out of the box, and picking one
or two capabilities to do *notably better* than the incumbents rather than
matching their entire surface.

---

*Sources: LibreChat and Open WebUI README/feature listings and repository
structure, reviewed via shallow local clones. Feature naming has been
normalized to capabilities; consult each project's docs for authoritative,
version-specific details.*

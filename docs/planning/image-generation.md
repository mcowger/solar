# Image Generation Mode

Status: scope confirmed; implementation not started.

## Agreed scope

- Separate **New Image** button alongside **New Chat**.
- Dedicated non-chat image workspace, listed alongside chats in the shared sidebar with a distinct icon.
- Owner-private workspaces available to all signed-in users.
- Start with a text prompt or one uploaded reference image.
- Subsequent edits send only the selected image and new instruction, not earlier prompts or full ancestry.
- Every result is a saved, immutable version. Selecting an older version allows branching from it.
- Large selected image, chronological thumbnail strip, and links to each version's source; no visual branch tree.
- Starting from a different upload or generating from scratch requires a new workspace once the workspace has started.
- OpenRouter through direct `pi-ai` calls, with an admin-approved image model picker. Users may switch models between edits.
- Model-supported aspect ratio and resolution controls.
- Request one image per click; one active request per workspace.
- Generation continues server-side after navigation or browser disconnect.
- Retain failed or interrupted attempts, with explicit manual retry rather than automatic resubmission.
- Solar database owns image metadata and job status; disk storage holds originals. Do not use the coding-agent loop or pi session history for images.
- Reuse server-managed provider credentials. Rely on provider-side spending limits rather than introducing Solar quotas. Show actual usage/cost when reported.
- Delete whole workspaces, not individual versions.
- Download original images. No sharing or chat export in this release.

## 1. Verify and upgrade the image API dependency

**Files:** `apps/server/package.json`, `bun.lock`

- Select an exact compatible `pi-ai` release exposing `generateImages()`.
- Verify OpenRouter reference-image input, model discovery, aspect ratio, resolution, and usage reporting.
- Check existing chat imports before upgrading; do not upgrade `pi-coding-agent` unless necessary.
- Add a mocked adapter test before connecting the feature.

**Compatibility gate:** Solar now declares `pi-ai` / `pi-coding-agent` / `pi-agent-core` `0.99.0` (unified image-model surface: `ImageModel`, `getModelsOfType("image")`).

## 2. Add image persistence

**Files:** new database migration, `apps/server/src/db/types.generated.ts`, new `apps/server/src/images/` modules

Create dedicated records for:

- **Workspaces:** owner, title, timestamps, current settings.
- **Assets/versions:** uploaded or generated originals, dimensions, MIME type, storage reference, source-version relationship.
- **Attempts:** source image, prompt, model and settings snapshot, status, error, optional usage/cost, resulting asset.

Keep attempts separate from assets: failed requests have history but no resulting image.

Reuse the existing disk-storage mechanism, not chat-dependent attachment records. Store originals outside SQLite; regenerate database types through `bun run codegen`.

## 3. Add the image model catalog

**Integration:** provider configuration, `apps/server/src/chat/catalog.ts`, admin settings

- Reuse server-managed OpenRouter credentials.
- Provide a distinct admin-approved image-model catalog.
- Only enable launch models supporting both generation and reference-image editing.
- Expose supported aspect ratios and resolutions per model.
- Keep image models out of chat model selection.
- Revalidate settings server-side, including after model changes.

## 4. Implement server-owned generation

**New modules:** image provider adapter, repository, storage, generation service

For each request:

1. Authenticate and verify workspace/source ownership.
2. Validate approved model and supported settings.
3. Atomically record the attempt and claim the workspace's single active slot.
4. Generate independently of the browser connection.
5. Persist the original file before marking completion.

Additional behavior:

- Edits send only the selected image and new instruction.
- Initial uploads remain selectable sources.
- Prevent duplicate submissions from creating duplicate provider requests.
- Retain failures; explicit retry creates a new attempt.
- On startup, mark stranded active attempts interrupted. Never automatically resubmit them.
- Do not intentionally retry ambiguous provider failures.
- Workspace deletion must prevent late results from recreating deleted files.

Use `SOLAR_MOCK_LLM=1` to substitute deterministic image fixtures, including failure cases. Mock mode must prevent paid image API requests even when stored settings select a real model.

## 5. Expose authenticated APIs

**Files:** new image tRPC router and file routes; existing router/server registration

Support:

- Workspace listing, creation, loading, and deletion.
- Initial upload, generation, retry, and status retrieval.
- Approved image models and capabilities.
- Authenticated previews and original downloads.

Enforce ownership on every metadata and file operation. Validate uploaded files and generation inputs at these boundaries. Use status polling while generating; no chat SSE dependency is required.

## 6. Build the dedicated image view

**Files:** `apps/web/src/chat/ChatApp.tsx`, `apps/web/src/chat/Sidebar.tsx`, new `apps/web/src/images/` components

- Add **New Image** alongside **New Chat**.
- Display image workspaces in the shared sidebar with distinct icons.
- Preserve selected workspace across refresh/navigation using existing navigation conventions.
- Render a dedicated view outside the assistant-ui thread containing:
  - Large selected image.
  - Chronological thumbnails and source links.
  - Prompt, model, aspect ratio, and resolution controls.
  - Initial single-image upload.
  - Generation/failure status, explicit retry, and original download.
- Selecting an older image makes it the next edit's source.
- No source replacement or text-only reset after the workspace starts.

## 7. Verify

Add tests covering:

- Source-only edit payloads and branching.
- Ownership checks, including downloads.
- Duplicate submissions and simultaneous requests.
- Disconnects, interrupted jobs, failures, and manual retry.
- File persistence and deletion during generation.
- Model approval and unsupported settings.
- Mock mode preventing paid requests.
- Existing chat behavior remaining unchanged.

Run with `SOLAR_MOCK_LLM=1`:

```bash
SOLAR_MOCK_LLM=1 bun run typecheck
SOLAR_MOCK_LLM=1 bun run test
SOLAR_MOCK_LLM=1 bun run build
SOLAR_MOCK_LLM=1 bun run test:e2e
```

Scope Playwright execution to relevant tests during iteration. Run server tests through the project script, not bare `bun test`.

Finish with desktop/mobile `agent-browser` verification and screenshots. Document that backups must include image metadata and stored originals alongside existing chat data.

## Architecture rationale

The purpose of reuse is to avoid duplicate infrastructure, not to mandate a single session format.

- A coding-agent loop plus an image tool introduces text-model orchestration and additional controls for deterministic generation and isolated edit context.
- SessionManager custom entries plus direct `pi-ai` calls could store external image references and version metadata without a text-model turn. However, Solar would still need image-specific execution, status recovery, and history handling.
- Solar database records plus direct `pi-ai` calls reuse authentication, provider configuration, database, and disk storage without adapting chat-session semantics. This is the confirmed direction.

No application implementation is authorized by this document alone.

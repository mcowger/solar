# Spike 3 Findings — Mirage attachment storage on Bun

Status: **adopt Mirage with Bun caveats** · 2026-07-17

## Result

Mirage 0.0.3 runs under Bun 1.3.14 for its in-memory filesystem. The proof
created the parent directory, stored a binary PNG attachment, read it back,
checked its existence, deleted it, and verified its removal through
`RAMResource`. Conversation data is explicitly out of scope and remains in
MikroORM + SQLite.

Mirage's `RAMResource`, `DiskResource`, and `S3Resource` implement the same
resource operations, including `writeFile`, `readFile`, `exists`, and `unlink`.
The RAM proof therefore validates the API used by filesystem and S3-compatible
mounts, but deliberately does not exercise a live object-store service.

The Bun proof has material caveats. Mirage documents Node.js 20+ rather than
Bun, and its type declarations reference optional peer dependencies that are
not installed for this RAM-only use case. `skipLibCheck` is required to check
the proof itself. Installing the package added 159 packages and Bun blocked one
dependency postinstall.

## Criteria assessment

| Criterion | Result | Evidence |
| --- | --- | --- |
| Runs under Bun | Pass with caveats | `bun run typecheck` and `bun test` passed on Bun 1.3.14 after `skipLibCheck`; Mirage documents Node.js 20+, not Bun. |
| Attachment lifecycle | Pass | `RAMResource` stored, read, checked, and deleted a binary PNG. |
| Shared filesystem/S3 resource API | Pass by source inspection | `RAMResource`, `DiskResource`, and `S3Resource` share Mirage's resource operations; no live S3 service was tested. |
| Simpler over the storage lifecycle | Pass | Mirage's common resource API lets local disk and S3-compatible storage share application code, avoiding a later storage-layer migration. |

## Commands run

```text
bun install             # installed @struktoai/mirage-node 0.0.3; 159 packages
bun run typecheck       # passed with skipLibCheck
bun test                # 1 pass, 0 fail
```

## Decision

Adopt **Mirage** for attachments: use its local-disk resource in v1 and its
S3-compatible resource when object storage is required. The shared resource API
is the simplicity win because it avoids owning and later migrating an
application-specific storage layer. Before production adoption, run a live
S3-compatible integration test and resolve the documented Bun caveats. Keep
this throwaway proof in `.spikes/spike-3` until architecture decisions are
captured, then remove or quarantine it as specified by the spike plan.

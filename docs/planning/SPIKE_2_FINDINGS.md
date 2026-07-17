# Spike 2 Findings — MikroORM + SQLite on Bun

Status: **go — MikroORM + SQLite** · 2026-07-17

## Result

MikroORM 6.6.16 runs on Bun 1.3.14 with its SQLite driver. A Bun-only proof
generated and applied a TypeScript migration, then exercised related CRUD for
`User`, `Conversation`, `Message`, and `Preset` against a temporary SQLite file.
No Node-only native-module blocker was encountered.

## Criteria assessment

| Criterion | Result | Evidence |
| --- | --- | --- |
| Bun initialization and migrations | Pass | `bun run migration:prove` generated and applied `Migration20260717232154.ts`. |
| CRUD and relations | Pass | `bun test` created a user, preset, conversation, and three related messages; then read the populated relations, updated the conversation, and deleted the preset. |
| Generate + apply workflow | Pass | The test and standalone proof both call `getMigrator().createMigration()` followed by `getMigrator().up()` under Bun. |
| Postgres seam | Pass | Entities contain only MikroORM mappings; no SQLite-specific SQL or types. Switching drivers changes the driver package and connection/migration configuration, not entity definitions. |
| Streaming message appends | Pass | The test flushes each of three message chunks independently, then reloads them in order. The complete migration-and-CRUD test finished in 560 ms; this is acceptable qualitative signal for per-chunk writes at the spike scale. |

## Caveat

Bun does not supply TypeScript decorator design metadata at runtime. Scalar
MikroORM decorators therefore need explicit `type` options (and enums explicit
`items`) rather than relying on `emitDecoratorMetadata`. This is local entity
configuration, not a runtime blocker.

## Commands run

```text
bun install
bun run typecheck          # passed
bun run migration:prove    # generated and applied a migration
bun test                   # 1 pass, 0 fail
```

## Decision

Proceed with MikroORM + SQLite. No fallback ORM evaluation is needed. Keep this
throwaway proof in `.spikes/spike-2` until architecture decisions are captured,
then remove or quarantine it as specified by the spike plan.

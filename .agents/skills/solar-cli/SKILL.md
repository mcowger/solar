---
name: solar-cli
description: Manage Solar development servers and investigate local or production instances with the Solar CLI. Use for dev-server lifecycle, seeded development credentials, or server history inspection.
---

# Solar CLI operations

Use this skill for Solar development-server lifecycle and existing-server investigation. `bun run solar` is not a deployment CLI.

## Development server

Use managed commands only; never start a raw background server:

```bash
bun run solar dev start
bun run solar dev status
bun run solar dev logs
bun run solar dev restart
bun run solar dev stop
```

For UI or chat-flow verification, start it with the local model substitute:

```bash
SOLAR_MOCK_LLM=1 bun run solar dev start
```

On the first start with an empty development database, migrations run and the output includes:

```text
seeded dev admin account: admin@solar.local / password
seeded dev API key: <generated key>
```

The generated API key persists in that database. Retrieve it from the start output or `.dev-server.log`. No seed output means the database already has users. Delete `apps/server/solar.db*` only when an intentional local reset is requested.

## Investigate an existing server

History commands support `list`, `inspect`, `export`, `export-all`, and `import`. They default to the local running server unless `--url` or `SOLAR_URL` is set. Prefer read-only commands (`list`, `inspect`, `export`) for investigation; import only when explicitly requested.

```bash
bun run solar history list
bun run solar history list --url https://solar.example.com --api-key <key>
```

Use `SOLAR_API_KEY` or `--api-key` for authentication. Never print API keys.

## Production deployment

```bash
bun run deploy:production
```

It builds the production image on its Docker context, recreates the Compose service, waits for health, optionally exports history, and prunes old images. Overrides use `SOLAR_PRODUCTION_*` environment variables. For published release images, see `docs/releases.md`.

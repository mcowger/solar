---
name: solar-cli
description: Manage Solar development servers and investigate local or staging instances with the Solar CLI. Use for dev-server lifecycle, seeded development credentials, server history inspection, or staging investigation.
---

# Solar CLI operations

Use this skill for Solar development-server lifecycle and existing-server
investigation. `bun run solar` is not a deployment CLI.

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

On the first start with an empty development database, migrations run and the
output includes:

```text
seeded dev admin account: admin@solar.local / password
seeded dev API key: <generated key>
```

The generated API key persists in that database. Retrieve it from the start
output or `.dev-server.log`. No seed output means the database already has
users. Delete `apps/server/solar.db*` only when an intentional local reset is
requested.

Use the URL printed by `bun run solar dev status` and the generated key for
local history investigation:

```bash
SOLAR_URL=http://localhost:<port> SOLAR_API_KEY=<generated-key> \
  bun run solar history list --user admin@solar.local
```

## Investigate an existing server

History commands support `list`, `inspect`, `export`, `export-all`, and
`import`. They require an API key and default to a local server unless `--url`
or `SOLAR_URL` is set. Prefer read-only commands (`list`, `inspect`, `export`)
for investigation; import only when explicitly requested.

For staging, keep staging credentials in `SOLAR_STAGING_*` variables and map
them explicitly for the management command:

```bash
SOLAR_URL="$SOLAR_STAGING_URL" SOLAR_API_KEY="$SOLAR_STAGING_API_KEY" \
  bun run solar history list --user <user@example.com>
```

Never substitute development credentials for staging credentials, and do not
print either API key.

## Staging deployment

Deployment is intentionally separate:

```bash
bun run deploy:staging
```

It rebuilds the staging image, recreates the Compose service, waits for health,
exports history, and prunes old images. It consumes only `SOLAR_STAGING_*`
configuration, including `SOLAR_STAGING_URL` and `SOLAR_STAGING_API_KEY`.
Run it only when the task explicitly requests a staging deployment; never use
it for investigation or verification.

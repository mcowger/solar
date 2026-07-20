# Solar server-management CLI

`bun run solar` manages or investigates existing servers. History commands
require `SOLAR_API_KEY` (or `--api-key`) and send it as the `X-API-Key` header.
Set `SOLAR_URL` (or pass `--url`) to target another server. Deployment is a
separate `bun run deploy:staging` command.

## Local server

```bash
bun run solar dev start
bun run solar dev status
bun run solar dev logs
bun run solar dev restart
bun run solar dev stop
```

## History

```bash
# List a user's chat IDs, then inspect raw rows for one chat.
bun run solar history list --user <user@example.com>
bun run solar history inspect --chat <chat-id>

# Download or upload a versioned Solar JSON history bundle.
bun run solar history export --user <user@example.com> --output history.json
bun run solar history export-all --output history.json
bun run solar history import --user <user@example.com> --input history.json

# Operate on a remote server.
SOLAR_URL=https://solar.home.cowger.us SOLAR_API_KEY=sk_solar_your_api_key_here \
  bun run solar history export-all --output history.json
```

Imports merge without overwriting and reject ID or tag-name conflicts. History
bundles include attachment metadata but not the underlying attachment files.

## Staging deployment

`bun run deploy:staging` rebuilds and recreates the configured container,
checks its health, and exports all chat history. Its configuration uses
`SOLAR_STAGING_*`, including `SOLAR_STAGING_URL`,
`SOLAR_STAGING_API_KEY`, `SOLAR_STAGING_HISTORY_OUTPUT`,
`SOLAR_STAGING_DOCKER_CONTEXT`, `SOLAR_STAGING_SSH_HOST`,
`SOLAR_STAGING_CONTAINER_NAME`, `SOLAR_STAGING_IMAGE_NAME`,
`SOLAR_STAGING_IMAGE_RETAIN`, `SOLAR_STAGING_HEALTH_TIMEOUT`, and
`SOLAR_STAGING_TARGET_PLATFORM`. It is a state-changing operation; do not run
it to investigate a server.

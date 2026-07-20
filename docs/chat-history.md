# Solar operations CLI

All server operations run through `bun run solar`. History and deployment
commands require `SOLAR_API_KEY` (or `--api-key`) and send it as the
`X-API-Key` header. Set `SOLAR_URL` (or pass `--url`) to target another server.

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

`bun run solar staging deploy` rebuilds and recreates the configured container,
checks its health, and exports all chat history. It uses the same `SOLAR_URL`
and `SOLAR_API_KEY` as history commands. Deployment-only configuration uses
`SOLAR_DEPLOY_*`; history output uses
`SOLAR_HISTORY_OUTPUT`.

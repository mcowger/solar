# Chat-history tooling

Admin CLI tooling for chat inspection and history import/export. All commands
run from the repo root against a running server.

## `bun run chat-history`

Calls the admin-only tRPC debugging and history APIs on the running server.

**Authentication.** When the seeded development login is available, prefer it:
`SOLAR_ADMIN_EMAIL=admin@solar.local SOLAR_ADMIN_PASSWORD=password`. Otherwise,
authenticate with an existing admin session cookie via `SOLAR_SESSION_COOKIE`,
or set `SOLAR_ADMIN_EMAIL` and `SOLAR_ADMIN_PASSWORD` for another admin.
Override the target with `SOLAR_URL` (defaults to `http://localhost:3000`).
Prefer environment variables over credential flags so passwords do not appear
in shell history.

For live staging information, set `SOLAR_URL=https://solar.home.cowger.us` and
`SOLAR_ADMIN_EMAIL=devuser@cowger.us`. For staging only, you may use the
staging (non-secret) password: `password`.

```bash
# List a user's chat IDs, then inspect the raw database rows for one chat.
bun run chat-history -- list --user <user-id>
bun run chat-history -- inspect --chat <chat-id>

# Download or upload a versioned Solar JSON history bundle.
bun run chat-history -- export --user <user-id> --output history.json
bun run chat-history -- export-all --output .staging-history/all-users.json
bun run chat-history -- import --user <user-id> --input history.json

bun run chat-history -- --help
```

Imports merge without overwriting and reject ID or tag-name conflicts. History
bundles include attachment metadata but not the underlying attachment files.
`export-all` writes one bundle containing each user's account metadata and history.

Staging deploys run `export-all` automatically after the new container passes its
health check. The output defaults to a timestamped file under
`.staging-history/`; override it with `SOLAR_STAGING_HISTORY_OUTPUT`.

## `bun run dev:load-history`

Starts the local dev server and restores a saved bundle in one command:

```bash
bun run dev:load-history
bun run dev:load-history -- --input history.json
```

It defaults to `.staging-history.json` and imports into `admin@solar.local`.
Use `--user`, `--url`, and the standard `SOLAR_*` authentication variables to
override the destination.

## `bun run sync-staging-history`

With a running local dev server and an empty local chat history, run:

```bash
bun run sync-staging-history
```

This calls the staging export and local restore APIs, writes the gitignored
`.staging-history.json` bundle, and restores the staging user's history into
local `admin@solar.local`. The staging URL, users, and credentials default to
the staging values above; override them with command options or the
`SOLAR_STAGING_*` and `SOLAR_*` environment variables (see `--help`). Repeat
imports require a clean local history because the restore API rejects
conflicts.

# Solar

Self-hosted team chat with a single Bun server, SQLite, and local attachments.

## Docker Compose

Copy `.env.example` to `.env`, set a strong `BETTER_AUTH_SECRET`, then run:

```sh
docker compose up --build
```

Open http://localhost:3000. Persistent database and attachment data live in
`./data`.

For local Bun development, run `bun run dev:start`. It uses a stable
worktree-specific port (in the 3000–3999 range); set `PASEO_PORT` to override
it.

## bunx

After publishing, run:

```sh
bunx @mcowger/solar
```

Set `BETTER_AUTH_SECRET` and optional runtime variables before starting. By
default, SQLite and attachments are created relative to the current directory.

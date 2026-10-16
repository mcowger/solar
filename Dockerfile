FROM oven/bun:1.4.3

# pi child processes run under bun via the data-dir shim (pi's RpcClient
# hardcodes a `node` binary name; Solar redirects it to bun). No node install.
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN bun install --frozen-lockfile --ignore-scripts

COPY . .

RUN bun run package

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/solar.db
ENV SOLAR_ATTACHMENTS_DIR=/data/attachments
ENV SOLAR_PI_AGENT_DIR=/data/pi-agent
ENV SOLAR_PI_CLI=/app/apps/server/node_modules/@earendil-works/pi-coding-agent/dist/cli.js

EXPOSE 3000

CMD ["bun", "run", "dist/index.js"]
 

FROM oven/bun:1.3.14

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

EXPOSE 3000

CMD ["bun", "run", "dist/index.js"]
 

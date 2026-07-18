FROM oven/bun:1.3.14

WORKDIR /app

COPY . .

RUN bun install --frozen-lockfile --ignore-scripts && bun run package

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/solar.db
ENV SOLAR_ATTACHMENTS_DIR=/data/attachments

EXPOSE 3000

CMD ["bun", "run", "dist/index.js"]

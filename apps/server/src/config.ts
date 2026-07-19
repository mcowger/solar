/** Runtime configuration from environment variables. */
const authBaseURL = process.env.BETTER_AUTH_URL ?? (process.env.NODE_ENV === "production" ? "https://solar.home.cowger.us" : `http://localhost:${process.env.PORT ?? 3000}`);

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DATABASE_PATH ?? "solar.db",
  authSecret: process.env.BETTER_AUTH_SECRET ?? "dev-insecure-secret-change-me",
  authBaseURL,
  attachmentsDataDir: process.env.SOLAR_ATTACHMENTS_DIR ?? "data/attachments",
} as const;

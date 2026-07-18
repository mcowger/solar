/** Runtime configuration from environment variables. */
export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DATABASE_PATH ?? "solar.db",
  authSecret: process.env.BETTER_AUTH_SECRET ?? "dev-insecure-secret-change-me",
  authBaseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
} as const;

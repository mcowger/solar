import { getMigrations } from "better-auth/db/migration";
import { auth } from "../auth";
import { logger } from "../logger";
import { sqlite } from "./index";

/**
 * Runs Better Auth's own table migrations against the shared `solar.db`. Better
 * Auth is a separate migration owner from our Kysely migrations; both run at
 * startup so the single DB is fully provisioned.
 */
export async function migrateAuth(): Promise<void> {
  const columns = sqlite.query("PRAGMA table_info(user)").all() as { name: string }[];
  if (columns.length > 0 && !columns.some((column) => column.name === "isDisabled")) {
    sqlite.exec("ALTER TABLE user ADD COLUMN isDisabled INTEGER NOT NULL DEFAULT 0");
  }
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(
    auth.options,
  );
  if (toBeCreated.length === 0 && toBeAdded.length === 0) return;
  await runMigrations();
  logger.info("better-auth migrations applied");
}

if (import.meta.main) {
  await migrateAuth();
  logger.info("auth migrations up to date");
  process.exit(0);
}

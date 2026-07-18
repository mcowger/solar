import { getMigrations } from "better-auth/db/migration";
import { auth } from "../auth";

/**
 * Runs Better Auth's own table migrations against the shared `solar.db`. Better
 * Auth is a separate migration owner from our Kysely migrations; both run at
 * startup so the single DB is fully provisioned.
 */
export async function migrateAuth(): Promise<void> {
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(
    auth.options,
  );
  if (toBeCreated.length === 0 && toBeAdded.length === 0) return;
  await runMigrations();
  console.log("better-auth migrations applied");
}

if (import.meta.main) {
  await migrateAuth();
  console.log("auth migrations up to date");
  process.exit(0);
}

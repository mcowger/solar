import { auth } from "../auth";
import { sqlite } from "./index";

/**
 * Development-only convenience account. Runs when NODE_ENV !== "production" and
 * no users exist yet, so a fresh dev database has a known login. Because it is
 * the first account, the first-user-admin hook (see auth.ts) makes it an admin.
 *
 * Never runs in production — real deployments register their own first
 * (admin) user through the sign-up form.
 */
export const DEV_EMAIL = "admin@solar.local";
export const DEV_PASSWORD = "password";

export async function seedDevUser(): Promise<void> {
  if (process.env.NODE_ENV === "production" || process.env.SOLAR_SEED_DEV_USER !== "1") return;

  const row = sqlite.query("SELECT COUNT(*) AS c FROM user").get() as {
    c: number;
  };
  if (row.c > 0) return;

  await auth.api.signUpEmail({
    body: { email: DEV_EMAIL, password: DEV_PASSWORD, name: "Dev Admin" },
  });
  console.log(`seeded dev admin account: ${DEV_EMAIL} / ${DEV_PASSWORD}`);
}

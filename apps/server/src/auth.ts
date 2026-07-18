import { betterAuth } from "better-auth";
import { config } from "./config";
import { dialect, sqlite } from "./db";

/**
 * Better Auth instance. It uses its own Kysely adapter over the *same* SQLite
 * dialect/connection as the app (see `db/index.ts`), so auth tables and app
 * tables co-locate in one `solar.db`. Better Auth owns and migrates its own
 * tables (`user`, `session`, `account`, `verification`).
 *
 * M0 enables email/password only to prove the wiring; OAuth and roles land in
 * later milestones.
 */
export const auth = betterAuth({
  database: { dialect, type: "sqlite" },
  secret: config.authSecret,
  baseURL: config.authBaseURL,
  emailAndPassword: { enabled: true },
  user: {
    additionalFields: {
      // Admin/user roles (full enforcement + admin UI land in M4). Assigned by
      // the server, never accepted from client input.
      role: { type: "string", defaultValue: "user", input: false },
    },
  },
  databaseHooks: {
    user: {
      create: {
        // First account to register on a deployment becomes the admin.
        before: async (user) => {
          const row = sqlite
            .query("SELECT COUNT(*) AS c FROM user")
            .get() as { c: number };
          const role = row.c === 0 ? "admin" : "user";
          return { data: { ...user, role } };
        },
      },
    },
  },
});

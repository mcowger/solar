import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { config } from "./config";
import { dialect, sqlite } from "./db";

/**
 * Better Auth instance. It uses its own Kysely adapter over the *same* SQLite
 * dialect/connection as the app (see `db/index.ts`), so auth tables and app
 * tables co-locate in one `solar.db`. Better Auth owns and migrates its own
 * tables (`user`, `session`, `account`, `verification`).
 *
 * Local email/password accounts are the only sign-in method for now; OAuth is
 * explicitly deferred. Roles and account state are server-assigned fields.
 */
export const auth = betterAuth({
  database: { dialect, type: "sqlite" },
  secret: config.authSecret,
  baseURL: config.authBaseURL,
  trustedOrigins: process.env.NODE_ENV !== "production" ? ["*"] : [config.authBaseURL],
  emailAndPassword: { enabled: true },
  user: {
    additionalFields: {
      // Admin/user roles (full enforcement + admin UI land in M4). Assigned by
      // the server, never accepted from client input.
      role: { type: "string", defaultValue: "user", input: false },
      isDisabled: { type: "boolean", defaultValue: false, input: false },
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
    session: {
      create: {
        before: async (session) => {
          const user = sqlite
            .query("SELECT isDisabled FROM user WHERE id = ?")
            .get(session.userId) as { isDisabled: number } | null;
          if (user?.isDisabled) {
            throw new APIError("FORBIDDEN", { message: "This account is disabled" });
          }
        },
      },
    },
  },
});

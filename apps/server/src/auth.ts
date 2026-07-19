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
 * Email addresses are the account identity. Google accounts with a verified
 * matching email are linked to an existing email/password account.
 */
export const auth = betterAuth({
	database: { dialect, type: "sqlite" },
	secret: config.authSecret,
	baseURL: config.authBaseURL,
	trustedOrigins:
		process.env.NODE_ENV !== "production" ? ["*"] : [config.authBaseURL],
	emailAndPassword: { enabled: true },
	...(config.googleClientId && config.googleClientSecret
		? {
				socialProviders: {
					google: {
						clientId: config.googleClientId,
						clientSecret: config.googleClientSecret,
					},
				},
			}
		: {}),
	account: {
		accountLinking: {
			enabled: true,
			trustedProviders: ["google"],
			allowDifferentEmails: false,
			// This app has no local email-verification flow, so email/password
			// accounts are never marked verified. Without this opt-out, Better Auth
			// refuses to implicitly link a Google sign-in to an existing local
			// account. Google's verified-email claim is the linking trust anchor.
			requireLocalEmailVerified: false,
		},
	},
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
					const row = sqlite.query("SELECT COUNT(*) AS c FROM user").get() as {
						c: number;
					};
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
						throw new APIError("FORBIDDEN", {
							message: "This account is disabled",
						});
					}
				},
			},
		},
	},
});

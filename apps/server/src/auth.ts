import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { apiKey } from "@better-auth/api-key";
import { config } from "./config";
import { dialect, sqlite } from "./db";

export const API_KEY_HEADER = "x-api-key";

/** Throws unless the email's domain is on the (optional) allowlist. */
function assertAllowedEmailDomain(email: string): void {
	const allowed = config.allowedEmailDomains;
	if (allowed.length === 0) return;
	const domain = email.split("@").at(-1)?.toLowerCase();
	if (!domain || !allowed.includes(domain)) {
		throw new APIError("FORBIDDEN", {
			message: "Email domain is not allowed",
		});
	}
}

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
						// Enforce the email-domain allowlist on every Google sign-in
						// (including linking to existing users). The profile email comes
						// from Google's signed ID token, so it can be trusted.
						mapProfileToUser: (profile) => {
							assertAllowedEmailDomain(profile.email);
							return {};
						},
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
	plugins: [
		apiKey({
			apiKeyHeaders: API_KEY_HEADER,
			defaultPrefix: "sk_solar_",
			requireName: true,
			keyExpiration: {
				defaultExpiresIn: null,
				disableCustomExpiresTime: true,
			},
			rateLimit: { enabled: false },
			enableSessionForAPIKeys: true,
		}) as unknown as BetterAuthPlugin,
	],
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
					// Covers email/password registration (Google is also checked
					// earlier in mapProfileToUser).
					assertAllowedEmailDomain(user.email);
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

export async function getSolarSession(headers: Headers) {
	let session: Awaited<ReturnType<typeof auth.api.getSession>>;
	try {
		session = await auth.api.getSession({ headers });
	} catch {
		return null;
	}
	if (!session) return null;
	const user = sqlite
		.query("SELECT role, isDisabled FROM user WHERE id = ?")
		.get(session.user.id) as { role: string; isDisabled: number } | null;
	if (
		!user ||
		user.isDisabled ||
		(headers.has(API_KEY_HEADER) && user.role !== "admin")
	)
		return null;
	return {
		session: session.session,
		user: { ...session.user, role: user.role },
	};
}

interface ApiKeyApi {
	createApiKey(input: {
		body: { name: string; userId: string };
	}): Promise<{ id: string; key: string }>;
}

export function createSolarApiKey(name: string, userId: string) {
	return (auth.api as unknown as ApiKeyApi).createApiKey({
		body: { name, userId },
	});
}

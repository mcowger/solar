import { isSecureOidcUrl } from "./oidcUrl";

/** Runtime configuration from environment variables. */
const authBaseURL =
	process.env.BETTER_AUTH_URL ??
	(process.env.NODE_ENV === "production"
		? "https://solar.home.cowger.us"
		: `http://localhost:${process.env.PORT ?? 3000}`);

function isTruthy(value?: string): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return ["1", "true", "yes", "on"].includes(normalized);
}

export { isTruthy };

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Resolved settings for the optional OpenID Connect provider. */
export interface OidcConfig {
	/**
	 * Issuer exactly as configured. Passed to Better Auth as `issuer`, which
	 * compares it byte-for-byte with the `iss` callback parameter, so a trailing
	 * slash (Authentik) must survive untouched.
	 */
	issuer: string;
	discoveryUrl: string;
	clientId: string;
	clientSecret: string;
	/** Label for the sign-in button ("Continue with <name>"). */
	displayName: string;
	scopes: string[];
	/** When true, only admin-created users may sign in through the IdP. */
	disableSignUp: boolean;
	/** Claim path holding group membership, e.g. `realm_access.roles`. */
	adminClaim?: string;
	/** Claim value that grants the admin role. */
	adminValue?: string;
}

const DEFAULT_OIDC_SCOPES = ["openid", "profile", "email"];

/**
 * Reads the `OIDC_*` environment into a provider config. Returns null unless the
 * issuer and both credentials are present; that triple is what enables OIDC,
 * mirroring how the Google client id/secret pair enables Google.
 */
export function parseOidcConfig(
	env: Record<string, string | undefined>,
): OidcConfig | null {
	const issuer = env.OIDC_ISSUER?.trim();
	const clientId = env.OIDC_CLIENT_ID?.trim();
	const clientSecret = env.OIDC_CLIENT_SECRET?.trim();
	if (!issuer || !clientId || !clientSecret) return null;
	if (!isSecureOidcUrl(issuer)) {
		throw new Error(
			"OIDC_ISSUER must use HTTPS; HTTP is allowed only for localhost, 127.0.0.1, or [::1]",
		);
	}
	const issuerUrl = new URL(issuer);
	if (issuerUrl.href.includes("?") || issuerUrl.href.includes("#")) {
		throw new Error("OIDC_ISSUER must not contain a query string or fragment");
	}

	const scopes = (env.OIDC_SCOPES ?? "")
		.split(/[\s,]+/)
		.map((scope) => scope.trim())
		.filter(Boolean);
	if (scopes.length === 0) scopes.push(...DEFAULT_OIDC_SCOPES);
	if (!scopes.includes("openid")) scopes.unshift("openid");

	// Role sync needs both halves; one without the other is a misconfiguration
	// that `index.ts` warns about at startup.
	const adminClaim = env.OIDC_ADMIN_CLAIM?.trim();
	const adminValue = env.OIDC_ADMIN_VALUE?.trim();

	return {
		issuer,
		discoveryUrl: `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
		clientId,
		clientSecret,
		displayName: env.OIDC_DISPLAY_NAME?.trim() || "SSO",
		scopes,
		disableSignUp: isTruthy(env.OIDC_DISABLE_SIGNUP),
		...(adminClaim && adminValue ? { adminClaim, adminValue } : {}),
	};
}

export const config = {
	port: Number(process.env.PORT ?? 3000),
	dbPath: process.env.DATABASE_PATH ?? "solar.db",
	authSecret: process.env.BETTER_AUTH_SECRET ?? "dev-insecure-secret-change-me",
	authBaseURL,
	googleClientId: process.env.GOOGLE_CLIENT_ID,
	googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
	// Optional self-hosted OpenID Connect provider (Authentik, Keycloak,
	// Zitadel, Authelia). Null when not configured. Unlike Google this stays
	// enabled in airgap mode: the IdP is the operator's own, not a third party.
	oidc: parseOidcConfig(process.env),
	cloudflareRadarApiToken: process.env.CLOUDFLARE_RADAR_API_TOKEN,
	// Optional comma-separated list of email domains allowed to sign up or sign
	// in (Google, OIDC, and email/password). Empty means any domain is allowed.
	allowedEmailDomains: (process.env.AUTH_ALLOWED_DOMAINS ?? "")
		.split(",")
		.map((domain) => domain.trim().toLowerCase())
		.filter(Boolean),
	airgapMode: isTruthy(
		process.env.SOLAR_AIRGAP_MODE ?? process.env.AIRGAP_MODE,
	),
	attachmentsDataDir: process.env.SOLAR_ATTACHMENTS_DIR ?? "data/attachments",
	maxToolOutputCharacters: Number(
		process.env.SOLAR_MAX_TOOL_OUTPUT_CHARS ??
			process.env.MAX_TOOL_OUTPUT_CHARS ??
			100_000,
	),
	// How long one MCP tool call (or prompt / resource read) may take. The MCP
	// SDK's own default is 60s, too short for tools that crawl a site or render
	// a page. Keep it below SOLAR_PI_STALL_TIMEOUT_MS: a running tool sends pi
	// no events, so the stall watchdog would abort the turn first.
	mcpToolTimeoutMs: positiveInteger(
		process.env.SOLAR_MCP_TOOL_TIMEOUT_MS,
		60_000,
	),
} as const;

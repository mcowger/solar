import { describe, expect, test } from "bun:test";
import { isTruthy, parseModelSyncIntervalMs, parseOidcConfig } from "./config";

describe("environment booleans", () => {
	test("recognizes explicit chat feature-flag values", () => {
		expect(isTruthy("1")).toBe(true);
		expect(isTruthy("true")).toBe(true);
		expect(isTruthy("TRUE")).toBe(true);
		expect(isTruthy("0")).toBe(false);
		expect(isTruthy("false")).toBe(false);
		expect(isTruthy(undefined)).toBe(false);
	});
});

describe("model sync interval", () => {
	test("defaults to hourly, takes minutes, and 0 turns the timer off", () => {
		expect(parseModelSyncIntervalMs(undefined)).toBe(3_600_000);
		expect(parseModelSyncIntervalMs("")).toBe(3_600_000);
		expect(parseModelSyncIntervalMs("15")).toBe(900_000);
		expect(parseModelSyncIntervalMs("0")).toBe(0);
		expect(parseModelSyncIntervalMs("-5")).toBe(3_600_000);
		expect(parseModelSyncIntervalMs("soon")).toBe(3_600_000);
	});
});

const CREDENTIALS = {
	OIDC_ISSUER: "https://auth.example.com",
	OIDC_CLIENT_ID: "solar",
	OIDC_CLIENT_SECRET: "secret",
};

describe("parseOidcConfig", () => {
	test("is disabled until issuer and both credentials are present", () => {
		expect(parseOidcConfig({})).toBeNull();
		expect(
			parseOidcConfig({ OIDC_ISSUER: CREDENTIALS.OIDC_ISSUER }),
		).toBeNull();
		expect(
			parseOidcConfig({
				OIDC_ISSUER: CREDENTIALS.OIDC_ISSUER,
				OIDC_CLIENT_ID: "solar",
			}),
		).toBeNull();
		expect(
			parseOidcConfig({ ...CREDENTIALS, OIDC_CLIENT_SECRET: "   " }),
		).toBeNull();
	});

	test("applies defaults", () => {
		const oidc = parseOidcConfig(CREDENTIALS);
		expect(oidc?.displayName).toBe("SSO");
		expect(oidc?.scopes).toEqual(["openid", "profile", "email"]);
		expect(oidc?.disableSignUp).toBe(false);
		expect(oidc?.adminClaim).toBeUndefined();
		expect(oidc?.adminValue).toBeUndefined();
	});

	test("derives the discovery URL without doubling the slash", () => {
		expect(parseOidcConfig(CREDENTIALS)?.discoveryUrl).toBe(
			"https://auth.example.com/.well-known/openid-configuration",
		);
		const trailing = parseOidcConfig({
			...CREDENTIALS,
			OIDC_ISSUER: "https://auth.example.com/application/o/solar/",
		});
		expect(trailing?.discoveryUrl).toBe(
			"https://auth.example.com/application/o/solar/.well-known/openid-configuration",
		);
	});

	test("keeps the issuer verbatim so the iss check can match", () => {
		const issuer = "https://auth.example.com/application/o/solar/";
		expect(
			parseOidcConfig({ ...CREDENTIALS, OIDC_ISSUER: issuer })?.issuer,
		).toBe(issuer);
	});

	test("rejects cleartext public issuers and non-HTTP URL schemes", () => {
		expect(() =>
			parseOidcConfig({
				...CREDENTIALS,
				OIDC_ISSUER: "http://auth.example.com",
			}),
		).toThrow(/HTTPS/);
		expect(() =>
			parseOidcConfig({ ...CREDENTIALS, OIDC_ISSUER: "file:///tmp/oidc" }),
		).toThrow(/HTTPS/);
	});

	test("allows cleartext issuers only on explicit loopback hosts", () => {
		expect(
			parseOidcConfig({
				...CREDENTIALS,
				OIDC_ISSUER: "http://localhost:8080/realms/solar",
			})?.issuer,
		).toBe("http://localhost:8080/realms/solar");
		expect(
			parseOidcConfig({
				...CREDENTIALS,
				OIDC_ISSUER: "http://127.0.0.1:8080/realms/solar",
			})?.issuer,
		).toBe("http://127.0.0.1:8080/realms/solar");
		expect(
			parseOidcConfig({
				...CREDENTIALS,
				OIDC_ISSUER: "http://[::1]:8080/realms/solar",
			})?.issuer,
		).toBe("http://[::1]:8080/realms/solar");
	});

	test("rejects issuers with query strings or fragments", () => {
		for (const issuer of [
			"https://auth.example.com/realms/solar?tenant=solar",
			"https://auth.example.com/realms/solar#configuration",
			"https://auth.example.com/realms/solar?",
			"https://auth.example.com/realms/solar#",
		]) {
			expect(() =>
				parseOidcConfig({ ...CREDENTIALS, OIDC_ISSUER: issuer }),
			).toThrow(/query string or fragment/);
		}
	});

	test("parses scopes from either separator and always includes openid", () => {
		expect(
			parseOidcConfig({ ...CREDENTIALS, OIDC_SCOPES: "openid email groups" })
				?.scopes,
		).toEqual(["openid", "email", "groups"]);
		expect(
			parseOidcConfig({ ...CREDENTIALS, OIDC_SCOPES: "email, groups" })?.scopes,
		).toEqual(["openid", "email", "groups"]);
		expect(
			parseOidcConfig({ ...CREDENTIALS, OIDC_SCOPES: "  " })?.scopes,
		).toEqual(["openid", "profile", "email"]);
	});

	test("enables role mapping only when both halves are set", () => {
		expect(
			parseOidcConfig({ ...CREDENTIALS, OIDC_ADMIN_CLAIM: "groups" })
				?.adminClaim,
		).toBeUndefined();
		expect(
			parseOidcConfig({ ...CREDENTIALS, OIDC_ADMIN_VALUE: "solar-admins" })
				?.adminValue,
		).toBeUndefined();
		const both = parseOidcConfig({
			...CREDENTIALS,
			OIDC_ADMIN_CLAIM: "groups",
			OIDC_ADMIN_VALUE: "solar-admins",
		});
		expect(both?.adminClaim).toBe("groups");
		expect(both?.adminValue).toBe("solar-admins");
	});

	test("reads the sign-up switch and display name", () => {
		const oidc = parseOidcConfig({
			...CREDENTIALS,
			OIDC_DISABLE_SIGNUP: "yes",
			OIDC_DISPLAY_NAME: "Authentik",
		});
		expect(oidc?.disableSignUp).toBe(true);
		expect(oidc?.displayName).toBe("Authentik");
	});
});

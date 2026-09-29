import { describe, expect, it } from "bun:test";
import {
	buildFrpcArgs,
	buildFrpcEndpoint,
	buildFrpcSubdomain,
	buildFrpcUrl,
	repositoryNameFromRemote,
	sanitizeDnsLabel,
} from "./frpc";

describe("frpc helpers", () => {
	it("extracts repository names from common git remote formats", () => {
		expect(
			repositoryNameFromRemote("https://github.com/mcowger/solar.git"),
		).toBe("solar");
		expect(repositoryNameFromRemote("git@github.com:mcowger/solar.git")).toBe(
			"solar",
		);
	});

	it("creates a DNS-safe deterministic subdomain", () => {
		const subdomain = buildFrpcSubdomain("Solar", "feature/auth login");
		expect(subdomain).toBe("solar-feature-auth-login");
		expect(buildFrpcSubdomain("Solar", "feature/auth login")).toBe(subdomain);
	});

	it("keeps long subdomains within the DNS label limit", () => {
		const subdomain = buildFrpcSubdomain("solar", "a".repeat(100));
		expect(subdomain.length).toBeLessThanOrEqual(63);
		expect(subdomain).toMatch(/-[a-f0-9]{8}$/);
	});

	it("uses a fallback for labels with no DNS-safe characters", () => {
		expect(sanitizeDnsLabel("---", "fallback")).toBe("fallback");
	});

	it("builds a full URL only when the optional host is configured", () => {
		expect(buildFrpcUrl("solar-worktree", "dev.home.cowger.us")).toBe(
			"https://solar-worktree.dev.home.cowger.us",
		);
		expect(buildFrpcUrl("solar-worktree")).toBeUndefined();
	});

	it("builds the CLI proxy arguments", () => {
		expect(
			buildFrpcArgs({
				serverAddr: "192.168.0.2",
				serverPort: 7000,
				token: "secret",
				proxyName: "solar-worktree",
				localPort: 3456,
				subdomain: "solar-worktree",
			}),
		).toEqual([
			"http",
			"--server-addr",
			"192.168.0.2",
			"--server-port",
			"7000",
			"--token",
			"secret",
			"--proxy-name",
			"solar-worktree",
			"--local-ip",
			"127.0.0.1",
			"--local-port",
			"3456",
			"--sd",
			"solar-worktree",
			"--host-header-rewrite",
			"localhost",
		]);
	});

	it("builds the endpoint used by the dev lifecycle", () => {
		expect(
			buildFrpcEndpoint("Solar", "purple-turtle", "dev.home.cowger.us"),
		).toEqual({
			subdomain: "solar-purple-turtle",
			url: "https://solar-purple-turtle.dev.home.cowger.us",
		});
	});
});

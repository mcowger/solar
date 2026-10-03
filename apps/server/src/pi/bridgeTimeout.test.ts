import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { config } = await import("../config");
const { piConfig } = await import("./config");

describe("pi bridge timeout", () => {
	test("outlasts the MCP tool call it waits on", () => {
		const settable = config as { mcpToolTimeoutMs: number };
		const saved = settable.mcpToolTimeoutMs;
		settable.mcpToolTimeoutMs = 180_000;
		try {
			expect(piConfig.bridgeTimeoutMs).toBe(195_000);
		} finally {
			settable.mcpToolTimeoutMs = saved;
		}
	});

	test("the extension takes it from the environment Solar spawns pi with", () => {
		// extension.ts runs inside the pi child (its typebox import only resolves
		// there), so check its source rather than importing it.
		const source = readFileSync(
			join(import.meta.dir, "bridge", "extension.ts"),
			"utf-8",
		);
		expect(source).toContain("SOLAR_PI_BRIDGE_TIMEOUT_MS");
		expect(source).not.toMatch(/setTimeout\([^)]*,\s*120_000\)/);
	});
});

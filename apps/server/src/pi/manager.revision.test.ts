import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SOLAR_PI_AGENT_DIR = join(
	mkdtempSync(join(tmpdir(), "solar-pi-manager-test-")),
	"pi-agent",
);
const { spawnSignature } = await import("./manager");
const { recordPiModelConfig } = await import("./models");

test("a changed model config changes the spawn signature, so the next turn respawns pi", () => {
	const options = {
		identity: { conversationId: "c1", userId: "u1", isAdmin: false },
		systemPrompt: "prompt",
		bridgeUrl: "http://127.0.0.1:3000",
	} as unknown as Parameters<typeof spawnSignature>[0];
	recordPiModelConfig('{"providers":{"a":{}}}', "{}");
	const before = spawnSignature(options);
	expect(spawnSignature(options)).toBe(before);
	recordPiModelConfig('{"providers":{"b":{}}}', "{}");
	expect(spawnSignature(options)).not.toBe(before);
});

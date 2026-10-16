import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SOLAR_PI_AGENT_DIR = join(
	mkdtempSync(join(tmpdir(), "solar-pi-manager-exit-")),
	"pi-agent",
);

/** Stands in for pi's RpcClient: stop() ends the child, as a real one does. */
class FakeRpcClient {
	process = new EventEmitter();
	async start() {}
	async getState() {
		return {};
	}
	async stop() {
		this.process.emit("exit");
	}
}
mock.module("@earendil-works/pi-coding-agent", () => ({
	RpcClient: FakeRpcClient,
	ModelRegistry: class {},
	ModelRuntime: class {},
}));

const { PiSessionManager } = await import("./manager");
const { recordPiModelConfig } = await import("./models");

test("a process dropped on purpose is not reported as a crash and never takes its replacement down", async () => {
	const exits: string[] = [];
	const manager = new PiSessionManager();
	const options = {
		identity: { conversationId: "c1", userId: "u1", isAdmin: false },
		systemPrompt: "prompt",
		bridgeUrl: "http://127.0.0.1:3000",
		provider: "p",
		modelId: "m",
		onExit: (conversationId: string) => exits.push(conversationId),
	} as unknown as Parameters<typeof manager.acquire>[0];

	recordPiModelConfig('{"providers":{"a":{}}}', "{}");
	const first = await manager.acquire(options);
	// A model sync changes the config: the next turn respawns the process.
	recordPiModelConfig('{"providers":{"b":{}}}', "{}");
	const second = await manager.acquire(options);
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(second).not.toBe(first);
	expect(exits).toEqual([]);
	expect(manager.get("c1")).toBe(second);

	// A real crash of the current process is still reported and dropped.
	(second.client as unknown as FakeRpcClient).process.emit("exit");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(exits).toEqual(["c1"]);
	expect(manager.get("c1")).toBeUndefined();
	await manager.shutdown();
});

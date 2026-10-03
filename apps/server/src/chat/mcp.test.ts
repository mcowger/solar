import { beforeEach, describe, expect, mock, test } from "bun:test";

const state = {
	rows: [] as Array<Record<string, unknown>>,
	tools: { tools: [] as Array<Record<string, unknown>> },
	prompts: { prompts: [] as Array<Record<string, unknown>> },
	resources: { resources: [] as Array<Record<string, unknown>> },
	promptError: null as Error | null,
	resourceError: null as Error | null,
	requestOptions: [] as Array<{ method: string; options: unknown }>,
};

const query = {
	leftJoin() {
		return this;
	},
	select() {
		return this;
	},
	where() {
		return this;
	},
	execute: async () => state.rows,
};

mock.module("../db", () => ({
	db: { selectFrom: () => query },
}));

const logger = {
	withError() {
		return this;
	},
	withMetadata() {
		return this;
	},
	warn: mock(() => {}),
};

mock.module("../logger", () => ({ logger }));

class FakeTransport {
	async close() {}
}

class FakeClient {
	async connect() {}

	async listTools() {
		return state.tools;
	}

	async listPrompts() {
		if (state.promptError) throw state.promptError;
		return state.prompts;
	}

	async listResources() {
		if (state.resourceError) throw state.resourceError;
		return state.resources;
	}

	getServerVersion() {
		return { name: "fake-mcp" };
	}

	async callTool(_params: unknown, _schema: unknown, options?: unknown) {
		state.requestOptions.push({ method: "callTool", options });
		return { content: [{ type: "text", text: "ok" }] };
	}

	async getPrompt(_params: unknown, options?: unknown) {
		state.requestOptions.push({ method: "getPrompt", options });
		return { messages: [] };
	}

	async readResource(_params: unknown, options?: unknown) {
		state.requestOptions.push({ method: "readResource", options });
		return { contents: [] };
	}
}

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: FakeClient,
}));
mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: FakeTransport,
}));

const { resolveMcpTools, testMcpServer } = await import("./mcp");
const { config } = await import("../config");

beforeEach(() => {
	state.rows = [
		{
			id: "server-1",
			name: "Search",
			url: "https://mcp.example.test",
			headers: "{}",
			preferenceEnabled: null,
			conversationEnabled: null,
		},
	];
	state.tools = {
		tools: [
			{
				name: "search",
				description: "Search the web",
				inputSchema: { type: "object", properties: {} },
			},
		],
	};
	state.prompts = { prompts: [] };
	state.resources = { resources: [] };
	state.promptError = null;
	state.resourceError = null;
	state.requestOptions = [];
	logger.warn.mockClear();
});

describe("MCP capability discovery", () => {
	test("keeps tools when optional prompts and resources are unavailable", async () => {
		state.promptError = new Error("prompts/list is not supported");
		state.resourceError = new Error("resources/list is not supported");

		const tools = await resolveMcpTools("user-1", "conversation-1");

		expect(tools.map((tool) => tool.tool.name)).toEqual(["search"]);
		expect(logger.warn).toHaveBeenCalledTimes(2);
	});

	test("reports supported optional capabilities without affecting tools", async () => {
		state.prompts = { prompts: [{ name: "research" }] };
		state.resources = { resources: [{ uri: "resource://guide" }] };

		const tools = await resolveMcpTools("user-1", "conversation-1");

		expect(tools.map((tool) => tool.tool.name)).toEqual([
			"search",
			"list_prompts",
			"get_prompt",
			"list_resources",
			"read_resource",
		]);
	});

	test("connection tests succeed when only tools are supported", async () => {
		state.promptError = new Error("prompts/list is not supported");
		state.resourceError = new Error("resources/list is not supported");

		await expect(
			testMcpServer("https://mcp.example.test", {}),
		).resolves.toEqual({
			name: "fake-mcp",
			tools: 1,
			prompts: 0,
			resources: 0,
		});
	});
});

describe("MCP request timeout", () => {
	const settable = config as { mcpToolTimeoutMs: number };
	const saved = settable.mcpToolTimeoutMs;

	test("defaults to the MCP SDK's own 60s", () => {
		expect(saved).toBe(60_000);
	});

	test("tool calls, prompts and resource reads use the configured timeout", async () => {
		settable.mcpToolTimeoutMs = 180_000;
		try {
			state.prompts = { prompts: [{ name: "research" }] };
			state.resources = { resources: [{ uri: "resource://guide" }] };
			const tools = await resolveMcpTools("user-1", "conversation-1");
			const run = (name: string, args: Record<string, unknown>) =>
				tools.find((tool) => tool.tool.name === name)!.execute(args);

			await run("search", {});
			await run("get_prompt", { name: "research" });
			await run("read_resource", { uri: "resource://guide" });

			expect(state.requestOptions).toEqual([
				{ method: "callTool", options: { timeout: 180_000 } },
				{ method: "getPrompt", options: { timeout: 180_000 } },
				{ method: "readResource", options: { timeout: 180_000 } },
			]);
		} finally {
			settable.mcpToolTimeoutMs = saved;
		}
	});
});

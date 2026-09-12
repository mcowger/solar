import { beforeEach, describe, expect, mock, test } from "bun:test";

const state = {
	rows: [] as Array<Record<string, unknown>>,
	tools: { tools: [] as Array<Record<string, unknown>> },
	prompts: { prompts: [] as Array<Record<string, unknown>> },
	resources: { resources: [] as Array<Record<string, unknown>> },
	promptError: null as Error | null,
	resourceError: null as Error | null,
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
}

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: FakeClient,
}));
mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: FakeTransport,
}));

const { resolveMcpTools, testMcpServer } = await import("./mcp");

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
	logger.warn.mockClear();
});

describe("MCP capability discovery", () => {
	test("keeps tools when optional prompts and resources are unavailable", async () => {
		state.promptError = new Error("prompts/list is not supported");
		state.resourceError = new Error("resources/list is not supported");

		const tools = await resolveMcpTools("user-1", "conversation-1");

		expect(tools.map((tool) => tool.tool.name)).toEqual([
			"mcp_server_1_search",
		]);
		expect(logger.warn).toHaveBeenCalledTimes(2);
	});

	test("reports supported optional capabilities without affecting tools", async () => {
		state.prompts = { prompts: [{ name: "research" }] };
		state.resources = { resources: [{ uri: "resource://guide" }] };

		const tools = await resolveMcpTools("user-1", "conversation-1");

		expect(tools.map((tool) => tool.tool.name)).toEqual([
			"mcp_server_1_search",
			"mcp_server_1_list_prompts",
			"mcp_server_1_get_prompt",
			"mcp_server_1_list_resources",
			"mcp_server_1_read_resource",
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

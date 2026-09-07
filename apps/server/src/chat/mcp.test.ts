import { describe, expect, mock, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// mcp.ts imports the shared sqlite handle; none of these tests touch it.
mock.module("../db", () => ({ db: {} }));
const { discoverMcpServer, toolsForServer } = await import("./mcp");

async function connectTo(server: McpServer): Promise<Client> {
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "test", version: "0.0.0" });
	await client.connect(clientTransport);
	return client;
}

const echo = async () => ({ content: [{ type: "text" as const, text: "ok" }] });

describe("discoverMcpServer", () => {
	test("asks only for what the server declares, so a tools-only server is not dropped", async () => {
		// A server with tools but no prompts capability answers prompts/list with
		// JSON-RPC -32601 (Method not found). Listing unconditionally turned that
		// into a thrown error and the whole server was skipped.
		const server = new McpServer({ name: "tools-only", version: "1.0.0" });
		server.registerTool(
			"search",
			{ description: "Search", inputSchema: { query: z.string() } },
			echo,
		);
		const found = await discoverMcpServer(await connectTo(server));
		expect(found.tools.map((tool) => tool.name)).toEqual(["search"]);
		expect(found.prompts).toEqual([]);
		expect(found.resources).toEqual([]);
		expect(found.capabilities).toEqual({ prompts: false, resources: false });
	});

	test("lists tools even when the server did not declare the tools capability", async () => {
		// Proxies, gateways and older frameworks answer tools/list without
		// advertising `tools`. Trusting the declaration there would drop every
		// tool with no error. Only the optional prompts/resources calls are
		// gated; tools/list is always asked, as it was before this change.
		const stub = {
			getServerCapabilities: () => ({}),
			listTools: async () => ({
				tools: [{ name: "search", inputSchema: { type: "object" } }],
			}),
			listPrompts: async () => {
				throw new Error("prompts/list must not be called");
			},
			listResources: async () => {
				throw new Error("resources/list must not be called");
			},
		} as unknown as Client;
		const found = await discoverMcpServer(stub);
		expect(found.tools.map((tool) => tool.name)).toEqual(["search"]);
		expect(found.prompts).toEqual([]);
		expect(found.resources).toEqual([]);
		expect(found.capabilities).toEqual({ prompts: false, resources: false });
	});

	test("still lists prompts and resources when the server declares them", async () => {
		const server = new McpServer({ name: "full", version: "1.0.0" });
		server.registerTool("t", { description: "t" }, echo);
		server.registerPrompt("p", { description: "p" }, () => ({
			messages: [{ role: "user", content: { type: "text", text: "hi" } }],
		}));
		server.registerResource(
			"r",
			"res://r",
			{ description: "r", mimeType: "text/plain" },
			async () => ({ contents: [{ uri: "res://r", text: "x" }] }),
		);
		const found = await discoverMcpServer(await connectTo(server));
		expect(found.tools.map((tool) => tool.name)).toEqual(["t"]);
		expect(found.prompts.map((prompt) => prompt.name)).toEqual(["p"]);
		expect(found.resources.map((resource) => resource.uri)).toEqual([
			"res://r",
		]);
		expect(found.capabilities).toEqual({ prompts: true, resources: true });
	});
});

describe("toolsForServer", () => {
	const server = {
		id: "abc-def",
		name: "Web search",
		url: "http://searxng-mcp:3000/mcp",
		headers: "{}",
	};
	const search = {
		name: "search",
		description: "Search",
		inputSchema: { type: "object" as const },
	};

	test("omits the prompt and resource helper tools a server cannot serve", () => {
		const names = toolsForServer(server, {
			tools: [search],
			prompts: [],
			resources: [],
			capabilities: { prompts: false, resources: true },
		}).map((resolved) => resolved.remoteName);
		expect(names).toEqual(["search", "list_resources", "read_resource"]);
	});

	test("keeps every helper tool for a server that declares both", () => {
		const names = toolsForServer(server, {
			tools: [search],
			prompts: [],
			resources: [],
			capabilities: { prompts: true, resources: true },
		}).map((resolved) => resolved.remoteName);
		expect(names).toEqual([
			"search",
			"list_prompts",
			"get_prompt",
			"list_resources",
			"read_resource",
		]);
	});

	test("namespaces remote tool names by server id", () => {
		const [resolved] = toolsForServer(server, {
			tools: [search],
			prompts: [],
			resources: [],
			capabilities: { prompts: false, resources: false },
		});
		if (!resolved) throw new Error("expected one resolved tool");
		expect(resolved.tool.name).toBe("mcp_abc_def_search");
		expect(resolved.tool.description).toBe("[Web search] Search");
	});
});

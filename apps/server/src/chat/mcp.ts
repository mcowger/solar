import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
	Prompt,
	Resource,
	Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import { Type, type Tool } from "@earendil-works/pi-ai";
import { db } from "../db";

export interface ResolvedTool {
	tool: Tool;
	serverName: string;
	remoteName: string;
	execute: (
		args: Record<string, unknown>,
	) => Promise<{ content: string; isError: boolean }>;
}

interface ServerRow {
	id: string;
	name: string;
	url: string;
	headers: string;
}

const CLIENT_INFO = { name: "Solar", version: "0.1.0" };
const asText = (value: unknown) => JSON.stringify(value, null, 2);
const toolName = (serverId: string, name: string) =>
	`mcp_${serverId.replaceAll("-", "_")}_${name}`;

function parseHeaders(headers: string): Record<string, string> {
	try {
		const parsed = JSON.parse(headers);
		return parsed && typeof parsed === "object"
			? Object.fromEntries(
					Object.entries(parsed).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				)
			: {};
	} catch {
		return {};
	}
}

async function withClient<T>(
	server: ServerRow,
	fn: (client: Client) => Promise<T>,
): Promise<T> {
	const transport = new StreamableHTTPClientTransport(new URL(server.url), {
		requestInit: { headers: parseHeaders(server.headers) },
	});
	const client = new Client(CLIENT_INFO);
	await client.connect(transport);
	try {
		return await fn(client);
	} finally {
		await transport.close();
	}
}

export interface McpDiscovery {
	tools: McpTool[];
	prompts: Prompt[];
	resources: Resource[];
	/** Which optional list/get helpers the server can actually answer. */
	capabilities: { prompts: boolean; resources: boolean };
}

/**
 * Lists what a connected server offers. tools/list is always asked, as
 * before: proxies, gateways and older frameworks answer it without
 * advertising the `tools` capability, and trusting the declaration there
 * would drop every tool with no error. The optional prompts/resources lists
 * are asked only when declared: a server without the `prompts` capability
 * answers `prompts/list` with JSON-RPC -32601 (Method not found), and
 * listing it unconditionally turned that into a thrown error that silently
 * dropped every tools-only server (most search or fetch servers).
 */
export async function discoverMcpServer(client: Client): Promise<McpDiscovery> {
	const declared = client.getServerCapabilities() ?? {};
	const [tools, prompts, resources] = await Promise.all([
		client.listTools(),
		declared.prompts ? client.listPrompts() : Promise.resolve({ prompts: [] }),
		declared.resources
			? client.listResources()
			: Promise.resolve({ resources: [] }),
	]);
	return {
		tools: tools.tools,
		prompts: prompts.prompts,
		resources: resources.resources,
		capabilities: {
			prompts: Boolean(declared.prompts),
			resources: Boolean(declared.resources),
		},
	};
}

export async function testMcpServer(
	url: string,
	headers: Record<string, string>,
): Promise<{
	name?: string;
	tools: number;
	prompts: number;
	resources: number;
}> {
	return withClient(
		{ id: "test", name: "test", url, headers: JSON.stringify(headers) },
		async (client) => {
			const found = await discoverMcpServer(client);
			return {
				name: client.getServerVersion()?.name,
				tools: found.tools.length,
				prompts: found.prompts.length,
				resources: found.resources.length,
			};
		},
	);
}

/**
 * The model-facing tools for one server: each remote tool, plus the prompt
 * and resource helpers - only for the capabilities the server declared, so
 * the model is never offered a helper that can only fail.
 */
export function toolsForServer(
	server: ServerRow,
	discovered: McpDiscovery,
): ResolvedTool[] {
	const result: ResolvedTool[] = [];
	for (const remote of discovered.tools) {
		result.push({
			tool: {
				name: toolName(server.id, remote.name),
				description: `[${server.name}] ${remote.description ?? remote.name}`,
				parameters: Type.Unsafe(remote.inputSchema),
			},
			serverName: server.name,
			remoteName: remote.name,
			execute: async (args) =>
				withClient(server, async (client) => {
					const response = await client.callTool({
						name: remote.name,
						arguments: args,
					});
					return {
						content: asText(response),
						isError: "isError" in response && Boolean(response.isError),
					};
				}),
		});
	}
	if (discovered.capabilities.prompts) {
		result.push({
			tool: {
				name: toolName(server.id, "list_prompts"),
				description: `[${server.name}] List available MCP prompts`,
				parameters: Type.Object({}),
			},
			serverName: server.name,
			remoteName: "list_prompts",
			execute: async () => ({
				content: asText(
					await withClient(server, (client) => client.listPrompts()),
				),
				isError: false,
			}),
		});
		result.push({
			tool: {
				name: toolName(server.id, "get_prompt"),
				description: `[${server.name}] Get an MCP prompt by name`,
				parameters: Type.Object({
					name: Type.String(),
					arguments: Type.Optional(Type.Record(Type.String(), Type.String())),
				}),
			},
			serverName: server.name,
			remoteName: "get_prompt",
			execute: async (args) => ({
				content: asText(
					await withClient(server, (client) =>
						client.getPrompt({
							name: String(args.name),
							arguments: args.arguments as Record<string, string> | undefined,
						}),
					),
				),
				isError: false,
			}),
		});
	}
	if (discovered.capabilities.resources) {
		result.push({
			tool: {
				name: toolName(server.id, "list_resources"),
				description: `[${server.name}] List available MCP resources`,
				parameters: Type.Object({}),
			},
			serverName: server.name,
			remoteName: "list_resources",
			execute: async () => ({
				content: asText(
					await withClient(server, (client) => client.listResources()),
				),
				isError: false,
			}),
		});
		result.push({
			tool: {
				name: toolName(server.id, "read_resource"),
				description: `[${server.name}] Read an MCP resource by URI`,
				parameters: Type.Object({ uri: Type.String() }),
			},
			serverName: server.name,
			remoteName: "read_resource",
			execute: async (args) => ({
				content: asText(
					await withClient(server, (client) =>
						client.readResource({ uri: String(args.uri) }),
					),
				),
				isError: false,
			}),
		});
	}
	return result;
}

/**
 * Maps persisted MCP tool names (`mcp_<serverId>_<remoteName>`, see `toolName`
 * above) back to their display {serverName, remoteName}, without contacting
 * any MCP server. Used to render tool-call chips for history loaded from the
 * DB, where the live per-generation `serverName`/`remoteName` metadata (built
 * while resolving tools for the run) isn't persisted.
 */
export async function describeToolNames(
	names: readonly string[],
): Promise<Map<string, { serverName: string; remoteName: string }>> {
	const result = new Map<string, { serverName: string; remoteName: string }>();
	const mcpNames = names.filter((name) => name.startsWith("mcp_"));
	if (!mcpNames.length) return result;
	const servers = await db
		.selectFrom("mcp_server")
		.select(["id", "name"])
		.execute();
	for (const name of mcpNames) {
		for (const server of servers) {
			const prefix = toolName(server.id, "");
			if (name.startsWith(prefix)) {
				result.set(name, {
					serverName: server.name,
					remoteName: name.slice(prefix.length),
				});
				break;
			}
		}
	}
	return result;
}

export async function resolveMcpTools(
	userId: string,
	conversationId: string,
): Promise<ResolvedTool[]> {
	const rows = await db
		.selectFrom("mcp_server")
		.leftJoin("user_mcp_server_preference", (join) =>
			join
				.onRef("user_mcp_server_preference.serverId", "=", "mcp_server.id")
				.on("user_mcp_server_preference.userId", "=", userId),
		)
		.leftJoin("v2_conversation_mcp_server", (join) =>
			join
				.onRef("v2_conversation_mcp_server.serverId", "=", "mcp_server.id")
				.on("v2_conversation_mcp_server.conversationId", "=", conversationId),
		)
		.select([
			"mcp_server.id",
			"mcp_server.name",
			"mcp_server.url",
			"mcp_server.headers",
			"user_mcp_server_preference.enabled as preferenceEnabled",
			"v2_conversation_mcp_server.enabled as conversationEnabled",
		])
		.where("mcp_server.enabled", "=", 1)
		.where((eb) =>
			eb.or([
				eb("mcp_server.userId", "is", null),
				eb("mcp_server.userId", "=", userId),
			]),
		)
		.execute();
	const active = rows.filter(
		(row) => (row.conversationEnabled ?? row.preferenceEnabled ?? 1) === 1,
	);
	const result: ResolvedTool[] = [];
	for (const server of active) {
		try {
			const discovered = await withClient(server, discoverMcpServer);
			result.push(...toolsForServer(server, discovered));
		} catch {
			// An unavailable server must not prevent unrelated servers or chat from working.
		}
	}
	return result;
}

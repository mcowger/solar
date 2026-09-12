import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type, type Tool } from "@earendil-works/pi-ai";
import { db } from "../db";
import { logger } from "../logger";

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

type DiscoveredCapabilities = {
	tools: Awaited<ReturnType<Client["listTools"]>>;
	prompts: Awaited<ReturnType<Client["listPrompts"]>> | null;
	resources: Awaited<ReturnType<Client["listResources"]>> | null;
};

async function optionalCapability<T>(options: {
	server: ServerRow;
	conversationId?: string;
	name: "prompts" | "resources";
	load: () => Promise<T>;
}): Promise<T | null> {
	try {
		return await options.load();
	} catch (error) {
		logger
			.withError(error)
			.withMetadata({
				mcpServer: options.server.name,
				...(options.conversationId
					? { conversationId: options.conversationId }
					: {}),
				capability: options.name,
			})
			.warn("MCP optional capability discovery failed");
		return null;
	}
}

async function discoverCapabilitiesWithClient(
	server: ServerRow,
	client: Client,
	conversationId?: string,
): Promise<DiscoveredCapabilities> {
	// Tool discovery is required. Prompts and resources are optional MCP
	// capabilities and must not prevent valid tools from being registered.
	const tools = await client.listTools();
	const [prompts, resources] = await Promise.all([
		optionalCapability({
			server,
			conversationId,
			name: "prompts",
			load: () => client.listPrompts(),
		}),
		optionalCapability({
			server,
			conversationId,
			name: "resources",
			load: () => client.listResources(),
		}),
	]);
	return { tools, prompts, resources };
}

async function discoverCapabilities(
	server: ServerRow,
	conversationId?: string,
): Promise<DiscoveredCapabilities> {
	return withClient(server, (client) =>
		discoverCapabilitiesWithClient(server, client, conversationId),
	);
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
	const server = {
		id: "test",
		name: "test",
		url,
		headers: JSON.stringify(headers),
	};
	return withClient(server, async (client) => {
		const discovered = await discoverCapabilitiesWithClient(server, client);
		return {
			name: client.getServerVersion()?.name,
			tools: discovered.tools.tools.length,
			prompts: discovered.prompts?.prompts.length ?? 0,
			resources: discovered.resources?.resources.length ?? 0,
		};
	});
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
			const discovered = await discoverCapabilities(server, conversationId);
			for (const remote of discovered.tools.tools) {
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
			if (discovered.prompts) {
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
							arguments: Type.Optional(
								Type.Record(Type.String(), Type.String()),
							),
						}),
					},
					serverName: server.name,
					remoteName: "get_prompt",
					execute: async (args) => ({
						content: asText(
							await withClient(server, (client) =>
								client.getPrompt({
									name: String(args.name),
									arguments: args.arguments as
										| Record<string, string>
										| undefined,
								}),
							),
						),
						isError: false,
					}),
				});
			}
			if (discovered.resources) {
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
		} catch (error) {
			logger
				.withError(error)
				.withMetadata({
					conversationId,
					mcpServer: server.name,
				})
				.warn("MCP tool discovery failed");
		}
	}
	return result;
}

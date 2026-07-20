import { resolveBuiltinTools } from "./builtins";
import { resolveMcpTools, type ResolvedTool } from "./mcp";

export interface ToolResolutionContext {
	userId: string;
	conversationId: string;
}

export interface ToolProvider {
	resolve(context: ToolResolutionContext): Promise<ResolvedTool[]>;
}

class BuiltinToolProvider implements ToolProvider {
	async resolve(): Promise<ResolvedTool[]> {
		return resolveBuiltinTools();
	}
}

class McpToolProvider implements ToolProvider {
	async resolve(context: ToolResolutionContext): Promise<ResolvedTool[]> {
		return resolveMcpTools(context.userId, context.conversationId);
	}
}

class CompositeToolProvider implements ToolProvider {
	constructor(private readonly providers: ToolProvider[]) {}

	async resolve(context: ToolResolutionContext): Promise<ResolvedTool[]> {
		const lists = await Promise.all(
			this.providers.map((provider) => provider.resolve(context)),
		);
		return lists.flat();
	}
}

export const toolProvider = new CompositeToolProvider([
	new BuiltinToolProvider(),
	new McpToolProvider(),
]);

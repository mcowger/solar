import type { Tool } from "@earendil-works/pi-ai";
import { resolveMcpTools, type ResolvedTool } from "./mcp";

export interface ToolResolutionContext {
  userId: string;
  conversationId: string;
}

export interface ToolProvider {
  resolve(context: ToolResolutionContext): Promise<ResolvedTool[]>;
}

class McpToolProvider implements ToolProvider {
  async resolve(context: ToolResolutionContext): Promise<ResolvedTool[]> {
    return resolveMcpTools(context.userId, context.conversationId);
  }
}

export const toolProvider = new McpToolProvider();

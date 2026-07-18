import type { Tool } from "@earendil-works/pi-ai";

export interface ToolResolutionContext {
  userId: string;
  conversationId: string;
}

export interface ToolProvider {
  resolve(context: ToolResolutionContext): Promise<Tool[]>;
}

class EmptyToolProvider implements ToolProvider {
  async resolve(_context: ToolResolutionContext): Promise<Tool[]> {
    return [];
  }
}

export const toolProvider = new EmptyToolProvider();

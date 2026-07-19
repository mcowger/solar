export type UiChunk =
	| { type: "start"; messageId: string }
	| { type: "text-delta"; textDelta: string }
	| { type: "reasoning-delta"; delta: string }
	| {
			type: "tool-call-start";
			toolCallId: string;
			toolName: string;
			serverName?: string;
			remoteName?: string;
	  }
	| { type: "tool-call-delta"; toolCallId: string; argsText: string }
	| { type: "tool-call-end"; toolCallId: string }
	| {
			type: "tool-call-result";
			toolCallId: string;
			output: string;
			isError: boolean;
	  }
	| {
			type: "finish";
			finishReason: string;
			usage: { inputTokens: number; outputTokens: number };
	  }
	| { type: "title-update"; title: string }
	| { type: "error"; errorText: string };

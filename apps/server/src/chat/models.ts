import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { ResolvedTool } from "./mcp";
import type { ToolCallResultEvent } from "./adapter";
import {
	modelCallTelemetry,
	type ChatProviderCall,
	type ProviderCallObservation,
	type TelemetryMetadata,
} from "../context/telemetry";
import {
	MOCK,
	resolveModel,
	streamModel,
	type GenerationParams,
	type ModelSelection,
} from "./catalog";

export interface StreamChatOptions {
	telemetry?: TelemetryMetadata;
	onGenerationStep?: (message: AssistantMessage | ToolResultMessage) => void;
	onProviderCall?: (call: ChatProviderCall) => void;
}

/**
 * Stream an assistant turn as pi-ai events for the chosen model.
 *
 * The `mock` provider (available when SOLAR_MOCK_LLM is set) is served by a
 * local echo generator so no provider API is called and nothing is billed —
 * used for local development and UI verification only. All other providers are
 * streamed through pi-ai with the DB-configured key/baseURL.
 */
export async function* streamChat(
	context: Context,
	selection: ModelSelection,
	params: GenerationParams,
	signal: AbortSignal,
	resolvedTools: ResolvedTool[] = [],
	options: StreamChatOptions = {},
): AsyncIterable<AssistantMessageEvent | ToolCallResultEvent> {
	if (selection.provider === "mock") {
		const startedAt = Date.now();
		let message: AssistantMessage | undefined;
		let error: unknown;
		try {
			for await (const event of mockStream(
				context,
				selection,
				params,
				signal,
			)) {
				if (event.type === "done") message = event.message;
				yield event;
			}
		} catch (caught) {
			error = caught;
			throw caught;
		} finally {
			options.onProviderCall?.({
				purpose: "chat",
				observation: modelCallTelemetry(
					selection,
					message,
					Date.now() - startedAt,
					options.telemetry,
					undefined,
					error,
				),
			});
		}
		return;
	}
	const resolved = await resolveModel(selection);
	const executors = new Map(
		resolvedTools.map(({ tool, execute }) => [tool.name, execute]),
	);
	let turnContext = context;
	let toolStepsCompleted = false;
	while (true) {
		const startedAt = Date.now();
		let message: AssistantMessage | undefined;
		let reason: string | undefined;
		let error: unknown;
		let outputStarted = false;
		try {
			const events = streamModel(resolved, turnContext, signal, params);
			for await (const event of events) {
				yield event;
				if (event.type !== "start") outputStarted = true;
				if (event.type === "done") {
					message = event.message;
					reason = event.reason;
				} else if (event.type === "error") {
					message = event.error;
				}
			}
		} catch (caught) {
			error = caught;
			throw caught;
		} finally {
			options.onProviderCall?.({
				purpose: toolStepsCompleted ? "tool_loop" : "chat",
				observation: modelCallTelemetry(
					selection,
					message,
					Date.now() - startedAt,
					options.telemetry,
					resolved.model.contextWindow,
					error,
					outputStarted,
					toolStepsCompleted,
				),
			});
		}
		if (!message || reason !== "toolUse") return;
		const calls = message.content.filter((part) => part.type === "toolCall");
		if (calls.length === 0) return;
		options.onGenerationStep?.(message);
		const results = await Promise.all(
			calls.map(async (call) => {
				const execute = executors.get(call.name);
				if (!execute) {
					const output = "Tool is unavailable.";
					return {
						result: {
							role: "toolResult" as const,
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: "text" as const, text: output }],
							isError: true,
							timestamp: Date.now(),
						},
						chunk: {
							type: "tool-call-result" as const,
							toolCallId: call.id,
							output,
							isError: true,
						},
					};
				}
				try {
					const result = await execute(call.arguments);
					return {
						result: {
							role: "toolResult" as const,
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: "text" as const, text: result.content }],
							isError: result.isError,
							timestamp: Date.now(),
						},
						chunk: {
							type: "tool-call-result" as const,
							toolCallId: call.id,
							output: result.content,
							isError: result.isError,
						},
					};
				} catch (error) {
					const output = error instanceof Error ? error.message : String(error);
					return {
						result: {
							role: "toolResult" as const,
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: "text" as const, text: output }],
							isError: true,
							timestamp: Date.now(),
						},
						chunk: {
							type: "tool-call-result" as const,
							toolCallId: call.id,
							output,
							isError: true,
						},
					};
				}
			}),
		);
		for (const { chunk, result } of results) {
			options.onGenerationStep?.(result);
			yield chunk;
		}
		toolStepsCompleted = true;
		turnContext = {
			...turnContext,
			messages: [
				...turnContext.messages,
				message,
				...results.map(({ result }) => result),
			],
		};
	}
}

function mockMessage(
	text: string,
	selection: ModelSelection,
	thinking?: string,
): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (thinking) content.push({ type: "thinking", thinking });
	content.push({ type: "text", text });
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: selection.provider,
		model: selection.modelId,
		usage: { input: 0, output: 0 },
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

async function* mockStream(
	context: Context,
	selection: ModelSelection,
	params: GenerationParams,
	signal: AbortSignal,
): AsyncIterable<AssistantMessageEvent> {
	if (signal.aborted) throw new DOMException("aborted", "AbortError");
	const lastUser = [...context.messages]
		.reverse()
		.find((m) => m.role === "user");
	const prompt =
		lastUser && typeof lastUser.content === "string" ? lastUser.content : "";

	yield {
		type: "start",
		partial: mockMessage("", selection),
	} as AssistantMessageEvent;

	// When reasoning is requested, stream a canned "thinking" block first so the
	// reasoning UI can be exercised at zero cost.
	let thinkingAcc = "";
	if (params.reasoningEffort) {
		const thinking =
			`Reasoning (${params.reasoningEffort}) about: ${prompt}. ` +
			"Step 1: parse. Step 2: consider options. Step 3: answer.";
		const thoughtToks = thinking.match(/\S+\s*|\s+/g) ?? [thinking];
		for (const tok of thoughtToks) {
			if (signal.aborted) throw new DOMException("aborted", "AbortError");
			thinkingAcc += tok;
			yield {
				type: "thinking_delta",
				contentIndex: 0,
				delta: tok,
				partial: mockMessage("", selection, thinkingAcc),
			} as AssistantMessageEvent;
			await new Promise((r) => setTimeout(r, 25));
		}
	}

	const reply =
		`**Mock reply** (${selection.modelId}) to: ${prompt}\n\n` +
		"Inline code `x = 1`, a fenced block:\n\n" +
		'```js\nconsole.log("hello");\n```\n\n' +
		"And display math: $$E = mc^2$$\n\n" +
		"Sources: [React documentation](https://react.dev/), [MDN Web Docs](https://developer.mozilla.org/), [TypeScript handbook](https://www.typescriptlang.org/docs/), and [Bun documentation](https://bun.sh/docs).";

	const tokens = reply.match(/\S+\s*|\s+/g) ?? [reply];
	let acc = "";
	for (const tok of tokens) {
		if (signal.aborted) {
			throw new DOMException("aborted", "AbortError");
		}
		acc += tok;
		yield {
			type: "text_delta",
			contentIndex: 0,
			delta: tok,
			partial: mockMessage(acc, selection, thinkingAcc || undefined),
		} as AssistantMessageEvent;
		await new Promise((r) => setTimeout(r, 25));
	}

	yield {
		type: "done",
		reason: "stop",
		message: mockMessage(acc, selection, thinkingAcc || undefined),
	};
}

export { MOCK };

export async function generateTitle(
	prompt: string,
	selection: ModelSelection,
	options: StreamChatOptions = {},
): Promise<string> {
	const context: Context = {
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	};
	let text = "";
	for await (const event of streamChat(
		context,
		selection,
		{},
		new AbortController().signal,
		[],
		options,
	)) {
		if (event.type === "error") {
			throw new Error(event.error.errorMessage ?? "Title generation failed");
		}
		if (event.type === "text_delta") text += event.delta;
	}
	return text;
}

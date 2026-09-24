// @ts-nocheck -- this file is not part of Solar's module graph: it is read as
// source by the spawned `pi` process and transpiled/loaded there via pi's own
// jiti extension loader, which aliases @earendil-works/pi-coding-agent and
// typebox into its own node_modules tree (see pi-spike/extension.ts for the
// same convention).
//
// Runs INSIDE the `pi --mode rpc` child process, loaded by pi's own jiti-based
// extension loader (which aliases @earendil-works/pi-coding-agent and typebox).
// Solar's tsc does not typecheck this file against the pi child's module
// resolution, so it stays intentionally self-contained and defensive.
//
// The extension is Solar's generic bridge (see docs/planning/pi-rpc-rewrite.md):
// - session_start: fetch this conversation's resolved tool list from Solar and
//   register each as a custom tool whose execute() proxies back over HTTP.
// - context: before every provider call, expand <solar-attachments> markers
//   into real (model-capability-aware) content parts for that request only —
//   attachment bytes are never persisted into the pi session JSONL.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BRIDGE_URL = process.env.SOLAR_PI_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.SOLAR_PI_BRIDGE_TOKEN;
// Solar's MCP tool timeout plus headroom (piConfig.bridgeTimeoutMs); 120s when
// spawned by a Solar that does not pass it.
const BRIDGE_TIMEOUT_MS =
	Number(process.env.SOLAR_PI_BRIDGE_TIMEOUT_MS) > 0
		? Number(process.env.SOLAR_PI_BRIDGE_TIMEOUT_MS)
		: 120_000;

async function bridge(path: string, init?: RequestInit): Promise<unknown> {
	if (!BRIDGE_URL || !BRIDGE_TOKEN) {
		throw new Error("solar pi bridge env not configured");
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
	try {
		const response = await fetch(`${BRIDGE_URL}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${BRIDGE_TOKEN}`,
				"content-type": "application/json",
				...(init?.headers ?? {}),
			},
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`bridge ${path} -> ${response.status}`);
		}
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}

interface BridgedTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

interface AttachmentPart {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

/** Fresh regex per call: /g regexes carry lastIndex state across uses. */
function attachmentMarker(): RegExp {
	return /<solar-attachments\s+ids="([^"]*)"\s*\/>/g;
}

function attachmentIdsIn(text: string): string[] {
	const ids: string[] = [];
	for (const match of text.matchAll(attachmentMarker())) {
		for (const id of (match[1] ?? "").split(",").filter(Boolean)) ids.push(id);
	}
	return ids;
}

interface TextBlock {
	type: "text";
	text: string;
}

type ContentCarrier = {
	content: string | (TextBlock | Record<string, unknown>)[];
};

/** AgentMessage is a union; only real conversation messages carry content. */
function withContent(message: unknown): ContentCarrier | null {
	if (message && typeof message === "object" && "content" in message) {
		return message as ContentCarrier;
	}
	return null;
}

function textsOf(carrier: ContentCarrier): string[] {
	if (typeof carrier.content === "string") return [carrier.content];
	return carrier.content
		.filter((part): part is TextBlock => (part as TextBlock).type === "text")
		.map((part) => part.text);
}

export default async function solarBridgeExtension(pi: ExtensionAPI) {
	// Edit/regenerate for Solar: branch the session tree at the target's parent
	// (the branch pointer only lives in-process, so Solar can't set it from
	// outside — navigateTree is only command-context), then append the prompt.
	// Solar sends /solar-reprompt <json{parentEntryId, text}> as the prompt.
	pi.registerCommand("solar-reprompt", {
		description: "Solar: branch to a prior point, then send a user message",
		handler: async (args, ctx) => {
			const { parentEntryId, text } = JSON.parse(args) as {
				parentEntryId: string | null;
				text: string;
			};
			if (parentEntryId) await ctx.navigateTree(parentEntryId);
			await pi.sendUserMessage(text);
		},
	} as Parameters<ExtensionAPI["registerCommand"]>[1]);

	pi.on("session_start", async () => {
		try {
			const { tools } = (await bridge("/internal/pi-bridge/tools")) as {
				tools: BridgedTool[];
			};
			for (const tool of tools ?? []) {
				pi.registerTool({
					name: tool.name,
					label: tool.name,
					description: tool.description,
					parameters: Type.Unsafe(tool.parameters as never),
					execute: async (_toolCallId, params) => {
						try {
							const result = (await bridge(
								"/internal/pi-bridge/tools/execute",
								{
									method: "POST",
									body: JSON.stringify({ toolName: tool.name, args: params }),
								},
							)) as { content: string; isError: boolean };
							return {
								content: [{ type: "text", text: result.content }],
								isError: result.isError,
							};
						} catch (error) {
							return {
								content: [
									{
										type: "text",
										text: `Tool call failed to reach Solar: ${(error as Error).message}`,
									},
								],
								isError: true,
							};
						}
					},
				} as Parameters<ExtensionAPI["registerTool"]>[0]);
			}
		} catch (error) {
			// Surface, but keep the session alive with zero tools rather than
			// failing generation entirely: the user gets a text-only reply.
			console.error("[solar-pi-bridge] failed to load tools:", error);
		}
	});

	pi.on("context", async (event) => {
		const requestedIds = new Set<string>();
		for (const message of event.messages) {
			const carrier = withContent(message);
			if (!carrier) continue;
			for (const text of textsOf(carrier)) {
				for (const id of attachmentIdsIn(text)) requestedIds.add(id);
			}
		}
		if (requestedIds.size === 0) return {};
		let partsById: Record<string, AttachmentPart>;
		try {
			({ partsById } = (await bridge(
				`/internal/pi-bridge/attachments?ids=${[...requestedIds].join(",")}`,
			)) as { partsById: Record<string, AttachmentPart> });
		} catch (error) {
			console.error("[solar-pi-bridge] attachment expansion failed:", error);
			return {};
		}
		const messages = event.messages.map((message) => {
			const carrier = withContent(message);
			if (!carrier) return message;
			const baseParts: unknown[] =
				typeof carrier.content === "string"
					? [{ type: "text", text: carrier.content }]
					: [...carrier.content];
			let touched = false;
			const extra: unknown[] = [];
			const rewritten = baseParts
				.map((part) => {
					const textPart = part as { type?: string; text?: string };
					if (textPart.type !== "text" || textPart.text === undefined)
						return part;
					const ids = attachmentIdsIn(textPart.text);
					if (ids.length === 0) return part;
					touched = true;
					for (const id of ids) {
						const expanded = partsById[id];
						if (expanded) extra.push(expanded);
					}
					const cleaned = textPart.text.replace(attachmentMarker(), "");
					return cleaned.trim()
						? ({ ...textPart, text: cleaned } as unknown)
						: undefined;
				})
				.filter((part): part is unknown => part !== undefined);
			return touched
				? { ...message, content: [...rewritten, ...extra] }
				: message;
		});
		return { messages };
	});
}

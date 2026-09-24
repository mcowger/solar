/**
 * PiChatEngine — the pi-engine equivalents of chat/v2Live's send/edit/
 * regenerate/stop: Solar sends (or replaces) a user message as a pi prompt
 * against the conversation's own process (PiSessionManager), translates the
 * live JsonAgentSessionEvent stream into Solar's existing UiChunk SSE
 * contract (PiGenerationRegistry), and leaves all message persistence to the
 * child's SessionManager (plan: Core principle — pi's JSONL is canonical).
 *
 * Edit/regenerate are pi-style sibling branches (plan: Current seams): branch
 * to the target's parent, then prompt again — the abandoned path stays on
 * disk, inert and recoverable; the UI renders only the current path.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	SessionManager,
	type RpcClient,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import {
	renderBuiltinPromptInterpolations,
	type UserLocation,
} from "../chat/builtins";
import {
	getTitlePrompt,
	mockForcedSelection,
	resolveSelection,
	resolveTaskModelOrFallback,
	type ModelSelection,
} from "../chat/catalog";
import { generatePiTitleText } from "./titles";
import type { ResolvedTool } from "../chat/mcp";
import {
	listExposedSkills,
	skillCatalogContext,
	skillInvocationContext,
} from "../chat/skills";
import { chatV2Repository } from "../chat-v2/db/repository";
import { db } from "../db";
import { logger } from "../logger";
import { peekResolvedTools } from "./bridge/server";
import { loadProviderConfigs } from "../chat/catalog";
import { piConfig, piSessionDir } from "./config";
import { piGenerations, type PiGeneration } from "./generation";
import { piSessionManager } from "./manager";
import {
	attachmentMarker,
	importConversation,
	isPiSessionReady,
	piSessionFile,
} from "./migration";
import { piProviderId } from "./models";

/** Solar-owned framing; pi's coding-agent default system prompt is never used. */
const SOLAR_DEFAULT_SYSTEM_PROMPT =
	"You are a helpful assistant in Solar, a general-purpose chat application. " +
	"Answer clearly and concisely, cite sources you used (links are fine), and " +
	"explain tool usage at a level a non-technical user understands.";

export interface PiTurnInput {
	userId: string;
	isAdmin: boolean;
	conversationId: string;
	userLocation?: UserLocation;
}

export interface PiSendMessageInput extends PiTurnInput {
	text: string;
	attachmentIds?: string[];
	skillName?: string;
}

// ---------------------------------------------------------------------------
// Shared turn plumbing

async function resolveTurn(input: PiTurnInput) {
	const conversation = await chatV2Repository.getConversation(
		input.userId,
		input.conversationId,
	);
	// Mock mode redirects every stored selection to the mock model — a
	// conversation pinned to a real provider must never make paid calls in dev.
	const selection = mockForcedSelection(
		await resolveSelection(
			{
				provider: conversation.provider ?? undefined,
				endpointId: conversation.endpointId ?? undefined,
				modelId: conversation.modelId ?? undefined,
				api: conversation.modelApi ?? undefined,
			},
			input.userId,
			input.isAdmin,
		),
	);
	if (piGenerations.isConversationGenerating(input.conversationId)) {
		throw new Error("conversation is already generating");
	}
	return { conversation, selection };
}

/**
 * The thinking level Solar actually wants for this conversation: the
 * conversation's own choice, else the allowlist entry's per-model default
 * ("Thinking: medium" in Admin Settings), else off. Never leave this at a
 * bare off for models with no immediate conversation setting: pi clamps the
 * request up (`off` is unsupported on some Gemini models and they'd land on
 * `minimal` instead of the configured default).
 */
async function thinkingLevelOf(options: {
	conversation: { reasoningEffort?: string | null };
	selection: ModelSelection;
}): Promise<ThinkingLevel> {
	if (options.conversation.reasoningEffort) {
		return options.conversation.reasoningEffort as ThinkingLevel;
	}
	const config = (await loadProviderConfigs()).find(
		(candidate) => candidate.provider === options.selection.provider,
	);
	const entry = config?.enabledModels.find(
		(candidate) =>
			candidate.id === options.selection.modelId &&
			candidate.endpointId === options.selection.endpointId &&
			candidate.api === options.selection.api,
	);
	return (entry?.reasoningEffort ?? "off") as ThinkingLevel;
}

async function acquireForTurn(
	input: PiTurnInput,
	conversation: Awaited<ReturnType<typeof resolveTurn>>["conversation"],
	selection: ModelSelection,
) {
	const skills = await listExposedSkills(input.userId);
	const systemPrompt =
		renderBuiltinPromptInterpolations(
			conversation.systemPrompt,
			input.userLocation,
		) ?? SOLAR_DEFAULT_SYSTEM_PROMPT;
	const session = await piSessionManager.acquire({
		identity: {
			conversationId: input.conversationId,
			userId: input.userId,
			userLocation: input.userLocation,
		},
		systemPrompt,
		appendSystemPrompt: skillCatalogContext(skills) ?? undefined,
		bridgeUrl: `http://127.0.0.1:${process.env.PORT ?? 3000}`,
		provider: piProviderId(selection),
		modelId: selection.modelId,
		onExit: (conversationId) =>
			piGenerations.interruptAllForConversation(
				conversationId,
				"generation process exited unexpectedly",
			),
	});
	// Model/thinking are turn-scoped RPC commands — cheap roundtrips, always
	// re-asserted so a reused (previously idle) process is reconfigured.
	await session.client.setModel(piProviderId(selection), selection.modelId);
	await session.client.setThinkingLevel(
		await thinkingLevelOf({ conversation, selection }),
	);
	session.generating = true;
	return session;
}

// ---------------------------------------------------------------------------
// Stream pump: pi session events → UiChunk generation contract

interface PumpOptions {
	conversationId: string;
	userText: string;
}

export interface PiTurnMetrics {
	ttftMs: number | null;
	tps: number | null;
	e2e: number | null;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface PumpResult {
	metrics: PiTurnMetrics | null;
	/** Set when the stall watchdog ended the turn (see recordTurnError). */
	stallError: string | null;
}

/**
 * What a turn ended by the stall watchdog reports. The abort itself surfaces
 * from pi as "Request was aborted", which reads as if the user or the gateway
 * cancelled. Models that think or buffer tool input without streaming can go
 * quiet this long legitimately, hence the pointer to the setting.
 */
function stallErrorText(): string {
	const seconds = Math.round(piConfig.stallTimeoutMs / 1000);
	return `The model sent nothing for ${seconds}s, so Solar stopped waiting. Raise SOLAR_PI_STALL_TIMEOUT_MS if replies legitimately take longer.`;
}

export function pumpGeneration(
	generation: PiGeneration,
	client: RpcClient,
	options: PumpOptions,
): Promise<PumpResult> {
	return new Promise((resolve) => {
		const toolDisplayNames = new Map(
			(peekResolvedTools(options.conversationId) ?? []).map(
				(tool: ResolvedTool) => [
					tool.tool.name,
					{ serverName: tool.serverName, remoteName: tool.remoteName },
				],
			),
		);
		const usage = { inputTokens: 0, outputTokens: 0 };
		let lastActivity = Date.now();
		let stopRequested = false;
		let abortGrace: ReturnType<typeof setTimeout> | null = null;
		let settled = false;
		let stalled = false;
		let stallTimer: ReturnType<typeof setInterval>;

		// Streaming metrics (UI display). Turn scope: startedAt is fixed here at
		// pump creation (pi replays several assistant message_start/end pairs
		// across tool loops — a per-message clock collapses TTFT to ~0). Usage
		// accumulates from message_end, whose message is the authoritative final
		// one; the RPC wire never delivers the inner `done` event.
		const metrics = {
			startedAt: Date.now() as number | null,
			firstTokenAt: null as number | null,
			finishedAt: null as number | null,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
		};

		const finish = (ok: boolean, errorText?: string) => {
			if (settled) return;
			settled = true;
			if (abortGrace) clearTimeout(abortGrace);
			clearInterval(stallTimer);
			if (ok) {
				piGenerations.emit(generation, {
					type: "finish",
					finishReason: stopRequested ? "stop" : "stop",
					usage,
				});
				piGenerations.finish(generation, "done");
			} else {
				piGenerations.emit(generation, {
					type: "error",
					// After a stall, whatever pi reports is the watchdog's own abort.
					errorText: stalled
						? stallErrorText()
						: (errorText ?? "generation failed"),
				});
				piGenerations.finish(generation, "error");
			}
			const session = piSessionManager.get(generation.conversationId);
			if (session) {
				session.generating = false;
				session.lastActivityAt = Date.now();
			}
			resolve({
				metrics: resolveMetrics(metrics, ok),
				stallError: stalled ? stallErrorText() : null,
			});
		};

		function resolveMetrics(
			m: typeof metrics,
			ok: boolean,
		): PiTurnMetrics | null {
			if (!ok || m.startedAt === null) return null;
			const finished = m.finishedAt ?? Date.now();
			const ttftMs =
				m.firstTokenAt === null
					? null
					: m.firstTokenAt - (m.startedAt as number);
			const output = m.usage.output;
			const tps =
				ttftMs !== null && output > 0 && finished > (m.firstTokenAt as number)
					? output / ((finished - (m.firstTokenAt as number)) / 1000)
					: null;
			const e2e =
				output > 0 && finished > (m.startedAt as number)
					? output / ((finished - (m.startedAt as number)) / 1000)
					: null;
			return {
				ttftMs,
				tps,
				e2e,
				input: m.usage.input,
				output: m.usage.output,
				cacheRead: m.usage.cacheRead,
				cacheWrite: m.usage.cacheWrite,
			};
		}

		generation.onStop = async () => {
			stopRequested = true;
			await client.abort().catch(() => {});
		};

		// Stall watchdog (plan: Watchdog): reset on every inbound event; lapse →
		// abort, grace for agent_settled, then kill.
		stallTimer = setInterval(
			() => {
				if (Date.now() - lastActivity < piConfig.stallTimeoutMs) return;
				lastActivity = Date.now();
				stalled = true;
				logger
					.withMetadata({
						conversationId: generation.conversationId,
						generationId: generation.id,
					})
					.warn("pi generation stalled; aborting");
				void client
					.abort()
					.catch(() => {})
					.finally(() => {
						// pi answers the abort command only once it is idle, so it has
						// usually settled already; its process is then fine to reuse.
						if (settled) return;
						abortGrace = setTimeout(() => {
							void piSessionManager
								.drop(generation.conversationId)
								.catch(() => {});
							finish(false);
						}, piConfig.abortGraceMs);
					});
			},
			Math.min(piConfig.stallTimeoutMs, 5_000),
		);
		stallTimer.unref?.();

		client.onEvent((event) => {
			lastActivity = Date.now();
			try {
				if (event.type === "message_update") {
					const inner = event.assistantMessageEvent;
					switch (inner.type) {
						case "text_delta":
						case "thinking_delta":
							if (!metrics.firstTokenAt) metrics.firstTokenAt = Date.now();
							piGenerations.emit(
								generation,
								inner.type === "text_delta"
									? { type: "text-delta", textDelta: inner.delta }
									: { type: "reasoning-delta", delta: inner.delta },
							);
							break;
						case "error":
							finish(false, inner.error.errorMessage);
							break;
					}
				} else if (event.type === "message_end") {
					const msg = event.message as {
						role?: string;
						usage?: {
							input: number;
							output: number;
							cacheRead?: number;
							cacheWrite?: number;
						};
					};
					if (msg.role === "assistant") {
						metrics.finishedAt = Date.now();
						const u = msg.usage;
						if (u) {
							usage.inputTokens += u.input;
							usage.outputTokens += u.output;
							metrics.usage.input += u.input;
							metrics.usage.output += u.output;
							metrics.usage.cacheRead += u.cacheRead ?? 0;
							metrics.usage.cacheWrite += u.cacheWrite ?? 0;
						}
					}
				} else if (event.type === "tool_execution_start") {
					// pi's JSON protocol strips partial assistant snapshots (no
					// per-token tool-call arg streaming at this layer), so Solar's UI
					// contract is served from the execution events instead: start +
					// full args + end on execution start, result on execution end.
					piGenerations.emit(generation, {
						type: "tool-call-start",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						...toolDisplayNames.get(event.toolName),
					});
					piGenerations.emit(generation, {
						type: "tool-call-delta",
						toolCallId: event.toolCallId,
						argsText: JSON.stringify(event.args ?? {}),
					});
					piGenerations.emit(generation, {
						type: "tool-call-end",
						toolCallId: event.toolCallId,
					});
				} else if (event.type === "tool_execution_end") {
					const result = event.result as
						| { content?: Array<{ type: string; text?: string }> }
						| undefined;
					const output = (result?.content ?? [])
						.filter((part) => part.type === "text")
						.map((part) => part.text ?? "")
						.join("\n");
					piGenerations.emit(generation, {
						type: "tool-call-result",
						toolCallId: event.toolCallId,
						output: output || (event.isError ? "Tool failed." : "Done."),
						isError: event.isError,
					});
				} else if (event.type === "agent_settled") {
					// A stalled turn settles too (pi saved it as aborted): not a success.
					finish(!stalled);
				}
				// agent_end(willRetry=true) stays running; auto_retry_* events only
				// reset the stall watchdog. agent_settled is the terminal signal.
			} catch (error) {
				finish(false, error instanceof Error ? error.message : String(error));
			}
		});

		client.prompt(options.userText).catch((error) => {
			finish(false, error instanceof Error ? error.message : String(error));
		});
	});
}

// ---------------------------------------------------------------------------
// Public engine API (mirrors chat/v2Live's entry points)

export async function piSendMessage(
	input: PiSendMessageInput,
	options?: { skipImport?: boolean },
): Promise<string> {
	const { conversation, selection } = await resolveTurn(input);
	if (!options?.skipImport && !isPiSessionReady(input.conversationId)) {
		await importConversation(input.userId, input.conversationId);
	}
	const isFirstMessage = conversationIsEmpty(input.conversationId);

	const skills = input.skillName ? await listExposedSkills(input.userId) : null;
	const skill = skills?.find((candidate) => candidate.name === input.skillName);
	if (input.skillName && !skill) throw new Error("skill not found");

	const userText = withAttachments(
		skill
			? `${input.text}${skillInvocationContext({ name: skill.name, content: skill.content })}`
			: input.text,
		input.attachmentIds,
	);

	const generation = piGenerations.start({
		conversationId: input.conversationId,
		userId: input.userId,
	});
	generate(
		generation,
		input,
		conversation,
		selection,
		userText,
		[],
		isFirstMessage,
	);
	return generation.id;
}

function generate(
	generation: PiGeneration,
	input: PiTurnInput,
	conversation: Awaited<ReturnType<typeof resolveTurn>>["conversation"],
	selection: ModelSelection,
	userText: string,
	attachmentIds: string[] = [],
	isFirstMessage = false,
): void {
	void (async () => {
		const session = await acquireForTurn(input, conversation, selection);
		const result = await pumpGeneration(generation, session.client, {
			conversationId: input.conversationId,
			userText,
		});
		if (result.stallError) {
			await recordTurnError(input.conversationId, result.stallError);
		}
		if (generation.status === "done") {
			await recordTurnMetrics(input.conversationId, userText, result.metrics);
			const userEntryId = await findLatestUserEntryId(
				input.conversationId,
				userText,
			);
			if (attachmentIds.length && userEntryId) {
				await db
					.insertInto("v2_message_attachment")
					.values(
						attachmentIds.map((attachmentId, index) => ({
							messageId: userEntryId,
							attachmentId,
							ordinal: index,
						})),
					)
					.onConflict((oc) => oc.doNothing())
					.execute();
			}
			await touchConversation(input.conversationId);
			if (isFirstMessage)
				await generatePiTitle(generation, input, selection, userText);
		}
	})().catch((error) => {
		logger
			.withError(error)
			.withMetadata({ conversationId: input.conversationId })
			.error("pi generation failed");
		if (generation.status === "running") {
			piGenerations.emit(generation, {
				type: "error",
				errorText: error instanceof Error ? error.message : String(error),
			});
			piGenerations.finish(generation, "error");
		}
	});
}

// ---------------------------------------------------------------------------
// Edit / regenerate — sibling branches over pi's own tree

export interface PiEditInput extends PiTurnInput {
	targetTurnId: string; // pi entry id of the user message being replaced
	text: string;
	attachmentIds?: string[];
}

/**
 * Edit/regenerate mechanics (plan: Current seams): the pi process owns the
 * session entirely while it runs, so Solar can't and shouldn't edit JSONL
 * behind its back. Instead edits go to the process as a `/solar-reprompt`
 * extension command: the extension moves the tree pointer (navigateTree) to
 * the target's parent and sends the new/edited text — the abandoned path
 * stays on disk, inert (plan decision: no destructiveness, no switcher UI).
 */
async function piReprompt(
	input: PiTurnInput,
	conversation: Awaited<ReturnType<typeof resolveTurn>>["conversation"],
	selection: ModelSelection,
	parentEntryId: string,
	text: string,
	attachmentIds?: string[],
): Promise<string> {
	const generation = piGenerations.start({
		conversationId: input.conversationId,
		userId: input.userId,
	});
	const payload = JSON.stringify({
		parentEntryId,
		text: withAttachments(text, attachmentIds),
	});
	generate(
		generation,
		input,
		conversation,
		selection,
		`/solar-reprompt ${payload}`,
		attachmentIds ?? [],
	);
	return generation.id;
}

export async function piEditUserMessage(input: PiEditInput): Promise<string> {
	const { conversation, selection } = await resolveTurn(input);
	const manager = openSession(input.conversationId);
	const target = manager.getEntry(input.targetTurnId);
	if (!target || target.type !== "message")
		throw new Error("message not found");
	// Root-of-tree edits (first message, no parent) restart the conversation:
	// navigateTree has no "reset to null" target, and chat-v2 discarded
	// everything after the edited message anyway. skipImport: the conversation
	// already lives on pi (nothing to import from chat-v2).
	if (target.parentId === null) {
		await piDeleteConversation(input.conversationId);
		return piSendMessage(
			{ ...input, attachmentIds: input.attachmentIds ?? [] },
			{ skipImport: true },
		);
	}
	return piReprompt(
		input,
		conversation,
		selection,
		target.parentId,
		input.text,
		input.attachmentIds,
	);
}

export async function piRegenerateAssistantTurn(
	input: PiTurnInput & { targetTurnId: string },
): Promise<string> {
	const { conversation, selection } = await resolveTurn(input);
	const manager = openSession(input.conversationId);
	const path = manager.getBranch();
	const targetIndex = path.findIndex(
		(entry) => entry.id === input.targetTurnId,
	);
	if (targetIndex < 0) throw new Error("message not found");
	// assistant-ui's onReload may pass the assistant entry or its parent user
	// entry; both resolve to "the user prompt to re-answer".
	const target = path[targetIndex] as SessionMessageEntry;
	let userIndex = targetIndex;
	if (target.type !== "message" || target.message.role !== "user") {
		userIndex = targetIndex - 1;
		while (
			userIndex >= 0 &&
			(path[userIndex]!.type !== "message" ||
				(path[userIndex] as SessionMessageEntry).message.role !== "user")
		)
			userIndex--;
	}
	const userEntry =
		userIndex >= 0 && path[userIndex]!.type === "message"
			? (path[userIndex] as SessionMessageEntry)
			: null;
	if (!userEntry || userEntry.message.role !== "user") {
		throw new Error("no user message to regenerate from");
	}
	const rawText =
		typeof userEntry.message.content === "string"
			? userEntry.message.content
			: (userEntry.message.content as Array<{ type: string; text?: string }>)
					.filter((part) => part.type === "text")
					.map((part) => part.text ?? "")
					.join("\n");

	if (userEntry.parentId === null) {
		// Root-prompt regeneration restarts the (single-turn) conversation.
		await piDeleteConversation(input.conversationId);
		return piSendMessage(
			{ ...input, text: rawText, attachmentIds: [] },
			{ skipImport: true },
		);
	}
	return piReprompt(
		input,
		conversation,
		selection,
		userEntry.parentId,
		rawText,
	);
}

// ---------------------------------------------------------------------------
// Stop / stream / ownership

export async function piStopGeneration(
	userId: string,
	generationId: string,
): Promise<boolean> {
	if (!piGenerations.owns(userId, generationId)) return false;
	return piGenerations.stop(generationId);
}

export function piStream(
	generationId: string,
	lastEventId: number,
): ReadableStream<Uint8Array> {
	return piGenerations.subscribe(generationId, lastEventId);
}

/** conversation.compact for pi conversations: pi compacts in its own process. */
export async function piCompact(input: PiTurnInput): Promise<void> {
	const { conversation, selection } = await resolveTurn(input);
	if (!isPiSessionReady(input.conversationId)) {
		throw new Error("conversation is not on the pi engine");
	}
	const session = await acquireForTurn(input, conversation, selection);
	try {
		await session.client.compact();
	} finally {
		session.generating = false;
		session.lastActivityAt = Date.now();
	}
}

/** conversation.remove for pi conversations: kill the child + drop the files. */
export async function piDeleteConversation(
	conversationId: string,
): Promise<void> {
	await piSessionManager.drop(conversationId);
	const dir = piSessionDir(conversationId);
	try {
		const { rmSync } = await import("node:fs");
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// never block deletion of metadata on file cleanup
	}
}

// ---------------------------------------------------------------------------
// Helpers

function openSession(conversationId: string) {
	const file = piSessionFile(conversationId);
	if (!file) throw new Error("conversation has no pi session");
	return SessionManager.open(file, piSessionDir(conversationId));
}

async function findLatestUserEntryId(
	conversationId: string,
	_userText: string,
): Promise<string | null> {
	try {
		const manager = openSession(conversationId);
		const messages = manager
			.getEntries()
			.filter(
				(entry): entry is SessionMessageEntry => entry.type === "message",
			);
		for (let index = messages.length - 1; index >= 0; index--) {
			if (messages[index]!.message.role === "user") return messages[index]!.id;
		}
	} catch {
		// best effort
	}
	return null;
}

function withAttachments(text: string, attachmentIds?: string[]): string {
	if (!attachmentIds?.length) return text;
	const marker = attachmentMarker(attachmentIds);
	return text ? `${text}\n${marker}` : marker;
}

function conversationIsEmpty(conversationId: string): boolean {
	try {
		return (
			openSession(conversationId)
				.getEntries()
				.filter((entry) => entry.type === "message").length === 0
		);
	} catch {
		return true;
	}
}

async function generatePiTitle(
	generation: PiGeneration,
	input: PiTurnInput,
	selection: ModelSelection,
	userText: string,
): Promise<void> {
	try {
		// The admin task-model default may point at a live provider; mock mode
		// must rewrite it just like the turn selection above.
		const taskSelection = mockForcedSelection(
			await resolveTaskModelOrFallback(selection),
		);
		const title = await generatePiTitleText(
			userText,
			await getTitlePrompt(),
			taskSelection,
		);
		if (!title) return;
		piGenerations.emit(generation, { type: "title-update", title });
		const session = piSessionManager.get(input.conversationId);
		if (session && !session.generating) {
			await session.client.setSessionName(title).catch(() => {});
			return;
		}
		openSession(input.conversationId).appendSessionInfo(title);
	} catch (error) {
		logger
			.withError(error)
			.withMetadata({ conversationId: input.conversationId })
			.warn("pi title generation failed");
	}
}

/**
 * Persist the turn's streaming metrics as a pi custom entry. Custom entries
 * are plain session data pi ignores when building context — they're how Solar
 * attaches its own observability (TTFT/TPS/E2E + usage) without another
 * table and without touching pi's message payloads.
 */
async function recordTurnMetrics(
	conversationId: string,
	_userText: string,
	metrics: PiTurnMetrics | null,
): Promise<void> {
	if (!metrics) return;
	const file = piSessionFile(conversationId);
	if (!file) return;
	try {
		const manager = SessionManager.open(file, piSessionDir(conversationId));
		const assistant = latestAssistantEntry(manager);
		manager.appendCustomEntry(`solar-turn-metrics`, {
			assistantEntryId: assistant?.id ?? null,
			...metrics,
		});
	} catch (error) {
		logger
			.withError(error)
			.withMetadata({ conversationId })
			.warn("failed to persist pi turn metrics");
	}
}

/**
 * Persist why the stall watchdog ended the turn, as a custom entry on the
 * assistant message pi saved for it. pi records that message as "Request was
 * aborted", which is what a reload would otherwise show; turns.ts prefers
 * this entry's text.
 */
async function recordTurnError(
	conversationId: string,
	errorMessage: string,
): Promise<void> {
	const file = piSessionFile(conversationId);
	if (!file) return;
	try {
		const manager = SessionManager.open(file, piSessionDir(conversationId));
		const assistant = latestAssistantEntry(manager);
		// A pi process killed before it saved the aborted message leaves an
		// earlier turn's reply last; that one did not fail.
		const stopReason = (assistant?.message as { stopReason?: string })
			?.stopReason;
		if (!assistant || stopReason !== "aborted") return;
		manager.appendCustomEntry(`solar-turn-error`, {
			assistantEntryId: assistant.id,
			errorMessage,
		});
	} catch (error) {
		logger
			.withError(error)
			.withMetadata({ conversationId })
			.warn("failed to persist pi turn error");
	}
}

function latestAssistantEntry(
	manager: SessionManager,
): SessionMessageEntry | undefined {
	return manager
		.getBranch()
		.filter(
			(e): e is SessionMessageEntry =>
				e.type === "message" &&
				(e as SessionMessageEntry).message.role === "assistant",
		)
		.at(-1);
}

async function touchConversation(conversationId: string): Promise<void> {
	await db
		.updateTable("v2_conversation")
		.set({ updatedAt: new Date().toISOString() })
		.where("id", "=", conversationId)
		.execute()
		.catch(() => {});
}

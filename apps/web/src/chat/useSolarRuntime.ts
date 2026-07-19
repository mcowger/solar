import {
	useExternalStoreRuntime,
	createMessageQueue,
	type CompleteAttachment,
	type ThreadMessageLike,
	type AppendMessage,
} from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "../trpc";
import { trpcClient } from "../trpcClient";
import {
	isDocumentMimeType,
	SolarAttachmentAdapter,
} from "./attachmentAdapter";
import type { UiChunk } from "./streamTypes";

interface SolarAttachmentMeta {
	id: string;
	filename: string;
	mimeType: string;
	kind: "image" | "text" | "document";
}

interface SolarMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	connectionStatus?: SolarConnectionStatus;
	reasoning?: string;
	toolCalls?: SolarToolCall[];
	summaryEvent?: SolarSummaryEvent;
	attachments?: SolarAttachmentMeta[];
}

export type SolarConnectionStatus = "connecting" | "request-sent";

export interface SolarSummaryEvent {
	tokensBefore: number | null;
	tokensAfter: number | null;
	revision: number | null;
	createdAt: string | null;
	position: "before" | "after";
}

export interface SolarToolCall {
	id: string;
	name: string;
	serverName?: string;
	remoteName?: string;
	args: string;
	status: "streaming" | "executing" | "complete" | "error";
	output?: string;
}

function toCompleteAttachment(a: SolarAttachmentMeta): CompleteAttachment {
	return {
		id: a.id,
		type: a.kind === "image" ? "image" : "document",
		name: a.filename,
		contentType: a.mimeType,
		status: { type: "complete" },
		content:
			a.kind === "image"
				? [{ type: "image", image: `/api/attachments/${a.id}` }]
				: [{ type: "text", text: "" }],
	};
}

function convertMessage(m: SolarMessage): ThreadMessageLike {
	return {
		id: m.id,
		role: m.role,
		content: [
			...(m.reasoning
				? [{ type: "reasoning" as const, text: m.reasoning }]
				: []),
			{ type: "text", text: m.content },
		],
		attachments: m.attachments?.map(toCompleteAttachment),
		metadata: {
			custom: {
				connectionStatus: m.connectionStatus,
				toolCalls: m.toolCalls,
				summaryEvent: m.summaryEvent,
			},
		},
	};
}

function appendText(message: AppendMessage): string {
	return message.content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

const jsonHeaders = { "content-type": "application/json" };

/**
 * External-store runtime backing assistant-ui with our DB-canonical,
 * decoupled-generation model. We own message state: history is loaded from the
 * server, sending POSTs to /api/chat and streams the reply, an in-progress
 * generation is resumed on load, and Stop hits the explicit stop endpoint.
 *
 * Edit and regenerate discard the affected tail server-side and stream a fresh
 * reply; after every turn we reload history so local ids match the DB (required
 * for subsequent edit/regenerate, which key off canonical message ids).
 */
export function useSolarRuntime(
	conversationId: string,
	allowImages: boolean,
	documentMimeTypes: readonly string[],
) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const [messages, setMessages] = useState<SolarMessage[]>([]);
	const [isRunning, setIsRunning] = useState(false);
	const assistantIdRef = useRef<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const eventSourceRef = useRef<EventSource | null>(null);
	const lastEventIdRef = useRef(0);
	const reconnectRef = useRef<(() => void) | null>(null);
	const finishStreamRef = useRef<(() => void) | null>(null);
	const toolCallsByMessageRef = useRef(new Map<string, SolarToolCall[]>());
	const runQueuedTurnRef = useRef<(message: AppendMessage) => void>(
		() => undefined,
	);
	const [messageQueue] = useState(() =>
		createMessageQueue({
			run: (message) => runQueuedTurnRef.current(message),
		}),
	);

	const upsertAssistant = useCallback(
		(
			id: string,
			text: string,
			reasoning?: string,
			toolCalls?: SolarToolCall[],
			connectionStatus?: SolarConnectionStatus,
		) => {
			setMessages((prev) => {
				const exists = prev.some((m) => m.id === id);
				if (exists) {
					if (toolCalls?.length)
						toolCallsByMessageRef.current.set(id, toolCalls);
					return prev.map((m) =>
						m.id === id
							? {
									...m,
									content: text,
									connectionStatus: connectionStatus ?? m.connectionStatus,
									reasoning,
									toolCalls: toolCalls ?? m.toolCalls,
								}
							: m,
					);
				}
				if (toolCalls?.length) toolCallsByMessageRef.current.set(id, toolCalls);
				return [
					...prev,
					{
						id,
						role: "assistant",
						content: text,
						connectionStatus,
						reasoning,
						toolCalls,
					},
				];
			});
		},
		[],
	);

	const consume = useCallback(
		async (messageId: string, displayId: string, resetEventId = true) => {
			let text = "";
			let reasoning = "";
			let toolCalls: SolarToolCall[] = [];
			let source: EventSource | null = null;
			let resolveCompletion: (() => void) | null = null;
			const completed = new Promise<void>((resolve) => {
				resolveCompletion = resolve;
			});
			finishStreamRef.current = resolveCompletion;
			const handleChunk = (chunk: UiChunk, eventId: string) => {
				const parsedId = Number(eventId);
				if (
					Number.isSafeInteger(parsedId) &&
					parsedId <= lastEventIdRef.current
				)
					return;
				if (Number.isSafeInteger(parsedId)) lastEventIdRef.current = parsedId;
				if (chunk.type === "text-delta") {
					text += chunk.textDelta;
					upsertAssistant(displayId, text, reasoning || undefined, toolCalls);
				} else if (chunk.type === "reasoning-delta") {
					reasoning += chunk.delta;
					upsertAssistant(displayId, text, reasoning, toolCalls);
				} else if (chunk.type === "tool-call-start") {
					toolCalls = [
						...toolCalls,
						{
							id: chunk.toolCallId,
							name: chunk.toolName,
							serverName: chunk.serverName,
							remoteName: chunk.remoteName,
							args: "",
							status: "streaming",
						},
					];
					upsertAssistant(displayId, text, reasoning || undefined, toolCalls);
				} else if (chunk.type === "tool-call-delta") {
					toolCalls = toolCalls.map((call) =>
						call.id === chunk.toolCallId
							? { ...call, args: call.args + chunk.argsText }
							: call,
					);
					upsertAssistant(displayId, text, reasoning || undefined, toolCalls);
				} else if (chunk.type === "tool-call-end") {
					toolCalls = toolCalls.map((call) =>
						call.id === chunk.toolCallId
							? { ...call, status: "executing" }
							: call,
					);
					upsertAssistant(displayId, text, reasoning || undefined, toolCalls);
				} else if (chunk.type === "tool-call-result") {
					toolCalls = toolCalls.map((call) =>
						call.id === chunk.toolCallId
							? {
									...call,
									output: chunk.output,
									status: chunk.isError ? "error" : "complete",
								}
							: call,
					);
					upsertAssistant(displayId, text, reasoning || undefined, toolCalls);
				} else if (chunk.type === "error") {
					text += `\n\n_Error: ${chunk.errorText}_`;
					upsertAssistant(displayId, text, reasoning || undefined, toolCalls);
				} else if (chunk.type === "title-update") {
					queryClient.invalidateQueries({
						queryKey: trpc.conversation.list.queryKey(),
					});
				}
			};
			const connect = () => {
				source?.close();
				const query = new URLSearchParams({ messageId });
				if (lastEventIdRef.current > 0)
					query.set("lastEventId", String(lastEventIdRef.current));
				source = new EventSource(`/api/chat/stream?${query}`);
				eventSourceRef.current = source;
				source.onmessage = (event) => {
					if (event.data === "[DONE]") {
						source?.close();
						resolveCompletion?.();
						return;
					}
					handleChunk(JSON.parse(event.data) as UiChunk, event.lastEventId);
				};
			};
			reconnectRef.current = connect;
			setIsRunning(true);
			upsertAssistant(displayId, "", undefined, undefined, "request-sent");
			if (resetEventId) lastEventIdRef.current = 0;
			connect();
			try {
				await completed;
			} finally {
				eventSourceRef.current?.close();
				eventSourceRef.current = null;
				if (reconnectRef.current === connect) reconnectRef.current = null;
				if (finishStreamRef.current === resolveCompletion)
					finishStreamRef.current = null;
				if (toolCalls.length && assistantIdRef.current) {
					toolCallsByMessageRef.current.set(assistantIdRef.current, toolCalls);
				}
				setIsRunning(false);
				assistantIdRef.current = null;
			}
		},
		[queryClient, trpc.conversation.list, upsertAssistant],
	);

	// Reload the canonical history from the server, replacing local state so ids
	// stay in sync with the DB. Returns the rows (for the resume check).
	const loadHistory = useCallback(async () => {
		const [rows, contextState] = await Promise.all([
			trpcClient.conversation.messages.query({ conversationId }),
			trpcClient.conversation.contextState.query({ conversationId }),
		]);
		const boundaryIndex = contextState.summaryEvent
			? rows.findIndex(
					(row) =>
						row.id === contextState.summaryEvent?.retainedMessageBoundaryId,
				)
			: -1;
		const markerIndex = boundaryIndex >= 0 ? boundaryIndex : rows.length - 1;
		setMessages(
			rows.map((r, index) => ({
				id: r.id,
				role: r.role,
				content: r.text,
				reasoning: r.reasoning ?? undefined,
				toolCalls: toolCallsByMessageRef.current.get(r.id) ?? r.toolCalls,
				summaryEvent:
					contextState.summaryEvent && index === markerIndex
						? {
								tokensBefore: contextState.summaryEvent.tokensBefore,
								tokensAfter: contextState.summaryEvent.tokensAfter,
								revision: contextState.summaryEvent.revision,
								createdAt: contextState.summaryEvent.createdAt,
								position: boundaryIndex >= 0 ? "before" : "after",
							}
						: undefined,
				attachments: r.attachments.length ? r.attachments : undefined,
			})),
		);
		return rows;
	}, [conversationId]);

	// Load history; resume an in-progress generation if the server has one.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			const rows = await loadHistory();
			if (cancelled) return;

			const active = rows.find((r) => r.isActive);
			if (active) {
				assistantIdRef.current = active.id;
				messageQueue.notifyBusy();
				if (cancelled) {
					messageQueue.notifyIdle();
					return;
				}
				try {
					await consume(active.id, active.id);
					if (!cancelled) await loadHistory();
				} finally {
					messageQueue.notifyIdle();
				}
			}
		})();
		return () => {
			cancelled = true;
			eventSourceRef.current?.close();
			finishStreamRef.current?.();
		};
	}, [conversationId, consume, loadHistory, messageQueue]);

	const streamTurn = useCallback(
		async (url: string, body: unknown) => {
			const abort = new AbortController();
			const displayId = crypto.randomUUID();
			abortRef.current = abort;
			const request = fetch(url, {
				method: "POST",
				headers: jsonHeaders,
				body: JSON.stringify(body),
				signal: abort.signal,
			});
			setIsRunning(true);
			upsertAssistant(displayId, "", undefined, undefined, "connecting");
			try {
				const res = await request;
				if (!res.ok) throw new Error(`Chat request failed (${res.status})`);
				const result = (await res.json()) as { messageId?: string };
				if (!result.messageId)
					throw new Error("Chat request returned no message id");
				assistantIdRef.current = result.messageId;
				await consume(result.messageId, displayId);
				await loadHistory();
			} catch (error) {
				setIsRunning(false);
				abortRef.current = null;
				throw error;
			}
		},
		[consume, loadHistory, upsertAssistant],
	);

	useEffect(() => {
		const reconnectWhenVisible = () => {
			if (document.visibilityState === "visible") reconnectRef.current?.();
		};
		document.addEventListener("visibilitychange", reconnectWhenVisible);
		return () =>
			document.removeEventListener("visibilitychange", reconnectWhenVisible);
	}, []);

	const onNew = useCallback(
		async (message: AppendMessage) => {
			const text = appendText(message).trim();
			const attachmentIds = (message.attachments ?? []).map((a) => a.id);
			if (!text && attachmentIds.length === 0) return;
			setMessages((prev) => [
				...prev,
				{
					id: crypto.randomUUID(),
					role: "user",
					content: text,
					attachments: message.attachments?.map((a) => ({
						id: a.id,
						filename: a.name,
						mimeType: a.contentType ?? "",
						kind:
							a.type === "image"
								? "image"
								: isDocumentMimeType(a.contentType)
									? "document"
									: "text",
					})),
				},
			]);
			try {
				await streamTurn("/api/chat", { conversationId, text, attachmentIds });
			} finally {
				messageQueue.notifyIdle();
			}
		},
		[conversationId, messageQueue, streamTurn],
	);
	runQueuedTurnRef.current = onNew;

	const onEdit = useCallback(
		async (message: AppendMessage) => {
			const sourceId = message.sourceId;
			const text = appendText(message).trim();
			if (!sourceId || !text) return;
			setMessages((prev) => {
				const idx = prev.findIndex((m) => m.id === sourceId);
				if (idx === -1) return prev;
				return prev
					.slice(0, idx + 1)
					.map((m, i) => (i === idx ? { ...m, content: text } : m));
			});
			await streamTurn("/api/chat/edit", { messageId: sourceId, text });
		},
		[streamTurn],
	);

	const onReload = useCallback(
		async (parentId: string | null) => {
			if (!parentId) return;
			setMessages((prev) => {
				const idx = prev.findIndex((m) => m.id === parentId);
				return idx === -1 ? prev : prev.slice(0, idx + 1);
			});
			await streamTurn("/api/chat/regenerate", { messageId: parentId });
		},
		[streamTurn],
	);

	const onCancel = useCallback(async () => {
		const messageId = assistantIdRef.current;
		// Explicit Stop: tell the server to abort (decoupled from the fetch), then
		// detach our reader.
		if (messageId) {
			await fetch("/api/chat/stop", {
				method: "POST",
				headers: jsonHeaders,
				body: JSON.stringify({ messageId }),
			});
		}
		abortRef.current?.abort();
		eventSourceRef.current?.close();
		finishStreamRef.current?.();
	}, []);

	const attachmentAdapter = useMemo(
		() => new SolarAttachmentAdapter(allowImages, documentMimeTypes),
		[allowImages, documentMimeTypes],
	);

	return useExternalStoreRuntime({
		messages,
		isRunning,
		convertMessage,
		onNew,
		onEdit,
		onReload,
		onCancel,
		queue: messageQueue.adapter,
		adapters: { attachments: attachmentAdapter },
	});
}

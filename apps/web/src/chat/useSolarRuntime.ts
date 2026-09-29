import {
	useExternalStoreRuntime,
	createMessageQueue,
	type AppendMessage,
} from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "../trpc";
import { trpcClient } from "../trpcClient";
import { newId } from "../id";
import {
	isDocumentMimeType,
	SolarAttachmentAdapter,
} from "./attachmentAdapter";
import { consumeChatStream } from "./consumeChatStream";
import {
	convertMessage,
	parseMessageMetrics,
	type SolarAttachmentMeta,
	type SolarConnectionStatus,
	type SolarMessage,
	type SolarMetrics,
	type SolarSummaryEvent,
	type SolarToolCall,
	type TimelineItem,
} from "./solarMessages";
export { parseTimelineItems } from "./solarMessages";
import { parseSkillCommand, type SkillOption } from "./skillCommands";

export type {
	SolarConnectionStatus,
	SolarMetrics,
	SolarSummaryEvent,
	SolarToolCall,
	TimelineItem,
} from "./solarMessages";

interface UserLocation {
	timeZone: string;
	latitude?: number;
	longitude?: number;
	accuracy?: number;
	timestamp?: number;
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
	allowDocuments: boolean,
	summaryRevision?: number | null,
	skills: readonly SkillOption[] = [],
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
	const loadedSummaryRevisionRef = useRef<number | null | undefined>(undefined);
	const loadHistoryRef = useRef<() => Promise<void>>(() => Promise.resolve());
	const toolCallsByMessageRef = useRef(new Map<string, SolarToolCall[]>());
	const metricsByMessageRef = useRef(new Map<string, SolarMetrics>());
	const runQueuedTurnRef = useRef<(message: AppendMessage) => void>(
		() => undefined,
	);
	const userLocationRef = useRef<UserLocation>({
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	});

	useEffect(() => {
		const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		userLocationRef.current = { timeZone };
		if (!navigator.geolocation) return;
		navigator.geolocation.getCurrentPosition(
			(position) => {
				userLocationRef.current = {
					timeZone,
					latitude: position.coords.latitude,
					longitude: position.coords.longitude,
					accuracy: position.coords.accuracy,
					timestamp: position.timestamp,
				};
			},
			() => undefined,
			{ maximumAge: 300_000, timeout: 10_000 },
		);
	}, []);
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
			metrics?: SolarMetrics,
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
									metrics: metrics ?? m.metrics,
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
						createdAt: new Date().toISOString(),
						connectionStatus,
						reasoning,
						toolCalls,
						metrics,
					},
				];
			});
		},
		[],
	);

	const consume = useCallback(
		async (messageId: string, displayId: string, resetEventId = true) => {
			return consumeChatStream({
				messageId,
				displayId,
				resetEventId,
				lastEventIdRef,
				eventSourceRef,
				reconnectRef,
				finishStreamRef,
				assistantIdRef,
				toolCallsByMessageRef,
				metricsByMessageRef,
				setIsRunning,
				upsertAssistant,
				onTitleUpdate: () =>
					queryClient.invalidateQueries({
						queryKey: trpc.conversation.list.queryKey(),
					}),
			});
		},
		[queryClient, trpc.conversation.list, upsertAssistant],
	);

	// The stale-turn force-stop control was a legacy artifact (a streaming
	// placeholder row left behind by a crashed process). Under pi there is no
	// placeholder — the session file only records completed state — so the
	// state cannot be entered from history anymore and the control is gone.

	// Reload the canonical history from the server, replacing local state so ids
	// stay in sync with the DB. Returns the rows (for the resume check).
	const loadHistory = useCallback(async () => {
		const [rows, contextState] = await Promise.all([
			trpcClient.conversation.messages.query({ conversationId }),
			trpcClient.conversation.contextState.query({ conversationId }),
		]);
		// pi sessions hide summarized history server-side; the transcript we get
		// back is already the current path. Row-level marker data (if any) pins
		// the badge to the first kept turn rather than the tail.
		loadedSummaryRevisionRef.current = contextState.summaryEvent
			? contextState.summaryEvent.revision
			: null;
		setMessages(
			rows.map((r) => ({
				id: r.id,
				role: r.role,
				content: r.text,
				createdAt: r.createdAt,
				reasoning: r.reasoning ?? undefined,
				metrics:
					metricsByMessageRef.current.get(r.id) ?? parseMessageMetrics(r.parts),
				toolCalls: toolCallsByMessageRef.current.get(r.id) ?? r.toolCalls,
				parts: r.parts,
				// The marker lives at the true boundary position: the server pins it
				// to the first kept turn on the current path (pi semantics) instead
				// of the transcript tail.
				summaryEvent: r.summaryEvent ?? undefined,
				attachments: r.attachments.length ? r.attachments : undefined,
				skillInvocation: r.skillInvocation,
			})),
		);
		return rows;
	}, [conversationId]);
	loadHistoryRef.current = async () => {
		await loadHistory();
	};

	useEffect(() => {
		if (
			summaryRevision == null ||
			loadedSummaryRevisionRef.current === undefined ||
			loadedSummaryRevisionRef.current === summaryRevision
		)
			return;
		void loadHistory();
	}, [loadHistory, summaryRevision]);

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
		async (url: string, body: Record<string, unknown>) => {
			const abort = new AbortController();
			const displayId = newId();
			abortRef.current = abort;
			const request = fetch(url, {
				method: "POST",
				headers: jsonHeaders,
				body: JSON.stringify({
					...body,
					userLocation: userLocationRef.current,
				}),
				signal: abort.signal,
			});
			setIsRunning(true);
			upsertAssistant(displayId, "", undefined, undefined, "connecting");
			let sent = false;
			try {
				const res = await request;
				if (!res.ok) {
					const body = await res.json().catch(() => null);
					const detail =
						body && typeof body === "object" && "error" in body
							? String((body as { error: unknown }).error)
							: `HTTP ${res.status}`;
					throw new Error(detail);
				}
				const result = (await res.json()) as { messageId?: string };
				if (!result.messageId)
					throw new Error("Chat request returned no message id");
				sent = true;
				assistantIdRef.current = result.messageId;
				await consume(result.messageId, displayId);
				await loadHistory();
			} catch (error) {
				setIsRunning(false);
				abortRef.current = null;
				// The request never reached the model (e.g. it failed before a
				// generation was even created) — say so instead of leaving the
				// placeholder blank, which reads as "the model returned empty".
				if (!sent) {
					const reason = error instanceof Error ? error.message : String(error);
					upsertAssistant(displayId, `_Failed to send message: ${reason}_`);
				} else {
					await loadHistory().catch(() => undefined);
				}
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
			const command = parseSkillCommand(appendText(message), skills);
			const text = command.text.trim();
			const attachmentIds = (message.attachments ?? []).map((a) => a.id);
			if (!text && attachmentIds.length === 0 && !command.skillName) return;
			setMessages((prev) => [
				...prev,
				{
					id: newId(),
					role: "user",
					content: text,
					skillInvocation: command.skillName
						? { name: command.skillName }
						: null,
					createdAt: new Date().toISOString(),
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
				await streamTurn("/api/chat", {
					conversationId,
					text,
					attachmentIds,
					skillName: command.skillName,
				});
			} finally {
				messageQueue.notifyIdle();
			}
		},
		[conversationId, messageQueue, skills, streamTurn],
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
		// Explicit Stop: tell the server to abort (decoupled from the fetch). The
		// server persists the partial text before ending subscriber streams, so
		// wait for the SSE [DONE] rather than tearing down locally — otherwise the
		// follow-up history reload can race ahead of persistence and drop the
		// partial output.
		if (messageId) {
			try {
				const res = await fetch("/api/chat/stop", {
					method: "POST",
					headers: jsonHeaders,
					body: JSON.stringify({ messageId }),
				});
				if (res.ok) return;
			} catch {
				// Fall through to local teardown.
			}
		}
		abortRef.current?.abort();
		eventSourceRef.current?.close();
		finishStreamRef.current?.();
	}, []);

	const attachmentAdapter = useMemo(() => {
		const adapter = new SolarAttachmentAdapter(
			allowImages,
			documentMimeTypes,
			allowDocuments,
		);
		console.info("[attachments] picker configuration", {
			allowImages,
			allowDocuments,
			documentMimeTypes,
			accept: adapter.accept,
		});
		return adapter;
	}, [allowImages, documentMimeTypes, allowDocuments]);

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

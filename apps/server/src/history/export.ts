import {
	SessionManager,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { conversationRepository } from "../conversations/repository";
import type { AttachmentRecord } from "../conversations/types";
import { piSessionDir } from "../pi/config";
import { piSessionFile } from "../pi/sessions";
import {
	HISTORY_BUNDLE_VERSION,
	type HistoryBundle,
	type HistoryMessage,
	type HistoryTurn,
} from "./bundle";

interface MarkerEntry {
	entryId: string;
	attachmentIds: string[];
}

function messageTextOf(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return (
		(content as Array<{ type?: string; text?: string }> | undefined) ?? []
	)
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/** Build one history bundle from the pi session of a conversation. */
export async function buildHistoryBundle(
	userId: string,
	conversationId: string,
): Promise<HistoryBundle> {
	const file = piSessionFile(conversationId);
	if (!file) throw new Error("conversation has no pi session");
	const manager = SessionManager.open(file, piSessionDir(conversationId));
	const conversation = (
		await conversationRepository.listConversations(userId)
	).find((candidate) => candidate.id === conversationId);
	if (!conversation) throw new Error("conversation not found");
	const messageEntries = manager
		.getEntries()
		.filter((entry): entry is SessionMessageEntry => entry.type === "message");

	const markers: MarkerEntry[] = [];
	const messages: HistoryMessage[] = [];
	const turns: HistoryTurn[] = [];

	let ordinal = 0;
	let turnId: string | null = null;
	let turnRole: "user" | "assistant" | null = null;
	for (const entry of messageEntries) {
		const role = entry.message.role === "user" ? "user" : "assistant";
		const turnStart = turnId === null || role !== turnRole;
		if (turnStart) {
			turnId = entry.id;
			turnRole = role;
			turns.push({
				id: entry.id,
				conversationId,
				ordinal: turns.length,
				role,
				origin: "text",
				status: "complete",
				createdAt: entry.timestamp,
			});
		}
		messages.push({
			id: entry.id,
			conversationId,
			turnId,
			ordinal: ordinal++,
			role: entry.message.role as HistoryMessage["role"],
			// AgentMessage is structurally a superset of Message for every
			// role we emit here.
			message: entry.message as unknown as HistoryMessage["message"],
			origin: "text",
			status: "complete",
			createdAt: entry.timestamp,
		});
		if (role === "user") {
			const ids = [
				...(messageTextOf(
					entry.message as unknown as { content?: unknown },
				).matchAll(/<solar-attachments\s+ids="([^"]*)"\s*\/>/g) ?? []),
			].flatMap((match) => (match[1] ?? "").split(",").filter(Boolean));
			if (ids.length) markers.push({ entryId: entry.id, attachmentIds: ids });
		}
	}

	const attachmentIds = [...new Set(markers.flatMap((m) => m.attachmentIds))];
	const attachments: AttachmentRecord[] = [];
	for (const id of attachmentIds) {
		const attachment = await conversationRepository
			.getAttachment(userId, id)
			.catch(() => null);
		if (attachment) attachments.push(attachment);
	}
	const bindings = markers.flatMap(({ entryId, attachmentIds }) =>
		attachmentIds
			.filter((id) => attachments.some((a) => a.id === id))
			.map((attachmentId, index) => ({
				messageId: entryId,
				attachmentId,
				ordinal: index,
			})),
	);

	return {
		version: HISTORY_BUNDLE_VERSION,
		sourceUserId: userId,
		conversation: {
			id: conversation.id,
			userId: conversation.userId,
			title:
				manager.getSessionName() ??
				conversation.title ??
				`Imported ${conversationId}`,
			folderId: conversation.folderId,
			provider: conversation.provider,
			endpointId: conversation.endpointId,
			modelId: conversation.modelId,
			modelApi: conversation.modelApi,
			systemPrompt: conversation.systemPrompt,
			reasoningEffort: conversation.reasoningEffort,
			reasoningSummary: conversation.reasoningSummary,
			verbosity: conversation.verbosity,
			autoExecuteTools: conversation.autoExecuteTools,
			displayMode: conversation.displayMode,
			createdAt: conversation.createdAt,
			updatedAt: conversation.updatedAt,
		},
		turns,
		messages,
		attachments,
		bindings,
		folder: conversation.folderId
			? ((await conversationRepository.listFolders(userId)).find(
					(folder) => folder.id === conversation.folderId,
				) ?? null)
			: null,
		tags: (await conversationRepository.listTags(userId)).filter((tag) =>
			conversation.tagIds.includes(tag.id),
		),
	};
}

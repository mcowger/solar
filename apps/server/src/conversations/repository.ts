import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema";
import type { AttachmentRecord, ConversationListRecord } from "./types";

type Executor = Kysely<Database> | Transaction<Database>;

export class NotFoundError extends Error {
	constructor(resource: string, id: string) {
		super(`${resource} ${id} was not found for this user`);
		this.name = "NotFoundError";
	}
}

export interface CreateConversationInput {
	id?: string;
	title: string;
	folderId?: string | null;
	provider?: string | null;
	endpointId?: string | null;
	modelId?: string | null;
	modelApi?: string | null;
	systemPrompt?: string | null;
	reasoningEffort?: string | null;
	reasoningSummary?: boolean;
	verbosity?: string | null;
	displayMode?: string | null;
	createdAt?: string;
}

export interface CreateAttachmentInput {
	id?: string;
	storageKey: string;
	filename: string;
	mimeType: string;
	kind: string;
	byteSize: number;
	sha256: string;
	width?: number | null;
	height?: number | null;
	pageCount?: number | null;
	createdAt?: string;
}

export interface CreateOrganizationInput {
	id?: string;
	name: string;
	createdAt?: string;
}

function now(): string {
	return new Date().toISOString();
}

function id(): string {
	return crypto.randomUUID();
}

export class ConversationRepository {
	constructor(private readonly db: Kysely<Database>) {}

	async createConversation(userId: string, input: CreateConversationInput) {
		const createdAt = input.createdAt ?? now();
		const record = {
			id: input.id ?? id(),
			userId,
			title: input.title,
			provider: input.provider ?? null,
			endpointId: input.endpointId ?? null,
			modelId: input.modelId ?? null,
			modelApi: input.modelApi ?? null,
			systemPrompt: input.systemPrompt ?? null,
			reasoningEffort: input.reasoningEffort ?? null,
			reasoningSummary: input.reasoningSummary ? 1 : 0,
			verbosity: input.verbosity ?? null,
			displayMode: input.displayMode ?? null,
			createdAt,
			updatedAt: createdAt,
			folderId: input.folderId ?? null,
		};
		await this.db.insertInto("conversation").values(record).execute();
		return this.requireConversation(this.db, userId, record.id);
	}

	async createAttachment(
		userId: string,
		input: CreateAttachmentInput,
	): Promise<AttachmentRecord> {
		if (!Number.isInteger(input.byteSize) || input.byteSize < 0)
			throw new Error("attachment byteSize must be a non-negative integer");
		const record = {
			id: input.id ?? id(),
			userId,
			storageKey: input.storageKey,
			filename: input.filename,
			mimeType: input.mimeType,
			kind: input.kind,
			byteSize: input.byteSize,
			sha256: input.sha256,
			width: input.width ?? null,
			height: input.height ?? null,
			pageCount: input.pageCount ?? null,
			createdAt: input.createdAt ?? now(),
		};
		await this.db.insertInto("attachment").values(record).execute();
		return record;
	}

	async createFolder(userId: string, input: CreateOrganizationInput) {
		const record = {
			id: input.id ?? id(),
			userId,
			name: input.name,
			createdAt: input.createdAt ?? now(),
		};
		await this.db.insertInto("folder").values(record).execute();
		return record;
	}

	async listFolders(userId: string) {
		return this.db
			.selectFrom("folder")
			.select(["id", "name", "createdAt"])
			.where("userId", "=", userId)
			.orderBy("name", "asc")
			.execute();
	}

	async renameFolder(
		userId: string,
		folderId: string,
		name: string,
	): Promise<void> {
		const result = await this.db
			.updateTable("folder")
			.set({ name })
			.where("id", "=", folderId)
			.where("userId", "=", userId)
			.executeTakeFirst();
		if ((result.numUpdatedRows ?? 0n) === 0n)
			throw new NotFoundError("folder", folderId);
	}

	async deleteFolder(userId: string, folderId: string): Promise<void> {
		await this.db.transaction().execute(async (trx) => {
			const result = await trx
				.deleteFrom("folder")
				.where("id", "=", folderId)
				.where("userId", "=", userId)
				.executeTakeFirst();
			if ((result.numDeletedRows ?? 0n) === 0n)
				throw new NotFoundError("folder", folderId);
			await trx
				.updateTable("conversation")
				.set({ folderId: null })
				.where("folderId", "=", folderId)
				.where("userId", "=", userId)
				.execute();
		});
	}

	async createTag(userId: string, input: CreateOrganizationInput) {
		const record = {
			id: input.id ?? id(),
			userId,
			name: input.name,
			createdAt: input.createdAt ?? now(),
		};
		await this.db.insertInto("tag").values(record).execute();
		return record;
	}

	async findTagByName(userId: string, name: string) {
		return this.db
			.selectFrom("tag")
			.select("id")
			.where("userId", "=", userId)
			.where("name", "=", name)
			.executeTakeFirst();
	}

	async listTags(userId: string) {
		return this.db
			.selectFrom("tag")
			.select(["id", "name", "createdAt"])
			.where("userId", "=", userId)
			.orderBy("name", "asc")
			.execute();
	}

	async deleteTag(userId: string, tagId: string): Promise<void> {
		const result = await this.db
			.deleteFrom("tag")
			.where("id", "=", tagId)
			.where("userId", "=", userId)
			.executeTakeFirst();
		if ((result.numDeletedRows ?? 0n) === 0n)
			throw new NotFoundError("tag", tagId);
	}

	async renameConversation(
		userId: string,
		conversationId: string,
		title: string,
	): Promise<void> {
		await this.requireConversation(this.db, userId, conversationId);
		await this.db
			.updateTable("conversation")
			.set({ title, updatedAt: now() })
			.where("id", "=", conversationId)
			.execute();
	}

	async setConversationFolder(
		userId: string,
		conversationId: string,
		folderId: string | null,
	): Promise<void> {
		await this.db.transaction().execute(async (trx) => {
			await this.requireConversation(trx, userId, conversationId);
			if (folderId) await this.requireFolder(trx, userId, folderId);
			await trx
				.updateTable("conversation")
				.set({ folderId, updatedAt: now() })
				.where("id", "=", conversationId)
				.execute();
		});
	}

	async setConversationTags(
		userId: string,
		conversationId: string,
		tagIds: readonly string[],
	): Promise<void> {
		await this.db.transaction().execute(async (trx) => {
			await this.requireConversation(trx, userId, conversationId);
			for (const tagId of tagIds) await this.requireTag(trx, userId, tagId);
			await trx
				.deleteFrom("conversation_tag")
				.where("conversationId", "=", conversationId)
				.execute();
			if (tagIds.length > 0)
				await trx
					.insertInto("conversation_tag")
					.values(tagIds.map((tagId) => ({ conversationId, tagId })))
					.execute();
		});
	}

	async setConversationModel(
		userId: string,
		conversationId: string,
		selection: {
			provider: string;
			endpointId: string;
			modelId: string;
			modelApi: string;
		},
	): Promise<void> {
		await this.requireConversation(this.db, userId, conversationId);
		await this.db
			.updateTable("conversation")
			.set({
				provider: selection.provider,
				endpointId: selection.endpointId,
				modelId: selection.modelId,
				modelApi: selection.modelApi,
				updatedAt: now(),
			})
			.where("id", "=", conversationId)
			.execute();
	}

	async setConversationGenerationSettings(
		userId: string,
		conversationId: string,
		settings: {
			reasoningEffort?: string | null;
			verbosity?: string | null;
			reasoningSummary?: boolean;
		},
	): Promise<void> {
		await this.requireConversation(this.db, userId, conversationId);
		await this.db
			.updateTable("conversation")
			.set({
				...(settings.reasoningEffort !== undefined
					? { reasoningEffort: settings.reasoningEffort }
					: {}),
				...(settings.verbosity !== undefined
					? { verbosity: settings.verbosity }
					: {}),
				...(settings.reasoningSummary !== undefined
					? { reasoningSummary: settings.reasoningSummary ? 1 : 0 }
					: {}),
				updatedAt: now(),
			})
			.where("id", "=", conversationId)
			.execute();
	}

	async setConversationDisplayMode(
		userId: string,
		conversationId: string,
		displayMode: string,
	): Promise<void> {
		await this.requireConversation(this.db, userId, conversationId);
		await this.db
			.updateTable("conversation")
			.set({ displayMode, updatedAt: now() })
			.where("id", "=", conversationId)
			.execute();
	}

	async setConversationAutoExecuteTools(
		userId: string,
		conversationId: string,
		enabled: boolean,
	): Promise<void> {
		await this.requireConversation(this.db, userId, conversationId);
		await this.db
			.updateTable("conversation")
			.set({ autoExecuteTools: enabled ? 1 : 0, updatedAt: now() })
			.where("id", "=", conversationId)
			.execute();
	}

	async setConversationMcpServer(
		userId: string,
		conversationId: string,
		serverId: string,
		enabled: boolean,
	): Promise<void> {
		await this.requireConversation(this.db, userId, conversationId);
		await this.db
			.insertInto("conversation_mcp_server")
			.values({ conversationId, serverId, enabled: enabled ? 1 : 0 })
			.onConflict((oc) =>
				oc
					.columns(["conversationId", "serverId"])
					.doUpdateSet({ enabled: enabled ? 1 : 0 }),
			)
			.execute();
	}

	async listConversationMcpServers(
		userId: string,
		conversationId: string,
	): Promise<{ serverId: string; enabled: boolean }[]> {
		await this.requireConversation(this.db, userId, conversationId);
		const rows = await this.db
			.selectFrom("conversation_mcp_server")
			.select(["serverId", "enabled"])
			.where("conversationId", "=", conversationId)
			.execute();
		return rows.map((row) => ({
			serverId: row.serverId,
			enabled: Boolean(row.enabled),
		}));
	}

	async listConversations(userId: string): Promise<ConversationListRecord[]> {
		const conversations = await this.db
			.selectFrom("conversation")
			.selectAll()
			.where("userId", "=", userId)
			.orderBy("updatedAt", "desc")
			.execute();
		const tags = await this.db
			.selectFrom("conversation_tag as binding")
			.innerJoin("tag as tag", "tag.id", "binding.tagId")
			.select(["binding.conversationId", "binding.tagId"])
			.where("tag.userId", "=", userId)
			.execute();
		const tagIdsByConversation = new Map<string, string[]>();
		for (const tag of tags)
			tagIdsByConversation.set(tag.conversationId, [
				...(tagIdsByConversation.get(tag.conversationId) ?? []),
				tag.tagId,
			]);
		return conversations.map((conversation) => ({
			...conversation,
			tagIds: tagIdsByConversation.get(conversation.id) ?? [],
		}));
	}

	async getConversation(userId: string, conversationId: string) {
		return this.requireConversation(this.db, userId, conversationId);
	}

	async deleteConversation(
		userId: string,
		conversationId: string,
	): Promise<void> {
		await this.requireConversation(this.db, userId, conversationId);
		await this.db
			.deleteFrom("conversation")
			.where("id", "=", conversationId)
			.execute();
	}

	async removeOrphanAttachment(
		userId: string,
		attachmentId: string,
	): Promise<{ removed: boolean; storageKey?: string }> {
		return this.db.transaction().execute(async (trx) => {
			const attachment = await trx
				.selectFrom("attachment")
				.select(["id", "storageKey"])
				.where("id", "=", attachmentId)
				.where("userId", "=", userId)
				.executeTakeFirst();
			if (!attachment) return { removed: false };

			// Keep the orphan check in the same conditional DELETE as the row
			// removal. A concurrent completion can therefore either bind first
			// (and make this delete a no-op) or lose the race before binding
			// validates its attachment, but it cannot bind after a successful
			// check and then have its binding silently cascaded away.
			const deleted = await trx
				.deleteFrom("attachment")
				.where("id", "=", attachmentId)
				.where("userId", "=", userId)
				.where((eb) =>
					eb.not(
						eb.exists(
							eb
								.selectFrom("message_attachment")
								.select("attachmentId")
								.where("attachmentId", "=", attachmentId),
						),
					),
				)
				.executeTakeFirst();
			return (deleted.numDeletedRows ?? 0n) > 0n
				? { removed: true, storageKey: attachment.storageKey }
				: { removed: false };
		});
	}

	async getAttachment(userId: string, attachmentId: string) {
		return this.requireAttachment(this.db, userId, attachmentId);
	}

	private async requireConversation(
		executor: Executor,
		userId: string,
		conversationId: string,
	) {
		const record = await executor
			.selectFrom("conversation")
			.selectAll()
			.where("id", "=", conversationId)
			.where("userId", "=", userId)
			.executeTakeFirst();
		if (!record) throw new NotFoundError("conversation", conversationId);
		return record;
	}

	private async requireAttachment(
		executor: Executor,
		userId: string,
		attachmentId: string,
	) {
		const record = await executor
			.selectFrom("attachment")
			.selectAll()
			.where("id", "=", attachmentId)
			.where("userId", "=", userId)
			.executeTakeFirst();
		if (!record) throw new NotFoundError("attachment", attachmentId);
		return record;
	}

	private async requireFolder(
		executor: Executor,
		userId: string,
		folderId: string,
	) {
		const folder = await executor
			.selectFrom("folder")
			.selectAll()
			.where("id", "=", folderId)
			.where("userId", "=", userId)
			.executeTakeFirst();
		if (!folder) throw new NotFoundError("folder", folderId);
		return folder;
	}

	private async requireTag(executor: Executor, userId: string, tagId: string) {
		const tag = await executor
			.selectFrom("tag")
			.selectAll()
			.where("id", "=", tagId)
			.where("userId", "=", userId)
			.executeTakeFirst();
		if (!tag) throw new NotFoundError("tag", tagId);
		return tag;
	}
}

/** Process-wide repository handle. */
import { db } from "../db";
export const conversationRepository = new ConversationRepository(db);

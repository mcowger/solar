import { afterEach, describe, expect, test } from "bun:test";
import { createTestDatabase } from "./fixtures";
import { ConversationRepository, NotFoundError } from "./repository";

const USER_A = "user-a";
const USER_B = "user-b";

describe("conversation metadata", () => {
	const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];

	afterEach(async () => {
		await Promise.all(
			databases.splice(0).map((database) => database.destroy()),
		);
	});

	async function repositoryFixture() {
		const database = await createTestDatabase();
		databases.push(database);
		database.seedUser(USER_A);
		database.seedUser(USER_B);
		return { ...database, repository: new ConversationRepository(database.db) };
	}

	test("creates, lists, renames, and deletes conversations with ownership checks", async () => {
		const { repository } = await repositoryFixture();
		const conversation = await repository.createConversation(USER_A, {
			title: "First chat",
		});
		expect(conversation.title).toBe("First chat");

		const listed = await repository.listConversations(USER_A);
		expect(listed.map((row) => row.id)).toEqual([conversation.id]);
		expect(listed[0]!.tagIds).toEqual([]);
		expect(await repository.listConversations(USER_B)).toEqual([]);

		await repository.renameConversation(USER_A, conversation.id, "Renamed");
		expect(
			(await repository.getConversation(USER_A, conversation.id)).title,
		).toBe("Renamed");

		await expect(
			repository.getConversation(USER_B, conversation.id),
		).rejects.toBeInstanceOf(NotFoundError);
		await expect(
			repository.renameConversation(USER_B, conversation.id, "Nope"),
		).rejects.toBeInstanceOf(NotFoundError);

		await repository.deleteConversation(USER_A, conversation.id);
		expect(await repository.listConversations(USER_A)).toEqual([]);
	});

	test("organizes conversations with folders and tags", async () => {
		const { repository } = await repositoryFixture();
		const folder = await repository.createFolder(USER_A, { name: "Work" });
		const tag = await repository.createTag(USER_A, { name: "urgent" });
		const conversation = await repository.createConversation(USER_A, {
			title: "Tagged",
		});

		await repository.setConversationFolder(USER_A, conversation.id, folder.id);
		await repository.setConversationTags(USER_A, conversation.id, [tag.id]);
		const [listed] = await repository.listConversations(USER_A);
		expect(listed!.folderId).toBe(folder.id);
		expect(listed!.tagIds).toEqual([tag.id]);

		expect(await repository.listFolders(USER_A)).toHaveLength(1);
		expect(await repository.listTags(USER_A)).toHaveLength(1);

		await repository.deleteFolder(USER_A, folder.id);
		expect(
			(await repository.getConversation(USER_A, conversation.id)).folderId,
		).toBeNull();
	});

	test("persists per-conversation model, effort, verbosity, display mode, and MCP settings", async () => {
		const { repository } = await repositoryFixture();
		const conversation = await repository.createConversation(USER_A, {
			title: "Settings",
		});

		await repository.setConversationModel(USER_A, conversation.id, {
			provider: "openai",
			endpointId: "openai-default",
			modelId: "gpt-5.6",
			modelApi: "openai-responses",
		});
		await repository.setConversationGenerationSettings(
			USER_A,
			conversation.id,
			{
				reasoningEffort: "high",
				verbosity: "low",
			},
		);
		await repository.setConversationDisplayMode(
			USER_A,
			conversation.id,
			"timeline",
		);
		await repository.setConversationAutoExecuteTools(
			USER_A,
			conversation.id,
			false,
		);

		const reloaded = await repository.getConversation(USER_A, conversation.id);
		expect(reloaded.provider).toBe("openai");
		expect(reloaded.endpointId).toBe("openai-default");
		expect(reloaded.modelId).toBe("gpt-5.6");
		expect(reloaded.modelApi).toBe("openai-responses");
		expect(reloaded.reasoningEffort).toBe("high");
		expect(reloaded.verbosity).toBe("low");
		expect(reloaded.displayMode).toBe("timeline");
		expect(reloaded.autoExecuteTools).toBe(0);

		// Partial updates leave previously set fields untouched.
		await repository.setConversationGenerationSettings(
			USER_A,
			conversation.id,
			{
				verbosity: "high",
			},
		);
		const afterPartialUpdate = await repository.getConversation(
			USER_A,
			conversation.id,
		);
		expect(afterPartialUpdate.reasoningEffort).toBe("high");
		expect(afterPartialUpdate.verbosity).toBe("high");

		// Ownership is enforced the same way as every other repository mutation.
		await expect(
			repository.setConversationModel(USER_B, conversation.id, {
				provider: "openai",
				endpointId: "openai-default",
				modelId: "gpt-5.6",
				modelApi: "openai-responses",
			}),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test("binds and lists MCP servers per conversation, isolated from other conversations", async () => {
		const { db, repository } = await repositoryFixture();
		const conversation = await repository.createConversation(USER_A, {
			title: "MCP",
		});
		const otherConversation = await repository.createConversation(USER_A, {
			title: "Other",
		});
		await db
			.insertInto("mcp_server")
			.values({
				id: "server-1",
				userId: null,
				name: "Shared server",
				url: "https://example.test/mcp",
				headers: "{}",
				enabled: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			})
			.execute();

		await repository.setConversationMcpServer(
			USER_A,
			conversation.id,
			"server-1",
			true,
		);
		expect(
			await repository.listConversationMcpServers(USER_A, conversation.id),
		).toEqual([{ serverId: "server-1", enabled: true }]);
		expect(
			await repository.listConversationMcpServers(USER_A, otherConversation.id),
		).toEqual([]);

		await repository.setConversationMcpServer(
			USER_A,
			conversation.id,
			"server-1",
			false,
		);
		expect(
			await repository.listConversationMcpServers(USER_A, conversation.id),
		).toEqual([{ serverId: "server-1", enabled: false }]);

		await expect(
			repository.listConversationMcpServers(USER_B, conversation.id),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test("creates and removes orphaned attachments", async () => {
		const { repository } = await repositoryFixture();
		const attachment = await repository.createAttachment(USER_A, {
			id: "attachment-1",
			storageKey: "attachment-1",
			filename: "note.txt",
			mimeType: "text/plain",
			kind: "text",
			byteSize: 4,
			sha256: "hash",
		});
		expect(attachment.filename).toBe("note.txt");
		expect((await repository.getAttachment(USER_A, "attachment-1")).id).toBe(
			"attachment-1",
		);

		const removed = await repository.removeOrphanAttachment(
			USER_A,
			"attachment-1",
		);
		expect(removed.removed).toBe(true);
		expect(removed.storageKey).toBe("attachment-1");
		await expect(
			repository.getAttachment(USER_B, "attachment-1"),
		).rejects.toBeInstanceOf(NotFoundError);
	});
});

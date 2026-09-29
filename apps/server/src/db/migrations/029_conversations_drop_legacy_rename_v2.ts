import { sql, type Kysely } from "kysely";

/**
 * Post-migration-window cleanup (029).
 *
 * The chat-v2 → pi migration window has passed: pi session JSONL under
 * ${SOLAR_PI_AGENT_DIR} is the only conversation history. This migration:
 *
 * 1. Rebuilds the attachment↔entry binding table without its foreign key to
 *    the dropped message table (`messageId` is a pi session entry id — plain
 *    text, since session files are not SQL rows).
 * 2. Drops archive-only chat-v2 tables (turns, messages, generations,
 *    generation events, voice turns, compactions, compaction jobs).
 *    Unmigrated archive rows are abandoned.
 * 3. Drops dead v1 tables (conversation, message, folder, tag,
 *    conversation_tag, attachment, conversation_mcp_server,
 *    conversation_context_state, generation_step, provider_call_telemetry)
 *    which have had no live readers since the pi engine rollout.
 * 4. Renames the live v2_* metadata tables to clean names. SQLite rewrites
 *    foreign-key references on RENAME TABLE, so dependent FKs follow.
 * 5. Drops the unread `generationConfigJson` column (nothing reads it).
 *
 * Table drops/renames run in FK-safe order (children before parents) because
 * the app connection enforces foreign keys.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	// 1. Preserve bindings while dropping the dead message FK.
	await db.schema
		.createTable("message_attachment_new")
		.addColumn("messageId", "text", (col) => col.notNull())
		.addColumn("attachmentId", "text", (col) =>
			col.notNull().references("v2_attachment.id").onDelete("cascade"),
		)
		.addColumn("ordinal", "integer", (col) => col.notNull())
		.addPrimaryKeyConstraint("message_attachment_pk", [
			"messageId",
			"attachmentId",
		])
		.addUniqueConstraint("message_attachment_message_ordinal_unique", [
			"messageId",
			"ordinal",
		])
		.execute();
	await sql`insert into message_attachment_new (messageId, attachmentId, ordinal) select messageId, attachmentId, ordinal from v2_message_attachment`.execute(
		db,
	);
	await db.schema.dropTable("v2_message_attachment").execute();
	await db.schema
		.alterTable("message_attachment_new")
		.renameTo("message_attachment")
		.execute();

	// 2. Archive-only chat-v2 tables (children before parents).
	for (const table of [
		"v2_context_compaction_job",
		"v2_context_compaction",
		"v2_generation_event",
		"v2_generation",
		"v2_voice_turn",
		"v2_conversation_message",
		"v2_conversation_turn",
	] as const) {
		await db.schema.dropTable(table).execute();
	}

	// 3. Dead v1 tables (children before parents).
	for (const table of [
		"conversation_tag",
		"attachment",
		"message",
		"conversation_mcp_server",
		"conversation_context_state",
		"generation_step",
		"provider_call_telemetry",
		"conversation",
		"folder",
		"tag",
	] as const) {
		await db.schema.dropTable(table).ifExists().execute();
	}

	// 4. Rename live tables (SQLite rewrites referencing FKs).
	const renames = [
		["v2_conversation", "conversation"],
		["v2_folder", "folder"],
		["v2_tag", "tag"],
		["v2_conversation_tag", "conversation_tag"],
		["v2_attachment", "attachment"],
		["v2_conversation_mcp_server", "conversation_mcp_server"],
	] as const;
	for (const [from, to] of renames) {
		await db.schema.alterTable(from).renameTo(to).execute();
	}

	for (const index of [
		"v2_conversation_userId_idx",
		"v2_folder_userId_idx",
		"v2_tag_userId_idx",
		"v2_conversation_folderId_idx",
	] as const) {
		await db.schema.dropIndex(index).ifExists().execute();
	}
	await db.schema
		.createIndex("conversation_userId_idx")
		.on("conversation")
		.column("userId")
		.execute();
	await db.schema
		.createIndex("folder_userId_idx")
		.on("folder")
		.column("userId")
		.execute();
	await db.schema
		.createIndex("tag_userId_idx")
		.on("tag")
		.column("userId")
		.execute();
	await db.schema
		.createIndex("conversation_folderId_idx")
		.on("conversation")
		.column("folderId")
		.execute();

	// 5. Drop the unread snapshot column.
	await db.schema
		.alterTable("conversation")
		.dropColumn("generationConfigJson")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// Best-effort reversal of the renames only. Dropped tables and their rows
	// (archive history, dead v1 state) are not recoverable.
	await db.schema
		.alterTable("conversation")
		.addColumn("generationConfigJson", "text", (col) =>
			col.notNull().defaultTo("{}"),
		)
		.execute();
	const renames = [
		["conversation", "v2_conversation"],
		["folder", "v2_folder"],
		["tag", "v2_tag"],
		["conversation_tag", "v2_conversation_tag"],
		["attachment", "v2_attachment"],
		["message_attachment", "v2_message_attachment"],
		["conversation_mcp_server", "v2_conversation_mcp_server"],
	] as const;
	for (const [from, to] of renames) {
		await db.schema.alterTable(from).renameTo(to).execute();
	}
}

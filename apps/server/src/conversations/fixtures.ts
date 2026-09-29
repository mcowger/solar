import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import type { Database } from "../db/schema";
import { up as upSkills } from "../db/migrations/018_skills";

/**
 * In-memory test database matching the post-029 schema: live conversation
 * metadata tables with clean names, no archive tables, no dead v1 tables.
 */
export async function createTestDatabase(): Promise<{
	db: Kysely<Database>;
	sqlite: BunDatabase;
	seedUser(id: string): void;
	reset(): Promise<void>;
	destroy(): Promise<void>;
}> {
	const sqlite = new BunDatabase(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	const db = new Kysely<Database>({
		dialect: new BunSqliteDialect({ database: sqlite }),
	});
	await db.schema
		.createTable("user")
		.addColumn("id", "text", (col) => col.primaryKey())
		.execute();
	await db.schema
		.createTable("mcp_server")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("userId", "text")
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("url", "text", (col) => col.notNull())
		.addColumn("headers", "text", (col) => col.notNull().defaultTo("{}"))
		.addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
		.addColumn("createdAt", "text", (col) => col.notNull())
		.addColumn("updatedAt", "text", (col) => col.notNull())
		.execute();
	await db.schema
		.createTable("user_mcp_server_preference")
		.addColumn("userId", "text", (col) => col.notNull())
		.addColumn("serverId", "text", (col) =>
			col.notNull().references("mcp_server.id").onDelete("cascade"),
		)
		.addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
		.addPrimaryKeyConstraint("user_mcp_server_preference_pk", [
			"userId",
			"serverId",
		])
		.execute();
	await db.schema
		.createTable("folder")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("userId", "text", (col) =>
			col.notNull().references("user.id").onDelete("cascade"),
		)
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();
	await db.schema
		.createTable("tag")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("userId", "text", (col) =>
			col.notNull().references("user.id").onDelete("cascade"),
		)
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();
	await db.schema
		.createTable("conversation")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("userId", "text", (col) =>
			col.notNull().references("user.id").onDelete("cascade"),
		)
		.addColumn("title", "text", (col) => col.notNull())
		.addColumn("provider", "text")
		.addColumn("endpointId", "text")
		.addColumn("modelId", "text")
		.addColumn("modelApi", "text")
		.addColumn("systemPrompt", "text")
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.addColumn("updatedAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.addColumn("folderId", "text", (col) =>
			col.references("folder.id").onDelete("set null"),
		)
		.addColumn("reasoningEffort", "text")
		.addColumn("verbosity", "text")
		.addColumn("autoExecuteTools", "integer", (col) =>
			col.notNull().defaultTo(1),
		)
		.addColumn("displayMode", "text")
		.addColumn("reasoningSummary", "integer", (col) =>
			col.notNull().defaultTo(0),
		)
		.execute();
	await db.schema
		.createIndex("conversation_userId_idx")
		.on("conversation")
		.column("userId")
		.execute();
	await db.schema
		.createIndex("conversation_folderId_idx")
		.on("conversation")
		.column("folderId")
		.execute();
	await db.schema
		.createTable("conversation_tag")
		.addColumn("conversationId", "text", (col) =>
			col.notNull().references("conversation.id").onDelete("cascade"),
		)
		.addColumn("tagId", "text", (col) =>
			col.notNull().references("tag.id").onDelete("cascade"),
		)
		.addPrimaryKeyConstraint("conversation_tag_pk", ["conversationId", "tagId"])
		.execute();
	await db.schema
		.createTable("attachment")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("userId", "text", (col) =>
			col.notNull().references("user.id").onDelete("cascade"),
		)
		.addColumn("storageKey", "text", (col) => col.notNull().unique())
		.addColumn("filename", "text", (col) => col.notNull())
		.addColumn("mimeType", "text", (col) => col.notNull())
		.addColumn("kind", "text", (col) => col.notNull())
		.addColumn("byteSize", "integer", (col) => col.notNull())
		.addColumn("sha256", "text", (col) => col.notNull())
		.addColumn("width", "integer")
		.addColumn("height", "integer")
		.addColumn("pageCount", "integer")
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();
	await db.schema
		.createTable("message_attachment")
		.addColumn("messageId", "text", (col) => col.notNull())
		.addColumn("attachmentId", "text", (col) =>
			col.notNull().references("attachment.id").onDelete("cascade"),
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
	await db.schema
		.createTable("conversation_mcp_server")
		.addColumn("conversationId", "text", (col) =>
			col.notNull().references("conversation.id").onDelete("cascade"),
		)
		.addColumn("serverId", "text", (col) =>
			col.notNull().references("mcp_server.id").onDelete("cascade"),
		)
		.addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
		.addPrimaryKeyConstraint("conversation_mcp_server_pk", [
			"conversationId",
			"serverId",
		])
		.execute();
	await upSkills(db as unknown as Kysely<unknown>);
	return {
		db,
		sqlite,
		seedUser(id) {
			sqlite.query("insert into user (id) values (?)").run(id);
		},
		async reset() {
			await db.deleteFrom("conversation").execute();
			await db.deleteFrom("attachment").execute();
			await db.deleteFrom("folder").execute();
			await db.deleteFrom("tag").execute();
			await sql`delete from user`.execute(db);
		},
		async destroy() {
			await db.destroy();
			sqlite.close();
		},
	};
}

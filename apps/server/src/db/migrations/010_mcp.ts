import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
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
	await db.schema
		.alterTable("conversation")
		.addColumn("autoExecuteTools", "integer", (col) =>
			col.notNull().defaultTo(1),
		)
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("conversation")
		.dropColumn("autoExecuteTools")
		.execute();
	await db.schema.dropTable("conversation_mcp_server").execute();
	await db.schema.dropTable("user_mcp_server_preference").execute();
	await db.schema.dropTable("mcp_server").execute();
}

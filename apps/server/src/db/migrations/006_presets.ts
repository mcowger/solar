import { sql, type Kysely } from "kysely";

/**
 * Presets (M3): reusable assistant configs — model + system prompt + capability-
 * gated reasoning/verbosity params. A preset is chosen only at conversation
 * start; its settings are snapshotted onto the conversation (below), so editing
 * or deleting a preset never mutates existing conversations.
 *
 * - `preset`: owned by a user; `scope` is "personal" or "shared". Shared presets
 *   are usable by anyone but editable/deletable only by the owner or an admin.
 * - `conversation` gains the snapshotted generation params. Model columns
 *   (provider/modelId/modelApi) already exist from migration 004.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("preset")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("userId", "text", (col) =>
			col.notNull().references("user.id").onDelete("cascade"),
		)
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("scope", "text", (col) => col.notNull().defaultTo("personal"))
		.addColumn("provider", "text", (col) => col.notNull())
		.addColumn("modelId", "text", (col) => col.notNull())
		.addColumn("modelApi", "text", (col) => col.notNull())
		.addColumn("systemPrompt", "text")
		.addColumn("reasoningEffort", "text")
		.addColumn("reasoningSummary", "integer", (col) =>
			col.notNull().defaultTo(0),
		)
		.addColumn("verbosity", "text")
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();

	await db.schema
		.createIndex("preset_scope_idx")
		.on("preset")
		.column("scope")
		.execute();

	await db.schema
		.alterTable("conversation")
		.addColumn("systemPrompt", "text")
		.execute();
	await db.schema
		.alterTable("conversation")
		.addColumn("reasoningEffort", "text")
		.execute();
	await db.schema
		.alterTable("conversation")
		.addColumn("reasoningSummary", "integer", (col) =>
			col.notNull().defaultTo(0),
		)
		.execute();
	await db.schema
		.alterTable("conversation")
		.addColumn("verbosity", "text")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("conversation").dropColumn("verbosity").execute();
	await db.schema
		.alterTable("conversation")
		.dropColumn("reasoningSummary")
		.execute();
	await db.schema
		.alterTable("conversation")
		.dropColumn("reasoningEffort")
		.execute();
	await db.schema
		.alterTable("conversation")
		.dropColumn("systemPrompt")
		.execute();
	await db.schema.dropTable("preset").execute();
}

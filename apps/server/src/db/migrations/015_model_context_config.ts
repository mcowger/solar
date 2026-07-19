import { sql, type Kysely } from "kysely";

/** Model context overrides now live with provider allowlist entries. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("context_policy").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("context_policy")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("scope", "text", (col) => col.notNull())
		.addColumn("provider", "text", (col) => col.notNull())
		.addColumn("modelFamily", "text")
		.addColumn("modelId", "text")
		.addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
		.addColumn("softTriggerTokens", "integer", (col) => col.notNull())
		.addColumn("targetTokens", "integer", (col) => col.notNull())
		.addColumn("hardInputTokens", "integer", (col) => col.notNull())
		.addColumn("maxPinnedAttachmentTokens", "integer", (col) => col.notNull())
		.addColumn("outputReserveTokens", "integer", (col) => col.notNull())
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.addColumn("updatedAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();
	await db.schema
		.createIndex("context_policy_resolution_idx")
		.on("context_policy")
		.columns(["scope", "provider", "modelFamily", "modelId"])
		.execute();
}

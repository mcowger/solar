import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createIndex("message_usage_idx")
		.on("message")
		.columns(["conversationId", "role", "model"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("message_usage_idx").execute();
}

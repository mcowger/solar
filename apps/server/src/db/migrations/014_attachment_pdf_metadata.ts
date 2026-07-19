import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("attachment")
		.addColumn("pageCount", "integer")
		.execute();
	await db.schema
		.alterTable("attachment")
		.addColumn("extractedTextChars", "integer")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("attachment")
		.dropColumn("extractedTextChars")
		.execute();
	await db.schema.alterTable("attachment").dropColumn("pageCount").execute();
}

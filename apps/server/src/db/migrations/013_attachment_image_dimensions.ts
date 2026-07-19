import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("attachment")
		.addColumn("width", "integer")
		.execute();
	await db.schema
		.alterTable("attachment")
		.addColumn("height", "integer")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("attachment").dropColumn("height").execute();
	await db.schema.alterTable("attachment").dropColumn("width").execute();
}

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("user_setting")
		.addColumn("defaultPresetId", "text")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("user_setting")
		.dropColumn("defaultPresetId")
		.execute();
}

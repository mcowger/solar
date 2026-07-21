import { type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("user_setting")
		.addColumn("defaultDisplayMode", "text")
		.execute();

	await db.schema
		.alterTable("conversation")
		.addColumn("displayMode", "text")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("user_setting")
		.dropColumn("defaultDisplayMode")
		.execute();

	await db.schema
		.alterTable("conversation")
		.dropColumn("displayMode")
		.execute();
}

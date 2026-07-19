import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("conversation")
		.addColumn("presetReasoningEffort", "text")
		.execute();
	await db.schema
		.alterTable("conversation")
		.addColumn("presetVerbosity", "text")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("conversation")
		.dropColumn("presetVerbosity")
		.execute();
	await db.schema
		.alterTable("conversation")
		.dropColumn("presetReasoningEffort")
		.execute();
}

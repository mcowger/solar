import type { Kysely } from "kysely";

/**
 * Model sync: whether a provider's models follow its gateway on the
 * background timer, and the outcome of the last sync (JSON; see
 * chat/modelSync.ts). Writing the status never bumps updatedAt, which tracks
 * the configuration itself.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("provider_config")
		.addColumn("autoSyncModels", "integer", (col) => col.notNull().defaultTo(0))
		.execute();
	await db.schema
		.alterTable("provider_config")
		.addColumn("modelSyncStatus", "text")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("provider_config")
		.dropColumn("modelSyncStatus")
		.execute();
	await db.schema
		.alterTable("provider_config")
		.dropColumn("autoSyncModels")
		.execute();
}

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("source_category")
		.addColumn("domain", "text", (col) => col.primaryKey())
		.addColumn("category", "text")
		.addColumn("source", "text", (col) => col.notNull())
		.addColumn("updatedAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("source_category").execute();
}

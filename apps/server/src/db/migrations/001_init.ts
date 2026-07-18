import type { Kysely } from "kysely";

/**
 * First app migration. Better Auth manages its own tables separately; this
 * migration owns only app tables. `app_meta` is a minimal key/value table that
 * proves the migration + codegen loop end-to-end for M0.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("app_meta")
    .addColumn("key", "text", (col) => col.primaryKey())
    .addColumn("value", "text", (col) => col.notNull())
    .addColumn("updatedAt", "text", (col) =>
      col.notNull().defaultTo("CURRENT_TIMESTAMP"),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("app_meta").execute();
}

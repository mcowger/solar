import { sql, type Kysely } from "kysely";

/**
 * Per-user default model (M3). Admin-wide default lives in `app_meta` under the
 * `default_model` key. Default resolution order at send time: the conversation's
 * stored selection → the user's personal default → the admin default → the first
 * available model.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("user_setting")
    .addColumn("userId", "text", (col) =>
      col.primaryKey().references("user.id").onDelete("cascade"),
    )
    .addColumn("defaultProvider", "text")
    .addColumn("defaultModelId", "text")
    .addColumn("defaultApi", "text")
    .addColumn("updatedAt", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("user_setting").execute();
}

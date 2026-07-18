import { sql, type Kysely } from "kysely";

/**
 * Attachments (M3): images + plain-text files, stored on disk via Mirage
 * (DiskResource), never locally parsed/extracted. `attachment` rows are
 * created on upload with `messageId` null (the file exists before the user
 * hits send); the chat routes link them to the message they were sent with.
 * Orphaned (never-linked) rows/files are cleaned up by the uploader's explicit
 * remove action in the composer; linked ones cascade-delete with their
 * message/conversation (the app deletes the on-disk files first — SQLite FK
 * cascade only removes rows, not files).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("attachment")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("userId", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("messageId", "text", (col) =>
      col.references("message.id").onDelete("cascade"),
    )
    .addColumn("filename", "text", (col) => col.notNull())
    .addColumn("mimeType", "text", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("byteSize", "integer", (col) => col.notNull())
    .addColumn("storageKey", "text", (col) => col.notNull())
    .addColumn("createdAt", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  await db.schema
    .createIndex("attachment_messageId_idx")
    .on("attachment")
    .column("messageId")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("attachment").execute();
}

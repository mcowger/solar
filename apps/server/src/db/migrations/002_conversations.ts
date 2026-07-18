import { sql, type Kysely } from "kysely";

/**
 * Conversation + message tables (M1). DB-canonical conversation state: one row
 * per message with a searchable `text` column plus pi-native `parts` as JSON.
 * `conversation.userId` is a managed FK to Better Auth's `user` table in the
 * same solar.db.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("conversation")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("userId", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("createdAt", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updatedAt", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  await db.schema
    .createIndex("conversation_userId_idx")
    .on("conversation")
    .column("userId")
    .execute();

  await db.schema
    .createTable("message")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("conversationId", "text", (col) =>
      col.notNull().references("conversation.id").onDelete("cascade"),
    )
    .addColumn("role", "text", (col) => col.notNull())
    .addColumn("text", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("parts", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("complete"))
    .addColumn("model", "text")
    .addColumn("inputTokens", "integer")
    .addColumn("outputTokens", "integer")
    .addColumn("createdAt", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  await db.schema
    .createIndex("message_conversationId_idx")
    .on("message")
    .column("conversationId")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("message").execute();
  await db.schema.dropTable("conversation").execute();
}

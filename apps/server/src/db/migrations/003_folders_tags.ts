import { sql, type Kysely } from "kysely";

/**
 * Organization for conversations (M2): folders and tags, both user-scoped.
 *
 * - `folder`: a named container; `conversation.folderId` is a nullable FK that
 *   nulls out when its folder is deleted (conversations survive folder removal).
 * - `tag` + `conversation_tag`: many-to-many labels, unique per (user, name).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("folder")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("userId", "text", (col) =>
			col.notNull().references("user.id").onDelete("cascade"),
		)
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();

	await db.schema
		.createIndex("folder_userId_idx")
		.on("folder")
		.column("userId")
		.execute();

	await db.schema
		.alterTable("conversation")
		.addColumn("folderId", "text", (col) =>
			col.references("folder.id").onDelete("set null"),
		)
		.execute();

	await db.schema
		.createTable("tag")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("userId", "text", (col) =>
			col.notNull().references("user.id").onDelete("cascade"),
		)
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();

	await db.schema
		.createIndex("tag_userId_name_unique")
		.on("tag")
		.columns(["userId", "name"])
		.unique()
		.execute();

	await db.schema
		.createTable("conversation_tag")
		.addColumn("conversationId", "text", (col) =>
			col.notNull().references("conversation.id").onDelete("cascade"),
		)
		.addColumn("tagId", "text", (col) =>
			col.notNull().references("tag.id").onDelete("cascade"),
		)
		.addPrimaryKeyConstraint("conversation_tag_pk", ["conversationId", "tagId"])
		.execute();

	await db.schema
		.createIndex("conversation_tag_tagId_idx")
		.on("conversation_tag")
		.column("tagId")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("conversation_tag").execute();
	await db.schema.dropTable("tag").execute();
	await db.schema.alterTable("conversation").dropColumn("folderId").execute();
	await db.schema.dropTable("folder").execute();
}

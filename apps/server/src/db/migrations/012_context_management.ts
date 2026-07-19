import { sql, type Kysely } from "kysely";

/** Context working-memory, opaque generation steps, and content-free call usage. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("context_policy")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("scope", "text", (col) => col.notNull())
		.addColumn("provider", "text", (col) => col.notNull())
		.addColumn("modelFamily", "text")
		.addColumn("modelId", "text")
		.addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
		.addColumn("softTriggerTokens", "integer", (col) => col.notNull())
		.addColumn("targetTokens", "integer", (col) => col.notNull())
		.addColumn("hardInputTokens", "integer", (col) => col.notNull())
		.addColumn("maxPinnedAttachmentTokens", "integer", (col) => col.notNull())
		.addColumn("outputReserveTokens", "integer", (col) => col.notNull())
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.addColumn("updatedAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();
	await db.schema
		.createIndex("context_policy_resolution_idx")
		.on("context_policy")
		.columns(["scope", "provider", "modelFamily", "modelId"])
		.execute();

	await db.schema
		.createTable("conversation_context_state")
		.addColumn("conversationId", "text", (col) =>
			col.primaryKey().references("conversation.id").onDelete("cascade"),
		)
		.addColumn("revision", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("summary", "text")
		.addColumn("summaryRevision", "integer")
		.addColumn("retainedMessageBoundaryId", "text", (col) =>
			col.references("message.id").onDelete("set null"),
		)
		.addColumn("jobStatus", "text", (col) => col.notNull().defaultTo("idle"))
		.addColumn("jobId", "text")
		.addColumn("jobAttempt", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("jobError", "text")
		.addColumn("jobUpdatedAt", "text")
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.addColumn("updatedAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();

	await db.schema
		.createTable("generation_step")
		.addColumn("messageId", "text", (col) =>
			col.notNull().references("message.id").onDelete("cascade"),
		)
		.addColumn("sequence", "integer", (col) => col.notNull())
		.addColumn("data", "text", (col) => col.notNull())
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.addPrimaryKeyConstraint("generation_step_pk", ["messageId", "sequence"])
		.execute();

	await db.schema
		.createTable("provider_call_telemetry")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("conversationId", "text", (col) =>
			col.references("conversation.id").onDelete("cascade"),
		)
		.addColumn("messageId", "text", (col) =>
			col.references("message.id").onDelete("set null"),
		)
		.addColumn("provider", "text", (col) => col.notNull())
		.addColumn("api", "text", (col) => col.notNull())
		.addColumn("modelId", "text", (col) => col.notNull())
		.addColumn("purpose", "text", (col) => col.notNull())
		.addColumn("inputTokens", "integer")
		.addColumn("outputTokens", "integer")
		.addColumn("cacheReadTokens", "integer")
		.addColumn("cacheWriteTokens", "integer")
		.addColumn("estimatedCostMicros", "integer")
		.addColumn("latencyMs", "integer")
		.addColumn("contextPolicySource", "text")
		.addColumn("contextPolicyEnabled", "integer")
		.addColumn("contextPolicyState", "text")
		.addColumn("overflowed", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("retryAttempt", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("compactionTokensBefore", "integer")
		.addColumn("compactionTokensAfter", "integer")
		.addColumn("createdAt", "text", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();
	await db.schema
		.createIndex("provider_call_telemetry_conversationId_idx")
		.on("provider_call_telemetry")
		.column("conversationId")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("provider_call_telemetry").execute();
	await db.schema.dropTable("generation_step").execute();
	await db.schema.dropTable("conversation_context_state").execute();
	await db.schema.dropTable("context_policy").execute();
}

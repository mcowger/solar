import { sql, type Kysely } from "kysely";

/**
 * Multi-provider model selection (M3).
 *
 * - `provider_config`: global, admin-owned credentials + model allowlist, one
 *   row per provider id (e.g. "openai", "anthropic", "openrouter"). `apiKey`
 *   and `baseUrl` are optional overrides; `enabledModels` is a JSON array of
 *   `{ id, api }` entries (the admin-curated allowlist). API keys are stored
 *   plaintext by deliberate design (see ARCHITECTURE.md §8).
 * - `conversation` gains `provider` / `modelId` / `modelApi`: the per-conversation
 *   model selection, switchable at any time. Null = resolve the default at send
 *   time.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("provider_config")
    .addColumn("provider", "text", (col) => col.primaryKey())
    .addColumn("apiKey", "text")
    .addColumn("baseUrl", "text")
    .addColumn("enabledModels", "text", (col) => col.notNull().defaultTo("[]"))
    .addColumn("updatedAt", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  await db.schema
    .alterTable("conversation")
    .addColumn("provider", "text")
    .execute();
  await db.schema
    .alterTable("conversation")
    .addColumn("modelId", "text")
    .execute();
  await db.schema
    .alterTable("conversation")
    .addColumn("modelApi", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("conversation").dropColumn("modelApi").execute();
  await db.schema.alterTable("conversation").dropColumn("modelId").execute();
  await db.schema.alterTable("conversation").dropColumn("provider").execute();
  await db.schema.dropTable("provider_config").execute();
}

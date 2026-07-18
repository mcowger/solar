import { sql, type Kysely } from "kysely";

interface LegacyAllowlistEntry {
  id?: unknown;
  api?: unknown;
  visibility?: unknown;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("provider_config")
    .addColumn("endpoints", "text", (col) => col.notNull().defaultTo("[]"))
    .execute();
  await db.schema.alterTable("conversation").addColumn("endpointId", "text").execute();
  await db.schema.alterTable("preset").addColumn("endpointId", "text").execute();
  await db.schema.alterTable("user_setting").addColumn("defaultEndpointId", "text").execute();

  const { rows } = await sql<{
    provider: string;
    baseUrl: string | null;
    enabledModels: string;
  }>`SELECT provider, baseUrl, enabledModels FROM provider_config`.execute(db);

  for (const row of rows) {
    let entries: LegacyAllowlistEntry[] = [];
    try {
      const parsed = JSON.parse(row.enabledModels);
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      // Invalid allowlists were already treated as empty by the application.
    }
    const apis = [...new Set(entries.map((entry) => entry.api).filter((api): api is string => typeof api === "string"))];
    const endpoints = apis.map((api) => ({
      id: api,
      label: api,
      baseUrl: row.baseUrl ?? "",
      api,
    }));
    const enabledModels = entries.flatMap((entry) =>
      typeof entry.id === "string" && typeof entry.api === "string"
        ? [{
            id: entry.id,
            api: entry.api,
            endpointId: entry.api,
            visibility: entry.visibility === "private" ? "private" : "public",
          }]
        : [],
    );
    await sql`
      UPDATE provider_config
      SET endpoints = ${JSON.stringify(endpoints)}, enabledModels = ${JSON.stringify(enabledModels)}
      WHERE provider = ${row.provider}
    `.execute(db);
  }

  await sql`UPDATE conversation SET endpointId = modelApi WHERE endpointId IS NULL AND modelApi IS NOT NULL`.execute(db);
  await sql`UPDATE preset SET endpointId = modelApi WHERE endpointId IS NULL`.execute(db);
  await sql`UPDATE user_setting SET defaultEndpointId = defaultApi WHERE defaultEndpointId IS NULL AND defaultApi IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("user_setting").dropColumn("defaultEndpointId").execute();
  await db.schema.alterTable("preset").dropColumn("endpointId").execute();
  await db.schema.alterTable("conversation").dropColumn("endpointId").execute();
  await db.schema.alterTable("provider_config").dropColumn("endpoints").execute();
}

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import type { Database } from "../db/schema";
import { up as upModelSync } from "../db/migrations/030_provider_model_sync";

// No outbound model sync from tests: enabling auto-sync reports "skipped".
process.env.SOLAR_AIRGAP_MODE = "1";
process.env.SOLAR_PI_AGENT_DIR = join(
	mkdtempSync(join(tmpdir(), "solar-router-providers-")),
	"pi-agent",
);

const sqlite = new BunDatabase(":memory:");
const memoryDb = new Kysely<Database>({
	dialect: new BunSqliteDialect({ database: sqlite }),
});
mock.module("../db", () => ({ db: memoryDb, sqlite }));
mock.module("../auth", () => ({
	createSolarApiKey: async () => ({ id: "key", key: "sk_solar_test" }),
	createSolarUser: async () => {},
	setSolarUserPassword: async () => true,
}));
mock.module("../chat/attachments", () => ({
	deleteAttachmentFilesForMessages: async () => {},
	deleteAttachmentFilesForUser: async () => {},
	deleteAttachmentFilesByStorageKey: async () => {},
	expandAttachmentRows: async () => ({ parts: [], documents: [] }),
}));

await memoryDb.schema
	.createTable("provider_config")
	.addColumn("provider", "text", (column) => column.primaryKey())
	.addColumn("apiKey", "text")
	.addColumn("baseUrl", "text")
	.addColumn("endpoints", "text", (column) => column.notNull().defaultTo("[]"))
	.addColumn("enabledModels", "text", (column) =>
		column.notNull().defaultTo("[]"),
	)
	.addColumn("imageModels", "text", (column) =>
		column.notNull().defaultTo("[]"),
	)
	.addColumn("updatedAt", "text", (column) => column.notNull())
	.execute();
await upModelSync(memoryDb as unknown as Kysely<unknown>);

const { appRouter } = await import("./router");
const admin = appRouter.createCaller({
	user: { id: "admin", role: "admin" },
} as never);

const ENDPOINT = {
	id: "chat",
	label: "Chat",
	baseUrl: "https://gw.example/v1",
	api: "openai-completions",
};
const SAVED_AT = "2026-10-01T00:00:00.000Z";

beforeEach(async () => {
	await memoryDb.deleteFrom("provider_config").execute();
	await memoryDb
		.insertInto("provider_config")
		.values({
			provider: "plexus",
			apiKey: "key",
			baseUrl: null,
			endpoints: JSON.stringify([ENDPOINT]),
			enabledModels: JSON.stringify([
				{
					id: "m1",
					endpointId: "chat",
					api: "openai-completions",
					visibility: "public",
				},
			]),
			imageModels: "[]",
			updatedAt: SAVED_AT,
		})
		.execute();
});

const save = (expectedUpdatedAt?: string) =>
	admin.admin.setProvider({
		provider: "plexus",
		endpoints: [ENDPOINT],
		enabledModels: [
			{
				id: "m2",
				endpointId: "chat",
				api: "openai-completions",
				visibility: "public",
			},
		],
		...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
	});

async function savedModels() {
	const row = await memoryDb
		.selectFrom("provider_config")
		.select("enabledModels")
		.where("provider", "=", "plexus")
		.executeTakeFirstOrThrow();
	return (JSON.parse(row.enabledModels) as { id: string }[]).map(
		(model) => model.id,
	);
}

describe("provider saves and model sync", () => {
	test("a save from a form older than the stored provider is refused", async () => {
		await expect(save("2026-09-01T00:00:00.000Z")).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(await savedModels()).toEqual(["m1"]);
	});

	test("a save from an up-to-date form goes through", async () => {
		await save(SAVED_AT);
		expect(await savedModels()).toEqual(["m2"]);
	});

	test("a save without a form version still goes through", async () => {
		await save();
		expect(await savedModels()).toEqual(["m2"]);
	});

	test("listProviders reports the version, auto-sync, last sync and availability", async () => {
		const [provider] = await admin.admin.listProviders();
		expect(provider).toMatchObject({
			provider: "plexus",
			updatedAt: SAVED_AT,
			autoSyncModels: false,
			modelSync: null,
			syncing: false,
			syncAvailable: false,
		});
	});

	test("auto-sync can be switched on and off without touching the provider version", async () => {
		const on = await admin.admin.setProviderAutoSync({
			provider: "plexus",
			enabled: true,
		});
		expect(on).toMatchObject({ autoSyncModels: true });
		expect(on.skipped).toContain("airgap");
		let [provider] = await admin.admin.listProviders();
		expect(provider).toMatchObject({
			autoSyncModels: true,
			updatedAt: SAVED_AT,
		});
		await admin.admin.setProviderAutoSync({
			provider: "plexus",
			enabled: false,
		});
		[provider] = await admin.admin.listProviders();
		expect(provider?.autoSyncModels).toBe(false);
	});

	test("a manual sync in airgap mode explains why nothing happened", async () => {
		await expect(
			admin.admin.syncProviderModels({ provider: "plexus" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	test("non-admins cannot sync or change auto-sync", async () => {
		const user = appRouter.createCaller({
			user: { id: "user", role: "user" },
		} as never);
		await expect(
			user.admin.syncProviderModels({ provider: "plexus" }),
		).rejects.toThrow();
		await expect(
			user.admin.setProviderAutoSync({ provider: "plexus", enabled: true }),
		).rejects.toThrow();
	});
});

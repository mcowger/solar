import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import type { Database } from "../db/schema";
import { up as upModelSync } from "../db/migrations/030_provider_model_sync";

const sqlite = new BunDatabase(":memory:");
const memoryDb = new Kysely<Database>({
	dialect: new BunSqliteDialect({ database: sqlite }),
});
mock.module("../db", () => ({ db: memoryDb, sqlite }));

const {
	isProviderSyncing,
	listAutoSyncProviders,
	parseModelSyncStatus,
	setProviderAutoSync,
	startModelSyncScheduler,
	syncProviderModels,
	withProviderLock,
} = await import("./modelSync");

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

// `findStaleModelReferences` reads these two tables after a sync changes the
// model list.
await memoryDb.schema
	.createTable("preset")
	.addColumn("id", "text", (column) => column.primaryKey())
	.addColumn("userId", "text", (column) => column.notNull())
	.addColumn("name", "text", (column) => column.notNull())
	.addColumn("scope", "text", (column) =>
		column.notNull().defaultTo("personal"),
	)
	.addColumn("provider", "text", (column) => column.notNull())
	.addColumn("endpointId", "text")
	.addColumn("modelId", "text", (column) => column.notNull())
	.addColumn("modelApi", "text", (column) => column.notNull())
	.execute();
await memoryDb.schema
	.createTable("user_setting")
	.addColumn("userId", "text", (column) => column.primaryKey())
	.addColumn("defaultProvider", "text")
	.addColumn("defaultEndpointId", "text")
	.addColumn("defaultModelId", "text")
	.addColumn("defaultApi", "text")
	.execute();
// Better Auth owns `user`; the stale-reference report reads its role and email.
await memoryDb.schema
	.createTable("user")
	.addColumn("id", "text", (column) => column.primaryKey())
	.addColumn("email", "text", (column) => column.notNull())
	.addColumn("role", "text", (column) => column.notNull().defaultTo("user"))
	.execute();

const ENDPOINT = {
	id: "chat",
	label: "Chat",
	baseUrl: "https://gw.example/v1",
	api: "openai-completions",
};
const UPDATED_AT = "2026-10-01T00:00:00.000Z";

async function seed(models: { id: string; visibility?: string }[]) {
	await memoryDb.deleteFrom("provider_config").execute();
	await memoryDb.deleteFrom("preset").execute();
	await memoryDb.deleteFrom("user_setting").execute();
	await memoryDb
		.insertInto("provider_config")
		.values({
			provider: "plexus",
			apiKey: "key",
			baseUrl: null,
			endpoints: JSON.stringify([ENDPOINT]),
			enabledModels: JSON.stringify(
				models.map((model) => ({
					id: model.id,
					endpointId: "chat",
					api: "openai-completions",
					visibility: model.visibility ?? "public",
				})),
			),
			imageModels: "[]",
			updatedAt: UPDATED_AT,
		})
		.execute();
}

async function row() {
	const found = await memoryDb
		.selectFrom("provider_config")
		.selectAll()
		.where("provider", "=", "plexus")
		.executeTakeFirstOrThrow();
	return {
		...found,
		models: JSON.parse(found.enabledModels) as {
			id: string;
			visibility: string;
		}[],
		status: found.modelSyncStatus ? JSON.parse(found.modelSyncStatus) : null,
	};
}

function gateway(ids: string[]) {
	const calls: string[] = [];
	const fetchImpl = mock(async (url: URL | string) => {
		calls.push(String(url));
		return new Response(
			JSON.stringify({
				data: ids.map((id) => ({
					id,
					architecture: { output_modalities: ["text"] },
				})),
			}),
		);
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

let changes = 0;
const onModelsChanged = async () => {
	changes++;
};

beforeEach(() => {
	changes = 0;
});

describe("syncProviderModels", () => {
	test("adds, removes and records the outcome, then regenerates pi's model config", async () => {
		await seed([{ id: "keep" }, { id: "gone" }]);
		const { fetchImpl, calls } = gateway(["keep", "new-model"]);
		const outcome = await syncProviderModels("plexus", {
			trigger: "manual",
			fetchImpl,
			onModelsChanged,
		});
		expect(calls).toEqual(["https://gw.example/v1/models"]);
		const after = await row();
		expect(after.models.map((model) => model.id)).toEqual([
			"keep",
			"new-model",
		]);
		expect(after.models[1]?.visibility).toBe("private");
		expect(after.updatedAt).not.toBe(UPDATED_AT);
		expect(after.status).toMatchObject({
			trigger: "manual",
			ok: true,
			added: ["new-model"],
			removed: ["gone"],
			errors: [],
		});
		expect(outcome.status?.ok).toBe(true);
		expect(changes).toBe(1);
	});

	test("reads an older status row that predates stale references", () => {
		const legacy = {
			at: "2026-10-01T00:00:00.000Z",
			trigger: "manual" as const,
			ok: true,
			added: [],
			removed: [],
			updated: [],
			moved: [],
			skipped: [],
			errors: [],
			missing: {},
			missingImages: {},
		};
		expect(parseModelSyncStatus(JSON.stringify(legacy))).toMatchObject({
			staleReferences: [],
			staleReferenceTotal: 0,
		});
	});

	test("flags presets the sync stranded", async () => {
		await seed([{ id: "keep" }, { id: "gone" }]);
		await memoryDb
			.insertInto("preset")
			.values({
				id: "preset-1",
				userId: "user-1",
				name: "Legal",
				provider: "plexus",
				endpointId: "chat",
				modelId: "gone",
				modelApi: "openai-completions",
			})
			.execute();
		await memoryDb
			.insertInto("preset")
			.values({
				id: "preset-2",
				userId: "user-1",
				name: "Fine",
				provider: "plexus",
				endpointId: "chat",
				modelId: "keep",
				modelApi: "openai-completions",
			})
			.execute();
		const { fetchImpl } = gateway(["keep"]);
		await syncProviderModels("plexus", {
			trigger: "manual",
			fetchImpl,
			onModelsChanged,
		});
		const after = await row();
		expect(after.status.staleReferences).toEqual([
			{ kind: "preset", id: "preset-1", label: "Legal", modelId: "gone" },
		]);
		expect(after.status.staleReferenceTotal).toBe(1);
	});

	test("keeps reporting stale references on a later sync that changes nothing", async () => {
		await seed([{ id: "keep" }, { id: "gone" }]);
		await memoryDb
			.insertInto("preset")
			.values({
				id: "preset-1",
				userId: "user-1",
				name: "Legal",
				provider: "plexus",
				endpointId: "chat",
				modelId: "gone",
				modelApi: "openai-completions",
			})
			.execute();
		const removed = gateway(["keep"]);
		await syncProviderModels("plexus", {
			trigger: "manual",
			fetchImpl: removed.fetchImpl,
			onModelsChanged,
		});
		// Nothing changes this time, but the preset is still broken.
		const stable = gateway(["keep"]);
		await syncProviderModels("plexus", {
			trigger: "timer",
			fetchImpl: stable.fetchImpl,
			onModelsChanged,
		});
		expect((await row()).status.staleReferences).toEqual([
			{ kind: "preset", id: "preset-1", label: "Legal", modelId: "gone" },
		]);
	});

	test("flags a personal default whose model is gone", async () => {
		await seed([{ id: "keep" }]);
		await memoryDb
			.insertInto("user_setting")
			.values({
				userId: "user-2",
				defaultProvider: "plexus",
				defaultEndpointId: "chat",
				defaultModelId: "gone",
				defaultApi: "openai-completions",
			})
			.execute();
		const { fetchImpl } = gateway(["keep", "fresh"]);
		await syncProviderModels("plexus", {
			trigger: "manual",
			fetchImpl,
			onModelsChanged,
		});
		expect((await row()).status.staleReferences).toEqual([
			{ kind: "user-default", id: "user-2", label: "user-2", modelId: "gone" },
		]);
	});

	test("a shared preset on a private model is flagged, an admin's personal preset is not", async () => {
		await seed([{ id: "private-model", visibility: "private" }]);
		// Better Auth's `user` table is outside the Kysely schema, so raw SQL.
		await sql`
			insert into user (id, email, role) values
			('admin-1', 'admin@example.com', 'admin'),
			('user-1', 'user@example.com', 'user')
		`.execute(memoryDb);
		const preset = (id: string, userId: string, scope: string) => ({
			id,
			userId,
			name: id,
			scope,
			provider: "plexus",
			endpointId: "chat",
			modelId: "private-model",
			modelApi: "openai-completions",
		});
		await memoryDb
			.insertInto("preset")
			.values([
				preset("shared-preset", "admin-1", "shared"),
				preset("admin-preset", "admin-1", "personal"),
			])
			.execute();
		const { fetchImpl } = gateway(["private-model"]);
		// Nothing changes, so the sync only refreshes the report.
		await syncProviderModels("plexus", {
			trigger: "manual",
			fetchImpl,
			onModelsChanged,
		});
		const stale = (await row()).status.staleReferences.map(
			(item: { id: string }) => item.id,
		);
		expect(stale).toEqual(["shared-preset"]);
	});

	test("a failing stale-reference query still writes the synced models", async () => {
		await seed([{ id: "keep" }]);
		const { fetchImpl } = gateway(["keep", "added"]);
		await memoryDb.schema.dropTable("preset").execute();
		try {
			await syncProviderModels("plexus", {
				trigger: "manual",
				fetchImpl,
				onModelsChanged,
			});
			const after = await row();
			expect(after.models.map((model) => model.id)).toEqual(["keep", "added"]);
			expect(after.status.staleReferences).toEqual([]);
		} finally {
			// Restore the table for the rest of the suite.
			await memoryDb.schema
				.createTable("preset")
				.addColumn("id", "text", (column) => column.primaryKey())
				.addColumn("userId", "text", (column) => column.notNull())
				.addColumn("name", "text", (column) => column.notNull())
				.addColumn("scope", "text", (column) =>
					column.notNull().defaultTo("personal"),
				)
				.addColumn("provider", "text", (column) => column.notNull())
				.addColumn("endpointId", "text")
				.addColumn("modelId", "text", (column) => column.notNull())
				.addColumn("modelApi", "text", (column) => column.notNull())
				.execute();
		}
	});

	test("a gateway error changes no models and records the error", async () => {
		await seed([{ id: "keep" }]);
		const fetchImpl = mock(
			async () =>
				new Response("bad gateway", { status: 502, statusText: "Bad Gateway" }),
		) as unknown as typeof fetch;
		await syncProviderModels("plexus", {
			trigger: "manual",
			fetchImpl,
			onModelsChanged,
		});
		const after = await row();
		expect(after.models.map((model) => model.id)).toEqual(["keep"]);
		expect(after.updatedAt).toBe(UPDATED_AT);
		expect(after.status.ok).toBe(false);
		expect(after.status.errors[0]).toContain("502");
		expect(changes).toBe(0);
	});

	test("an unchanged list writes only the status, not updatedAt", async () => {
		await seed([{ id: "keep" }]);
		const { fetchImpl } = gateway(["keep"]);
		await syncProviderModels("plexus", {
			trigger: "manual",
			fetchImpl,
			onModelsChanged,
		});
		const after = await row();
		expect(after.updatedAt).toBe(UPDATED_AT);
		expect(after.status.ok).toBe(true);
		expect(changes).toBe(0);
	});

	test("the timer removes a model only on its second miss in a row", async () => {
		await seed([{ id: "keep" }, { id: "flaky" }]);
		const { fetchImpl } = gateway(["keep"]);
		await syncProviderModels("plexus", {
			trigger: "timer",
			fetchImpl,
			onModelsChanged,
		});
		let after = await row();
		expect(after.models.map((model) => model.id)).toEqual(["keep", "flaky"]);
		expect(after.status.missing).toEqual({ flaky: 1 });
		await syncProviderModels("plexus", {
			trigger: "timer",
			fetchImpl,
			onModelsChanged,
		});
		after = await row();
		expect(after.models.map((model) => model.id)).toEqual(["keep"]);
		expect(after.status.removed).toEqual(["flaky"]);
	});

	test("two syncs at once share one gateway call", async () => {
		await seed([{ id: "keep" }]);
		const { fetchImpl, calls } = gateway(["keep", "x"]);
		const first = syncProviderModels("plexus", {
			trigger: "manual",
			fetchImpl,
			onModelsChanged,
		});
		expect(isProviderSyncing("plexus")).toBe(true);
		const second = syncProviderModels("plexus", {
			trigger: "manual",
			fetchImpl,
			onModelsChanged,
		});
		await Promise.all([first, second]);
		expect(calls).toHaveLength(1);
		expect(isProviderSyncing("plexus")).toBe(false);
	});

	test("an admin save that lands during the fetch wins over the sync's view", async () => {
		await seed([{ id: "keep" }]);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetchImpl = mock(async () => {
			await gate;
			return new Response(
				JSON.stringify({
					data: [
						{ id: "keep", architecture: { output_modalities: ["text"] } },
						{ id: "saved", architecture: { output_modalities: ["text"] } },
					],
				}),
			);
		}) as unknown as typeof fetch;
		const sync = syncProviderModels("plexus", {
			trigger: "manual",
			fetchImpl,
			onModelsChanged,
		});
		// The admin adds "saved" by hand and makes it public while sync waits.
		await withProviderLock("plexus", async () => {
			await memoryDb
				.updateTable("provider_config")
				.set({
					enabledModels: JSON.stringify([
						{
							id: "keep",
							endpointId: "chat",
							api: "openai-completions",
							visibility: "public",
						},
						{
							id: "saved",
							endpointId: "chat",
							api: "openai-completions",
							visibility: "public",
						},
					]),
				})
				.where("provider", "=", "plexus")
				.execute();
		});
		release();
		await sync;
		const after = await row();
		expect(after.models.map((model) => [model.id, model.visibility])).toEqual([
			["keep", "public"],
			["saved", "public"],
		]);
		expect(after.status.added).toEqual([]);
	});

	test("does nothing in airgap mode", async () => {
		await seed([{ id: "keep" }]);
		const { fetchImpl, calls } = gateway(["other"]);
		const outcome = await syncProviderModels("plexus", {
			trigger: "manual",
			fetchImpl,
			onModelsChanged,
			airgapMode: true,
		});
		expect(outcome.skipped).toContain("airgap");
		expect(calls).toHaveLength(0);
		expect((await row()).status).toBeNull();
	});
});

describe("auto-sync setting and scheduler", () => {
	test("the auto-sync flag lists providers without touching updatedAt", async () => {
		await seed([{ id: "keep" }]);
		expect(await listAutoSyncProviders()).toEqual([]);
		await setProviderAutoSync("plexus", true);
		expect(await listAutoSyncProviders()).toEqual(["plexus"]);
		expect((await row()).updatedAt).toBe(UPDATED_AT);
		await setProviderAutoSync("plexus", false);
		expect(await listAutoSyncProviders()).toEqual([]);
	});

	test("the scheduler runs after the first delay, then every interval, until stopped", async () => {
		let runs = 0;
		const scheduler = startModelSyncScheduler({
			intervalMs: 20,
			initialDelayMs: 5,
			run: async () => {
				runs++;
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 70));
		scheduler.stop();
		const seen = runs;
		expect(seen).toBeGreaterThanOrEqual(3);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(runs).toBe(seen);
	});

	test("the scheduler never overlaps a slow run", async () => {
		let active = 0;
		let overlapped = false;
		const scheduler = startModelSyncScheduler({
			intervalMs: 5,
			initialDelayMs: 1,
			run: async () => {
				active++;
				if (active > 1) overlapped = true;
				await new Promise((resolve) => setTimeout(resolve, 30));
				active--;
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 80));
		scheduler.stop();
		expect(overlapped).toBe(false);
	});
});

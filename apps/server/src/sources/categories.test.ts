import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import type { Database } from "../db/schema";
import { up } from "../db/migrations/016_source_categories";

let radarCalls = 0;

mock.module("../config", () => ({
	config: { cloudflareRadarApiToken: "test-token" },
}));

const { LOCAL_SOURCE_CATEGORIES, SourceCategoryResolver, sourceDomain } =
	await import("./categories");
const { NEWS_DOMAINS } = await import("./newsDomains");
const { RESEARCH_DOMAINS } = await import("./researchDomains");

let sqlite: BunDatabase;
let db: Kysely<Database>;

beforeEach(async () => {
	radarCalls = 0;
	sqlite = new BunDatabase(":memory:");
	db = new Kysely<Database>({
		dialect: new BunSqliteDialect({ database: sqlite }),
	});
	await up(db as unknown as Kysely<unknown>);
	globalThis.fetch = (async () => {
		radarCalls += 1;
		return Response.json({
			success: true,
			result: { details_0: { categories: [{ name: "News" }] } },
		});
	}) as unknown as typeof fetch;
});

afterEach(async () => {
	await db.destroy();
	sqlite.close();
});

describe("source categories", () => {
	test("normalizes a URL to its registrable domain", () => {
		expect(sourceDomain("https://www.bbc.co.uk/news/world")).toBe("bbc.co.uk");
	});

	test("includes a broad local news registry", () => {
		expect(Object.keys(LOCAL_SOURCE_CATEGORIES).length).toBeGreaterThanOrEqual(
			300,
		);
		expect(LOCAL_SOURCE_CATEGORIES["elpais.com"]).toBe("News");
		expect(LOCAL_SOURCE_CATEGORIES["reuters.com"]).toBe("News");
	});

	test("uses normalized domains as registry keys", () => {
		const invalidDomains = [...NEWS_DOMAINS].filter(
			(domain) => sourceDomain(`https://${domain}`) !== domain,
		);
		expect(invalidDomains).toEqual([]);
	});

	test("classifies OpenAlex repository domains as research", async () => {
		const resolver = new SourceCategoryResolver(db);
		expect(RESEARCH_DOMAINS.size).toBeGreaterThanOrEqual(75);
		expect(await resolver.resolve(["https://zenodo.org/record/1"])).toEqual([
			{ domain: "zenodo.org", category: "Research" },
		]);
		expect(radarCalls).toBe(0);
	});

	test("caches Cloudflare Radar categories by domain", async () => {
		const resolver = new SourceCategoryResolver(db);
		const url = "https://example.com/article";

		expect(await resolver.resolve([url])).toEqual([
			{ domain: "example.com", category: "News" },
		]);
		expect(await resolver.resolve([url])).toEqual([
			{ domain: "example.com", category: "News" },
		]);
		expect(radarCalls).toBe(1);
	});

	test("deduplicates simultaneous Radar requests", async () => {
		const url = "https://example.com/article";

		await Promise.all([
			new SourceCategoryResolver(db).resolve([url]),
			new SourceCategoryResolver(db).resolve([url]),
		]);
		expect(radarCalls).toBe(1);
	});

	test("uses local source categories without a Radar request", async () => {
		const resolver = new SourceCategoryResolver(db);

		expect(await resolver.resolve(["https://www.espn.com/soccer"])).toEqual([
			{ domain: "espn.com", category: "News" },
		]);
		expect(radarCalls).toBe(0);
	});
});

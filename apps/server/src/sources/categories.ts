import { getDomain } from "tldts";
import type { Kysely } from "kysely";
import { config } from "../config";
import type { Database } from "../db/schema";
import { NEWS_DOMAINS } from "./newsDomains";
import { RESEARCH_DOMAINS } from "./researchDomains";

const CLOUDFLARE_RADAR_URL =
	"https://api.cloudflare.com/client/v4/radar/ranking/domain";
const inFlightRadarCategories = new Map<
	string,
	Promise<string | null | undefined>
>();

export const LOCAL_SOURCE_CATEGORIES: Record<string, string> = {
	...Object.fromEntries([...NEWS_DOMAINS].map((domain) => [domain, "News"])),
	...Object.fromEntries(
		[...RESEARCH_DOMAINS].map((domain) => [domain, "Research"]),
	),
	"arxiv.org": "Research",
	"britannica.com": "Reference",
	"science.org": "Research",
	"wikidata.org": "Reference",
	"wikipedia.org": "Reference",
};

type RadarResponse = {
	success?: boolean;
	result?: {
		details_0?: {
			categories?: { name?: string }[];
		};
	};
};

export type SourceCategory = {
	domain: string;
	category: string;
};

export function sourceDomain(url: string) {
	try {
		const hostname = new URL(url).hostname;
		return getDomain(hostname) ?? hostname;
	} catch {
		return null;
	}
}

async function fetchCloudflareCategory(domain: string) {
	if (!config.cloudflareRadarApiToken) return undefined;

	try {
		const response = await fetch(
			`${CLOUDFLARE_RADAR_URL}/${encodeURIComponent(domain)}`,
			{
				headers: {
					Authorization: `Bearer ${config.cloudflareRadarApiToken}`,
				},
			},
		);
		if (response.status === 404) return null;
		if (!response.ok) return undefined;

		const body = (await response.json()) as RadarResponse;
		if (!body.success) return undefined;
		return body.result?.details_0?.categories?.[0]?.name ?? null;
	} catch {
		return undefined;
	}
}

function cloudflareCategory(db: Kysely<Database>, domain: string) {
	const existing = inFlightRadarCategories.get(domain);
	if (existing) return existing;

	const request = (async () => {
		const category = await fetchCloudflareCategory(domain);
		if (category === undefined) return undefined;

		await db
			.insertInto("source_category")
			.values({ domain, category, source: "cloudflare_radar" })
			.onConflict((conflict) => conflict.column("domain").doNothing())
			.execute();
		return category;
	})().finally(() => inFlightRadarCategories.delete(domain));
	inFlightRadarCategories.set(domain, request);
	return request;
}

export class SourceCategoryResolver {
	constructor(private readonly db: Kysely<Database>) {}

	async resolve(urls: string[]): Promise<SourceCategory[]> {
		const domains = [
			...new Set(
				urls
					.map(sourceDomain)
					.filter((domain): domain is string => Boolean(domain)),
			),
		];
		if (!domains.length) return [];

		const cached = await this.db
			.selectFrom("source_category")
			.select(["domain", "category"])
			.where("domain", "in", domains)
			.execute();
		const categories = new Map(
			cached.flatMap(({ domain, category }) =>
				category ? [[domain, category] as const] : [],
			),
		);
		const cachedDomains = new Set(cached.map(({ domain }) => domain));
		const uncachedDomains = domains.filter(
			(domain) => !cachedDomains.has(domain),
		);

		for (const domain of uncachedDomains) {
			const category = LOCAL_SOURCE_CATEGORIES[domain];
			if (category) categories.set(domain, category);
		}

		const fallbackDomains = uncachedDomains.filter(
			(domain) => !LOCAL_SOURCE_CATEGORIES[domain],
		);
		for (const domain of fallbackDomains) {
			const category = await cloudflareCategory(this.db, domain);
			if (category === undefined) continue;
			if (category) categories.set(domain, category);
		}

		return domains.flatMap((domain) => {
			const category = categories.get(domain);
			return category ? [{ domain, category }] : [];
		});
	}
}

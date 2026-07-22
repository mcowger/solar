import { config } from "../config";
import type { UserLocation } from "./builtins";

const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const NOMINATIM_USER_AGENT = "Solar/0.1.0 (https://solar.home.cowger.us)";
const REQUEST_TIMEOUT_MS = 1_000;
const CITY_FIELDS = ["city", "town", "village", "municipality", "hamlet"];

interface NominatimResponse {
	display_name?: unknown;
	address?: Record<string, unknown>;
}

type Fetcher = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

function addressValue(
	address: Record<string, unknown> | undefined,
	fields: readonly string[],
): string | undefined {
	for (const field of fields) {
		const value = address?.[field];
		if (typeof value === "string") return value;
	}
	return undefined;
}

export async function reverseGeocode(
	location: UserLocation | undefined,
	fetcher: Fetcher = fetch,
): Promise<UserLocation | undefined> {
	if (
		config.airgapMode ||
		location?.latitude === undefined ||
		location.longitude === undefined
	)
		return location;
	try {
		const url = new URL(NOMINATIM_REVERSE_URL);
		url.searchParams.set("lat", String(location.latitude));
		url.searchParams.set("lon", String(location.longitude));
		url.searchParams.set("format", "jsonv2");
		url.searchParams.set("addressdetails", "1");
		const response = await fetcher(url, {
			headers: { "user-agent": NOMINATIM_USER_AGENT },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) return location;
		const result = (await response.json()) as NominatimResponse;
		return {
			...location,
			displayName:
				typeof result.display_name === "string"
					? result.display_name
					: undefined,
			city: addressValue(result.address, CITY_FIELDS),
			region: addressValue(result.address, ["state", "region", "county"]),
			country: addressValue(result.address, ["country"]),
			countryCode: addressValue(result.address, [
				"country_code",
			])?.toUpperCase(),
		};
	} catch {
		return location;
	}
}

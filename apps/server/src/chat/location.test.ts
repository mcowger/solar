import { describe, expect, test } from "bun:test";
import { config } from "../config";
import { reverseGeocode } from "./location";

describe("reverseGeocode", () => {
	test("adds Nominatim locality details to browser coordinates", async () => {
		let request: RequestInfo | URL | undefined;
		const location = await reverseGeocode(
			{ latitude: 40.7128, longitude: -74.006, timeZone: "America/New_York" },
			async (input) => {
				request = input;
				return Response.json({
					display_name: "New York, United States",
					address: {
						city: "New York",
						state: "New York",
						country: "United States",
						country_code: "us",
					},
				});
			},
		);

		expect(request).toBeInstanceOf(URL);
		expect((request as URL).searchParams.get("lat")).toBe("40.7128");
		expect(location).toEqual({
			latitude: 40.7128,
			longitude: -74.006,
			timeZone: "America/New_York",
			displayName: "New York, United States",
			city: "New York",
			region: "New York",
			country: "United States",
			countryCode: "US",
		});
	});

	test("leaves coordinates unchanged when Nominatim fails", async () => {
		const location = { latitude: 40.7128, longitude: -74.006 };
		expect(
			await reverseGeocode(
				location,
				async () => new Response(null, { status: 503 }),
			),
		).toEqual(location);
	});

	test("skips fetch completely when airgap mode is enabled", async () => {
		let fetched = false;
		const originalAirgap = config.airgapMode;
		// @ts-expect-error - overriding read-only property for test
		config.airgapMode = true;

		try {
			const location = { latitude: 40.7128, longitude: -74.006 };
			const result = await reverseGeocode(location, async () => {
				fetched = true;
				return Response.json({});
			});

			expect(fetched).toBe(false);
			expect(result).toEqual(location);
		} finally {
			// @ts-expect-error - restoring property
			config.airgapMode = originalAirgap;
		}
	});
});

import { describe, expect, test } from "bun:test";
import { resolveBuiltinTools } from "./builtins";

function builtin(name: string, timeZone?: string) {
	const tool = resolveBuiltinTools(timeZone ? { timeZone } : undefined).find(
		(candidate) => candidate.tool.name === name,
	);
	if (!tool) throw new Error(`Missing built-in tool: ${name}`);
	return tool;
}

describe("location built-ins", () => {
	test("returns browser-provided location information", async () => {
		const result = await resolveBuiltinTools({
			timeZone: "America/New_York",
			latitude: 40.7128,
			longitude: -74.006,
			accuracy: 12,
			timestamp: 1_700_000_000_000,
			displayName: "New York, United States",
			city: "New York",
			region: "New York",
			country: "United States",
			countryCode: "US",
		})
			.find((tool) => tool.tool.name === "get_user_location")!
			.execute({});

		expect(JSON.parse(result.content)).toEqual({
			timeZone: "America/New_York",
			latitude: 40.7128,
			longitude: -74.006,
			accuracy: 12,
			timestamp: 1_700_000_000_000,
			displayName: "New York, United States",
			city: "New York",
			region: "New York",
			country: "United States",
			countryCode: "US",
		});
	});

	test("uses the browser time zone when no time zone is supplied", async () => {
		const result = await builtin(
			"get_current_datetime",
			"America/New_York",
		).execute({});

		const datetime = JSON.parse(result.content);
		expect(datetime.local.timeZone).toBe("America/New_York");
		expect(datetime.utc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	test("allows an explicit time zone to override the browser time zone", async () => {
		const result = await builtin(
			"get_current_datetime",
			"America/New_York",
		).execute({ timeZone: "Asia/Tokyo" });

		expect(JSON.parse(result.content).local.timeZone).toBe("Asia/Tokyo");
	});
});

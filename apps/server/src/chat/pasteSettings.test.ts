import { describe, expect, test } from "bun:test";
import {
	DEFAULT_PASTE_SETTINGS,
	parsePasteSettings,
	pasteSettingsInputSchema,
} from "./pasteSettings";

describe("paste settings", () => {
	test("uses defaults for missing or invalid persisted values", () => {
		expect(parsePasteSettings(null)).toEqual(DEFAULT_PASTE_SETTINGS);
		expect(parsePasteSettings("not json")).toEqual(DEFAULT_PASTE_SETTINGS);
		expect(
			parsePasteSettings(
				JSON.stringify({
					version: 1,
					enabled: true,
					lineThreshold: 0,
					byteThreshold: 5120,
				}),
			),
		).toEqual(DEFAULT_PASTE_SETTINGS);
	});

	test("accepts valid settings and enforces attachment limits", () => {
		const settings = {
			version: 1,
			enabled: false,
			lineThreshold: 50,
			byteThreshold: 10_000,
		} as const;
		expect(parsePasteSettings(JSON.stringify(settings))).toEqual(settings);
		expect(
			pasteSettingsInputSchema.safeParse({
				enabled: true,
				lineThreshold: 100_001,
				byteThreshold: 20 * 1024 * 1024 + 1,
			}).success,
		).toBe(false);
	});
});

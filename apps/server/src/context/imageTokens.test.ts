import { describe, expect, test } from "bun:test";
import { estimateImageTokens } from "./imageTokens";

describe("estimateImageTokens", () => {
	test("uses GPT-5.6 original-detail 32px patches", () => {
		expect(
			estimateImageTokens(
				{ width: 1_920, height: 1_080 },
				{ provider: "openai", modelId: "gpt-5.6" },
			),
		).toBe(2_040);
	});

	test("applies Claude resolution-tier limits", () => {
		expect(
			estimateImageTokens(
				{ width: 3_840, height: 2_160 },
				{ provider: "anthropic", modelId: "claude-sonnet-4-5" },
			),
		).toBe(1_568);
		expect(
			estimateImageTokens(
				{ width: 3_840, height: 2_160 },
				{ provider: "anthropic", modelId: "claude-opus-4-8" },
			),
		).toBe(4_784);
	});

	test("uses Gemini visual tiles", () => {
		expect(
			estimateImageTokens(
				{ width: 384, height: 384 },
				{ provider: "google", modelId: "gemini-2.5-flash" },
			),
		).toBe(258);
		expect(
			estimateImageTokens(
				{ width: 960, height: 540 },
				{ provider: "google", modelId: "gemini-2.5-flash" },
			),
		).toBe(1_548);
	});

	test("uses dimensions rather than encoded bytes and has a fixed fallback", () => {
		const model = { provider: "unknown", modelId: "vision-model" };
		expect(estimateImageTokens({ width: 1_024, height: 768 }, model)).toBe(
			1_036,
		);
		expect(estimateImageTokens({ width: null, height: null }, model)).toBe(
			4_784,
		);
	});
});

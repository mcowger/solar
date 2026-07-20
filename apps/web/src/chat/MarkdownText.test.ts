import { describe, expect, test } from "bun:test";
import { citationsFrom, removeCitationBlocks } from "./MarkdownText";

describe("citationsFrom", () => {
	test("captures a singular Source block", () => {
		const text =
			"Estimated cost: $52.96 USD.\n\nSource: [OpenAI pricing](https://developers.openai.com/api/docs/pricing).";

		expect(citationsFrom(text)).toEqual([
			{
				title: "OpenAI pricing",
				url: "https://developers.openai.com/api/docs/pricing",
				domain: "developers.openai.com",
				favicon: "https://developers.openai.com/favicon.ico",
			},
		]);
		expect(removeCitationBlocks(text).trimEnd()).toBe(
			"Estimated cost: $52.96 USD.",
		);
	});

	test("captures a trailing Markdown citation", () => {
		const text =
			"Spain won the **2026 FIFA World Cup**, beating Argentina **1–0 after extra time**. Ferran Torres scored in the 106th minute. [ESPN](https://www.espn.com/soccer/story/_/id/49403084/2026-world-cup-final-spain-argentina-score-ferran-torres-champions-title)";

		expect(citationsFrom(text)).toEqual([
			{
				title: "ESPN",
				url: "https://www.espn.com/soccer/story/_/id/49403084/2026-world-cup-final-spain-argentina-score-ferran-torres-champions-title",
				domain: "espn.com",
				favicon: "https://www.espn.com/favicon.ico",
			},
		]);
		expect(removeCitationBlocks(text)).toBe(
			"Spain won the **2026 FIFA World Cup**, beating Argentina **1–0 after extra time**. Ferran Torres scored in the 106th minute.",
		);
	});
});

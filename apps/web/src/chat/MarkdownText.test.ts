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
});

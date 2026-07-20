import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import {
	citationsFrom,
	PlainMarkdown,
	removeCitationBlocks,
} from "./MarkdownText";

describe("PlainMarkdown", () => {
	test("renders currency amounts literally", () => {
		render(
			createElement(PlainMarkdown, {
				text: "**$4 per gallon**; Brent crude rose above **$90 per barrel**",
			}),
		);

		expect(screen.getByText("$4 per gallon")).toBeTruthy();
		expect(screen.getByText("$90 per barrel")).toBeTruthy();
	});
});

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

	test("captures a bracketed, plain-text Sources block", () => {
		const text =
			"Today’s local headlines include a fire and an outage.\n\n[Sources: CBS San Francisco, NBC Bay Area, SFist, San Francisco Chronicle]";

		expect(citationsFrom(text)).toEqual([
			{ title: "CBS San Francisco" },
			{ title: "NBC Bay Area" },
			{ title: "SFist" },
			{ title: "San Francisco Chronicle" },
		]);
		expect(removeCitationBlocks(text).trimEnd()).toBe(
			"Today’s local headlines include a fire and an outage.",
		);
	});

	test("derives citations from bare domains", () => {
		const text = "Some answer.\n\nSources: reuters.com, www.bbc.com";

		expect(citationsFrom(text)).toEqual([
			{
				title: "reuters.com",
				url: "https://reuters.com/",
				domain: "reuters.com",
				favicon: "https://reuters.com/favicon.ico",
			},
			{
				title: "bbc.com",
				url: "https://www.bbc.com/",
				domain: "bbc.com",
				favicon: "https://www.bbc.com/favicon.ico",
			},
		]);
	});

	test("captures a trailing inline Markdown citation without stripping it", () => {
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
		// Inline links stay in the body — they render as compact source pills.
		expect(removeCitationBlocks(text)).toBe(text);
	});

	test("captures every inline per-bullet citation, in document order", () => {
		const text =
			"Headlines:\n\n" +
			"- Police pursuit crash. [CBS San Francisco](https://www.cbsnews.com/sanfrancisco/news/police-pursuit-san-francisco-crash/)\n" +
			"- Tenderloin apartment fire. [Patch](https://patch.com/california/san-francisco/3-hurt-6-story-apartment-fire-san-francisco)\n" +
			"- Overdose deaths declining. [San Francisco Chronicle](https://www.sfchronicle.com/sf/article/overdose-death-down-trend-22348069.php)\n" +
			"- Bay boating tragedy. [KQED](https://www.kqed.org/news/12091098/search-continues)";

		expect(citationsFrom(text).map((c) => c.title)).toEqual([
			"CBS San Francisco",
			"Patch",
			"San Francisco Chronicle",
			"KQED",
		]);
		// No Sources: footer block, so nothing is stripped from the body.
		expect(removeCitationBlocks(text)).toBe(text);
	});

	test("keeps duplicate occurrences of the same URL", () => {
		const text =
			"See [Reuters](https://www.reuters.com/a) and again [Reuters](https://www.reuters.com/a).";

		expect(citationsFrom(text).map((c) => c.url)).toEqual([
			"https://www.reuters.com/a",
			"https://www.reuters.com/a",
		]);
	});
});

import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ContextStatusIndicator, SummaryEventCard } from "./Thread";

describe("ContextStatusIndicator", () => {
	test("stays hidden for an unsummarized idle conversation", () => {
		const { container } = render(
			<ContextStatusIndicator
				status={{
					state: "idle",
					estimatedTokens: null,
					summarized: false,
					jobError: null,
				}}
			/>,
		);

		expect(container).toBeEmptyDOMElement();
	});

	test("shows compact running, completed, and failed states", () => {
		const { rerender } = render(
			<ContextStatusIndicator
				status={{
					state: "running",
					estimatedTokens: null,
					summarized: false,
					jobError: null,
				}}
			/>,
		);
		expect(screen.getByText("Summarizing history...")).toBeInTheDocument();

		rerender(
			<ContextStatusIndicator
				status={{
					state: "idle",
					estimatedTokens: 42,
					summarized: true,
					jobError: null,
				}}
			/>,
		);
		expect(screen.queryByText("History summarized")).not.toBeInTheDocument();

		rerender(
			<ContextStatusIndicator
				status={{
					state: "failed",
					estimatedTokens: null,
					summarized: false,
					jobError: "Model unavailable",
				}}
			/>,
		);
		expect(
			screen.getByText("Summary failed: Model unavailable"),
		).toBeInTheDocument();
	});
});

describe("SummaryEventCard", () => {
	test("shows compaction before and after statistics", () => {
		render(
			<SummaryEventCard
				event={{
					tokensBefore: 12_400,
					tokensAfter: 3_100,
					revision: 2,
					createdAt: "2026-01-01T00:00:00.000Z",
					position: "before",
				}}
			/>,
		);

		expect(screen.getByText("Conversation summarized")).toBeInTheDocument();
		expect(screen.getByText("12.4K → 3.1K tokens")).toBeInTheDocument();
		expect(screen.getByText("75% smaller")).toBeInTheDocument();
	});
});

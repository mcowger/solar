import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import {
	ContextStatusIndicator,
	EmptyAssistantResponse,
	shouldConvertPastedText,
	SummaryEventCard,
} from "./Thread";

describe("shouldConvertPastedText", () => {
	const settings = { lineThreshold: 20, byteThreshold: 5 * 1024 };

	test("converts when either limit is exceeded", () => {
		expect(
			shouldConvertPastedText(Array(21).fill("line").join("\n"), settings),
		).toBe(true);
		expect(shouldConvertPastedText("x".repeat(5 * 1024 + 1), settings)).toBe(
			true,
		);
	});

	test("does not convert at either exact limit", () => {
		expect(
			shouldConvertPastedText(Array(20).fill("x").join("\n"), settings),
		).toBe(false);
		expect(shouldConvertPastedText("x".repeat(5 * 1024), settings)).toBe(false);
	});

	test("measures size as UTF-8 bytes", () => {
		expect(shouldConvertPastedText("😀".repeat(1_281), settings)).toBe(true);
	});
});

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

describe("EmptyAssistantResponse", () => {
	test("shows connection status while a response is starting", () => {
		const { container, rerender } = render(
			<EmptyAssistantResponse isRunning={true} connectionStatus="connecting" />,
		);
		expect(container.querySelector(".solar-response-loader")).toBeTruthy();
		expect(screen.getByText("Connecting…")).toBeInTheDocument();

		rerender(
			<EmptyAssistantResponse
				isRunning={true}
				connectionStatus="request-sent"
			/>,
		);
		expect(screen.getByText("Request sent…")).toBeInTheDocument();
	});

	test("distinguishes a completed empty response from an active generation", () => {
		const { container, rerender } = render(
			<EmptyAssistantResponse isRunning={true} />,
		);
		expect(container.querySelector(".solar-response-loader")).toBeTruthy();
		expect(
			screen.queryByText("The model returned an empty response."),
		).not.toBeInTheDocument();

		rerender(<EmptyAssistantResponse isRunning={false} />);
		expect(container.querySelector(".solar-response-loader")).toBeNull();
		expect(
			screen.getByText("The model returned an empty response."),
		).toBeInTheDocument();
	});
});

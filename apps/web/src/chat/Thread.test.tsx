import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import {
	AssistantStatusIndicator,
	ContextStatusIndicator,
	EmptyAssistantResponse,
	formatToolInputPreview,
	getAssistantStatusState,
	GroupedToolCalls,
	groupToolCalls,
	isFileDrag,
	shouldConvertPastedText,
	SummaryEventCard,
} from "./Thread";
import type { SolarToolCall } from "./useSolarRuntime";

describe("isFileDrag", () => {
	test("recognizes file drags without treating text drags as attachments", () => {
		expect(isFileDrag({ types: ["Files"] } as unknown as DataTransfer)).toBe(
			true,
		);
		expect(
			isFileDrag({ types: ["text/plain"] } as unknown as DataTransfer),
		).toBe(false);
		expect(isFileDrag(null)).toBe(false);
	});
});

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

describe("GroupedToolCalls", () => {
	const calls: SolarToolCall[] = [
		{
			id: "exa-1",
			name: "mcp__exa__web_search_exa",
			serverName: "Exa",
			remoteName: "web_search_exa",
			args: JSON.stringify({ query: "first search" }),
			status: "complete",
			output: "first result",
		},
		{
			id: "builtin-1",
			name: "get_current_datetime",
			args: "{}",
			status: "complete",
		},
		{
			id: "exa-2",
			name: "mcp__exa__web_search_exa",
			serverName: "Exa",
			remoteName: "web_search_exa",
			args: JSON.stringify({ query: "second search", limit: 5 }),
			status: "executing",
		},
	];

	test("groups by displayed identity in first-seen order", () => {
		const groups = groupToolCalls(calls);
		expect(groups.map((group) => group.name)).toEqual([
			"Exa (web_search_exa)",
			"get_current_datetime",
		]);
		expect(groups[0]!.calls.map((call) => call.id)).toEqual(["exa-1", "exa-2"]);
	});

	test("formats parsed input as a compact preview", () => {
		expect(formatToolInputPreview(calls[2]!)).toBe(
			'query: "second search", limit: 5',
		);
		expect(
			formatToolInputPreview({
				...calls[2]!,
				args: "",
				status: "streaming",
			}),
		).toBe("Input pending…");
	});

	test("renders equal collapsed groups with aggregate statuses", () => {
		const { container } = render(<GroupedToolCalls toolCalls={calls} />);
		const groups =
			container.querySelectorAll<HTMLDetailsElement>(".solar-tool-group");

		expect(groups).toHaveLength(2);
		expect([...groups].every((group) => !group.open)).toBe(true);
		expect(
			screen.getByText(/Complete: 1\s+In Progress: 1/),
		).toBeInTheDocument();
		expect(screen.getAllByText("Complete").length).toBeGreaterThanOrEqual(1);
		expect(container.querySelectorAll(".solar-tool-call")).toHaveLength(3);
	});
});

describe("AssistantStatusIndicator & getAssistantStatusState", () => {
	test("correctly computes state transitions for all 4 states", () => {
		// State 1: Connecting
		expect(
			getAssistantStatusState({
				isRunning: true,
				connectionStatus: "connecting",
				isEmpty: true,
				hasToolCalls: false,
			}),
		).toBe("connecting");

		// State 2: Request Sent
		expect(
			getAssistantStatusState({
				isRunning: true,
				connectionStatus: "request-sent",
				isEmpty: true,
				hasToolCalls: false,
			}),
		).toBe("request-sent");

		// State 3: Response in progress (text content started)
		expect(
			getAssistantStatusState({
				isRunning: true,
				connectionStatus: "request-sent",
				isEmpty: false,
				hasToolCalls: false,
			}),
		).toBe("in-progress");

		// State 3: Response in progress (tool call started)
		expect(
			getAssistantStatusState({
				isRunning: true,
				connectionStatus: "request-sent",
				isEmpty: true,
				hasToolCalls: true,
			}),
		).toBe("in-progress");

		// State 4: Response complete (not running)
		expect(
			getAssistantStatusState({
				isRunning: false,
				connectionStatus: "request-sent",
				isEmpty: false,
				hasToolCalls: false,
			}),
		).toBe("complete");

		// State 4: Response complete (no connection status / completed historical turn)
		expect(
			getAssistantStatusState({
				isRunning: true,
				connectionStatus: undefined,
				isEmpty: false,
				hasToolCalls: false,
			}),
		).toBe("complete");
	});

	test("renders corresponding icons and titles for each state", () => {
		// Connecting state
		const { container: c1 } = render(
			<AssistantStatusIndicator
				isRunning={true}
				connectionStatus="connecting"
				isEmpty={true}
				hasToolCalls={false}
			/>,
		);
		expect(c1.querySelector(".solar-status-connecting")).toBeTruthy();
		expect(screen.getByTitle("Connecting…")).toBeInTheDocument();

		// Request sent state
		const { container: c2 } = render(
			<AssistantStatusIndicator
				isRunning={true}
				connectionStatus="request-sent"
				isEmpty={true}
				hasToolCalls={false}
			/>,
		);
		expect(c2.querySelector(".solar-status-request-sent")).toBeTruthy();
		expect(screen.getByTitle("Request sent…")).toBeInTheDocument();

		// Response in progress state
		const { container: c3 } = render(
			<AssistantStatusIndicator
				isRunning={true}
				connectionStatus="request-sent"
				isEmpty={false}
				hasToolCalls={false}
			/>,
		);
		expect(c3.querySelector(".solar-status-in-progress")).toBeTruthy();
		expect(screen.getByTitle("Response in progress…")).toBeInTheDocument();

		// Complete state
		const { container: c4 } = render(
			<AssistantStatusIndicator
				isRunning={false}
				connectionStatus="request-sent"
				isEmpty={false}
				hasToolCalls={false}
			/>,
		);
		expect(c4.querySelector(".solar-status-complete")).toBeTruthy();
		expect(screen.getByTitle("Response complete")).toBeInTheDocument();
	});
});

describe("EmptyAssistantResponse", () => {
	test("returns null while a response is actively starting or running", () => {
		const { container, rerender } = render(
			<EmptyAssistantResponse isRunning={true} connectionStatus="connecting" />,
		);
		expect(container.firstChild).toBeNull();

		rerender(
			<EmptyAssistantResponse
				isRunning={true}
				connectionStatus="request-sent"
			/>,
		);
		expect(container.firstChild).toBeNull();
	});

	test("distinguishes a completed empty response from an active generation", () => {
		const { container, rerender } = render(
			<EmptyAssistantResponse isRunning={true} />,
		);
		expect(container.firstChild).toBeNull();

		rerender(<EmptyAssistantResponse isRunning={false} />);
		expect(
			screen.getByText("The model returned an empty response."),
		).toBeInTheDocument();
	});

	test("offers a stale response force-stop control", () => {
		let forceStopped = false;
		render(
			<EmptyAssistantResponse
				isRunning={false}
				isStale
				onForceStop={async () => {
					forceStopped = true;
				}}
			/>,
		);

		const control = screen.getByTitle("Force stop response");
		expect(control.querySelector(".solar-response-loader")).toBeTruthy();
		fireEvent.mouseEnter(control);
		expect(control.querySelector(".lucide-ban")).toBeTruthy();
		fireEvent.click(control);
		expect(forceStopped).toBe(true);
	});
});

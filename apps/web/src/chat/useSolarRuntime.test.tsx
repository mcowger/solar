import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { parseTimelineItems, type SolarToolCall } from "./useSolarRuntime";

/**
 * Fake EventSource driving the SSE consumption in useSolarRuntime. Tests emit
 * chunks / [DONE] / errors manually.
 */
class FakeEventSource {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	static instances: FakeEventSource[] = [];

	url: string;
	readyState = FakeEventSource.OPEN;
	closed = false;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;

	constructor(url: string) {
		this.url = url;
		FakeEventSource.instances.push(this);
	}

	close() {
		this.closed = true;
		this.readyState = FakeEventSource.CLOSED;
	}

	emit(data: unknown, id?: number) {
		this.onmessage?.({
			data: typeof data === "string" ? data : JSON.stringify(data),
			lastEventId: id != null ? String(id) : "",
		} as MessageEvent);
	}

	/** Simulate a terminal connection failure (e.g. HTTP 401/404). */
	failTerminally() {
		this.readyState = FakeEventSource.CLOSED;
		this.onerror?.(new Event("error"));
	}

	/** Simulate a transient failure (EventSource is auto-reconnecting). */
	failTransiently() {
		this.readyState = FakeEventSource.CONNECTING;
		this.onerror?.(new Event("error"));
	}
}

interface FakeRow {
	id: string;
	role: "user" | "assistant";
	text: string;
	status: "complete" | "generating" | "error";
	reasoning: string | null;
	toolCalls: undefined;
	attachments: never[];
	isActive: boolean;
}

const row = (
	id: string,
	role: FakeRow["role"],
	text: string,
	isActive = false,
	status: FakeRow["status"] = "complete",
): FakeRow => ({
	id,
	role,
	text,
	status,
	reasoning: null,
	toolCalls: undefined,
	attachments: [],
	isActive,
});

let historyRows: FakeRow[] = [];
let contextState: {
	summaryEvent: null | {
		tokensBefore: number;
		tokensAfter: number;
		revision: number;
		createdAt: string;
		retainedMessageBoundaryId: string;
	};
} = { summaryEvent: null };
let historyCalls = 0;

mock.module("../trpcClient", () => ({
	trpcClient: {
		conversation: {
			messages: {
				query: async () => {
					historyCalls += 1;
					return historyRows;
				},
			},
			contextState: { query: async () => contextState },
		},
	},
}));

const realFetch = globalThis.fetch;
const realEventSource = globalThis.EventSource;

let stopHandler: () => Promise<Response>;
let stopCalls = 0;
let forceStopHandler: () => Promise<Response>;
let forceStopCalls = 0;

globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
globalThis.fetch = (async (input: RequestInfo | URL) => {
	const url =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url;
	if (url === "/api/chat/stop") {
		stopCalls += 1;
		return stopHandler();
	}
	if (url === "/api/chat/force-stop") {
		forceStopCalls += 1;
		return forceStopHandler();
	}
	throw new Error(`unexpected fetch in test: ${url}`);
}) as typeof fetch;

const { useSolarRuntime } = await import("./useSolarRuntime");
const { TRPCProvider } = await import("../trpc");
const { trpcClient } = await import("../trpcClient");

afterAll(() => {
	globalThis.fetch = realFetch;
	globalThis.EventSource = realEventSource;
});

beforeEach(() => {
	FakeEventSource.instances = [];
	contextState = { summaryEvent: null };
	historyCalls = 0;
	stopCalls = 0;
	forceStopCalls = 0;
	stopHandler = async () =>
		new Response(JSON.stringify({ stopped: true }), {
			headers: { "content-type": "application/json" },
		});
	forceStopHandler = async () =>
		new Response(JSON.stringify({ stopped: true }), {
			headers: { "content-type": "application/json" },
		});
});

function renderRuntime() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return renderHook(
		({ summaryRevision }: { summaryRevision?: number }) =>
			useSolarRuntime("conv-1", true, [], false, summaryRevision),
		{
			initialProps: { summaryRevision: undefined as number | undefined },
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={queryClient}>
					<TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
						{children}
					</TRPCProvider>
				</QueryClientProvider>
			),
		},
	);
}

/** Render with an active generation and wait for the SSE to attach. */
async function renderResumedRun() {
	historyRows = [row("u1", "user", "hi"), row("a1", "assistant", "", true)];
	const rendered = renderRuntime();
	await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
	const source = FakeEventSource.instances[0]!;
	await waitFor(() =>
		expect(rendered.result.current.thread.getState().isRunning).toBe(true),
	);
	return { ...rendered, source };
}

const lastMessageText = (
	runtime: ReturnType<typeof useSolarRuntime>,
): string => {
	const last = runtime.thread.getState().messages.at(-1);
	return (last?.content ?? [])
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
};

describe("useSolarRuntime compaction", () => {
	test("reloads history when a background summary completes", async () => {
		historyRows = [
			row("u1", "user", "old question"),
			row("a1", "assistant", "old answer"),
			row("u2", "user", "new question"),
			row("a2", "assistant", "new answer"),
		];
		const rendered = renderRuntime();
		await waitFor(() => expect(historyCalls).toBe(1));

		contextState = {
			summaryEvent: {
				tokensBefore: 272_000,
				tokensAfter: 8_000,
				revision: 2,
				createdAt: "2026-07-19T20:14:47.000Z",
				retainedMessageBoundaryId: "u2",
			},
		};
		rendered.rerender({ summaryRevision: 2 });

		await waitFor(() => {
			expect(historyCalls).toBe(2);
			const marker = rendered.result.current.thread
				.getState()
				.messages.find((message) => message.id === "u2")?.metadata?.custom as
				| {
						summaryEvent?: {
							tokensBefore: number;
							tokensAfter: number;
							position: string;
						};
				  }
				| undefined;
			expect(marker?.summaryEvent).toMatchObject({
				tokensBefore: 272_000,
				tokensAfter: 8_000,
				position: "before",
			});
		});
		rendered.unmount();
	});
});

describe("useSolarRuntime cancel (Stop)", () => {
	test("waits for the server [DONE] after /stop so persisted partial output is loaded", async () => {
		const { result, source, unmount } = await renderResumedRun();
		act(() =>
			source.emit({ type: "text-delta", textDelta: "partial answer" }, 1),
		);

		act(() => result.current.thread.cancelRun());
		await waitFor(() => expect(stopCalls).toBe(1));
		// Give any (incorrect) local teardown a chance to run.
		await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

		// The run must still be live: the server only persists the partial text
		// before it sends [DONE], so tearing down locally would race the reload.
		expect(source.closed).toBe(false);
		expect(result.current.thread.getState().isRunning).toBe(true);

		// Server persists the partial text, then ends the stream.
		historyRows = [
			row("u1", "user", "hi"),
			row("a1", "assistant", "partial answer"),
		];
		act(() => source.emit("[DONE]"));

		await waitFor(() =>
			expect(result.current.thread.getState().isRunning).toBe(false),
		);
		await waitFor(() =>
			expect(lastMessageText(result.current)).toBe("partial answer"),
		);
		unmount();
	});

	test("falls back to local teardown when /stop fails", async () => {
		stopHandler = async () => {
			throw new Error("network down");
		};
		const { result, source, unmount } = await renderResumedRun();
		act(() => source.emit({ type: "text-delta", textDelta: "partial" }, 1));

		act(() => result.current.thread.cancelRun());

		await waitFor(() =>
			expect(result.current.thread.getState().isRunning).toBe(false),
		);
		expect(source.closed).toBe(true);
		unmount();
	});

	test("falls back to local teardown when /stop returns an error status", async () => {
		stopHandler = async () => new Response("not found", { status: 404 });
		const { result, source, unmount } = await renderResumedRun();

		act(() => result.current.thread.cancelRun());

		await waitFor(() => expect(stopCalls).toBe(1));
		await waitFor(() =>
			expect(result.current.thread.getState().isRunning).toBe(false),
		);
		expect(source.closed).toBe(true);
		unmount();
	});
});

describe("useSolarRuntime stale turns", () => {
	test("leaves orphaned generating messages for the user to force-stop", async () => {
		historyRows = [
			row("u1", "user", "hi"),
			row("a1", "assistant", "partial answer", false, "generating"),
		];
		const { unmount } = renderRuntime();

		await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
		expect(forceStopCalls).toBe(0);
		unmount();
	});
});

describe("useSolarRuntime stream errors", () => {
	test("finishes the run on a terminal EventSource failure", async () => {
		const { result, source, unmount } = await renderResumedRun();

		act(() => source.failTerminally());

		await waitFor(() =>
			expect(result.current.thread.getState().isRunning).toBe(false),
		);
		expect(source.closed).toBe(true);
		unmount();
	});

	test("keeps running through a transient EventSource failure", async () => {
		const { result, source, unmount } = await renderResumedRun();

		act(() => source.failTransiently());
		await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

		expect(result.current.thread.getState().isRunning).toBe(true);

		// Recover and finish normally.
		source.readyState = FakeEventSource.OPEN;
		act(() => source.emit({ type: "text-delta", textDelta: "done" }, 1));
		historyRows = [row("u1", "user", "hi"), row("a1", "assistant", "done")];
		act(() => source.emit("[DONE]"));
		await waitFor(() =>
			expect(result.current.thread.getState().isRunning).toBe(false),
		);
		unmount();
	});
});

describe("parseTimelineItems", () => {
	test("parses chronological sequence from structured message parts", () => {
		const partsJson = JSON.stringify({
			content: [
				{ type: "thinking", thinking: "Step 1 thought" },
				{ type: "text", text: "Step 1 text" },
				{ type: "toolCall", id: "call-1", name: "search" },
				{ type: "text", text: "Final answer" },
			],
			solarToolCalls: [
				{
					id: "call-1",
					name: "search",
					args: '{"q":"foo"}',
					status: "complete",
					output: "results",
				},
			],
		});

		const items = parseTimelineItems(partsJson, "Fallback text");
		expect(items).toEqual([
			{ kind: "reasoning", id: "reasoning-0", text: "Step 1 thought" },
			{ kind: "text", id: "text-1", text: "Step 1 text" },
			{
				kind: "toolCalls",
				id: "tools-2",
				calls: [
					{
						id: "call-1",
						name: "search",
						args: '{"q":"foo"}',
						status: "complete",
						output: "results",
					},
				],
			},
			{ kind: "text", id: "text-3", text: "Final answer" },
		]);
	});

	test("falls back cleanly when parts string is absent", () => {
		const toolCalls: SolarToolCall[] = [
			{ id: "call-1", name: "list", args: "{}", status: "complete" },
		];
		const items = parseTimelineItems(
			null,
			"Main output",
			"Global reasoning",
			toolCalls,
		);

		expect(items).toEqual([
			{ kind: "toolCalls", id: "tools-fallback", calls: toolCalls },
			{ kind: "reasoning", id: "reasoning-fallback", text: "Global reasoning" },
			{ kind: "text", id: "text-fallback", text: "Main output" },
		]);
	});
});

import { beforeEach, describe, expect, mock, test } from "bun:test";

const attachmentRecords = new Map<
	string,
	{
		id: string;
		userId: string;
		storageKey: string;
		kind: string;
		mimeType: string;
		filename: string;
	}
>();
let selectionApi = "anthropic-messages";

const expandCalls: string[][] = [];

mock.module("../../chat/attachments", () => ({
	expandAttachmentRows: async (rows: { id: string; filename: string }[]) => {
		expandCalls.push(rows.map((row) => row.id));
		return {
			parts: [],
			documents: rows.map((row) => ({
				marker: `[[solar-document:${row.id}]]`,
				data: `bytes-of-${row.id}`,
				mimeType: "application/pdf",
				filename: row.filename,
			})),
		};
	},
}));
mock.module("../../chat/catalog", () => ({
	MOCK: false,
	resolveSelection: async () => ({ api: selectionApi }),
	documentInputCapabilities: async () => ({
		nativeMimeTypes: ["application/pdf"],
		extractedTextMimeTypes: [],
	}),
}));
mock.module("../../chat/tools", () => ({ toolProvider: {} }));
mock.module("../../chat-v2/db/repository", () => ({
	chatV2Repository: {
		getConversation: async () => ({
			provider: "Plexus",
			endpointId: "endpoint",
			modelId: "model",
			modelApi: selectionApi,
		}),
		getAttachment: async (userId: string, id: string) => {
			const record = attachmentRecords.get(id);
			if (!record || record.userId !== userId) throw new Error("not found");
			return record;
		},
	},
}));
mock.module("../../logger", () => ({
	logger: {
		withError: () => ({ withMetadata: () => ({ warn: () => {} }) }),
		withMetadata: () => ({ debug: () => {} }),
	},
}));

const { piBridgeRoutes } = await import("./server");
const { issueBridgeToken } = await import("./tokens");

const token = issueBridgeToken({ conversationId: "chat-1", userId: "user-1" });

function inject(payload: unknown, authorization = `Bearer ${token}`) {
	return piBridgeRoutes.request("/internal/pi-bridge/inject-documents", {
		method: "POST",
		headers: { authorization, "content-type": "application/json" },
		body: JSON.stringify({ payload }),
	});
}

function anthropicPayload(...markers: string[]) {
	return {
		messages: [
			{
				role: "user",
				content: [
					...markers.map((text) => ({ type: "text", text })),
					{ type: "text", text: "tell me about this doc" },
				],
			},
		],
	};
}

beforeEach(() => {
	attachmentRecords.clear();
	expandCalls.length = 0;
	selectionApi = "anthropic-messages";
	attachmentRecords.set("doc-1", {
		id: "doc-1",
		userId: "user-1",
		storageKey: "user-1/doc-1",
		kind: "document",
		mimeType: "application/pdf",
		filename: "report.pdf",
	});
});

describe("POST /internal/pi-bridge/inject-documents", () => {
	test("rejects requests without a valid bridge token", async () => {
		expect((await inject({}, "Bearer nope")).status).toBe(401);
	});

	test("swaps a placeholder for a native Anthropic document block", async () => {
		const response = await inject(anthropicPayload("[[solar-document:doc-1]]"));
		expect(response.status).toBe(200);
		const { payload } = (await response.json()) as {
			payload: { messages: { content: unknown[] }[] };
		};
		expect(payload.messages[0]!.content).toEqual([
			{
				type: "document",
				source: {
					type: "base64",
					media_type: "application/pdf",
					data: "bytes-of-doc-1",
				},
				title: "report.pdf",
			},
			{ type: "text", text: "tell me about this doc" },
		]);
	});

	test("swaps a placeholder for an OpenAI responses input_file", async () => {
		selectionApi = "openai-responses";
		const response = await inject({
			input: [
				{
					role: "user",
					content: [{ type: "input_text", text: "[[solar-document:doc-1]]" }],
				},
			],
		});
		const { payload } = (await response.json()) as {
			payload: { input: { content: unknown[] }[] };
		};
		expect(payload.input[0]!.content).toEqual([
			{
				type: "input_file",
				filename: "report.pdf",
				file_data: "data:application/pdf;base64,bytes-of-doc-1",
			},
		]);
	});

	test("returns the payload untouched when it has no placeholders", async () => {
		const original = anthropicPayload();
		const response = await inject(original);
		expect(await response.json()).toEqual({ payload: original });
		expect(expandCalls).toEqual([]);
	});

	test("ignores placeholders for attachments the user does not own", async () => {
		attachmentRecords.set("doc-2", {
			id: "doc-2",
			userId: "someone-else",
			storageKey: "someone-else/doc-2",
			kind: "document",
			mimeType: "application/pdf",
			filename: "secret.pdf",
		});
		const original = anthropicPayload("[[solar-document:doc-2]]");
		const response = await inject(original);
		expect(await response.json()).toEqual({ payload: original });
		expect(expandCalls).toEqual([]);
	});

	test("returns the payload untouched for APIs without a native adapter", async () => {
		selectionApi = "openai-completions";
		const original = anthropicPayload("[[solar-document:doc-1]]");
		const response = await inject(original);
		expect(await response.json()).toEqual({ payload: original });
	});

	test("rejects a malformed body", async () => {
		const response = await piBridgeRoutes.request(
			"/internal/pi-bridge/inject-documents",
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: "not json",
			},
		);
		expect(response.status).toBe(400);
	});
});

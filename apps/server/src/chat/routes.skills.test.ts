import { beforeEach, describe, expect, mock, test } from "bun:test";

const skillContent = `---
name: release-notes
description: Draft release notes.
---
# Release notes
`;
const inserted: Record<string, unknown>[] = [];

function query(table: string) {
	const filters: [string, unknown][] = [];
	const builder = {
		select: () => builder,
		where: (column: string, _operator: string, value: unknown) => {
			filters.push([column, value]);
			return builder;
		},
		orderBy: () => builder,
		limit: () => builder,
		executeTakeFirst: async () => {
			if (table === "conversation") return { id: "conversation" };
			if (table === "skill")
				return { name: "release-notes", content: skillContent };
			return undefined;
		},
		execute: async () => {
			if (table === "message") {
				if (filters.some(([column]) => column === "status"))
					return inserted.filter((row) => row.role === "user");
				return inserted.filter((row) => row.role === "user");
			}
			return [];
		},
	};
	return builder;
}

mock.module("../auth", () => ({
	getSolarSession: async () => ({ user: { id: "owner", role: "user" } }),
}));
mock.module("../db", () => ({
	db: {
		selectFrom: (table: string) => query(table),
		insertInto: () => ({
			values: (row: Record<string, unknown>) => ({
				execute: async () => {
					inserted.push(row);
				},
			}),
		}),
		updateTable: () => ({
			set: () => ({ where: () => ({ execute: async () => {} }) }),
		}),
	},
	sqlite: {},
}));
mock.module("./attachments", () => ({
	attachmentMetadata: async () => [],
	deleteAttachmentFilesForMessages: async () => {},
	linkAttachments: async () => {},
	loadAttachmentContentParts: async () => ({ parts: [], documents: [] }),
	loadAttachmentSummary: async () => "",
}));
mock.module("./catalog", () => ({
	documentInputCapabilities: async () => ({
		nativeMimeTypes: [],
		extractedTextMimeTypes: [],
	}),
	documentInputMimeTypes: async () => [],
	getModelCapabilities: async () => ({}),
	getTitlePrompt: async () => "",
	resolveSelection: async () => ({
		provider: "mock",
		endpointId: "mock",
		modelId: "mock",
		api: "mock",
	}),
	resolveTaskModelOrFallback: async (selection: unknown) => selection,
}));
mock.module("./generationManager", () => ({
	generationManager: { start: async () => {} },
}));
mock.module("./tools", () => ({ toolProvider: { resolve: async () => [] } }));
mock.module("../context/runtime", () => ({
	contextRuntime: {
		assemble: async () => ({
			messageIds: undefined,
			summary: null,
			allowedAttachmentIds: undefined,
		}),
	},
}));
mock.module("./location", () => ({ reverseGeocode: async () => undefined }));
mock.module("../logger", () => ({
	logger: { withMetadata: () => ({ trace: () => {} }) },
}));

const { chatRoutes } = await import("./routes");

describe("skill chat POST", () => {
	beforeEach(() => {
		inserted.length = 0;
	});

	test("persists a hidden explicit skill invocation with the ordinary user text", async () => {
		const response = await chatRoutes.request(
			"/",
			new Request("http://solar.local/", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "conversation",
					skillName: "release-notes",
					text: "prepare the patch",
				}),
			}),
		);

		expect(response.status).toBe(202);
		expect(inserted[0]).toMatchObject({
			role: "user",
			text: "prepare the patch",
			parts: JSON.stringify({
				solarSkillInvocation: {
					name: "release-notes",
					content: skillContent,
				},
			}),
		});
	});

	test("rejects malformed skill names before querying or persisting", async () => {
		const response = await chatRoutes.request(
			"/",
			new Request("http://solar.local/", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "conversation",
					skillName: "Release Notes",
					text: "prepare the patch",
				}),
			}),
		);

		expect(response.status).toBe(400);
		expect(inserted).toEqual([]);
	});
});

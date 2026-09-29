import { afterEach, describe, expect, mock, test } from "bun:test";
import { writeXlsx } from "openjsxl";

const files = new Map<string, Uint8Array>();
const attachmentRows = new Map<
	string,
	{ storageKey: string; userId: string }
>();

function selectQuery(table: string) {
	const where: [string, unknown][] = [];
	const query = {
		select: () => query,
		selectAll: () => query,
		where: (column: string, _operator: string, value: unknown) => {
			where.push([column, value]);
			return query;
		},
		execute: async () => {
			if (table !== "attachment") return [];
			return [...attachmentRows.values()].filter((row) =>
				where.every(([column, value]) =>
					column === "userId" ? row.userId === value : true,
				),
			);
		},
	};
	return query;
}

mock.module("../config", () => ({
	config: { attachmentsDataDir: "/test/attachments" },
}));
mock.module("../db", () => ({
	db: { selectFrom: (table: string) => selectQuery(table) },
}));
mock.module("@struktoai/mirage-node", () => ({
	DiskResource: class {
		open = async () => {};
		mkdir = async () => {};
		writeFile = async (path: { toString(): string }, bytes: Uint8Array) => {
			files.set(path.toString(), bytes);
		};
		readFile = async (path: { toString(): string }) => {
			const bytes = files.get(path.toString());
			if (!bytes) throw new Error("missing file");
			return bytes;
		};
		unlink = async (path: { toString(): string }) => {
			files.delete(path.toString());
		};
	},
	PathSpec: { fromStrPath: (value: string) => ({ toString: () => value }) },
}));

const attachments = await import("./attachments");

afterEach(() => {
	files.clear();
	attachmentRows.clear();
});

describe("attachments", () => {
	test("stores decoded image dimensions", async () => {
		const saved = await attachments.saveAttachmentFile({
			userId: "user-1",
			filename: "pixel.png",
			mimeType: "image/png",
			bytes: Uint8Array.from(
				Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAF/gL+Cd2fiAAAAABJRU5ErkJggg==",
					"base64",
				),
			),
		});

		expect(saved).toMatchObject({ width: 1, height: 1 });
	});

	test("classifies image, text, structured text, and document MIME types", async () => {
		const image = await attachments.saveAttachmentFile({
			userId: "user-1",
			filename: "photo.png",
			mimeType: "image/png",
			bytes: new Uint8Array([1]),
		});
		const text = await attachments.saveAttachmentFile({
			userId: "user-1",
			filename: "note.txt",
			mimeType: "text/plain",
			bytes: new Uint8Array([2]),
		});
		const yaml = await attachments.saveAttachmentFile({
			userId: "user-1",
			filename: "config.yaml",
			mimeType: "application/yaml",
			bytes: new Uint8Array([3]),
		});
		const document = await attachments.saveAttachmentFile({
			userId: "user-1",
			filename: "report.pdf",
			mimeType: "application/pdf",
			bytes: new Uint8Array([4]),
		});

		expect(image.kind).toBe("image");
		expect(text.kind).toBe("text");
		expect(yaml.kind).toBe("text");
		expect(document.kind).toBe("document");
	});

	test("rejects unsupported MIME types before writing a file", async () => {
		await expect(
			attachments.saveAttachmentFile({
				userId: "user-1",
				filename: "archive.zip",
				mimeType: "application/zip",
				bytes: new Uint8Array([1]),
			}),
		).rejects.toThrow("Unsupported file type: application/zip");

		expect(files).toHaveLength(0);
	});

	test("rejects empty documents before writing a file", async () => {
		await expect(
			attachments.saveAttachmentFile({
				userId: "user-1",
				filename: "empty.pdf",
				mimeType: "application/pdf",
				bytes: new Uint8Array(),
			}),
		).rejects.toThrow("Document is empty");

		expect(files).toHaveLength(0);
	});

	test("rejects files larger than 16 MB before writing a file", async () => {
		await expect(
			attachments.saveAttachmentFile({
				userId: "user-1",
				filename: "large.txt",
				mimeType: "text/plain",
				bytes: new Uint8Array(16 * 1024 * 1024 + 1),
			}),
		).rejects.toThrow("File exceeds the 16 MB limit");

		expect(files).toHaveLength(0);
	});

	test("reads back raw bytes by storage key", async () => {
		files.set("/user-1/attachment-1", new Uint8Array([7]));

		expect(
			await attachments.readAttachmentBytes("user-1/attachment-1"),
		).toEqual(new Uint8Array([7]));
	});

	test("deletes files by storage key without touching unrelated keys", async () => {
		files.set("/user-1/keep", new Uint8Array([1]));
		files.set("/user-1/remove", new Uint8Array([2]));

		await attachments.deleteAttachmentFilesByStorageKey(["user-1/remove"]);

		expect(files.has("/user-1/keep")).toBe(true);
		expect(files.has("/user-1/remove")).toBe(false);
	});

	test("frees every attachment file owned by a user", async () => {
		attachmentRows.set("a1", { storageKey: "user-1/a1", userId: "user-1" });
		attachmentRows.set("a2", { storageKey: "user-1/a2", userId: "user-1" });
		attachmentRows.set("a3", { storageKey: "user-2/a3", userId: "user-2" });
		files.set("/user-1/a1", new Uint8Array([1]));
		files.set("/user-1/a2", new Uint8Array([2]));
		files.set("/user-2/a3", new Uint8Array([3]));

		await attachments.deleteAttachmentFilesForUser("user-1");

		expect(files.has("/user-1/a1")).toBe(false);
		expect(files.has("/user-1/a2")).toBe(false);
		expect(files.has("/user-2/a3")).toBe(true);
	});

	test("builds base64 image parts and wrapped UTF-8 text parts", async () => {
		files.set("/user-1/image", new Uint8Array([0, 1, 2]));
		files.set("/user-1/text", new TextEncoder().encode("Hello, Solar!"));

		await expect(
			attachments.expandAttachmentRows([
				{
					id: "image",
					storageKey: "user-1/image",
					kind: "image",
					mimeType: "image/png",
					filename: "photo.png",
				},
				{
					id: "text",
					storageKey: "user-1/text",
					kind: "text",
					mimeType: "text/plain",
					filename: "note.txt",
				},
			]),
		).resolves.toEqual({
			parts: [
				{ type: "image", data: "AAEC", mimeType: "image/png" },
				{
					type: "text",
					text: '<attachment name="note.txt">\nHello, Solar!\n</attachment>',
				},
			],
			documents: [],
		});
	});

	test("returns no content parts for an empty row list", async () => {
		await expect(attachments.expandAttachmentRows([])).resolves.toEqual({
			parts: [],
			documents: [],
		});
	});

	test("loads documents as opaque native inputs only when enabled", async () => {
		files.set("/user-1/document", new Uint8Array([0, 1, 2]));
		const row = {
			id: "document",
			storageKey: "user-1/document",
			kind: "document" as const,
			mimeType: "application/pdf",
			filename: "report.pdf",
		};

		await expect(attachments.expandAttachmentRows([row])).resolves.toEqual({
			parts: [],
			documents: [],
		});
		await expect(
			attachments.expandAttachmentRows([row], {
				nativeMimeTypes: ["application/pdf"],
				extractedTextMimeTypes: [],
			}),
		).resolves.toEqual({
			parts: [{ type: "text", text: "[[solar-document:document]]" }],
			documents: [
				{
					marker: "[[solar-document:document]]",
					data: "AAEC",
					mimeType: "application/pdf",
					filename: "report.pdf",
				},
			],
		});
	});

	test("empty documents degrade to a placeholder instead of sinking the batch", async () => {
		files.set("/user-1/document", new Uint8Array());
		const row = {
			id: "document",
			storageKey: "user-1/document",
			kind: "document" as const,
			mimeType: "application/pdf",
			filename: "empty.pdf",
		};

		const { parts } = await attachments.expandAttachmentRows([row], {
			nativeMimeTypes: ["application/pdf"],
			extractedTextMimeTypes: [],
		});
		expect(parts).toHaveLength(1);
		const part = parts[0]!;
		if (part.type !== "text") throw new Error("expected a text part");
		expect(part.text).toContain("could not be read");
		expect(part.text).toContain("empty"); // keeps the original failure reason
	});

	test("extracts spreadsheet text only for a configured fallback capability", async () => {
		const bytes = await writeXlsx({
			sheets: [{ name: "Inventory", rows: [["Item"], ["Solar"]] }],
		});
		files.set("/user-1/spreadsheet", bytes);
		const row = {
			id: "spreadsheet",
			storageKey: "user-1/spreadsheet",
			kind: "document" as const,
			mimeType:
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			filename: "inventory.xlsx",
		};

		await expect(
			attachments.expandAttachmentRows([row], {
				nativeMimeTypes: [],
				extractedTextMimeTypes: [
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				],
			}),
		).resolves.toEqual({
			parts: [
				{
					type: "text",
					text: '<attachment name="inventory.xlsx">\n[Sheet: Inventory]\nItem\nSolar\n</attachment>',
				},
			],
			documents: [],
		});
	});
});

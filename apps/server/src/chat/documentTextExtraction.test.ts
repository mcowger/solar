import { describe, expect, mock, test } from "bun:test";
import { writeXlsx } from "openjsxl";

mock.module("mammoth", () => ({
	default: {
		extractRawText: async () => ({ value: "A".repeat(100_001) }),
	},
}));
mock.module("unpdf", () => ({
	getDocumentProxy: async (bytes: Uint8Array) => {
		structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
		return { numPages: 2 };
	},
	extractText: async () => ({ text: "PDF text" }),
}));

const { extractDocumentText, pdfMetadata } = await import(
	"./documentTextExtraction"
);

describe("document text extraction", () => {
	test("converts every spreadsheet sheet to named CSV text", async () => {
		const bytes = await writeXlsx({
			sheets: [
				{
					name: "Results",
					rows: [
						["Name", "Score"],
						["Ada", 42],
					],
				},
				{ name: "Notes", rows: [["Status"], ["Ready"]] },
			],
		});

		await expect(
			extractDocumentText(
				new Uint8Array(bytes),
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			),
		).resolves.toBe(
			"[Sheet: Results]\nName,Score\nAda,42\n\n[Sheet: Notes]\nStatus\nReady",
		);
	});

	test("caps DOCX extraction and includes a truncation notice", async () => {
		await expect(
			extractDocumentText(
				new Uint8Array(),
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			),
		).resolves.toEndWith("[Document text truncated at 100,000 characters.]");
	});

	test("extracts PDF text for non-native model fallbacks", async () => {
		await expect(
			extractDocumentText(new Uint8Array(), "application/pdf"),
		).resolves.toBe("PDF text");
	});

	test("preserves caller-owned PDF bytes when PDF.js transfers its input", async () => {
		const bytes = new Uint8Array([1, 2, 3]);

		await expect(pdfMetadata(bytes)).resolves.toEqual({
			pageCount: 2,
			extractedTextChars: 8,
		});
		expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
	});
});

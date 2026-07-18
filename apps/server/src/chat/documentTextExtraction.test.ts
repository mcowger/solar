import { describe, expect, mock, test } from "bun:test";
import { writeXlsx } from "openjsxl";

mock.module("mammoth", () => ({
  default: {
    extractRawText: async () => ({ value: "A".repeat(100_001) }),
  },
}));
mock.module("unpdf", () => ({
  getDocumentProxy: async () => ({}),
  extractText: async () => ({ text: "PDF text" }),
}));

const { extractDocumentText } = await import("./documentTextExtraction");

describe("document text extraction", () => {
  test("converts every spreadsheet sheet to named CSV text", async () => {
    const bytes = await writeXlsx({
      sheets: [
        { name: "Results", rows: [["Name", "Score"], ["Ada", 42]] },
        { name: "Notes", rows: [["Status"], ["Ready"]] },
      ],
    });

    await expect(
      extractDocumentText(new Uint8Array(bytes), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ).resolves.toBe("[Sheet: Results]\nName,Score\nAda,42\n\n[Sheet: Notes]\nStatus\nReady");
  });

  test("caps DOCX extraction and includes a truncation notice", async () => {
    await expect(
      extractDocumentText(new Uint8Array(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ).resolves.toEndWith("[Document text truncated at 100,000 characters.]");
  });

  test("extracts PDF text for non-native model fallbacks", async () => {
    await expect(extractDocumentText(new Uint8Array(), "application/pdf")).resolves.toBe("PDF text");
  });
});

import { describe, expect, test } from "bun:test";
import { estimateClaudePdfTokens } from "./pdfTokens";

describe("estimateClaudePdfTokens", () => {
	test("accounts for extracted text and visual processing per page", () => {
		expect(
			estimateClaudePdfTokens(
				{ pageCount: 3, extractedTextChars: 12_000 },
				"claude-sonnet-4-5",
			),
		).toBe(7_704);
	});

	test("uses a conservative text allowance when extraction is unavailable", () => {
		expect(
			estimateClaudePdfTokens(
				{ pageCount: 3, extractedTextChars: null },
				"claude-opus-4-8",
			),
		).toBe(23_352);
	});

	test("uses a fixed fallback for legacy PDFs without metadata", () => {
		expect(
			estimateClaudePdfTokens(
				{ pageCount: null, extractedTextChars: null },
				"claude-sonnet-4-5",
			),
		).toBe(4_784);
	});
});

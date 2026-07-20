import { describe, expect, test } from "bun:test";
import { SolarAttachmentAdapter } from "./attachmentAdapter";

describe("SolarAttachmentAdapter", () => {
	test("accepts common image formats by extension and MIME when enabled", () => {
		const adapter = new SolarAttachmentAdapter(true, []);

		expect(adapter.accept).toContain(".png");
		expect(adapter.accept).toContain(".webp");
		expect(adapter.accept).toContain(".jpg");
		expect(adapter.accept).toContain(".gif");
		expect(adapter.accept).toContain(".avif");
		expect(adapter.accept).toContain("image/*");
	});

	test("omits images when disabled but keeps text and document types", () => {
		const adapter = new SolarAttachmentAdapter(false, [
			"application/pdf",
			"application/msword",
			"application/vnd.ms-excel",
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		]);

		expect(adapter.accept).not.toContain("image/");
		expect(adapter.accept).not.toContain(".png");
		expect(adapter.accept).toContain(".pdf");
		expect(adapter.accept).toContain(".doc");
		expect(adapter.accept).toContain(".xls");
		expect(adapter.accept).toContain(".xlsx");
		expect(adapter.accept).toContain(".docx");
		expect(adapter.accept).toContain("application/pdf");
		expect(adapter.accept).toContain("text/*");
	});

	test("uses known document extensions when documents are enabled before MIME capabilities load", () => {
		const adapter = new SolarAttachmentAdapter(false, [], true);

		expect(adapter.accept).toContain(".pdf");
		expect(adapter.accept).toContain(".doc");
		expect(adapter.accept).toContain(".docx");
		expect(adapter.accept).toContain(".xls");
		expect(adapter.accept).toContain(".xlsx");
	});
});

import { describe, expect, test } from "bun:test";
import { SolarAttachmentAdapter } from "./attachmentAdapter";

describe("SolarAttachmentAdapter", () => {
	test("explicitly accepts common image formats when images are enabled", () => {
		const adapter = new SolarAttachmentAdapter(true, []);

		expect(adapter.accept).toContain("image/jpeg");
		expect(adapter.accept).toContain("image/png");
		expect(adapter.accept).toContain("image/gif");
		expect(adapter.accept).toContain("image/webp");
		expect(adapter.accept).toContain("image/avif");
	});
});

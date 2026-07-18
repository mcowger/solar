import { describe, expect, test } from "bun:test";
import { nativeAttachmentAdapter } from "./nativeAttachmentAdapters";

const document = {
  marker: "[[solar-document:document-1]]",
  data: "AAEC",
  mimeType: "application/pdf",
  filename: "report.pdf",
};

describe("native attachment adapters", () => {
  test("injects OpenAI Responses input_file blocks", () => {
    const adapter = nativeAttachmentAdapter({ api: "openai-responses" });
    expect(adapter?.documentMimeTypes).toContain("application/vnd.openxmlformats-officedocument.wordprocessingml.document");

    const payload = {
      input: [{ role: "user", content: [{ type: "input_text", text: document.marker }] }],
    };
    expect(adapter?.injectDocuments(payload, [document])).toEqual({
      input: [{
        role: "user",
        content: [{
          type: "input_file",
          filename: "report.pdf",
          file_data: "data:application/pdf;base64,AAEC",
        }],
      }],
    });
  });

  test("injects Claude PDF document blocks", () => {
    const adapter = nativeAttachmentAdapter({ api: "anthropic-messages" });
    expect(adapter?.documentMimeTypes).toEqual(["application/pdf"]);

    const payload = { messages: [{ role: "user", content: document.marker }] };
    expect(adapter?.injectDocuments(payload, [document])).toEqual({
      messages: [{
        role: "user",
        content: [{
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: "AAEC" },
          title: "report.pdf",
        }],
      }],
    });
  });
});

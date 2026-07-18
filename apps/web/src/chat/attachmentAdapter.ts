import type {
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from "@assistant-ui/react";

/**
 * Uploads immediately in `add()` (POST /api/attachments — Mirage-backed disk
 * storage server-side) so the file exists before the user hits send; `send()`
 * only builds the local preview content. The server links the already-stored
 * attachment to the message when the chat turn is sent (see useSolarRuntime).
 */
export class SolarAttachmentAdapter implements AttachmentAdapter {
  public accept =
    "image/*,text/plain,text/markdown,text/csv,text/xml,application/json";

  public async add({ file }: { file: File }): Promise<PendingAttachment> {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/attachments", { method: "POST", body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Upload failed");
    }
    const meta = (await res.json()) as { id: string; kind: "image" | "text" };

    return {
      id: meta.id,
      type: meta.kind === "image" ? "image" : "document",
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  }

  public async send(
    attachment: PendingAttachment,
  ): Promise<CompleteAttachment> {
    const content =
      attachment.type === "image"
        ? [{ type: "image" as const, image: await readAsDataURL(attachment.file) }]
        : [{ type: "text" as const, text: await readAsText(attachment.file) }];
    return { ...attachment, status: { type: "complete" }, content };
  }

  public async remove(attachment: { id: string }): Promise<void> {
    await fetch(`/api/attachments/${attachment.id}`, { method: "DELETE" });
  }
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

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
// The native file picker (esp. macOS) resolves MIME types unreliably and greys
// out valid files when the accept list contains types it can't map to a UTI
// (e.g. application/toml, application/yaml). We therefore advertise both MIME
// types AND explicit extensions for every accepted kind.
const IMAGE_ACCEPT = [
	".jpg",
	".jpeg",
	".png",
	".gif",
	".webp",
	".avif",
	"image/*",
];
const TEXT_ACCEPT = [
	".txt",
	".text",
	".md",
	".markdown",
	".csv",
	".tsv",
	".log",
	".json",
	".jsonld",
	".rtf",
	".sql",
	".toml",
	".xml",
	".yaml",
	".yml",
	"text/*",
	"application/json",
	"application/ld+json",
	"application/rtf",
	"application/sql",
	"application/toml",
	"application/xml",
	"application/yaml",
];
/** Known document MIME types → the extensions the native picker recognizes. */
const DOCUMENT_EXTENSIONS: Record<string, string> = {
	"application/pdf": ".pdf",
	"application/msword": ".doc",
	"application/vnd.ms-excel": ".xls",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		".docx",
};
const DOCUMENT_MIME_TYPES = new Set(Object.keys(DOCUMENT_EXTENSIONS));
const DEFAULT_DOCUMENT_MIME_TYPES = [...DOCUMENT_MIME_TYPES];

export function isDocumentFile(file: File): boolean {
	return isDocumentMimeType(file.type);
}

export function isDocumentMimeType(mimeType: string | undefined): boolean {
	return Boolean(mimeType && DOCUMENT_MIME_TYPES.has(mimeType));
}

export class SolarAttachmentAdapter implements AttachmentAdapter {
	public readonly accept: string;

	constructor(
		allowImages: boolean,
		documentMimeTypes: readonly string[],
		allowDocuments = false,
	) {
		const supportedDocumentMimeTypes =
			documentMimeTypes.length || !allowDocuments
				? documentMimeTypes
				: DEFAULT_DOCUMENT_MIME_TYPES;
		const documentAccept = supportedDocumentMimeTypes.flatMap((mime) => {
			const extension = DOCUMENT_EXTENSIONS[mime];
			return extension ? [extension] : [mime];
		});
		this.accept = [
			...(allowImages ? IMAGE_ACCEPT : []),
			...TEXT_ACCEPT,
			...documentAccept,
		].join(",");
	}

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
				? [
						{
							type: "image" as const,
							image: await readAsDataURL(attachment.file),
						},
					]
				: [
						{
							type: "text" as const,
							text: isDocumentFile(attachment.file)
								? ""
								: await readAsText(attachment.file),
						},
					];
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

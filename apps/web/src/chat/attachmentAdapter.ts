import type {
	AttachmentAdapter,
	CompleteAttachment,
	PendingAttachment,
} from "@assistant-ui/react";
import { uploadWithProgress } from "../uploadWithProgress";

interface UploadedAttachment {
	id: string;
	kind: "image" | "text";
}

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

export function buildAttachmentAccept(
	allowImages: boolean,
	documentMimeTypes: readonly string[],
	allowDocuments = false,
): string {
	const supportedDocumentMimeTypes =
		documentMimeTypes.length || !allowDocuments
			? documentMimeTypes
			: DEFAULT_DOCUMENT_MIME_TYPES;
	const documentAccept = supportedDocumentMimeTypes.flatMap((mime) => {
		const extension = DOCUMENT_EXTENSIONS[mime];
		return extension ? [mime, extension] : [mime];
	});
	return [
		...(allowImages ? IMAGE_ACCEPT : []),
		...TEXT_ACCEPT,
		...documentAccept,
	].join(",");
}

export class SolarAttachmentAdapter implements AttachmentAdapter {
	public readonly accept: string;
	// The composer needs a stable attachment id from the first progress update,
	// but the server assigns the real id only once the upload finishes. Local id
	// -> in-flight/finished upload; send() swaps in the server id.
	private readonly uploads = new Map<string, Promise<UploadedAttachment>>();

	constructor(
		allowImages: boolean,
		documentMimeTypes: readonly string[],
		allowDocuments = false,
	) {
		this.accept = buildAttachmentAccept(
			allowImages,
			documentMimeTypes,
			allowDocuments,
		);
	}

	public async *add({
		file,
	}: {
		file: File;
	}): AsyncGenerator<PendingAttachment, void> {
		const localId = crypto.randomUUID();
		const base = {
			id: localId,
			type: file.type.startsWith("image/") ? "image" : "document",
			name: file.name,
			contentType: file.type,
			file,
		} as const;

		let latest = 0;
		let done = false;
		let wake: (() => void) | undefined;
		const signal = () => {
			wake?.();
			wake = undefined;
		};
		const form = new FormData();
		form.append("file", file);
		const upload = uploadWithProgress<UploadedAttachment>(
			"/api/attachments",
			form,
			(percent) => {
				latest = percent;
				signal();
			},
		).finally(() => {
			done = true;
			signal();
		});
		this.uploads.set(localId, upload);
		// Failures surface via the await below (or send()); avoid an unhandled
		// rejection on the stored promise if nobody else awaits it.
		upload.catch(() => {});

		let reported = 0;
		yield {
			...base,
			status: { type: "running", reason: "uploading", progress: 0 },
		};
		while (true) {
			if (latest !== reported) {
				reported = latest;
				yield {
					...base,
					status: { type: "running", reason: "uploading", progress: reported },
				};
				continue;
			}
			if (done) break;
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}

		const meta = await upload;
		yield {
			...base,
			type: meta.kind === "image" ? "image" : "document",
			// Lets the composer chip show the stored image once upload finishes.
			...(meta.kind === "image" && {
				content: [{ type: "image", image: `/api/attachments/${meta.id}` }],
			}),
			status: { type: "requires-action", reason: "composer-send" },
		};
	}

	public async send(
		attachment: PendingAttachment,
	): Promise<CompleteAttachment> {
		const pending = this.uploads.get(attachment.id);
		if (!pending) throw new Error("Attachment upload failed");
		// Waits for an in-flight upload; throws if it failed.
		const meta = await pending;
		this.uploads.delete(attachment.id);
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
		return {
			...attachment,
			id: meta.id,
			status: { type: "complete" },
			content,
		};
	}

	public async remove(attachment: { id: string }): Promise<void> {
		const uploaded = await this.uploads
			.get(attachment.id)
			?.catch(() => undefined);
		this.uploads.delete(attachment.id);
		if (uploaded) {
			await fetch(`/api/attachments/${uploaded.id}`, { method: "DELETE" });
		}
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

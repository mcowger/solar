import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { DiskResource, PathSpec } from "@struktoai/mirage-node";
import { config } from "../config";
import { db } from "../db";
import type { AttachmentKind } from "../db/schema";
import type { DocumentInputCapabilities } from "./nativeAttachmentAdapters";
import { extractDocumentText, pdfMetadata } from "./documentTextExtraction";
import { logger } from "../logger";

/**
 * Attachment storage (M3): images + plain-text, plus request-scoped extraction
 * for selected Office formats. Backed by Mirage's local-disk resource today; the
 * same resource API swaps in an S3-compatible mount later with no call-site
 * changes.
 */

export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
const TEXT_MIME_TYPES = new Set([
	"application/json",
	"application/ld+json",
	"application/rtf",
	"application/sql",
	"application/toml",
	"application/xml",
	"application/yaml",
]);
const DOCUMENT_MIME_TYPES = new Set([
	"application/pdf",
	"application/msword",
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export interface NativeDocumentInput {
	marker: string;
	data: string;
	mimeType: string;
	filename: string;
}

const disk = new DiskResource({ root: config.attachmentsDataDir });
let opened: Promise<void> | null = null;
async function ensureOpen(): Promise<void> {
	if (!opened) opened = disk.open();
	await opened;
}

function path(storageKey: string): PathSpec {
	return PathSpec.fromStrPath(`/${storageKey}`);
}

export class AttachmentError extends Error {}

function classify(mimeType: string): AttachmentKind | null {
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("text/") || TEXT_MIME_TYPES.has(mimeType))
		return "text";
	if (DOCUMENT_MIME_TYPES.has(mimeType)) return "document";
	return null;
}

async function dimensions(bytes: Uint8Array): Promise<{
	width: number | null;
	height: number | null;
}> {
	try {
		const { width, height } = await new Bun.Image(bytes).metadata();
		if (typeof width === "number" && typeof height === "number") {
			return { width, height };
		}
	} catch {}
	return { width: null, height: null };
}

/** Validates and writes an attachment, leaving persistence to the caller. */
export async function saveAttachmentFile(params: {
	userId: string;
	filename: string;
	mimeType: string;
	bytes: Uint8Array;
}) {
	const kind = classify(params.mimeType);
	if (!kind) {
		throw new AttachmentError(`Unsupported file type: ${params.mimeType}`);
	}
	if (kind === "document" && params.bytes.byteLength === 0) {
		throw new AttachmentError("Document is empty");
	}
	if (params.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
		throw new AttachmentError("File exceeds the 16 MB limit");
	}
	const imageDimensions =
		kind === "image"
			? await dimensions(params.bytes)
			: { width: null, height: null };
	const documentMetadata =
		params.mimeType === "application/pdf"
			? await pdfMetadata(params.bytes).catch(() => ({
					pageCount: null,
					extractedTextChars: null,
				}))
			: { pageCount: null, extractedTextChars: null };

	await ensureOpen();
	const id = crypto.randomUUID();
	const storageKey = `${params.userId}/${id}`;
	await disk.mkdir(PathSpec.fromStrPath(`/${params.userId}`), {
		recursive: true,
	});
	await disk.writeFile(path(storageKey), params.bytes);
	const sha256 = Buffer.from(
		await crypto.subtle.digest(
			"SHA-256",
			params.bytes as unknown as BufferSource,
		),
	).toString("hex");
	return {
		id,
		storageKey,
		kind,
		mimeType: params.mimeType,
		filename: params.filename,
		byteSize: params.bytes.byteLength,
		sha256,
		...imageDimensions,
		pageCount: documentMetadata.pageCount,
		extractedTextChars: documentMetadata.extractedTextChars,
		createdAt: new Date().toISOString(),
	};
}

/** Frees every disk object owned by a user before their FK-cascaded rows go away. */
export async function deleteAttachmentFilesForUser(
	userId: string,
): Promise<void> {
	const rows = await db
		.selectFrom("attachment")
		.select("storageKey")
		.where("userId", "=", userId)
		.execute();
	if (rows.length === 0) return;
	await ensureOpen();
	await Promise.all(
		rows.map((row) => disk.unlink(path(row.storageKey)).catch(() => {})),
	);
}

/** Reads raw bytes for a stored attachment by storage key. */
export async function readAttachmentBytes(
	storageKey: string,
): Promise<Uint8Array> {
	await ensureOpen();
	return disk.readFile(path(storageKey));
}

/** Frees disk objects by storage key directly. */
export async function deleteAttachmentFilesByStorageKey(
	storageKeys: readonly string[],
): Promise<void> {
	if (storageKeys.length === 0) return;
	await ensureOpen();
	await Promise.all(
		storageKeys.map((key) => disk.unlink(path(key)).catch(() => {})),
	);
}

/** Builds pi-ai content parts for a message's attachments: images become
 * base64 image parts, plain text is inlined verbatim as a text part (no local
 * extraction, ever — see ARCHITECTURE §6.2). */
export interface AttachmentContentRow {
	id: string;
	storageKey: string;
	kind: AttachmentKind;
	mimeType: string;
	filename: string;
}

/**
 * Attachment-record-to-content expansion. Reads bytes off disk and decides
 * between inline text, inline image, provider-native document injection, or
 * extracted-text fallback.
 */
export async function expandAttachmentRows(
	rows: readonly AttachmentContentRow[],
	documentInput: DocumentInputCapabilities = {
		nativeMimeTypes: [],
		extractedTextMimeTypes: [],
	},
	allowedAttachmentIds?: ReadonlySet<string>,
): Promise<{
	parts: (TextContent | ImageContent)[];
	documents: NativeDocumentInput[];
}> {
	if (rows.length === 0) return { parts: [], documents: [] };
	await ensureOpen();
	const parts: (TextContent | ImageContent)[] = [];
	const documents: NativeDocumentInput[] = [];
	for (const r of rows) {
		if (allowedAttachmentIds && !allowedAttachmentIds.has(r.id)) continue;
		// Fault isolation: one unreadable/corrupt attachment must never sink
		// the whole batch (its old behavior took the whole prompt down with a
		// 500 from the bridge endpoint, silently dropping everything else).
		try {
			const bytes = await disk.readFile(path(r.storageKey));
			if (r.kind === "document" && bytes.byteLength === 0) {
				throw new AttachmentError(
					`Attachment ${r.filename} is empty; upload it again`,
				);
			}
			if (r.kind === "image") {
				parts.push({
					type: "image",
					data: Buffer.from(bytes).toString("base64"),
					mimeType: r.mimeType,
				});
			} else if (r.kind === "text") {
				const text = Buffer.from(bytes).toString("utf-8");
				parts.push({
					type: "text",
					text: `<attachment name="${r.filename}">\n${text}\n</attachment>`,
				});
			} else if (documentInput.nativeMimeTypes.includes(r.mimeType)) {
				const marker = `[[solar-document:${r.id}]]`;
				parts.push({ type: "text", text: marker });
				documents.push({
					marker,
					data: Buffer.from(bytes).toString("base64"),
					mimeType: r.mimeType,
					filename: r.filename,
				});
			} else if (documentInput.extractedTextMimeTypes.includes(r.mimeType)) {
				const text = await extractDocumentText(bytes, r.mimeType);
				parts.push({
					type: "text",
					text: `<attachment name="${r.filename}">\n${text}\n</attachment>`,
				});
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			logger
				.withError(error)
				.withMetadata({ attachmentId: r.id, filename: r.filename })
				.warn("attachment expansion failed; substituting placeholder");
			parts.push({
				type: "text",
				text: `<attachment name="${r.filename}">\n[Attachment could not be read: ${reason}]\n</attachment>`,
			});
		}
	}
	return { parts, documents };
}

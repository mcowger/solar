import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { DiskResource, PathSpec } from "@struktoai/mirage-node";
import { config } from "../config";
import { db } from "../db";
import type { AttachmentKind } from "../db/schema";

/**
 * Attachment storage (M3): images + plain-text, never locally parsed/extracted
 * (see ARCHITECTURE §6.2). Backed by Mirage's local-disk resource today; the
 * same resource API swaps in an S3-compatible mount later with no call-site
 * changes.
 */

const MAX_BYTES = 20 * 1024 * 1024;

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
  if (mimeType.startsWith("text/")) return "text";
  return null;
}

/** Uploads a file to disk and creates an unlinked (`messageId` null) row. */
export async function saveAttachment(params: {
  userId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}) {
  const kind = classify(params.mimeType);
  if (!kind) {
    throw new AttachmentError(`Unsupported file type: ${params.mimeType}`);
  }
  if (params.bytes.byteLength > MAX_BYTES) {
    throw new AttachmentError("File exceeds the 20 MB limit");
  }

  await ensureOpen();
  const id = crypto.randomUUID();
  const storageKey = `${params.userId}/${id}`;
  await disk.mkdir(PathSpec.fromStrPath(`/${params.userId}`), {
    recursive: true,
  });
  await disk.writeFile(path(storageKey), params.bytes);

  await db
    .insertInto("attachment")
    .values({
      id,
      userId: params.userId,
      messageId: null,
      filename: params.filename,
      mimeType: params.mimeType,
      kind,
      byteSize: params.bytes.byteLength,
      storageKey,
      createdAt: new Date().toISOString(),
    })
    .execute();

  return {
    id,
    kind,
    mimeType: params.mimeType,
    filename: params.filename,
    byteSize: params.bytes.byteLength,
  };
}

/** Reads back an attachment's bytes for the uploading user (composer preview). */
export async function readAttachment(id: string, userId: string) {
  const row = await db
    .selectFrom("attachment")
    .selectAll()
    .where("id", "=", id)
    .where("userId", "=", userId)
    .executeTakeFirst();
  if (!row) return null;
  await ensureOpen();
  const bytes = await disk.readFile(path(row.storageKey));
  return { row, bytes };
}

/** Links previously-uploaded, still-orphaned attachments to the message they
 * were sent with. */
export async function linkAttachments(
  ids: string[],
  userId: string,
  messageId: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .updateTable("attachment")
    .set({ messageId })
    .where("id", "in", ids)
    .where("userId", "=", userId)
    .where("messageId", "is", null)
    .execute();
}

export async function attachmentsForMessage(messageId: string) {
  return db
    .selectFrom("attachment")
    .selectAll()
    .where("messageId", "=", messageId)
    .orderBy("createdAt", "asc")
    .execute();
}

async function attachmentsForMessages(messageIds: string[]) {
  if (messageIds.length === 0) return [];
  return db
    .selectFrom("attachment")
    .selectAll()
    .where("messageId", "in", messageIds)
    .execute();
}

/** Deletes on-disk files for the given messages' attachments. The DB rows are
 * left to SQLite's ON DELETE CASCADE once the messages are deleted — this only
 * covers what the cascade can't: freeing the disk objects. */
export async function deleteAttachmentFilesForMessages(
  messageIds: string[],
): Promise<void> {
  const rows = await attachmentsForMessages(messageIds);
  if (rows.length === 0) return;
  await ensureOpen();
  await Promise.all(
    rows.map((r) => disk.unlink(path(r.storageKey)).catch(() => {})),
  );
}

/** Frees every disk object owned by a user before their FK-cascaded rows go away. */
export async function deleteAttachmentFilesForUser(userId: string): Promise<void> {
  const rows = await db
    .selectFrom("attachment")
    .select("storageKey")
    .where("userId", "=", userId)
    .execute();
  if (rows.length === 0) return;
  await ensureOpen();
  await Promise.all(rows.map((row) => disk.unlink(path(row.storageKey)).catch(() => {})));
}

/** Removes an orphaned (never sent) upload — used by the composer's "remove
 * attachment" action. */
export async function removeOrphanAttachment(
  id: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("attachment")
    .selectAll()
    .where("id", "=", id)
    .where("userId", "=", userId)
    .where("messageId", "is", null)
    .executeTakeFirst();
  if (!row) return false;
  await ensureOpen();
  await disk.unlink(path(row.storageKey)).catch(() => {});
  await db.deleteFrom("attachment").where("id", "=", id).execute();
  return true;
}

/** Builds pi-ai content parts for a message's attachments: images become
 * base64 image parts, plain text is inlined verbatim as a text part (no local
 * extraction, ever — see ARCHITECTURE §6.2). */
export async function loadAttachmentContentParts(
  messageId: string,
): Promise<(TextContent | ImageContent)[]> {
  const rows = await attachmentsForMessage(messageId);
  if (rows.length === 0) return [];
  await ensureOpen();
  const parts: (TextContent | ImageContent)[] = [];
  for (const r of rows) {
    const bytes = await disk.readFile(path(r.storageKey));
    if (r.kind === "image") {
      parts.push({
        type: "image",
        data: Buffer.from(bytes).toString("base64"),
        mimeType: r.mimeType,
      });
    } else {
      const text = Buffer.from(bytes).toString("utf-8");
      parts.push({
        type: "text",
        text: `<attachment name="${r.filename}">\n${text}\n</attachment>`,
      });
    }
  }
  return parts;
}

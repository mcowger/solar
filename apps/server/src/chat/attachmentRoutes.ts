import { Hono } from "hono";
import { getSolarSession } from "../auth";
import {
	AttachmentError,
	deleteAttachmentFilesByStorageKey,
	readAttachmentBytes,
	saveAttachmentFile,
} from "./attachments";
import { conversationRepository } from "../conversations/repository";

export const attachmentRoutes = new Hono();

async function requireUserId(req: Request): Promise<string | null> {
	return (await getSolarSession(req.headers))?.user.id ?? null;
}

// Upload an attachment ahead of sending: composer picks a file, this stores it
// on disk (Mirage) and returns metadata; the chat routes link it to a message
// once the user actually sends.
attachmentRoutes.post("/", async (c) => {
	const userId = await requireUserId(c.req.raw);
	if (!userId) return c.json({ error: "unauthorized" }, 401);

	const body = await c.req.parseBody();
	const file = body.file;
	if (!(file instanceof File)) {
		return c.json({ error: "file is required" }, 400);
	}

	try {
		const bytes = new Uint8Array(await file.arrayBuffer());
		const attachment = await saveAttachmentFile({
			userId,
			filename: file.name,
			mimeType: file.type || "application/octet-stream",
			bytes,
		});
		await conversationRepository.createAttachment(userId, attachment);
		return c.json({
			id: attachment.id,
			kind: attachment.kind,
			mimeType: attachment.mimeType,
			filename: attachment.filename,
			byteSize: attachment.byteSize,
		});
	} catch (err) {
		if (err instanceof AttachmentError) {
			return c.json({ error: err.message }, 400);
		}
		throw err;
	}
});

// Serve an attachment's bytes back (composer/message previews).
attachmentRoutes.get("/:id", async (c) => {
	const userId = await requireUserId(c.req.raw);
	if (!userId) return c.json({ error: "unauthorized" }, 401);

	let attachment: Awaited<
		ReturnType<typeof conversationRepository.getAttachment>
	>;
	try {
		attachment = await conversationRepository.getAttachment(
			userId,
			c.req.param("id"),
		);
	} catch {
		return c.json({ error: "not found" }, 404);
	}
	const bytes = await readAttachmentBytes(attachment.storageKey);
	return new Response(bytes as unknown as BodyInit, {
		headers: { "content-type": attachment.mimeType },
	});
});

// Remove an orphaned (never-sent) upload.
attachmentRoutes.delete("/:id", async (c) => {
	const userId = await requireUserId(c.req.raw);
	if (!userId) return c.json({ error: "unauthorized" }, 401);

	const result = await conversationRepository.removeOrphanAttachment(
		userId,
		c.req.param("id"),
	);
	if (result.storageKey)
		await deleteAttachmentFilesByStorageKey([result.storageKey]);
	return c.json({ removed: result.removed });
});

import { Hono } from "hono";
import { auth } from "../auth";
import {
	AttachmentError,
	readAttachment,
	removeOrphanAttachment,
	saveAttachment,
} from "./attachments";

export const attachmentRoutes = new Hono();

async function requireUserId(req: Request): Promise<string | null> {
	const session = await auth.api.getSession({ headers: req.headers });
	return session?.user?.id ?? null;
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
		const meta = await saveAttachment({
			userId,
			filename: file.name,
			mimeType: file.type || "application/octet-stream",
			bytes,
		});
		return c.json(meta);
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

	const found = await readAttachment(c.req.param("id"), userId);
	if (!found) return c.json({ error: "not found" }, 404);

	return new Response(found.bytes as unknown as BodyInit, {
		headers: { "content-type": found.row.mimeType },
	});
});

// Remove an orphaned (never-sent) upload.
attachmentRoutes.delete("/:id", async (c) => {
	const userId = await requireUserId(c.req.raw);
	if (!userId) return c.json({ error: "unauthorized" }, 401);

	const removed = await removeOrphanAttachment(c.req.param("id"), userId);
	return c.json({ removed });
});

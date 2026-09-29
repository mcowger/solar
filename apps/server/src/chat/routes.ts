import { Hono } from "hono";
import { z } from "zod";
import { getSolarSession } from "../auth";
import { conversationRepository } from "../conversations/repository";
import {
	piEditUserMessage,
	piRegenerateAssistantTurn,
	piSendMessage,
	piStopGeneration,
	piStream,
} from "../pi/engine";
import { piGenerations } from "../pi/generation";
import { piFindEntryOwner } from "../pi/turns";
import { reverseGeocode } from "./location";
import { SKILL_NAME_PATTERN } from "./skills";

export const chatRoutes = new Hono();

const chatPostSchema = z.object({
	conversationId: z.string().min(1),
	text: z.string().optional().default(""),
	attachmentIds: z.array(z.string()).optional(),
	userLocation: z.unknown().optional(),
	skillName: z.string().max(64).regex(SKILL_NAME_PATTERN).optional(),
});

interface AuthenticatedUser {
	id: string;
	isAdmin: boolean;
}

async function requireUser(req: Request): Promise<AuthenticatedUser | null> {
	const principal = await getSolarSession(req.headers);
	if (!principal) return null;
	return { id: principal.user.id, isAdmin: principal.user.role === "admin" };
}

const sseHeaders = {
	"content-type": "text/event-stream",
	"cache-control": "no-cache",
	connection: "keep-alive",
};

export interface UserLocation {
	timeZone?: string;
	latitude?: number;
	longitude?: number;
	accuracy?: number;
	timestamp?: number;
}

function parseUserLocation(value: unknown): UserLocation | undefined {
	if (!value || typeof value !== "object") return undefined;
	const location = value as Record<string, unknown>;
	const timeZone =
		typeof location.timeZone === "string" ? location.timeZone : undefined;
	const latitude =
		typeof location.latitude === "number" &&
		Number.isFinite(location.latitude) &&
		location.latitude >= -90 &&
		location.latitude <= 90
			? location.latitude
			: undefined;
	const longitude =
		typeof location.longitude === "number" &&
		Number.isFinite(location.longitude) &&
		location.longitude >= -180 &&
		location.longitude <= 180
			? location.longitude
			: undefined;
	const accuracy =
		typeof location.accuracy === "number" &&
		Number.isFinite(location.accuracy) &&
		location.accuracy >= 0
			? location.accuracy
			: undefined;
	const timestamp =
		typeof location.timestamp === "number" &&
		Number.isFinite(location.timestamp)
			? location.timestamp
			: undefined;
	return timeZone || latitude !== undefined || longitude !== undefined
		? { timeZone, latitude, longitude, accuracy, timestamp }
		: undefined;
}

async function ownsConversation(
	userId: string,
	conversationId: string,
): Promise<boolean> {
	try {
		await conversationRepository.getConversation(userId, conversationId);
		return true;
	} catch {
		return false;
	}
}

// Send a message: append the user turn, start a decoupled generation in the
// conversation's pi process, stream it via the returned messageId's SSE.
chatRoutes.post("/", async (c) => {
	const user = await requireUser(c.req.raw);
	if (!user) return c.json({ error: "unauthorized" }, 401);

	let input: z.infer<typeof chatPostSchema>;
	try {
		input = chatPostSchema.parse(await c.req.json());
	} catch {
		return c.json({ error: "invalid request body" }, 400);
	}
	const { conversationId, text, attachmentIds, userLocation, skillName } =
		input;
	if (!text.trim() && !attachmentIds?.length && !skillName) {
		return c.json(
			{ error: "conversationId and text or an attachment are required" },
			400,
		);
	}
	if (!(await ownsConversation(user.id, conversationId)))
		return c.json({ error: "conversation not found" }, 404);
	try {
		const location = await reverseGeocode(parseUserLocation(userLocation));
		const messageId = await piSendMessage({
			userId: user.id,
			isAdmin: user.isAdmin,
			conversationId,
			text,
			attachmentIds,
			skillName,
			userLocation: location,
		});
		return c.json({ messageId }, 202);
	} catch (error) {
		if (error instanceof Error && error.message === "skill not found")
			return c.json({ error: "skill not found" }, 404);
		throw error;
	}
});

// Edit a user message: branch the pi session at the target's parent and send
// the amended prompt (the abandoned path stays on disk, inert).
chatRoutes.post("/edit", async (c) => {
	const user = await requireUser(c.req.raw);
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const { messageId, text, userLocation } = (await c.req.json()) as {
		messageId: string;
		text: string;
		userLocation?: unknown;
	};
	if (!messageId || !text?.trim()) {
		return c.json({ error: "messageId and text are required" }, 400);
	}
	const owner = await piFindEntryOwner(user.id, messageId);
	if (owner?.role !== "user")
		return c.json({ error: "message not found" }, 404);
	const assistantMessageId = await piEditUserMessage({
		userId: user.id,
		isAdmin: user.isAdmin,
		conversationId: owner.conversationId,
		targetTurnId: messageId,
		text,
		userLocation: await reverseGeocode(parseUserLocation(userLocation)),
	});
	return c.json({ messageId: assistantMessageId }, 202);
});

// Regenerate a reply. assistant-ui's onReload passes either the assistant
// entry or its parent user entry; the engine accepts both.
chatRoutes.post("/regenerate", async (c) => {
	const user = await requireUser(c.req.raw);
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const { messageId, userLocation } = (await c.req.json()) as {
		messageId: string;
		userLocation?: unknown;
	};
	if (!messageId) return c.json({ error: "messageId required" }, 400);
	const owner = await piFindEntryOwner(user.id, messageId);
	if (!owner) return c.json({ error: "message not found" }, 404);
	const assistantMessageId = await piRegenerateAssistantTurn({
		userId: user.id,
		isAdmin: user.isAdmin,
		conversationId: owner.conversationId,
		targetTurnId: messageId,
		userLocation: await reverseGeocode(parseUserLocation(userLocation)),
	});
	return c.json({ messageId: assistantMessageId }, 202);
});

// Resume streaming an in-progress (or just-finished) generation after reconnect.
chatRoutes.get("/stream", async (c) => {
	const user = await requireUser(c.req.raw);
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const messageId = c.req.query("messageId");
	if (!messageId) return c.json({ error: "messageId required" }, 400);
	if (!piGenerations.owns(user.id, messageId))
		return c.json({ error: "message not found" }, 404);
	return new Response(
		piStream(
			messageId,
			Number(c.req.header("last-event-id") ?? c.req.query("lastEventId") ?? 0),
		),
		{ headers: sseHeaders },
	);
});

// Explicit user Stop — the only signal that cancels a generation.
chatRoutes.post("/stop", async (c) => {
	const user = await requireUser(c.req.raw);
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const { messageId } = (await c.req.json()) as { messageId: string };
	if (!messageId) return c.json({ error: "messageId required" }, 400);
	return c.json({ stopped: await piStopGeneration(user.id, messageId) });
});

// force-stop is the same stop under pi (no orphaned placeholders exist).
chatRoutes.post("/force-stop", async (c) => {
	const user = await requireUser(c.req.raw);
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const { messageId } = (await c.req.json()) as { messageId: string };
	if (!messageId) return c.json({ error: "messageId required" }, 400);
	return c.json({ stopped: await piStopGeneration(user.id, messageId) });
});

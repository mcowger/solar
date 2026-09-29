import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { piSessionDir } from "./config";

/** Marker appended to user-message text instead of inlining attachment bytes. */
export function attachmentMarker(ids: string[]): string {
	return `<solar-attachments ids="${ids.join(",")}"/>`;
}

/** A completed pi session exists for this conversation → route to pi engine. */
export function isPiSessionReady(conversationId: string): boolean {
	const dir = piSessionDir(conversationId);
	if (!existsSync(dir)) return false;
	try {
		return readdirSync(dir).some((name) => name.endsWith(".jsonl"));
	} catch {
		return false;
	}
}

/** The single session file of a conversation (after first spawn/prompt). */
export function piSessionFile(conversationId: string): string | null {
	const dir = piSessionDir(conversationId);
	if (!existsSync(dir)) return null;
	const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
	return file ? join(dir, file) : null;
}

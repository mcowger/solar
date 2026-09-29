/**
 * One-shot pre-029 backfill: replays archived conversation transcripts
 * (v2_conversation_message + compactions + attachment markers) into pi
 * session files, so the 029 migration can drop the archive tables without
 * losing history.
 *
 * Run BEFORE starting a server build that includes 029, with the same
 * environment as the server:
 *
 *   DATABASE_PATH=/data/solar.db SOLAR_PI_AGENT_DIR=/data/pi-agent \
 *     bun run scripts/import-archive-to-pi.ts [--dry-run] [--user <id>]
 *
 * Idempotent: conversations that already have a pi session are skipped.
 * If the archive tables are already gone (029 applied), it exits 0 with
 * nothing to do. Exits 1 if any conversation fails verification, leaving
 * that conversation untouched for a retry.
 */
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { db, sqlite } from "../src/db/index.ts";
import { ensurePiDirs, piCwdDir, piSessionDir } from "../src/pi/config.ts";
import { attachmentMarker } from "../src/pi/sessions.ts";

const { values } = parseArgs({
	options: {
		"dry-run": { type: "boolean", default: false },
		user: { type: "string" },
	},
});
const DRY_RUN = values["dry-run"] ?? false;
const ONLY_USER = values.user as string | undefined;

function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return (message.content as Array<{ type: string; text?: string }>)
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n")
		.trim();
}

function stripMarkers(text: string): string {
	return text.replace(/<solar-attachments\s+ids="[^"]*"\s*\/>/g, "").trim();
}

function isReady(conversationId: string): boolean {
	const dir = piSessionDir(conversationId);
	if (!existsSync(dir)) return false;
	try {
		return readdirSync(dir).some((n) => n.endsWith(".jsonl"));
	} catch {
		return false;
	}
}

interface ArchiveMessage {
	id: string;
	messageJson: string;
	status: string;
}

const archiveTables = new Set(
	(
		sqlite
			.query("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all() as Array<{
			name: string;
		}>
	).map((row) => row.name),
);
if (!archiveTables.has("v2_conversation_message")) {
	console.log("Archive tables are gone (029 applied); nothing to import.");
	process.exit(0);
}

let query = "SELECT id, userId, title FROM v2_conversation";
const params: string[] = [];
if (ONLY_USER) {
	query += " WHERE userId = ?";
	params.push(ONLY_USER);
}
const convos = sqlite.query(query).all(...params) as Array<{
	id: string;
	userId: string;
	title: string;
}>;

let already = 0;
let empty = 0;
let imported = 0;
const failed: string[] = [];

for (const convo of convos) {
	if (isReady(convo.id)) {
		already++;
		continue;
	}
	const messages = sqlite
		.query(
			"SELECT id, messageJson, status FROM v2_conversation_message " +
				"WHERE conversationId = ? AND status NOT IN ('pending', 'streaming') " +
				"ORDER BY ordinal",
		)
		.all(convo.id) as ArchiveMessage[];
	if (messages.length === 0) {
		empty++;
		continue;
	}
	if (DRY_RUN) {
		imported++;
		continue;
	}
	const bindings = sqlite
		.query(
			"SELECT b.messageId, b.attachmentId FROM v2_message_attachment b " +
				"JOIN v2_conversation_message m ON m.id = b.messageId " +
				"WHERE m.conversationId = ?",
		)
		.all(convo.id) as Array<{ messageId: string; attachmentId: string }>;
	const idsByMessage = new Map<string, string[]>();
	for (const b of bindings) {
		idsByMessage.set(b.messageId, [
			...(idsByMessage.get(b.messageId) ?? []),
			b.attachmentId,
		]);
	}
	const compactions = sqlite
		.query(
			"SELECT id, lastMessageId, replacementMessagesJson, tokensBefore, tokensAfter " +
				"FROM v2_context_compaction WHERE conversationId = ?",
		)
		.all(convo.id) as Array<{
		id: string;
		lastMessageId: string;
		replacementMessagesJson: string;
		tokensBefore: number | null;
		tokensAfter: number | null;
	}>;

	ensurePiDirs();
	mkdirSync(piCwdDir(convo.id), { recursive: true });
	const sessionDir = piSessionDir(convo.id);
	const tmpDir = `${sessionDir}.importing-${randomUUID()}`;
	rmSync(tmpDir, { recursive: true, force: true });
	mkdirSync(tmpDir, { recursive: true });
	try {
		const manager = SessionManager.create(piCwdDir(convo.id), tmpDir, {
			id: convo.id,
		});
		const entryByMsg = new Map<string, string>();
		for (const m of messages) {
			const message = JSON.parse(m.messageJson) as Message;
			const ids = idsByMessage.get(m.id) ?? [];
			let toAppend: Message = message;
			if (message.role === "user" && ids.length > 0) {
				const base = messageText(message);
				const marker = attachmentMarker(ids);
				toAppend = {
					...message,
					content: base ? `${base}\n${marker}` : marker,
				};
			}
			entryByMsg.set(m.id, manager.appendMessage(toAppend as never));
		}
		for (const c of compactions) {
			const idx = messages.findIndex((m) => m.id === c.lastMessageId);
			if (idx < 0) continue;
			const firstKept = messages
				.slice(idx + 1)
				.map((m) => entryByMsg.get(m.id))
				.find(Boolean);
			if (!firstKept) continue;
			const summary = (JSON.parse(c.replacementMessagesJson) as Message[])
				.map(messageText)
				.filter(Boolean)
				.join("\n\n");
			manager.appendCompaction(
				summary,
				firstKept,
				c.tokensBefore ?? 0,
				{ solarCompactionId: c.id },
				false,
				c.tokensBefore && c.tokensAfter
					? {
							input: c.tokensBefore,
							output: c.tokensAfter,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: c.tokensBefore + c.tokensAfter,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						}
					: undefined,
			);
		}
		if (convo.title && convo.title !== "New conversation") {
			manager.appendSessionInfo(convo.title);
		}
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("import produced no session file");
		const reopened = SessionManager.open(sessionFile, tmpDir).getEntries();
		const texts = new Set(
			reopened
				.filter((e) => e.type === "message")
				.map((e) =>
					stripMarkers(messageText((e as { message: Message }).message)),
				),
		);
		for (const m of messages) {
			const expected = messageText(JSON.parse(m.messageJson) as Message);
			if (!expected) continue;
			if (![...texts].some((t) => t.includes(expected)))
				throw new Error(`message ${m.id} did not round-trip`);
		}
		mkdirSync(dirname(sessionDir), { recursive: true });
		renameSync(tmpDir, sessionDir);
		imported++;
	} catch (error) {
		rmSync(tmpDir, { recursive: true, force: true });
		failed.push(
			`${convo.id}: ${error instanceof Error ? error.message : error}`,
		);
	}
}

console.log(
	JSON.stringify({ already, empty, imported, failed, dryRun: DRY_RUN }),
);
await db.destroy();
if (failed.length > 0) process.exit(1);

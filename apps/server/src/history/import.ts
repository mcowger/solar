import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { db, sqlite } from "../db";
import { ensurePiDirs, piCwdDir, piSessionDir } from "../pi/config";
import { HISTORY_BUNDLE_VERSION, type HistoryBundle } from "./bundle";

export class HistoryImportValidationError extends Error {}

export interface ImportWarning {
	code: "attachment_bytes_unavailable" | "binding_dropped" | "folder_dropped";
}

export interface HistoryImportPlan {
	bundle: HistoryBundle;
	targetUserId: string;
	remap: boolean;
	idMap: Record<string, string>;
	warnings: ImportWarning[];
}

function mapped(plan: HistoryImportPlan, id: string | null): string | null {
	if (id === null) return null;
	return plan.remap ? (plan.idMap[id] ?? id) : id;
}

export async function planHistoryImport(
	bundle: HistoryBundle,
	targetUserId: string,
	options: { remap?: boolean } = {},
): Promise<HistoryImportPlan> {
	if (!bundle || typeof bundle !== "object")
		throw new HistoryImportValidationError("history bundle is invalid");
	if (bundle.version !== HISTORY_BUNDLE_VERSION)
		throw new HistoryImportValidationError(
			`unsupported history bundle version (got ${String((bundle as { version?: unknown }).version)}, want ${HISTORY_BUNDLE_VERSION}); ` +
				"re-export from the source instance",
		);
	const target = sqlite
		.query("SELECT id FROM user WHERE id = ?")
		.get(targetUserId) as { id: string } | null;
	if (!target)
		throw new HistoryImportValidationError("target user does not exist");
	const conversation = bundle.conversation;
	if (!conversation || typeof conversation.id !== "string")
		throw new HistoryImportValidationError(
			"history bundle has no conversation",
		);
	if (!Array.isArray(bundle.messages))
		throw new HistoryImportValidationError("history bundle has no messages");

	const remap = options.remap ?? false;
	const idMap: Record<string, string> = {};
	if (remap) {
		for (const id of [
			conversation.id,
			...(bundle.folder ? [bundle.folder.id] : []),
			...(bundle.tags ?? []).map((tag) => tag.id),
			...(bundle.attachments ?? []).map((attachment) => attachment.id),
		]) {
			idMap[id] = randomUUID();
		}
	} else {
		const collisions: string[] = [];
		const exists = (table: string, id: string) =>
			Boolean(sqlite.query(`SELECT id FROM "${table}" WHERE id = ?`).get(id));
		if (await exists("conversation", conversation.id))
			collisions.push(`conversation ${conversation.id}`);
		if (bundle.folder && (await exists("folder", bundle.folder.id)))
			collisions.push(`folder ${bundle.folder.id}`);
		for (const tag of bundle.tags ?? []) {
			if (await exists("tag", tag.id)) collisions.push(`tag ${tag.id}`);
		}
		for (const attachment of bundle.attachments ?? []) {
			if (await exists("attachment", attachment.id))
				collisions.push(`attachment ${attachment.id}`);
		}
		if (collisions.length > 0)
			throw new HistoryImportValidationError(
				`import collides with existing rows (${collisions.join(", ")}); retry with remap`,
			);
	}

	const warnings: ImportWarning[] = [];
	if ((bundle.attachments ?? []).length > 0)
		warnings.push({ code: "attachment_bytes_unavailable" });
	return { bundle, targetUserId, remap, idMap, warnings };
}

export async function executeHistoryImport(
	plan: HistoryImportPlan,
): Promise<{ conversationId: string; warnings: ImportWarning[] }> {
	const { bundle, targetUserId } = plan;
	const warnings = [...plan.warnings];
	const conversationId = mapped(plan, bundle.conversation.id)!;
	const folderId =
		bundle.folder && bundle.conversation.folderId === bundle.folder.id
			? mapped(plan, bundle.folder.id)!
			: null;
	if (bundle.conversation.folderId && !folderId)
		warnings.push({ code: "folder_dropped" });

	const attachmentIdMap = new Map<string, string>();
	for (const attachment of bundle.attachments ?? []) {
		attachmentIdMap.set(attachment.id, mapped(plan, attachment.id)!);
	}

	await db.transaction().execute(async (trx) => {
		if (bundle.folder && folderId) {
			await trx
				.insertInto("folder")
				.values({
					id: folderId,
					userId: targetUserId,
					name: bundle.folder.name,
					createdAt: bundle.folder.createdAt,
				})
				.execute();
		}
		for (const tag of bundle.tags ?? []) {
			const tagId = mapped(plan, tag.id)!;
			await trx
				.insertInto("tag")
				.values({
					id: tagId,
					userId: targetUserId,
					name: tag.name,
					createdAt: tag.createdAt,
				})
				.execute();
			await trx
				.insertInto("conversation_tag")
				.values({ conversationId, tagId })
				.execute();
		}
		const meta = bundle.conversation;
		await trx
			.insertInto("conversation")
			.values({
				id: conversationId,
				userId: targetUserId,
				title: meta.title,
				folderId,
				provider: meta.provider,
				endpointId: meta.endpointId,
				modelId: meta.modelId,
				modelApi: meta.modelApi,
				systemPrompt: meta.systemPrompt,
				reasoningEffort: meta.reasoningEffort,
				reasoningSummary: meta.reasoningSummary ?? 0,
				verbosity: meta.verbosity,
				displayMode: meta.displayMode,
				autoExecuteTools: meta.autoExecuteTools ?? 1,
				createdAt: meta.createdAt,
				updatedAt: meta.updatedAt,
			})
			.execute();
		for (const attachment of bundle.attachments ?? []) {
			await trx
				.insertInto("attachment")
				.values({
					id: attachmentIdMap.get(attachment.id)!,
					userId: targetUserId,
					storageKey: plan.remap
						? `${attachmentIdMap.get(attachment.id)!}/${attachment.storageKey}`
						: attachment.storageKey,
					filename: attachment.filename,
					mimeType: attachment.mimeType,
					kind: attachment.kind,
					byteSize: attachment.byteSize,
					sha256: attachment.sha256,
					width: attachment.width,
					height: attachment.height,
					pageCount: attachment.pageCount,
					createdAt: attachment.createdAt,
				})
				.execute();
		}
	});

	// Build the pi session from the bundle messages. Entry ids are new, so
	// attachment bindings are remapped after the session exists.
	const entryIdByMessageId = new Map<string, string>();
	if (bundle.messages.length > 0) {
		ensurePiDirs();
		mkdirSync(piCwdDir(conversationId), { recursive: true });
		const sessionDir = piSessionDir(conversationId);
		const tmpDir = `${sessionDir}.importing-${randomUUID()}`;
		rmSync(tmpDir, { recursive: true, force: true });
		mkdirSync(tmpDir, { recursive: true });
		try {
			const manager = SessionManager.create(piCwdDir(conversationId), tmpDir, {
				id: conversationId,
			});
			for (const record of bundle.messages) {
				const entryId = manager.appendMessage(record.message as never);
				entryIdByMessageId.set(record.id, entryId);
			}
			if (
				bundle.conversation.title &&
				bundle.conversation.title !== "New conversation"
			) {
				manager.appendSessionInfo(bundle.conversation.title);
			}
			const sessionFilePath = manager.getSessionFile();
			if (!sessionFilePath) throw new Error("import produced no session file");
			mkdirSync(dirname(sessionDir), { recursive: true });
			renameSync(tmpDir, sessionDir);
		} catch (error) {
			rmSync(tmpDir, { recursive: true, force: true });
			await db
				.deleteFrom("conversation")
				.where("id", "=", conversationId)
				.execute();
			throw error;
		}
	}

	const bindings = (bundle.bindings ?? []).flatMap((binding) => {
		const messageId = entryIdByMessageId.get(binding.messageId);
		const attachmentId = attachmentIdMap.get(binding.attachmentId);
		if (!messageId || !attachmentId) {
			warnings.push({ code: "binding_dropped" });
			return [];
		}
		return [{ messageId, attachmentId, ordinal: binding.ordinal }];
	});
	if (bindings.length > 0) {
		await db.transaction().execute(async (trx) => {
			await trx
				.insertInto("message_attachment")
				.values(bindings)
				.onConflict((oc) => oc.doNothing())
				.execute();
		});
	}
	return { conversationId, warnings };
}

/**
 * Presets and per-user defaults store a model selection (provider + endpoint +
 * model id + api) rather than a foreign key, so a model sync that removes or
 * renames a model silently strands them. `findStaleModelReferences` reports
 * those rows whenever a provider's model list changes, so admins see the
 * breakage instead of hearing about a dead New Chat button later.
 *
 * "Stale" means the same thing it does at use time: the model must be in the
 * provider's allowlist, on the endpoint the reference names, and visible to
 * whoever uses the reference (a shared preset is used by everyone, so it needs
 * a public model; a personal preset only needs to be visible to its owner).
 */
import { sql } from "kysely";
import { db } from "../db";
import { visibleTo } from "./allowlist";

/** The fields of a provider's allowlist entry that availability uses. */
export interface ConfiguredModel {
	id: string;
	endpointId: string;
	api: string;
	visibility: string;
}

export interface StaleModelReference {
	kind: "preset" | "user-default";
	/** Preset id, or the user id for a stale personal default. */
	id: string;
	/** Preset name; for a personal default, the user id until resolved. */
	label: string;
	modelId: string;
}

interface Reference {
	provider: string;
	/** `null` means "any endpoint", as `sameSelection` treats it. */
	endpointId: string | null;
	modelId: string;
	api: string;
}

function availableTo(
	configured: ConfiguredModel[],
	reference: Reference,
	isAdmin: boolean,
): boolean {
	return configured.some(
		(model) =>
			model.id === reference.modelId &&
			model.api === reference.api &&
			(!reference.endpointId || model.endpointId === reference.endpointId) &&
			visibleTo(model.visibility as "public" | "private" | "hidden", isAdmin),
	);
}

/**
 * Rows in `preset` and `user_setting` that can no longer resolve against this
 * provider's model list. `configured` is the post-sync list, so this runs
 * before the provider write while the provider lock is held.
 */
export async function findStaleModelReferences(
	provider: string,
	configured: ConfiguredModel[],
): Promise<StaleModelReference[]> {
	const stale: StaleModelReference[] = [];

	// Better Auth owns `user` (it is not in the hand-written Kysely schema), so
	// its role column is read through raw SQL.
	const presets = await db
		.selectFrom("preset")
		.select([
			"id",
			"name",
			"scope",
			"endpointId",
			"modelId",
			"modelApi",
			"provider",
			sql<
				string | null
			>`(select role from user where user.id = preset.userId)`.as("ownerRole"),
		])
		.where("provider", "=", provider)
		.execute();
	for (const preset of presets) {
		// A shared preset must work for everyone, so only a public model counts;
		// a personal preset only has to be visible to its owner.
		const isAdmin = preset.scope !== "shared" && preset.ownerRole === "admin";
		if (
			availableTo(
				configured,
				{
					provider: preset.provider,
					endpointId: preset.endpointId ?? preset.modelApi,
					modelId: preset.modelId,
					api: preset.modelApi,
				},
				isAdmin,
			)
		)
			continue;
		stale.push({
			kind: "preset",
			id: preset.id,
			label: preset.name,
			modelId: preset.modelId,
		});
	}

	const defaults = await db
		.selectFrom("user_setting")
		.select([
			"userId",
			"defaultProvider as provider",
			"defaultEndpointId as endpointId",
			"defaultModelId as modelId",
			"defaultApi as api",
			sql<
				string | null
			>`(select role from user where user.id = user_setting.userId)`.as(
				"ownerRole",
			),
		])
		.where("defaultProvider", "=", provider)
		.where("defaultModelId", "is not", null)
		.execute();
	for (const row of defaults) {
		if (!row.modelId || !row.provider || !row.api) continue;
		if (
			availableTo(
				configured,
				{
					provider: row.provider,
					endpointId: row.endpointId,
					modelId: row.modelId,
					api: row.api,
				},
				row.ownerRole === "admin",
			)
		)
			continue;
		stale.push({
			kind: "user-default",
			id: row.userId,
			// Stored without PII; `resolveStaleReferenceLabels` fills in emails.
			label: row.userId,
			modelId: row.modelId,
		});
	}

	return stale;
}

/** Fills in account emails for personal defaults, for the admin UI. */
export async function resolveStaleReferenceLabels(
	references: StaleModelReference[],
): Promise<StaleModelReference[]> {
	const userIds = [
		...new Set(
			references
				.filter((reference) => reference.kind === "user-default")
				.map((reference) => reference.id),
		),
	];
	if (userIds.length === 0) return references;
	const result = await sql<{ id: string; email: string }>`
		select id, email from user where id in (${sql.join(userIds)})
	`.execute(db);
	const emailById = new Map(result.rows.map((row) => [row.id, row.email]));
	return references.map((reference) =>
		reference.kind === "user-default"
			? { ...reference, label: emailById.get(reference.id) ?? reference.id }
			: reference,
	);
}

import { z } from "zod";
import { db } from "../db";

const CONTEXT_GLOBAL_SETTINGS_KEY = "context_management_global_v1";
export const CONTEXT_GLOBAL_SETTINGS_VERSION = 1;

export const DEFAULT_CONTEXT_SUMMARY_PROMPT = `Summarize the conversation for a future model. Preserve the user's goals, decisions, constraints, unresolved questions, and information needed to continue accurately. Do not add commentary.`;

export const contextGlobalSettingsSchema = z.object({
	version: z.literal(CONTEXT_GLOBAL_SETTINGS_VERSION),
	enabled: z.boolean(),
	summaryPromptOverride: z.string().trim().min(1).max(20_000).nullable(),
});

export const contextGlobalSettingsInputSchema =
	contextGlobalSettingsSchema.omit({ version: true });

export type ContextGlobalSettings = z.infer<typeof contextGlobalSettingsSchema>;

export const DEFAULT_CONTEXT_GLOBAL_SETTINGS: ContextGlobalSettings = {
	version: CONTEXT_GLOBAL_SETTINGS_VERSION,
	enabled: true,
	summaryPromptOverride: null,
};

export function parseContextGlobalSettings(
	value: string | null | undefined,
): ContextGlobalSettings {
	if (!value) return DEFAULT_CONTEXT_GLOBAL_SETTINGS;
	try {
		const parsed = contextGlobalSettingsSchema.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : DEFAULT_CONTEXT_GLOBAL_SETTINGS;
	} catch {
		return DEFAULT_CONTEXT_GLOBAL_SETTINGS;
	}
}

/** Global controls remain in app_meta because policy inheritance has no global scope. */
export async function getContextGlobalSettings(): Promise<ContextGlobalSettings> {
	const row = await db
		.selectFrom("app_meta")
		.select("value")
		.where("key", "=", CONTEXT_GLOBAL_SETTINGS_KEY)
		.executeTakeFirst();
	return parseContextGlobalSettings(row?.value);
}

export async function setContextGlobalSettings(
	settings: ContextGlobalSettings,
): Promise<void> {
	const value = JSON.stringify(settings);
	await db
		.insertInto("app_meta")
		.values({ key: CONTEXT_GLOBAL_SETTINGS_KEY, value })
		.onConflict((oc) => oc.column("key").doUpdateSet({ value }))
		.execute();
}

import { z } from "zod";
import { db } from "../db";

const PASTE_SETTINGS_KEY = "large_paste_attachment_v1";
export const PASTE_SETTINGS_VERSION = 1;
export const DEFAULT_PASTE_SETTINGS = {
	version: PASTE_SETTINGS_VERSION as 1,
	enabled: true,
	lineThreshold: 20,
	byteThreshold: 5 * 1024,
};

export const pasteSettingsSchema = z.object({
	version: z.literal(PASTE_SETTINGS_VERSION),
	enabled: z.boolean(),
	lineThreshold: z.number().int().min(1).max(100_000),
	byteThreshold: z
		.number()
		.int()
		.min(1)
		.max(20 * 1024 * 1024),
});
export const pasteSettingsInputSchema = pasteSettingsSchema.omit({
	version: true,
});
export type PasteSettings = z.infer<typeof pasteSettingsSchema>;

export function parsePasteSettings(
	value: string | null | undefined,
): PasteSettings {
	if (!value) return DEFAULT_PASTE_SETTINGS;
	try {
		const parsed = pasteSettingsSchema.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : DEFAULT_PASTE_SETTINGS;
	} catch {
		return DEFAULT_PASTE_SETTINGS;
	}
}

export async function getPasteSettings(): Promise<PasteSettings> {
	const row = await db
		.selectFrom("app_meta")
		.select("value")
		.where("key", "=", PASTE_SETTINGS_KEY)
		.executeTakeFirst();
	return parsePasteSettings(row?.value);
}

export async function setPasteSettings(settings: PasteSettings): Promise<void> {
	const value = JSON.stringify(settings);
	await db
		.insertInto("app_meta")
		.values({ key: PASTE_SETTINGS_KEY, value })
		.onConflict((oc) => oc.column("key").doUpdateSet({ value }))
		.execute();
}

/** One allowlist entry stored in `provider_config.enabledModels`. */
export type ModelVisibility = "public" | "private";

export interface AllowlistEntry {
  id: string;
  api: string;
  visibility: ModelVisibility;
}

export function parseAllowlist(json: string): AllowlistEntry[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry.id !== "string" || typeof entry.api !== "string") {
        return [];
      }
      return [{
        id: entry.id,
        api: entry.api,
        visibility: entry.visibility === "private" ? "private" : "public",
      }];
    });
  } catch {
    return [];
  }
}

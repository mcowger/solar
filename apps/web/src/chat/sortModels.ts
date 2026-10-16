/** Shape every model list in the UI shares (model.available rows). */
interface NamedModel {
	name: string;
	modelId: string;
}

const collator = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: "base",
});

/** Hyphens, underscores and spaces separate words alike in model names. */
function sortKey(value: string) {
	return value.replace(/[-_\s]+/g, " ").trim();
}

/**
 * A copy of `models` sorted A to Z by display name for model dropdowns:
 * case-insensitive, hyphens and spaces alike ("claude-haiku" before "Claude
 * Sonnet"), numbers compared by value (glm-9 before glm-10), ties broken on
 * the model id. The server's order is left alone (its first model is the
 * last-resort fallback).
 */
export function sortModelsByName<T extends NamedModel>(
	models: readonly T[],
): T[] {
	return [...models].sort(
		(a, b) =>
			collator.compare(sortKey(a.name), sortKey(b.name)) ||
			collator.compare(a.modelId, b.modelId),
	);
}

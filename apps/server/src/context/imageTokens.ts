export interface ImageTokenModel {
	provider: string;
	modelId: string;
}

const PATCH_SIZE_OPENAI = 32;
const PATCH_SIZE_CLAUDE = 28;
const CLAUDE_STANDARD_TOKEN_LIMIT = 1_568;
const CLAUDE_HIGH_RESOLUTION_TOKEN_LIMIT = 4_784;
const GEMINI_SMALL_IMAGE_EDGE = 384;
const GEMINI_TILE_TOKENS = 258;
const FALLBACK_IMAGE_TOKENS = CLAUDE_HIGH_RESOLUTION_TOKEN_LIMIT;

function patches(width: number, height: number, size: number): number {
	return Math.ceil(width / size) * Math.ceil(height / size);
}

function isClaudeHighResolution(modelId: string): boolean {
	return /(?:opus-4[.-](?:7|8)|sonnet-5|fable-5|mythos-5)/.test(
		modelId.toLowerCase(),
	);
}

export function claudeVisualTokenLimit(modelId: string): number {
	return isClaudeHighResolution(modelId)
		? CLAUDE_HIGH_RESOLUTION_TOKEN_LIMIT
		: CLAUDE_STANDARD_TOKEN_LIMIT;
}

function geminiTokens(width: number, height: number): number {
	if (width <= GEMINI_SMALL_IMAGE_EDGE && height <= GEMINI_SMALL_IMAGE_EDGE)
		return GEMINI_TILE_TOKENS;
	const cropUnit = Math.floor(Math.min(width, height) / 1.5);
	return (
		Math.ceil(width / cropUnit) *
		Math.ceil(height / cropUnit) *
		GEMINI_TILE_TOKENS
	);
}

export function estimateImageTokens(
	image: { width: number | null; height: number | null },
	model: ImageTokenModel,
): number {
	if (!image.width || !image.height) return FALLBACK_IMAGE_TOKENS;

	const provider = model.provider.toLowerCase();
	const modelId = model.modelId.toLowerCase();
	if (provider === "openai" && modelId.includes("gpt-5.6"))
		return patches(image.width, image.height, PATCH_SIZE_OPENAI);
	if (provider === "anthropic" || modelId.includes("claude")) {
		const limit = claudeVisualTokenLimit(model.modelId);
		return Math.min(
			patches(image.width, image.height, PATCH_SIZE_CLAUDE),
			limit,
		);
	}
	if (provider === "google" || modelId.includes("gemini"))
		return geminiTokens(image.width, image.height);
	return patches(image.width, image.height, PATCH_SIZE_CLAUDE);
}

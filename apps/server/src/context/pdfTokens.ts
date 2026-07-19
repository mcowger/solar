import { claudeVisualTokenLimit } from "./imageTokens";

const CHARACTERS_PER_TOKEN = 4;
const FALLBACK_PDF_TOKENS = 4_784;
const DEFAULT_TEXT_TOKENS_PER_PAGE = 3_000;

export function estimateClaudePdfTokens(
	pdf: {
		pageCount: number | null;
		extractedTextChars: number | null;
	},
	modelId: string,
): number {
	if (!pdf.pageCount) return FALLBACK_PDF_TOKENS;
	const textTokens =
		pdf.extractedTextChars === null
			? pdf.pageCount * DEFAULT_TEXT_TOKENS_PER_PAGE
			: Math.ceil(pdf.extractedTextChars / CHARACTERS_PER_TOKEN);
	return pdf.pageCount * claudeVisualTokenLimit(modelId) + textTokens;
}

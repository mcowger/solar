import mammoth from "mammoth";
import { openXlsx } from "openjsxl";
import { extractText, getDocumentProxy } from "unpdf";

const MAX_EXTRACTED_TEXT_CHARS = 100_000;

function truncate(text: string): string {
	if (text.length <= MAX_EXTRACTED_TEXT_CHARS) return text;
	return `${text.slice(0, MAX_EXTRACTED_TEXT_CHARS)}\n\n[Document text truncated at ${MAX_EXTRACTED_TEXT_CHARS.toLocaleString()} characters.]`;
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
	const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
	return result.value;
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
	const pdf = await getDocumentProxy(bytes);
	const { text } = await extractText(pdf, { mergePages: true });
	return text;
}

function csvCell(value: unknown): string {
	const text = value === null || value === undefined ? "" : String(value);
	return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function extractSpreadsheet(bytes: Uint8Array): Promise<string> {
	const workbook = await openXlsx(bytes);
	const sheets: string[] = [];
	for (const { name } of workbook.sheets) {
		const sheet = workbook.sheet(name);
		const rows: string[] = [];
		for await (const row of sheet.rows()) {
			rows.push(row.cells.map((cell) => csvCell(cell.value)).join(","));
		}
		sheets.push(`[Sheet: ${name}]\n${rows.join("\n")}`);
	}
	return sheets.join("\n\n");
}

export async function extractDocumentText(
	bytes: Uint8Array,
	mimeType: string,
): Promise<string> {
	const text =
		mimeType ===
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
			? await extractDocx(bytes)
			: mimeType === "application/pdf"
				? await extractPdf(bytes)
				: await extractSpreadsheet(bytes);
	return truncate(text);
}

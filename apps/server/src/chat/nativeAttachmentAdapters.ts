import type { NativeDocumentInput } from "./attachments";

interface ModelApiSelection {
	api: string;
}

export interface DocumentInputCapabilities {
	nativeMimeTypes: readonly string[];
	extractedTextMimeTypes: readonly string[];
}

export const FALLBACK_DOCUMENT_INPUT: DocumentInputCapabilities = {
	nativeMimeTypes: [],
	extractedTextMimeTypes: [
		"application/pdf",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	],
};

interface NativeAttachmentAdapter extends DocumentInputCapabilities {
	api: string;
	injectDocuments(payload: unknown, documents: NativeDocumentInput[]): unknown;
}

function documentsByMarker(documents: NativeDocumentInput[]) {
	return new Map(documents.map((document) => [document.marker, document]));
}

function injectOpenAIResponsesDocuments(
	payload: unknown,
	documents: NativeDocumentInput[],
) {
	const input = (payload as { input?: unknown }).input;
	if (!Array.isArray(input)) return payload;
	const byMarker = documentsByMarker(documents);
	for (const message of input as { content?: unknown }[]) {
		if (!Array.isArray(message.content)) continue;
		message.content = message.content.flatMap((part) => {
			const text = part as { type?: unknown; text?: unknown };
			const document =
				text.type === "input_text" && typeof text.text === "string"
					? byMarker.get(text.text)
					: undefined;
			return document
				? [
						{
							type: "input_file",
							filename: document.filename,
							file_data: `data:${document.mimeType};base64,${document.data}`,
						},
					]
				: [part];
		});
	}
	return payload;
}

function injectAnthropicDocuments(
	payload: unknown,
	documents: NativeDocumentInput[],
) {
	const messages = (payload as { messages?: unknown }).messages;
	if (!Array.isArray(messages)) return payload;
	const byMarker = documentsByMarker(documents);
	const documentBlock = (document: NativeDocumentInput) => ({
		type: "document",
		source: {
			type: "base64",
			media_type: document.mimeType,
			data: document.data,
		},
		title: document.filename,
	});
	for (const message of messages as { content?: unknown }[]) {
		if (typeof message.content === "string") {
			const document = byMarker.get(message.content);
			if (document) message.content = [documentBlock(document)];
			continue;
		}
		if (!Array.isArray(message.content)) continue;
		message.content = message.content.flatMap((part) => {
			const text = part as { type?: unknown; text?: unknown };
			const document =
				text.type === "text" && typeof text.text === "string"
					? byMarker.get(text.text)
					: undefined;
			return document ? [documentBlock(document)] : [part];
		});
	}
	return payload;
}

const adapters: NativeAttachmentAdapter[] = [
	{
		api: "openai-responses",
		nativeMimeTypes: [
			"application/pdf",
			"application/msword",
			"application/vnd.ms-excel",
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		],
		extractedTextMimeTypes: [],
		injectDocuments: injectOpenAIResponsesDocuments,
	},
	{
		api: "anthropic-messages",
		nativeMimeTypes: ["application/pdf"],
		extractedTextMimeTypes: [
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		],
		injectDocuments: injectAnthropicDocuments,
	},
];

export function nativeAttachmentAdapter(selection: ModelApiSelection) {
	return adapters.find((adapter) => adapter.api === selection.api);
}

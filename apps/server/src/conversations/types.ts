/**
 * Live conversation metadata records. Transcript history lives in pi session
 * JSONL under ${SOLAR_PI_AGENT_DIR}; these rows are identity, ownership,
 * model selection, and UI settings only.
 */
export interface ConversationRecord {
	id: string;
	userId: string;
	title: string;
	folderId: string | null;
	provider: string | null;
	endpointId: string | null;
	modelId: string | null;
	modelApi: string | null;
	systemPrompt: string | null;
	reasoningEffort: string | null;
	reasoningSummary: number;
	verbosity: string | null;
	autoExecuteTools: number;
	displayMode: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface ConversationListRecord extends ConversationRecord {
	tagIds: string[];
}

export interface AttachmentRecord {
	id: string;
	userId: string;
	storageKey: string;
	filename: string;
	mimeType: string;
	kind: string;
	byteSize: number;
	sha256: string;
	width: number | null;
	height: number | null;
	pageCount: number | null;
	createdAt: string;
}

export interface FolderRecord {
	id: string;
	userId: string;
	name: string;
	createdAt: string;
}

export interface TagRecord {
	id: string;
	userId: string;
	name: string;
	createdAt: string;
}

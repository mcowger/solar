import {
	type ContextPart,
	type ContextRecord,
	type TokenEstimator,
	estimateRecordsTokens,
	estimateTextTokens,
} from "./tokens";

export interface ContextAssemblyOptions {
	inputLimit: number;
	summary?: ContextRecord;
	firstTurnAttachmentTokens?: number;
	estimateTokens?: TokenEstimator;
}

export interface ContextAssembly {
	records: ContextRecord[];
	tokens: number;
	omittedRecordIds: string[];
	compactionRecords: ContextRecord[];
	omittedAttachments: ContextPart[];
	overBudget: boolean;
}

function capFirstUserAttachments(
	record: ContextRecord,
	cap: number,
	estimate: TokenEstimator,
) {
	let remaining = cap;
	const omittedAttachments: ContextPart[] = [];
	const content = record.content.filter((part) => {
		if (part.kind !== "attachment") return true;
		const tokens = part.tokenCount ?? estimate(part.text);
		if (tokens <= remaining) {
			remaining -= tokens;
			return true;
		}
		omittedAttachments.push(part);
		return false;
	});
	return {
		record:
			content.length === record.content.length
				? record
				: { ...record, content },
		omittedAttachments,
	};
}

/** Old completed reasoning is not durable context. Tool results stay with their transaction until the whole turn is compacted. */
export function filterCompletedPayloads(
	records: readonly ContextRecord[],
	retainedRecordIds: ReadonlySet<string> = new Set(),
): ContextRecord[] {
	return records.map((record) => {
		if (record.status !== "complete" || retainedRecordIds.has(record.id))
			return record;
		const content = record.content.filter((part) => part.kind !== "reasoning");
		return content.length === record.content.length
			? record
			: { ...record, content };
	});
}

function turnGroups(records: readonly ContextRecord[]): ContextRecord[][] {
	const groups: ContextRecord[][] = [];
	for (const record of records) {
		const last = groups.at(-1);
		if (record.role === "user" && last?.some((item) => item.role === "user"))
			groups.push([record]);
		else if (last) last.push(record);
		else groups.push([record]);
	}
	for (let index = 0; index < groups.length - 1; ) {
		const left = groups[index]!;
		const right = groups[index + 1]!;
		const transactions = new Set(
			left.flatMap((record) =>
				record.toolTransactionId ? [record.toolTransactionId] : [],
			),
		);
		if (
			right.some(
				(record) =>
					record.toolTransactionId &&
					transactions.has(record.toolTransactionId),
			)
		) {
			left.push(...right);
			groups.splice(index + 1, 1);
		} else index += 1;
	}
	return groups;
}

export function assembleContext(
	records: readonly ContextRecord[],
	options: ContextAssemblyOptions,
): ContextAssembly {
	if (options.inputLimit <= 0)
		throw new RangeError("inputLimit must be positive");
	const estimate = options.estimateTokens ?? estimateTextTokens;
	const currentUserIndex = records
		.map((record) => record.role)
		.lastIndexOf("user");
	const retainedIds = new Set(
		records.slice(Math.max(0, currentUserIndex)).map((record) => record.id),
	);
	const filtered = filterCompletedPayloads(records, retainedIds);
	const firstUserIndex = filtered.findIndex((record) => record.role === "user");
	const firstUser =
		firstUserIndex < 0
			? undefined
			: capFirstUserAttachments(
					filtered[firstUserIndex]!,
					options.firstTurnAttachmentTokens ?? 64_000,
					estimate,
				);
	const normalized = filtered.map((record, index) =>
		index === firstUserIndex && firstUser ? firstUser.record : record,
	);
	const pinnedIds = new Set(
		normalized.flatMap((record, index) =>
			record.role === "system" ||
			record.role === "developer" ||
			index === firstUserIndex
				? [record.id]
				: [],
		),
	);
	const groups = turnGroups(normalized);
	const currentGroup = groups.find(
		(group) =>
			currentUserIndex >= 0 &&
			group.some((record) => record.id === records[currentUserIndex]!.id),
	);
	const selectedIds = new Set(pinnedIds);
	let used = estimateRecordsTokens(
		normalized.filter((record) => pinnedIds.has(record.id)),
		estimate,
	);
	if (options.summary)
		used += estimateRecordsTokens([options.summary], estimate);
	if (currentGroup) {
		currentGroup.forEach((record) => selectedIds.add(record.id));
		used += estimateRecordsTokens(
			currentGroup.filter((record) => !pinnedIds.has(record.id)),
			estimate,
		);
	}
	for (const group of groups.toReversed()) {
		if (
			group === currentGroup ||
			group.some((record) => pinnedIds.has(record.id))
		)
			continue;
		const tokens = estimateRecordsTokens(group, estimate);
		if (used + tokens > options.inputLimit) break;
		group.forEach((record) => selectedIds.add(record.id));
		used += tokens;
	}
	const pinned = normalized.filter(
		(record) => record.role === "system" || record.role === "developer",
	);
	const first = firstUser ? [firstUser.record] : [];
	const tail = normalized.filter(
		(record) => selectedIds.has(record.id) && !pinnedIds.has(record.id),
	);
	const output = [
		...pinned,
		...first,
		...(options.summary ? [options.summary] : []),
		...tail,
	];
	const compactionRecords = filtered.filter(
		(record) => !selectedIds.has(record.id),
	);
	if (firstUser?.omittedAttachments.length) {
		const omitted = new Set(
			firstUser.omittedAttachments.map((part) => part.id),
		);
		const firstForCompaction = filtered[firstUserIndex]!;
		const material = firstForCompaction.content
			.filter((part) => omitted.has(part.id))
			.map((part) => ({
				...part,
				kind: "text" as const,
				text: part.summary ?? `[Omitted attachment: ${part.text}]`,
				tokenCount: undefined,
			}));
		if (material.length) {
			compactionRecords.unshift({
				id: `${firstForCompaction.id}:omitted-attachments`,
				role: "user",
				status: "complete",
				content: material,
			});
		}
	}
	return {
		records: output,
		tokens: estimateRecordsTokens(output, estimate),
		omittedRecordIds: filtered
			.filter((record) => !selectedIds.has(record.id))
			.map((record) => record.id),
		compactionRecords,
		omittedAttachments: firstUser?.omittedAttachments ?? [],
		overBudget: estimateRecordsTokens(output, estimate) > options.inputLimit,
	};
}

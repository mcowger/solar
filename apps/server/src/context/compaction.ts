import { type ContextRecord, type TokenEstimator, estimateRecordsTokens } from "./tokens";

export interface StructuredSummary {
  goal: string;
  constraints: string[];
  decisions: string[];
  durableFacts: string[];
  progress: string[];
  unresolvedQuestions: string[];
  criticalExcerpts: string[];
  toolOutcomes: string[];
}

export interface SummaryChunkPlan {
  chunks: ContextRecord[][];
  oversizedTransactionIds: string[];
}

export function renderStructuredSummary(summary: StructuredSummary): string {
  const section = (title: string, values: string[]) => `## ${title}\n${values.length ? values.map((value) => `- ${value}`).join("\n") : "- None"}`;
  return [
    "# Rolling Context Summary",
    `## Goal\n${summary.goal || "None"}`,
    section("Constraints", summary.constraints),
    section("Decisions", summary.decisions),
    section("Durable Facts", summary.durableFacts),
    section("Progress", summary.progress),
    section("Unresolved Questions", summary.unresolvedQuestions),
    section("Critical Excerpts", summary.criticalExcerpts),
    section("Tool Outcomes", summary.toolOutcomes),
  ].join("\n\n");
}

export function buildRollingSummaryPrompt(previous: StructuredSummary | undefined, records: readonly ContextRecord[]): string {
  const prior = previous ? renderStructuredSummary(previous) : "No previous summary exists.";
  const transcript = records.map((record) => `${record.role}: ${record.content.map((part) => part.text).join("\n")}`).join("\n\n");
  return [
    "Update the rolling context summary. Preserve only durable, task-relevant information in every required section.",
    "Do not answer the conversation. Return only the exact structured summary format shown below.",
    "Previous summary:", prior, "New conversation material:", transcript,
  ].join("\n\n");
}

function transactionGroups(records: readonly ContextRecord[]): ContextRecord[][] {
  const groups: ContextRecord[][] = [];
  for (const record of records) {
    const previous = groups.at(-1);
    if (record.toolTransactionId && previous?.[0]?.toolTransactionId === record.toolTransactionId) previous.push(record);
    else groups.push([record]);
  }
  return groups;
}

export function planSummaryChunks(records: readonly ContextRecord[], taskModelInputLimit: number, reserveTokens: number, estimate?: TokenEstimator): SummaryChunkPlan {
  const limit = taskModelInputLimit - reserveTokens;
  if (limit <= 0) throw new RangeError("task model limit must exceed reserveTokens");
  const chunks: ContextRecord[][] = [];
  const oversizedTransactionIds: string[] = [];
  let chunk: ContextRecord[] = [];
  let tokens = 0;
  for (const group of transactionGroups(records)) {
    const groupTokens = estimateRecordsTokens(group, estimate);
    if (groupTokens > limit) {
      if (group[0]?.toolTransactionId) oversizedTransactionIds.push(group[0].toolTransactionId);
      continue;
    }
    if (tokens + groupTokens > limit && chunk.length > 0) {
      chunks.push(chunk);
      chunk = [];
      tokens = 0;
    }
    chunk.push(...group);
    tokens += groupTokens;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return { chunks, oversizedTransactionIds };
}

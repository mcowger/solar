import { describe, expect, test } from "bun:test";
import { assembleContext, filterCompletedPayloads } from "./assembler";
import { buildRollingSummaryPrompt, planSummaryChunks, renderStructuredSummary } from "./compaction";
import { CLAUDE_CONTEXT_POLICY, GPT_CONTEXT_POLICY, effectiveContextPolicy } from "./policy";
import { estimateRecordsTokens, type ContextRecord } from "./tokens";

const record = (id: string, role: ContextRecord["role"], text: string, extra: Partial<ContextRecord> = {}): ContextRecord => ({
  id, role, content: [{ kind: "text", text }], ...extra,
});

describe("context policy", () => {
  test("uses the persisted policy shape and reserves output before bounding input", () => {
    expect(effectiveContextPolicy({ provider: "openai", modelId: "gpt-5", contextWindow: 1_000_000, maxOutputTokens: 100_000 })).toEqual(GPT_CONTEXT_POLICY);
    expect(effectiveContextPolicy({ provider: "anthropic", modelId: "claude", contextWindow: 400_000, maxOutputTokens: 20_000 })).toMatchObject({
      ...CLAUDE_CONTEXT_POLICY, hardInputTokens: 380_000, outputReserveTokens: 20_000,
    });
    expect(effectiveContextPolicy({ contextWindow: 100_000 })).toMatchObject({
      softTriggerTokens: 70_000, targetTokens: 45_000, hardInputTokens: 68_000, outputReserveTokens: 32_000,
    });
  });
});

describe("context assembly", () => {
  test("places one summary after pinned first user and does not double-count it", () => {
    const summary = record("summary", "summary", "summary text");
    const result = assembleContext([
      record("system", "system", "rules"),
      record("first", "user", "first request"),
      record("old", "assistant", "old answer"),
      record("current", "user", "current request"),
    ], { inputLimit: 100, summary });
    expect(result.records.map((item) => item.id)).toEqual(["system", "first", "summary", "current"]);
    expect(result.records.filter((item) => item.id === "summary")).toHaveLength(1);
    expect(result.tokens).toBe(estimateRecordsTokens(result.records));
  });

  test("keeps typed first-turn text and omits, rather than truncates, oversized attachments", () => {
    const attachment = { id: "file-1", kind: "attachment" as const, text: "abcdefgh", tokenCount: 2, summary: "<attachment name=\"file-1\">durable text</attachment>" };
    const result = assembleContext([
      record("first", "user", "typed text", { content: [{ kind: "text", text: "typed text" }, attachment] }),
      record("current", "user", "current"),
    ], { inputLimit: 100, firstTurnAttachmentTokens: 1 });
    expect(result.records.find((item) => item.id === "first")?.content).toEqual([{ kind: "text", text: "typed text" }]);
    expect(result.omittedAttachments).toEqual([attachment]);
    expect(result.compactionRecords).toContainEqual(expect.objectContaining({ id: "first:omitted-attachments", content: [expect.objectContaining({ id: "file-1", kind: "text", text: attachment.summary })] }));
  });

  test("uses durable metadata when an omitted image has no textual representation", () => {
    const result = assembleContext([
      record("first", "user", "typed text", { content: [
        { kind: "text", text: "typed text" },
        { id: "image-1", kind: "attachment", text: "diagram.png", tokenCount: 10, summary: "[Omitted attachment: diagram.png; type: image/png; kind: image; bytes: 42]" },
      ] }),
    ], { inputLimit: 100, firstTurnAttachmentTokens: 1 });
    expect(result.records[0]?.content).toEqual([{ kind: "text", text: "typed text" }]);
    expect(result.compactionRecords[0]?.content[0]?.text).toBe("[Omitted attachment: diagram.png; type: image/png; kind: image; bytes: 42]");
  });

  test("always retains the full current turn and its tool transaction even when it exceeds budget", () => {
    const result = assembleContext([
      record("system", "system", "rules"),
      record("first", "user", "first"),
      record("current", "user", "current"),
      record("call", "assistant", "call", { status: "complete", toolTransactionId: "tx", content: [{ kind: "reasoning", text: "reasoning" }, { kind: "toolCall", text: "call" }] }),
      record("result", "tool", "result", { status: "complete", toolTransactionId: "tx", content: [{ kind: "toolResult", text: "tool output" }] }),
    ], { inputLimit: 2 });
    expect(result.records.map((item) => item.id)).toEqual(["system", "first", "current", "call", "result"]);
    expect(result.records.find((item) => item.id === "call")?.content).toContainEqual({ kind: "reasoning", text: "reasoning" });
    expect(result.records.find((item) => item.id === "result")?.content).toEqual([{ kind: "toolResult", text: "tool output" }]);
    expect(result.overBudget).toBe(true);
  });

  test("omits old completed reasoning but compacts whole old tool transactions", () => {
    const oldCall = record("old-call", "assistant", "call", { status: "complete", toolTransactionId: "old-tx", content: [{ kind: "reasoning", text: "discarded" }, { kind: "toolCall", text: "call" }] });
    const oldResult = record("old-result", "tool", "result", { status: "complete", toolTransactionId: "old-tx", content: [{ kind: "toolResult", text: "result" }] });
    const result = assembleContext([
      record("first", "user", "first"), oldCall, oldResult,
      record("current", "user", "current"),
    ], { inputLimit: 3 });
    expect(result.records.map((item) => item.id)).toEqual(["first", "current"]);
    expect(result.compactionRecords.map((item) => item.id)).toEqual(["old-call", "old-result"]);
    expect(result.compactionRecords[0]?.content).toEqual([{ kind: "toolCall", text: "call" }]);
    expect(result.compactionRecords[1]?.content).toEqual([{ kind: "toolResult", text: "result" }]);
  });

  test("does not remove tool results while filtering completed old payloads", () => {
    const result = filterCompletedPayloads([
      { ...record("a", "assistant", "answer"), status: "complete", content: [{ kind: "reasoning", text: "hidden" }, { kind: "text", text: "answer" }] },
      { ...record("tool", "tool", "result"), status: "complete", content: [{ kind: "toolResult", text: "result" }] },
    ]);
    expect(result[0]?.content).toEqual([{ kind: "text", text: "answer" }]);
    expect(result[1]?.content).toEqual([{ kind: "toolResult", text: "result" }]);
  });
});

describe("compaction", () => {
  test("renders every durable summary section and plans only safe atomic chunks", () => {
    const summary = {
      goal: "Ship", constraints: ["No DB"], decisions: ["Use Bun"], durableFacts: ["Server is Hono"], progress: ["Tests added"],
      unresolvedQuestions: ["Integrate"], criticalExcerpts: ["Exact API"], toolOutcomes: ["Tool passed"],
    };
    const rendered = renderStructuredSummary(summary);
    for (const title of ["Goal", "Constraints", "Decisions", "Durable Facts", "Progress", "Unresolved Questions", "Critical Excerpts", "Tool Outcomes"]) {
      expect(rendered).toContain(`## ${title}`);
    }
    expect(buildRollingSummaryPrompt(summary, [record("u", "user", "hello")])).toContain("New conversation material:");
    const records = [record("one", "user", "12345678"), record("two", "assistant", "12345678901234567890", { toolTransactionId: "tx" }), record("three", "tool", "12345678901234567890", { toolTransactionId: "tx" })];
    const plan = planSummaryChunks(records, 10, 2);
    expect(plan.chunks).toEqual([[records[0]!]]);
    expect(plan.oversizedTransactionIds).toEqual(["tx"]);
    expect(plan.chunks.every((chunk) => estimateRecordsTokens(chunk) <= 8)).toBe(true);
  });
});

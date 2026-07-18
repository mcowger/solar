import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import type { Database } from "../db/schema";
import { up } from "../db/migrations/012_context_management";
import { ContextRepository } from "./repository";

let sqlite: BunDatabase;
let db: Kysely<Database>;
let repository: ContextRepository;

beforeEach(async () => {
  sqlite = new BunDatabase(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  db = new Kysely<Database>({ dialect: new BunSqliteDialect({ database: sqlite }) });
  await db.schema.createTable("conversation")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("userId", "text", (col) => col.notNull())
    .addColumn("title", "text", (col) => col.notNull())
    .execute();
  await db.schema.createTable("message")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("conversationId", "text", (col) => col.notNull().references("conversation.id").onDelete("cascade"))
    .addColumn("role", "text", (col) => col.notNull())
    .addColumn("text", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .execute();
  await up(db as unknown as Kysely<unknown>);
  repository = new ContextRepository(db);
});

afterEach(async () => {
  await db.destroy();
  sqlite.close();
});

describe("ContextRepository policy resolution", () => {
  test("seeds global GPT and Claude family defaults idempotently", async () => {
    await repository.seedDefaultPolicies();
    await repository.seedDefaultPolicies();

    const policies = await db.selectFrom("context_policy").selectAll().orderBy("modelFamily").execute();
    expect(policies).toHaveLength(2);
    expect(policies.map((policy) => policy.modelFamily)).toEqual(["claude-1m", "gpt-5.6"]);
  });

  test("resolves exact model, then family, provider, and derived fallback", async () => {
    await repository.savePolicy({ scope: "provider", provider: "openai", enabled: true, softTriggerTokens: 40, targetTokens: 30, hardInputTokens: 90, maxPinnedAttachmentTokens: 10, outputReserveTokens: 10 });
    await repository.savePolicy({ scope: "model_family", provider: "openai", modelFamily: "gpt", enabled: true, softTriggerTokens: 50, targetTokens: 35, hardInputTokens: 80, maxPinnedAttachmentTokens: 10, outputReserveTokens: 10 });
    await repository.savePolicy({ scope: "exact_model", provider: "openai", modelId: "gpt-test", enabled: false, softTriggerTokens: 60, targetTokens: 40, hardInputTokens: 70, maxPinnedAttachmentTokens: 10, outputReserveTokens: 10 });

    expect((await repository.resolvePolicy({ provider: "openai", modelId: "gpt-test", modelFamily: "gpt", contextWindowTokens: 100 })).source).toBe("exact_model");
    expect((await repository.resolvePolicy({ provider: "openai", modelId: "other", modelFamily: "gpt", contextWindowTokens: 100 })).source).toBe("model_family");
    expect((await repository.resolvePolicy({ provider: "openai", modelId: "other", contextWindowTokens: 100 })).source).toBe("provider");
    expect(await repository.resolvePolicy({ provider: "unknown", modelId: "other", contextWindowTokens: 100_000 })).toMatchObject({ source: "derived", softTriggerTokens: 70_000, targetTokens: 45_000, hardInputTokens: 68_000 });
  });
});

describe("ContextRepository working state", () => {
  test("activates only the current claimed revision", async () => {
    await db.insertInto("conversation").values({ id: "conversation", userId: "user", title: "Test" }).execute();
    const initial = await repository.ensureState("conversation");
    expect(await repository.startJob("conversation", initial.revision, "job-1")).toBe(true);
    expect(await repository.invalidateSummary("conversation")).toBe(true);
    expect(await repository.activateSummary({ conversationId: "conversation", expectedRevision: initial.revision, jobId: "job-1", summary: "stale", retainedMessageBoundaryId: null })).toBe(false);

    const current = await repository.getState("conversation");
    expect(current).toMatchObject({ revision: 1, summary: null, jobStatus: "idle" });
  });

  test("persists steps in sequence and records content-free telemetry", async () => {
    await db.insertInto("conversation").values({ id: "conversation", userId: "user", title: "Test" }).execute();
    await db.insertInto("message").values({ id: "message", conversationId: "conversation", role: "assistant", text: "", status: "complete" }).execute();
    await repository.recordGenerationSteps("message", [{ event: "tool-call" }, { event: "tool-result" }]);
    await repository.recordProviderCall({ id: "call", conversationId: "conversation", messageId: "message", provider: "openai", api: "openai-responses", modelId: "gpt-test", purpose: "chat", inputTokens: 12, outputTokens: 8, contextPolicySource: "exact_model", contextPolicyState: { enabled: true, softTriggerTokens: 60, targetTokens: 40, hardInputTokens: 70, maxPinnedAttachmentTokens: 10, outputReserveTokens: 10 }, overflowed: true, retryAttempt: 1 });

    expect((await repository.generationSteps("message")).map((step) => JSON.parse(step.data))).toEqual([{ event: "tool-call" }, { event: "tool-result" }]);
    expect(await db.selectFrom("provider_call_telemetry").selectAll().executeTakeFirst()).toMatchObject({ inputTokens: 12, outputTokens: 8, contextPolicyState: expect.stringContaining("hardInputTokens"), overflowed: 1, retryAttempt: 1 });
  });
});

import { describe, expect, test } from "bun:test";
import { parseAllowlist } from "./allowlist";

describe("parseAllowlist", () => {
  test("returns valid entries and defaults unknown visibility to public", () => {
    expect(parseAllowlist(JSON.stringify([
      { id: "gpt-5", endpointId: "responses", api: "openai-responses", visibility: "private" },
      { id: "gpt-4.1", endpointId: "completions", api: "openai-completions", visibility: "unexpected" },
    ]))).toEqual([
      { id: "gpt-5", endpointId: "responses", api: "openai-responses", visibility: "private" },
      { id: "gpt-4.1", endpointId: "completions", api: "openai-completions", visibility: "public" },
    ]);
  });

  test("ignores malformed entries without discarding valid entries", () => {
    expect(parseAllowlist(JSON.stringify([
      { id: "valid", endpointId: "messages", api: "anthropic-messages" },
      null,
      { id: "missing-api" },
      { id: 42, api: "openai-responses" },
    ]))).toEqual([
      { id: "valid", endpointId: "messages", api: "anthropic-messages", visibility: "public" },
    ]);
  });

  test("keeps valid per-model generation defaults", () => {
    expect(parseAllowlist(JSON.stringify([
      { id: "gpt-5", endpointId: "responses", api: "openai-responses", reasoningEffort: "high", verbosity: "low" },
      { id: "gpt-4.1", endpointId: "responses", api: "openai-responses", reasoningEffort: "invalid", verbosity: "maximum" },
    ]))).toEqual([
      { id: "gpt-5", endpointId: "responses", api: "openai-responses", visibility: "public", reasoningEffort: "high", verbosity: "low" },
      { id: "gpt-4.1", endpointId: "responses", api: "openai-responses", visibility: "public" },
    ]);
  });

  test("returns an empty list for invalid JSON or a non-array value", () => {
    expect(parseAllowlist("not json")).toEqual([]);
    expect(parseAllowlist('{"id":"gpt-5"}')).toEqual([]);
  });
});

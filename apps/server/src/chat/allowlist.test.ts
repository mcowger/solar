import { describe, expect, test } from "bun:test";
import { parseAllowlist } from "./allowlist";

describe("parseAllowlist", () => {
	test("returns valid entries and defaults unknown visibility to public", () => {
		expect(
			parseAllowlist(
				JSON.stringify([
					{
						id: "gpt-5",
						endpointId: "responses",
						api: "openai-responses",
						visibility: "private",
					},
					{
						id: "gpt-4.1",
						endpointId: "completions",
						api: "openai-completions",
						visibility: "unexpected",
					},
				]),
			),
		).toEqual([
			{
				id: "gpt-5",
				endpointId: "responses",
				api: "openai-responses",
				visibility: "private",
			},
			{
				id: "gpt-4.1",
				endpointId: "completions",
				api: "openai-completions",
				visibility: "public",
			},
		]);
	});

	test("ignores malformed entries without discarding valid entries", () => {
		expect(
			parseAllowlist(
				JSON.stringify([
					{ id: "valid", endpointId: "messages", api: "anthropic-messages" },
					null,
					{ id: "missing-api" },
					{ id: 42, api: "openai-responses" },
				]),
			),
		).toEqual([
			{
				id: "valid",
				endpointId: "messages",
				api: "anthropic-messages",
				visibility: "public",
			},
		]);
	});

	test("keeps valid per-model generation defaults", () => {
		expect(
			parseAllowlist(
				JSON.stringify([
					{
						id: "gpt-5",
						endpointId: "responses",
						api: "openai-responses",
						reasoningEffort: "high",
						verbosity: "low",
						contextWindow: 128000,
						maxTokens: 32768,
					},
					{
						id: "gpt-4.1",
						endpointId: "responses",
						api: "openai-responses",
						reasoningEffort: "invalid",
						verbosity: "maximum",
						maxTokens: -100,
					},
				]),
			),
		).toEqual([
			{
				id: "gpt-5",
				endpointId: "responses",
				api: "openai-responses",
				visibility: "public",
				reasoningEffort: "high",
				verbosity: "low",
				contextWindow: 128000,
				maxTokens: 32768,
			},
			{
				id: "gpt-4.1",
				endpointId: "responses",
				api: "openai-responses",
				visibility: "public",
			},
		]);
	});

	test("keeps valid context metadata and discards malformed policy objects", () => {
		const contextPolicy = {
			enabled: true,
			softTriggerTokens: 90_000,
			targetTokens: 58_000,
			hardInputTokens: 96_000,
			maxPinnedAttachmentTokens: 32_000,
			outputReserveTokens: 32_000,
		};
		expect(
			parseAllowlist(
				JSON.stringify([
					{
						id: "configured",
						endpointId: "responses",
						api: "openai-responses",
						contextWindow: 128_000,
						contextPolicy,
					},
					{
						id: "malformed",
						endpointId: "responses",
						api: "openai-responses",
						contextPolicy: { enabled: true },
					},
				]),
			),
		).toEqual([
			{
				id: "configured",
				endpointId: "responses",
				api: "openai-responses",
				visibility: "public",
				contextWindow: 128_000,
				contextPolicy,
			},
			{
				id: "malformed",
				endpointId: "responses",
				api: "openai-responses",
				visibility: "public",
			},
		]);
	});

	test("returns an empty list for invalid JSON or a non-array value", () => {
		expect(parseAllowlist("not json")).toEqual([]);
		expect(parseAllowlist('{"id":"gpt-5"}')).toEqual([]);
	});
});

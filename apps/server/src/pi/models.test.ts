import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "solar-pi-models-test-"));
mkdirSync(join(dir, "pi-agent"), { recursive: true });
process.env.SOLAR_PI_AGENT_DIR = join(dir, "pi-agent");

const { piModelCapabilities, piModelConfigRevision, recordPiModelConfig } =
	await import("./models");

afterEach(() => {
	rmSync(join(dir, "pi-agent", "models.json"), { force: true });
});

describe("piModelCapabilities", () => {
	test("filters reasoning levels exactly as pi's thinkingLevelMap dictates", () => {
		writeFileSync(
			join(dir, "pi-agent", "models.json"),
			JSON.stringify({
				providers: {
					"solar:Plexus:endpoint-1": {
						models: [
							{
								id: "gemini-3.7-flash",
								reasoning: true,
								// low/medium/high only: off/minimal/xhigh/max unsupported.
								thinkingLevelMap: {
									off: null,
									minimal: null,
									low: "LOW",
									medium: "MEDIUM",
									high: "HIGH",
									xhigh: null,
									max: null,
								},
							},
						],
					},
				},
			}),
		);
		const caps = piModelCapabilities({
			provider: "Plexus",
			endpointId: "endpoint-1",
			modelId: "gemini-3.7-flash",
			api: "google-generative-ai",
		});
		expect(caps?.reasoningLevels).toEqual(["low", "medium", "high"]);
	});

	test("absent thinkingLevelMap values fall through to include the level (pi's own rule)", () => {
		writeFileSync(
			join(dir, "pi-agent", "models.json"),
			JSON.stringify({
				providers: {
					"solar:anthropic:endpoint": {
						models: [
							{
								id: "future-model",
								reasoning: true,
								thinkingLevelMap: { off: null, xhigh: "xhigh" },
							},
						],
					},
				},
			}),
		);
		const caps = piModelCapabilities({
			provider: "anthropic",
			endpointId: "endpoint",
			modelId: "future-model",
			api: "anthropic-messages",
		});
		expect(caps?.reasoningLevels).toContain("minimal");
		expect(caps?.reasoningLevels).toContain("high");
		expect(caps?.reasoningLevels).toContain("xhigh");
		expect(caps?.reasoningLevels).not.toContain("max");
	});

	test("returns null when no endpoint/model entry exists (legacy fallback path)", () => {
		expect(
			piModelCapabilities({
				provider: "nope",
				endpointId: "nope",
				modelId: "nope",
				api: "openai-responses",
			}),
		).toBeNull();
	});
});

describe("piModelConfigRevision", () => {
	test("changes only when the written model config changes", () => {
		expect(recordPiModelConfig('{"providers":{}}', "{}")).toBe(true);
		const first = piModelConfigRevision();
		expect(first).not.toBe("");
		expect(recordPiModelConfig('{"providers":{}}', "{}")).toBe(false);
		expect(piModelConfigRevision()).toBe(first);
		expect(recordPiModelConfig('{"providers":{"x":{}}}', "{}")).toBe(true);
		expect(piModelConfigRevision()).not.toBe(first);
	});
});

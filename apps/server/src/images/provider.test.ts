import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ImageModel } from "@earendil-works/pi-ai";
import { createImageGenerator } from "./provider";

const model = {
	id: "openai/gpt-image-1",
	name: "test image model",
	type: "image",
	api: "openrouter-images",
	provider: "openrouter",
	baseUrl: "https://example.test/v1",
	input: ["text", "image"],
	output: ["image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as ImageModel<"openrouter-images">;

type ImageFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

const originalMock = process.env.SOLAR_MOCK_LLM;

afterEach(() => {
	if (originalMock === undefined) delete process.env.SOLAR_MOCK_LLM;
	else process.env.SOLAR_MOCK_LLM = originalMock;
});

describe("image provider", () => {
	test("uses the fixture in mock mode without invoking fetch", async () => {
		process.env.SOLAR_MOCK_LLM = "1";
		const fetch = mock<ImageFetch>(async () => {
			throw new Error("live image provider must not be called");
		});
		const generator = createImageGenerator({ fetch });

		const result = await generator({
			model,
			apiKey: "never-used",
			prompt: "a test image",
		});

		expect(fetch).not.toHaveBeenCalled();
		expect(result.mimeType).toBe("image/png");
		expect(Buffer.from(result.data, "base64").subarray(0, 8)).toEqual(
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		);
	});

	test("posts selected source and settings to the OpenRouter images endpoint", async () => {
		delete process.env.SOLAR_MOCK_LLM;
		let receivedUrl: string | URL | RequestInfo | undefined;
		let receivedInit: RequestInit | undefined;
		const fetch = mock<ImageFetch>(async (input, init) => {
			receivedUrl = input;
			receivedInit = init;
			return new Response(
				JSON.stringify({
					id: "image-response",
					data: [{ b64_json: "iVBORw0KGgo=", media_type: "image/png" }],
					usage: { cost: 0.0123 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		const generator = createImageGenerator({ fetch });

		const result = await generator({
			model,
			apiKey: "test-key",
			prompt: "make it blue",
			source: { data: "source-base64", mimeType: "image/png" },
			aspectRatio: "16:9",
			resolution: "1024x1024",
		});

		expect(receivedUrl).toBe("https://example.test/v1/images");
		expect(receivedInit?.method).toBe("POST");
		expect(receivedInit?.headers).toMatchObject({
			authorization: "Bearer test-key",
			"content-type": "application/json",
		});
		expect(JSON.parse(String(receivedInit?.body))).toEqual({
			model: "openai/gpt-image-1",
			prompt: "make it blue",
			n: 1,
			aspect_ratio: "16:9",
			size: "1024x1024",
			provider: { allow_fallbacks: false },
			input_references: [
				{
					type: "image_url",
					image_url: {
						url: "data:image/png;base64,source-base64",
					},
				},
			],
		});
		expect(result.responseId).toBe("image-response");
		expect(result.actualCostUsd).toBe(0.0123);
	});
});

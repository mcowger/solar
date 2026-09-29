import type { ImageApi, ImageModel, Usage } from "@earendil-works/pi-ai";

export interface ImageProviderRequest {
	model: ImageModel<ImageApi>;
	apiKey: string;
	prompt: string;
	source?: { data: string; mimeType: string };
	aspectRatio?: string | null;
	resolution?: string | null;
	signal?: AbortSignal;
}

export interface ImageProviderResult {
	data: string;
	mimeType: string;
	responseId: string | null;
	usage: Usage | null;
	actualCostUsd: number | null;
}

type ImageFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

const IMAGE_COUNT = 1;
const MOCK_ERROR_MARKER = "[mock-error]";
const MOCK_IMAGE_MIME_TYPE = "image/png";
const MOCK_IMAGE_DATA =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4v5nhPwAHGQKyb+i68wAAAABJRU5ErkJggg==";
const GENERATION_ERROR = "Image generation failed.";
const CANCELLED_ERROR = "Image generation was cancelled.";
const NO_IMAGE_ERROR = "Image generation returned no image.";
const MULTIPLE_IMAGES_ERROR = "Image generation returned more than one image.";
const INVALID_IMAGE_ERROR = "Image generation returned an invalid image.";

interface OpenRouterImageResponse {
	id?: unknown;
	data?: unknown;
	usage?: unknown;
}

function imageEndpoint(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (!trimmed) throw new Error("Image provider endpoint is not configured");
	return `${trimmed}/images`;
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

function parseUsage(value: unknown): Usage | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const input = numberValue(raw.input_tokens ?? raw.prompt_tokens) ?? 0;
	const output = numberValue(raw.output_tokens ?? raw.completion_tokens) ?? 0;
	const cacheRead = numberValue(raw.cached_tokens) ?? 0;
	const cacheWrite = numberValue(raw.cache_write_tokens) ?? 0;
	const total = numberValue(raw.total_tokens) ?? input + output;
	const cost = numberValue(raw.cost) ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: total,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: cost,
		},
	};
}

function imageData(value: unknown): { data: string; mimeType: string } | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const item = value as Record<string, unknown>;
	if (typeof item.b64_json === "string" && item.b64_json.length > 0) {
		return {
			data: item.b64_json,
			mimeType:
				typeof item.media_type === "string" &&
				item.media_type.startsWith("image/")
					? item.media_type
					: MOCK_IMAGE_MIME_TYPE,
		};
	}
	if (typeof item.url === "string") {
		const match = item.url.match(/^data:(image\/[^;]+);base64,(.+)$/);
		if (match?.[1] && match[2]) return { mimeType: match[1], data: match[2] };
	}
	return null;
}

function requestBody(request: ImageProviderRequest): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: request.model.id,
		prompt: request.prompt,
		n: IMAGE_COUNT,
		provider: { allow_fallbacks: false },
	};
	if (request.aspectRatio) body.aspect_ratio = request.aspectRatio;
	if (request.resolution) {
		if (/^\d+x\d+$/i.test(request.resolution)) body.size = request.resolution;
		else body.resolution = request.resolution;
	}
	if (request.source) {
		body.input_references = [
			{
				type: "image_url",
				image_url: {
					url: `data:${request.source.mimeType};base64,${request.source.data}`,
				},
			},
		];
	}
	return body;
}

export function createImageGenerator(
	dependencies: { fetch?: ImageFetch } = {},
): (request: ImageProviderRequest) => Promise<ImageProviderResult> {
	return async (request) => {
		if (request.signal?.aborted) throw new Error(CANCELLED_ERROR);

		if (process.env.SOLAR_MOCK_LLM) {
			if (request.prompt.includes(MOCK_ERROR_MARKER)) {
				throw new Error(GENERATION_ERROR);
			}
			return {
				data: MOCK_IMAGE_DATA,
				mimeType: MOCK_IMAGE_MIME_TYPE,
				responseId: null,
				usage: null,
				actualCostUsd: null,
			};
		}

		const fetchResponse = dependencies.fetch ?? globalThis.fetch;
		let response: Response;
		try {
			response = await fetchResponse(imageEndpoint(request.model.baseUrl), {
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					authorization: `Bearer ${request.apiKey}`,
				},
				body: JSON.stringify(requestBody(request)),
				signal: request.signal,
			});
		} catch {
			throw new Error(
				request.signal?.aborted ? CANCELLED_ERROR : GENERATION_ERROR,
			);
		}

		let payload: OpenRouterImageResponse | null = null;
		try {
			payload = (await response.json()) as OpenRouterImageResponse;
		} catch {
			payload = null;
		}
		if (!response.ok) {
			throw new Error(
				request.signal?.aborted ? CANCELLED_ERROR : GENERATION_ERROR,
			);
		}

		const rawImages = Array.isArray(payload?.data) ? payload.data : [];
		if (rawImages.length === 0) throw new Error(NO_IMAGE_ERROR);
		if (rawImages.length !== IMAGE_COUNT)
			throw new Error(MULTIPLE_IMAGES_ERROR);
		const image = imageData(rawImages[0]);
		if (!image || !image.data || !image.mimeType.startsWith("image/"))
			throw new Error(INVALID_IMAGE_ERROR);

		const usage = parseUsage(payload?.usage);
		return {
			data: image.data,
			mimeType: image.mimeType,
			responseId: typeof payload?.id === "string" ? payload.id : null,
			usage,
			actualCostUsd:
				payload?.usage && typeof payload.usage === "object"
					? numberValue((payload.usage as Record<string, unknown>).cost)
					: null,
		};
	};
}

export const generateImage = createImageGenerator();

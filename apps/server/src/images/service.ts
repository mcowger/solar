import type { ImageModel } from "@earendil-works/pi-ai";
import {
	listAvailableImageModels,
	resolveImageModel,
	type ImageModelDescriptor,
	type ModelSelection,
} from "../chat/catalog";
import {
	ImageConflictError,
	ImageNotFoundError,
	ImageWorkspaceStartedError,
	imageRepository,
	type CreateWorkspaceInput,
	type ImageAssetRecord,
	type ImageAttemptRecord,
	type ImageRepository,
	type ImageWorkspaceDetails,
	type ImageWorkspaceRecord,
	type ReadImageAsset,
	type UploadInitialImageInput,
} from "./repository";
import {
	generateImage,
	type ImageProviderRequest,
	type ImageProviderResult,
} from "./provider";

export interface StartGenerationInput {
	userId?: string;
	workspaceId: string;
	requestKey?: string;
	prompt: string;
	modelId?: string;
	provider?: string;
	endpointId?: string;
	api?: string;
	aspectRatio?: string | null;
	resolution?: string | null;
	sourceAssetId?: string | null;
	sourceVariantId?: string | null;
}

export interface RetryAttemptInput {
	attemptId: string;
}

export interface UploadInitialImageRequest extends UploadInitialImageInput {
	userId: string;
	workspaceId: string;
}

export interface ImageGenerationServiceDependencies {
	repository?: ImageRepository;
	generateImage?: (
		request: ImageProviderRequest,
	) => Promise<ImageProviderResult>;
	resolveImageModel?: typeof resolveImageModel;
	listAvailableImageModels?: typeof listAvailableImageModels;
}

const DEFAULT_MOCK_MODEL: ImageModel<"openrouter-images"> = {
	id: "mock-image",
	name: "Solar mock image",
	type: "image",
	api: "openrouter-images",
	provider: "openrouter",
	baseUrl: "",
	input: ["text", "image"],
	output: ["image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function errorText(error: unknown): string {
	return error instanceof Error && error.message
		? error.message
		: "Image generation failed.";
}

function modelSelection(
	model: ImageModelDescriptor,
	input: StartGenerationInput,
): ModelSelection {
	return {
		provider: input.provider ?? model.provider,
		endpointId: input.endpointId ?? model.endpointId,
		modelId: model.modelId,
		api: input.api ?? model.api,
	};
}

function costMicros(result: ImageProviderResult): number | null {
	const dollars = result.actualCostUsd ?? result.usage?.cost.total ?? null;
	if (typeof dollars !== "number" || !Number.isFinite(dollars) || dollars < 0)
		return null;
	return Math.round(dollars * 1_000_000);
}

function extensionForMime(mimeType: string): string {
	if (mimeType === "image/jpeg") return "jpg";
	if (mimeType === "image/webp") return "webp";
	return "png";
}

export class ImageGenerationService {
	private readonly repository: ImageRepository;
	private readonly generator: (
		request: ImageProviderRequest,
	) => Promise<ImageProviderResult>;
	private readonly resolveModel: typeof resolveImageModel;
	private readonly listModels: typeof listAvailableImageModels;

	constructor(dependencies: ImageGenerationServiceDependencies = {}) {
		this.repository = dependencies.repository ?? imageRepository;
		this.generator = dependencies.generateImage ?? generateImage;
		this.resolveModel = dependencies.resolveImageModel ?? resolveImageModel;
		this.listModels =
			dependencies.listAvailableImageModels ?? listAvailableImageModels;
	}

	async list(userId: string): Promise<ImageWorkspaceRecord[]> {
		return this.repository.list(userId);
	}

	async get(
		userId: string,
		workspaceId: string,
	): Promise<ImageWorkspaceDetails> {
		return this.repository.get(userId, workspaceId);
	}

	async createWorkspace(
		userId: string,
		input: CreateWorkspaceInput | string = {},
	): Promise<ImageWorkspaceRecord> {
		return this.repository.createWorkspace(
			userId,
			typeof input === "string" ? { title: input } : input,
		);
	}

	async listWorkspaces(userId: string): Promise<ImageWorkspaceRecord[]> {
		return this.list(userId);
	}

	async getWorkspace(userId: string, workspaceId: string) {
		const details = await this.get(userId, workspaceId);
		return {
			workspace: details,
			assets: details.assets,
			attempts: details.attempts,
			activeAttempt: details.activeAttempt,
			currentAssetId: details.currentAssetId,
		};
	}

	async uploadInitialImage(
		userIdOrRequest: string | UploadInitialImageRequest,
		workspaceId?: string,
		input?: UploadInitialImageInput,
	): Promise<ImageAssetRecord> {
		const request =
			typeof userIdOrRequest === "string"
				? { userId: userIdOrRequest, workspaceId: workspaceId!, input: input! }
				: {
						userId: userIdOrRequest.userId,
						workspaceId: userIdOrRequest.workspaceId,
						input: userIdOrRequest,
					};
		const workspace = await this.repository.get(
			request.userId,
			request.workspaceId,
		);
		if (workspace.assets.length > 0) throw new ImageWorkspaceStartedError();
		return this.repository.uploadInitialImage(
			request.userId,
			request.workspaceId,
			request.input,
		);
	}

	async startGeneration(
		userIdOrInput: string | (StartGenerationInput & { userId: string }),
		inputArgument?: StartGenerationInput,
	): Promise<ImageAttemptRecord> {
		const userId =
			typeof userIdOrInput === "string" ? userIdOrInput : userIdOrInput.userId!;
		const input =
			typeof userIdOrInput === "string" ? inputArgument! : userIdOrInput;
		const prompt = input.prompt.trim();
		if (!prompt) throw new Error("Image prompt is required");
		if (prompt.length > 20_000) throw new Error("Image prompt is too long");

		const workspace = await this.repository.get(userId, input.workspaceId);
		const resolved = await this.resolveRequestedModel(
			input.modelId ?? workspace.modelId ?? "",
			input,
		);
		const settings = this.validateSettings(
			resolved.descriptor,
			input.aspectRatio ?? workspace.aspectRatio ?? null,
			input.resolution ?? workspace.resolution ?? null,
		);
		const sourceAssetId = input.sourceAssetId ?? input.sourceVariantId ?? null;
		if (sourceAssetId && !resolved.model.input.includes("image"))
			throw new Error("Selected image model cannot accept a source image");
		const attempt = await this.repository.createAttempt(userId, workspace.id, {
			requestKey: input.requestKey,
			prompt,
			modelId: resolved.modelId,
			provider: resolved.selection.provider,
			endpointId: resolved.selection.endpointId,
			api: resolved.selection.api,
			sourceAssetId,
			aspectRatio: settings.aspectRatio,
			resolution: settings.resolution,
		});
		this.runAttempt(userId, attempt, resolved.model, resolved.apiKey).catch(
			() => {},
		);
		return attempt;
	}

	async retryAttempt(
		userId: string,
		input: RetryAttemptInput | string,
	): Promise<ImageAttemptRecord> {
		const attemptId = typeof input === "string" ? input : input.attemptId;
		const previous = await this.repository.readAttempt(userId, attemptId);
		const resolved = await this.resolveRequestedModel(previous.modelId, {
			workspaceId: previous.workspaceId,
			prompt: previous.prompt,
			modelId: previous.modelId,
			aspectRatio: previous.aspectRatio,
			resolution: previous.resolution,
			sourceAssetId: previous.sourceAssetId,
		});
		this.validateSettings(
			resolved.descriptor,
			previous.aspectRatio,
			previous.resolution,
		);
		const attempt = await this.repository.createRetryAttempt(userId, attemptId);
		this.runAttempt(userId, attempt, resolved.model, resolved.apiKey).catch(
			() => {},
		);
		return attempt;
	}

	async retry(userId: string, attemptId: string): Promise<ImageAttemptRecord> {
		return this.retryAttempt(userId, attemptId);
	}

	async deleteWorkspace(userId: string, workspaceId: string): Promise<void> {
		return this.repository.deleteWorkspace(userId, workspaceId);
	}

	async deleteUserWorkspaces(userId: string): Promise<void> {
		const workspaces = await this.repository.list(userId);
		for (const workspace of workspaces)
			await this.repository.deleteWorkspace(userId, workspace.id);
	}

	async recoverActiveAttempts(userId?: string): Promise<number> {
		return this.repository.recoverActiveAttempts(userId);
	}

	async readAsset(userId: string, assetId: string): Promise<ReadImageAsset> {
		return this.repository.readAsset(userId, assetId);
	}

	async readAttempt(
		userId: string,
		attemptId: string,
	): Promise<ImageAttemptRecord> {
		return this.repository.readAttempt(userId, attemptId);
	}

	async getAsset(
		userId: string,
		workspaceIdOrAssetId: string | undefined,
		assetId?: string,
	): Promise<ImageAssetRecord> {
		const actualAssetId = assetId ?? workspaceIdOrAssetId;
		if (!actualAssetId) throw new ImageNotFoundError("image asset", "unknown");
		const record = await this.repository.getAsset(userId, actualAssetId);
		if (assetId && record.workspaceId !== workspaceIdOrAssetId)
			throw new ImageNotFoundError("image asset", actualAssetId);
		return record;
	}

	async shutdown(): Promise<void> {
		await this.recoverActiveAttempts();
	}

	private async resolveRequestedModel(
		modelId: string,
		input: StartGenerationInput,
	): Promise<{
		model: ImageModel<"openrouter-images">;
		modelId: string;
		descriptor: ImageModelDescriptor | null;
		selection: ModelSelection;
		apiKey: string;
	}> {
		if (!modelId.trim()) throw new Error("Image model is required");
		const models = await this.listModels();
		const descriptor =
			models.find((model) => model.modelId === modelId) ?? null;
		const selection = descriptor
			? modelSelection(descriptor, input)
			: {
					provider: "openrouter",
					endpointId: "openrouter-images",
					modelId,
					api: "openrouter-images",
				};
		if (process.env.SOLAR_MOCK_LLM) {
			return {
				model: { ...DEFAULT_MOCK_MODEL, id: modelId },
				modelId,
				descriptor,
				selection,
				apiKey: "",
			};
		}
		if (descriptor) {
			const resolved = await this.resolveModel(selection);
			if (!resolved.model.output.includes("image"))
				throw new Error("Selected image model cannot generate images");
			return {
				model: resolved.model,
				modelId,
				descriptor,
				selection,
				apiKey: resolved.apiKey ?? "",
			};
		}
		throw new Error("Image model unavailable");
	}

	private validateSettings(
		descriptor: ImageModelDescriptor | null,
		aspectRatio: string | null,
		resolution: string | null,
	): { aspectRatio: string | null; resolution: string | null } {
		if (
			descriptor?.aspectRatios.length &&
			aspectRatio &&
			!descriptor.aspectRatios.includes(aspectRatio)
		)
			throw new Error("Image aspect ratio is not supported by this model");
		if (
			descriptor?.resolutions.length &&
			resolution &&
			!descriptor.resolutions.includes(resolution)
		)
			throw new Error("Image resolution is not supported by this model");
		return { aspectRatio, resolution };
	}

	private async runAttempt(
		userId: string,
		attempt: ImageAttemptRecord,
		model: ImageModel<"openrouter-images">,
		apiKey: string,
	): Promise<void> {
		const claimed = await this.repository.claimAttempt(userId, attempt.id);
		if (!claimed) return;
		try {
			const source = claimed.sourceAssetId
				? await this.repository.readAsset(userId, claimed.sourceAssetId)
				: null;
			const result = await this.generator({
				model,
				apiKey,
				prompt: claimed.prompt,
				...(source
					? {
							source: {
								data: Buffer.from(source.bytes).toString("base64"),
								mimeType: source.asset.mimeType,
							},
						}
					: {}),
				aspectRatio: claimed.aspectRatio,
				resolution: claimed.resolution,
			});
			if (!result.data) throw new Error("Image generation returned no image.");
			await this.repository.completeAttemptWithImage(userId, attempt.id, {
				filename: `generated-${attempt.id}.${extensionForMime(result.mimeType)}`,
				mimeType: result.mimeType,
				bytes: Buffer.from(result.data, "base64"),
				usageJson: result.usage ? JSON.stringify(result.usage) : null,
				costMicros: costMicros(result),
			});
		} catch (error) {
			await this.repository.failAttempt(userId, attempt.id, errorText(error));
		}
	}
}

export { ImageConflictError, ImageNotFoundError };
export const imageGenerationService = new ImageGenerationService();

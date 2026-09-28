import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertCircle,
	ArrowDownToLine,
	ChevronDown,
	ImagePlus,
	LoaderCircle,
	RefreshCw,
	Sparkles,
	Trash2,
	Upload,
	WandSparkles,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTRPC } from "../trpc";
import { newId } from "../id";
import { uploadWithProgress } from "../uploadWithProgress";
import {
	getImageTrpc,
	imageUrl,
	type ImageAsset,
	type ImageAttempt,
	type ImageModel,
	type ImageWorkspaceSummary,
} from "./imageApi";

interface ImageWorkspaceProps {
	workspaceId: string | undefined;
	onCreated?: (id: string) => void;
	onDeleted?: () => void;
}

const DEFAULT_ASPECT_RATIO = "1:1";
const DEFAULT_RESOLUTION = "1024x1024";

function errorMessage(error: unknown) {
	return error instanceof Error
		? error.message
		: "Something went wrong. Try again.";
}

function formatCost(costMicros: number | null | undefined) {
	if (costMicros === null || costMicros === undefined) return null;
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 4,
	}).format(costMicros / 1_000_000);
}

function assetSource(asset: ImageAsset | null | undefined) {
	return (
		imageUrl(asset) ??
		(asset?.id ? `/api/images/assets/${encodeURIComponent(asset.id)}` : null)
	);
}

function assetsFromWorkspace(workspace: {
	assets?: ImageAsset[];
	variants?: ImageAsset[];
	versions?: ImageAsset[];
}) {
	return workspace.assets ?? workspace.variants ?? workspace.versions ?? [];
}

function modelIdOf(model: ImageModel) {
	return model.id ?? model.modelId ?? "";
}

function modelLabel(model: ImageModel) {
	return model.displayName ?? model.name ?? modelIdOf(model);
}

function attemptAsset(attempt: ImageAttempt | null | undefined) {
	return attempt?.asset ?? attempt?.result ?? null;
}

export function ImageWorkspace({
	workspaceId,
	onCreated,
	onDeleted,
}: ImageWorkspaceProps) {
	const trpc = useTRPC();
	const imageTrpc = getImageTrpc(trpc);
	const queryClient = useQueryClient();
	const inputRef = useRef<HTMLInputElement>(null);
	const [createdId, setCreatedId] = useState<string>();
	const [selectedId, setSelectedId] = useState<string>();
	const [prompt, setPrompt] = useState("");
	const [modelId, setModelId] = useState<string>();
	const [aspectRatio, setAspectRatio] = useState(DEFAULT_ASPECT_RATIO);
	const [resolution, setResolution] = useState(DEFAULT_RESOLUTION);
	const [error, setError] = useState<string>();
	const [uploading, setUploading] = useState(false);
	const [uploadProgress, setUploadProgress] = useState(0);
	const [localAsset, setLocalAsset] = useState<ImageAsset>();
	const [localAttempt, setLocalAttempt] = useState<ImageAttempt>();
	const [previewUrl, setPreviewUrl] = useState<string>();

	const activeWorkspaceId = workspaceId ?? createdId;
	const workspaceQuery = useQuery(
		imageTrpc.get.queryOptions(
			{ workspaceId: activeWorkspaceId ?? "" },
			{ enabled: Boolean(activeWorkspaceId) },
		),
	);
	const modelsQuery = useQuery(imageTrpc.models.queryOptions());
	const models = (modelsQuery.data ?? []) as ImageModel[];
	const workspace = workspaceQuery.data;
	const assets = useMemo(() => {
		const serverAssets = workspace ? assetsFromWorkspace(workspace) : [];
		if (!localAsset || serverAssets.some((asset) => asset.id === localAsset.id))
			return serverAssets;
		return [...serverAssets, localAsset];
	}, [localAsset, workspace]);
	const activeAttempt =
		workspace?.activeAttempt ?? workspace?.attempts?.at(-1) ?? localAttempt;
	const selectedAsset =
		assets.find((asset) => asset.id === selectedId) ??
		assets.find((asset) => asset.id === workspace?.currentAssetId) ??
		assets.at(-1) ??
		attemptAsset(activeAttempt);
	const selectedUrl = assetSource(selectedAsset);
	const hasStarted = assets.length > 0 || Boolean(activeAttempt);
	const selectedModel = models.find((model) => modelIdOf(model) === modelId);
	const aspectRatios = selectedModel
		? selectedModel.aspectRatios?.length
			? selectedModel.aspectRatios
			: [DEFAULT_ASPECT_RATIO, "16:9", "9:16", "4:3"]
		: [];
	const resolutions = selectedModel
		? selectedModel.resolutions?.length
			? selectedModel.resolutions
			: [DEFAULT_RESOLUTION, "1536x1024", "1024x1536"]
		: [];
	const isGenerating = ["queued", "running", "processing"].includes(
		activeAttempt?.status ?? "",
	);
	const failedAttempt =
		activeAttempt &&
		["failed", "interrupted", "error"].includes(activeAttempt.status)
			? activeAttempt
			: undefined;

	const invalidateWorkspace = (id = activeWorkspaceId) => {
		if (!id) return;
		void queryClient.invalidateQueries({
			queryKey: imageTrpc.get.queryKey({ workspaceId: id }),
		});
		void queryClient.invalidateQueries({ queryKey: imageTrpc.list.queryKey() });
	};

	const create = useMutation(imageTrpc.create.mutationOptions());
	const generate = useMutation(imageTrpc.generate.mutationOptions());
	const retry = useMutation(imageTrpc.retry.mutationOptions());
	const remove = useMutation(imageTrpc.remove.mutationOptions());

	useEffect(() => {
		if (!activeWorkspaceId || !isGenerating) return;
		const timer = window.setInterval(() => invalidateWorkspace(), 2_000);
		return () => window.clearInterval(timer);
	}, [activeWorkspaceId, isGenerating]);

	useEffect(() => {
		if (models.length === 0) {
			if (modelId !== undefined) setModelId(undefined);
			return;
		}
		if (!modelId || !models.some((model) => modelIdOf(model) === modelId)) {
			setModelId(modelIdOf(models[0]!));
		}
	}, [modelId, models]);

	useEffect(() => {
		if (
			selectedModel?.aspectRatios?.length &&
			!aspectRatios.includes(aspectRatio)
		) {
			setAspectRatio(selectedModel.aspectRatios[0] ?? DEFAULT_ASPECT_RATIO);
		}
		if (
			selectedModel?.resolutions?.length &&
			!resolutions.includes(resolution)
		) {
			setResolution(selectedModel.resolutions[0] ?? DEFAULT_RESOLUTION);
		}
	}, [aspectRatio, aspectRatios, resolution, resolutions, selectedModel]);

	useEffect(() => {
		return () => {
			if (previewUrl) URL.revokeObjectURL(previewUrl);
		};
	}, [previewUrl]);

	async function ensureWorkspace(title: string) {
		if (activeWorkspaceId) return activeWorkspaceId;
		const result = await create.mutateAsync({
			title: title.trim().slice(0, 80) || "Untitled image",
		});
		setCreatedId(result.id);
		onCreated?.(result.id);
		return result.id;
	}

	async function upload(file: File | undefined) {
		if (!file || uploading) return;
		if (!file.type.startsWith("image/")) {
			setError("Choose an image file.");
			return;
		}
		setError(undefined);
		setUploading(true);
		setUploadProgress(0);
		const nextPreview = URL.createObjectURL(file);
		setPreviewUrl((previous) => {
			if (previous) URL.revokeObjectURL(previous);
			return nextPreview;
		});
		try {
			const id = await ensureWorkspace(file.name.replace(/\.[^.]+$/, ""));
			const body = new FormData();
			body.append("file", file);
			const result = await uploadWithProgress<
				ImageAsset | { asset?: ImageAsset; variant?: ImageAsset }
			>(
				`/api/images/${encodeURIComponent(id)}/upload`,
				body,
				setUploadProgress,
			);
			const uploaded =
				("asset" in result ? result.asset : undefined) ??
				("variant" in result ? result.variant : undefined) ??
				(result as ImageAsset);
			if (uploaded?.id) {
				setLocalAsset(uploaded);
				setSelectedId(uploaded.id);
			}
			invalidateWorkspace(id);
		} catch (uploadError) {
			setError(errorMessage(uploadError));
		} finally {
			setUploading(false);
			if (inputRef.current) inputRef.current.value = "";
		}
	}

	async function submit() {
		const text = prompt.trim();
		if (
			!text ||
			!selectedModel ||
			generate.isPending ||
			retry.isPending ||
			uploading
		)
			return;
		setError(undefined);
		try {
			const id = await ensureWorkspace(text);
			const result = await generate.mutateAsync({
				workspaceId: id,
				sourceAssetId: selectedAsset?.id ?? null,
				prompt: text,
				modelId: modelIdOf(selectedModel),
				aspectRatio,
				resolution,
				requestKey: newId(),
			});
			setLocalAttempt(result);
			setPrompt("");
			invalidateWorkspace(id);
		} catch (generateError) {
			setError(errorMessage(generateError));
		}
	}

	async function retryAttempt() {
		if (!failedAttempt || retry.isPending) return;
		setError(undefined);
		try {
			const result = await retry.mutateAsync({ attemptId: failedAttempt.id });
			setLocalAttempt(result);
			invalidateWorkspace();
		} catch (retryError) {
			setError(errorMessage(retryError));
		}
	}

	async function deleteWorkspace() {
		if (!activeWorkspaceId || !window.confirm("Delete this image workspace?"))
			return;
		setError(undefined);
		try {
			await remove.mutateAsync({ workspaceId: activeWorkspaceId });
			queryClient.setQueryData<ImageWorkspaceSummary[]>(
				imageTrpc.list.queryKey(),
				(current) =>
					current?.filter((workspace) => workspace.id !== activeWorkspaceId),
			);
			void queryClient.invalidateQueries({
				queryKey: imageTrpc.list.queryKey(),
			});
			onDeleted?.();
		} catch (removeError) {
			setError(errorMessage(removeError));
		}
	}

	function download() {
		if (!selectedUrl) return;
		const link = document.createElement("a");
		link.href = selectedAsset?.downloadUrl ?? selectedUrl;
		link.download = `${workspace?.title ?? "solar-image"}.png`;
		link.target = "_blank";
		link.rel = "noreferrer";
		link.click();
	}

	const displayUrl = selectedUrl ?? previewUrl;
	const title = workspace?.title ?? "New image workspace";

	return (
		<main className="solar-image-workspace min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 sm:gap-6 sm:p-6 lg:p-8">
				<header className="flex flex-wrap items-end justify-between gap-3">
					<div>
						<p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
							Image workspace
						</p>
						<h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
							{title}
						</h1>
						<p className="mt-1 max-w-xl text-sm text-base-content/60">
							Create a first image, then branch edits from any saved version.
						</p>
					</div>
					{activeWorkspaceId && (
						<button
							type="button"
							className="btn btn-ghost btn-sm gap-2 text-error"
							disabled={remove.isPending}
							onClick={() => void deleteWorkspace()}
						>
							<Trash2 size={15} /> Delete workspace
						</button>
					)}
				</header>

				<div className="grid min-h-0 gap-5 lg:grid-cols-[minmax(0,1fr)_21rem]">
					<section className="min-w-0 space-y-3">
						<div className="solar-image-stage solar-image-checker flex min-h-[22rem] items-center justify-center overflow-hidden rounded-2xl border border-base-300 p-3 shadow-sm sm:min-h-[30rem] lg:min-h-[34rem]">
							{displayUrl ? (
								<img
									src={displayUrl}
									alt={selectedAsset?.prompt ?? title}
									className="max-h-full max-w-full rounded-xl object-contain shadow-lg"
								/>
							) : (
								<div className="flex max-w-sm flex-col items-center px-5 text-center">
									<span className="grid h-16 w-16 place-items-center rounded-2xl bg-primary/12 text-primary">
										<ImagePlus size={30} strokeWidth={1.6} />
									</span>
									<h2 className="mt-4 text-xl font-semibold">
										Start with an idea
									</h2>
									<p className="mt-2 text-sm leading-6 text-base-content/60">
										Describe what you want below, or add one reference image to
										begin an edit.
									</p>
								</div>
							)}
						</div>

						{assets.length > 0 && (
							<div className="rounded-2xl border border-base-300 bg-base-100 p-3">
								<div className="mb-2 flex items-center justify-between gap-3">
									<span className="text-xs font-semibold uppercase tracking-[0.14em] text-base-content/50">
										Saved versions
									</span>
									<span className="text-xs text-base-content/45">
										{assets.length}{" "}
										{assets.length === 1 ? "version" : "versions"}
									</span>
								</div>
								<div className="solar-scroll-overlay flex gap-2 overflow-x-auto pb-1">
									{assets.map((asset, index) => {
										const url = assetSource(asset);
										const selected = asset.id === selectedAsset?.id;
										return (
											<button
												key={asset.id}
												type="button"
												onClick={() => setSelectedId(asset.id)}
												className={`solar-image-thumb relative w-16 shrink-0 overflow-hidden rounded-xl border-2 bg-base-200 transition sm:w-20 ${selected ? "border-primary shadow-md" : "border-transparent hover:border-base-content/25"}`}
												title={`Version ${index + 1}`}
											>
												{url ? (
													<img
														src={url}
														alt=""
														className="h-full w-full object-cover"
													/>
												) : (
													<ImagePlus className="m-auto opacity-40" size={18} />
												)}
												<span className="absolute bottom-1 right-1 rounded bg-neutral/75 px-1 text-[10px] text-neutral-content">
													{index + 1}
												</span>
											</button>
										);
									})}
								</div>
							</div>
						)}
					</section>

					<aside className="flex min-w-0 flex-col gap-4">
						<form
							onSubmit={(event) => {
								event.preventDefault();
								void submit();
							}}
							className="rounded-2xl border border-base-300 bg-base-100 p-4 shadow-sm sm:p-5"
						>
							<div className="flex items-center gap-2 text-sm font-semibold">
								<WandSparkles size={16} className="text-primary" />
								{hasStarted ? "Edit this image" : "Describe your image"}
							</div>
							<textarea
								value={prompt}
								onChange={(event) => setPrompt(event.target.value)}
								placeholder={
									hasStarted
										? "What should change?"
										: "A sunlit cabin beside a quiet alpine lake…"
								}
								rows={5}
								className="textarea textarea-bordered mt-3 w-full resize-none leading-6"
								disabled={isGenerating}
							/>
							<div className="mt-3 flex items-center gap-2">
								<button
									type="submit"
									className="btn btn-primary min-w-0 flex-1 gap-2"
									disabled={
										!prompt.trim() ||
										!selectedModel ||
										isGenerating ||
										generate.isPending ||
										create.isPending
									}
								>
									{isGenerating || generate.isPending ? (
										<LoaderCircle className="animate-spin" size={16} />
									) : (
										<Sparkles size={16} />
									)}
									{isGenerating ? "Generating…" : "Generate"}
								</button>
								{failedAttempt && (
									<button
										type="button"
										className="btn btn-outline btn-error btn-square"
										title="Retry generation"
										onClick={() => void retryAttempt()}
										disabled={retry.isPending}
									>
										<RefreshCw
											size={16}
											className={retry.isPending ? "animate-spin" : undefined}
										/>
									</button>
								)}
							</div>
						</form>

						{!hasStarted && (
							<div className="rounded-2xl border border-dashed border-primary/35 bg-primary/5 p-4">
								<div className="flex items-center justify-between gap-3">
									<div>
										<p className="text-sm font-semibold">Add a reference</p>
										<p className="mt-1 text-xs leading-5 text-base-content/55">
											One image to guide your first generation.
										</p>
									</div>
									<Upload size={18} className="text-primary" />
								</div>
								<input
									ref={inputRef}
									type="file"
									accept="image/*"
									className="file-input file-input-bordered file-input-sm mt-3 w-full"
									disabled={uploading || create.isPending}
									onChange={(event) =>
										void upload(event.currentTarget.files?.[0])
									}
								/>
								{uploading && (
									<div className="mt-2 flex items-center gap-2 text-xs text-base-content/60">
										<progress
											className="progress progress-primary flex-1"
											value={uploadProgress}
											max={100}
										/>
										<span className="tabular-nums">
											Uploading reference… {uploadProgress}%
										</span>
									</div>
								)}
							</div>
						)}

						<div className="rounded-2xl border border-base-300 bg-base-100 p-4 shadow-sm sm:p-5">
							<div className="mb-3 flex items-center gap-2 text-sm font-semibold">
								<ChevronDown size={16} className="text-base-content/50" />{" "}
								Generation settings
							</div>
							<div className="grid gap-3">
								<label className="form-control gap-1">
									<span className="label-text text-xs font-semibold uppercase tracking-wide text-base-content/55">
										Model
									</span>
									<select
										className="select select-bordered select-sm w-full"
										value={selectedModel ? modelIdOf(selectedModel) : ""}
										onChange={(event) =>
											setModelId(event.target.value || undefined)
										}
										disabled={isGenerating || models.length === 0}
									>
										{models.length === 0 ? (
											<option value="">No valid image models configured</option>
										) : (
											models.map((model) => (
												<option key={modelIdOf(model)} value={modelIdOf(model)}>
													{modelLabel(model)}
												</option>
											))
										)}
									</select>
									{models.length === 0 && (
										<p className="label text-error">
											No valid image models configured. Ask an administrator to
											map an image model to the pi-ai catalog.
										</p>
									)}
								</label>
								<div className="grid grid-cols-2 gap-3">
									<label className="form-control gap-1">
										<span className="label-text text-xs font-semibold uppercase tracking-wide text-base-content/55">
											Aspect
										</span>
										<select
											className="select select-bordered select-sm w-full"
											value={aspectRatio}
											onChange={(event) => setAspectRatio(event.target.value)}
											disabled={isGenerating}
										>
											{aspectRatios.map((value) => (
												<option key={value}>{value}</option>
											))}
										</select>
									</label>
									<label className="form-control gap-1">
										<span className="label-text text-xs font-semibold uppercase tracking-wide text-base-content/55">
											Size
										</span>
										<select
											className="select select-bordered select-sm w-full"
											value={resolution}
											onChange={(event) => setResolution(event.target.value)}
											disabled={isGenerating}
										>
											{resolutions.map((value) => (
												<option key={value}>{value}</option>
											))}
										</select>
									</label>
								</div>
							</div>
						</div>

						{activeAttempt && (
							<div
								className={`rounded-2xl border p-4 text-sm ${failedAttempt ? "border-error/30 bg-error/8" : isGenerating ? "border-primary/25 bg-primary/6" : "border-success/25 bg-success/6"}`}
							>
								<div className="flex items-center gap-2 font-semibold">
									{failedAttempt ? (
										<AlertCircle size={16} className="text-error" />
									) : isGenerating ? (
										<LoaderCircle
											size={16}
											className="animate-spin text-primary"
										/>
									) : (
										<Sparkles size={16} className="text-success" />
									)}
									{failedAttempt
										? "Generation needs a retry"
										: isGenerating
											? "Working on your image"
											: "Generation complete"}
								</div>
								{(failedAttempt?.error ||
									failedAttempt?.errorMessage ||
									activeAttempt.prompt) && (
									<p className="mt-2 text-xs leading-5 text-base-content/60">
										{failedAttempt?.error ??
											failedAttempt?.errorMessage ??
											activeAttempt.prompt}
									</p>
								)}
								{formatCost(activeAttempt.costMicros) && (
									<p className="mt-2 text-xs text-base-content/55">
										Provider cost: {formatCost(activeAttempt.costMicros)}
									</p>
								)}
								{failedAttempt && (
									<button
										type="button"
										className="btn btn-sm btn-outline btn-error mt-3 gap-2"
										onClick={() => void retryAttempt()}
										disabled={retry.isPending}
									>
										<RefreshCw size={14} /> Retry
									</button>
								)}
							</div>
						)}

						{selectedUrl && (
							<button
								type="button"
								className="btn btn-outline w-full gap-2"
								onClick={download}
							>
								<ArrowDownToLine size={16} /> Download original
							</button>
						)}
						{error && (
							<div
								role="alert"
								className="alert alert-error alert-soft text-sm"
							>
								<AlertCircle size={16} />
								<span>{error}</span>
								<button
									type="button"
									className="btn btn-ghost btn-xs btn-circle ml-auto"
									onClick={() => setError(undefined)}
								>
									<X size={14} />
								</button>
							</div>
						)}
					</aside>
				</div>
			</div>
		</main>
	);
}

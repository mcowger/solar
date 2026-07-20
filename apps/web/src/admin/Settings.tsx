import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSession } from "../auth";
import { useTRPC } from "../trpc";

interface AllowlistEntry {
	id: string;
	endpointId: string;
	api: string;
	visibility: "public" | "private";
	name?: string;
	documents?: boolean;
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	verbosity?: "low" | "medium" | "high";
	capabilities?: {
		reasoningLevels: string[];
		supportsVerbosity: boolean;
		contextWindow?: number;
	};
	contextWindow?: number;
	contextPolicy?: ModelContextPolicy;
}

interface ModelContextPolicy {
	enabled: boolean;
	softTriggerTokens: number;
	targetTokens: number;
	hardInputTokens: number;
	maxPinnedAttachmentTokens: number;
	outputReserveTokens: number;
}

interface ProviderEndpoint {
	id: string;
	label: string;
	baseUrl: string;
	api: string;
}

interface ProviderForm {
	provider: string;
	hasApiKey: boolean;
	endpoints: ProviderEndpoint[];
	enabledModels: AllowlistEntry[];
	apis: string[];
}

interface ModelDescriptor {
	provider: string;
	endpointId: string;
	modelId: string;
	api: string;
	name: string;
}

interface ContextManagementSettings {
	global: {
		version: number;
		enabled: boolean;
		summaryPromptOverride: string | null;
		summaryPrompt: string;
		summaryPromptOverridden: boolean;
	};
}

interface PasteSettings {
	version: number;
	enabled: boolean;
	lineThreshold: number;
	byteThreshold: number;
}

const CONTEXT_TOKEN_STEP = 1_000;
const thinkingLevels = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
const verbosityLevels = ["low", "medium", "high"] as const;

const contextPolicyFields = [
	{
		field: "softTriggerTokens",
		label: "Soft trigger",
		min: CONTEXT_TOKEN_STEP,
	},
	{ field: "targetTokens", label: "Target", min: CONTEXT_TOKEN_STEP },
	{ field: "hardInputTokens", label: "Hard input", min: CONTEXT_TOKEN_STEP },
	{ field: "maxPinnedAttachmentTokens", label: "Pinned attachments", min: 0 },
	{
		field: "outputReserveTokens",
		label: "Output reserve",
		min: CONTEXT_TOKEN_STEP,
	},
] as const;

function formatTokenCount(tokens: number) {
	return `${Math.round(tokens / CONTEXT_TOKEN_STEP)}K`;
}

function ContextPolicySlider({
	label,
	min,
	value,
	max = 2_000_000,
	disabled,
	onChange,
}: {
	label: string;
	min: number;
	value: number;
	max?: number;
	disabled: boolean;
	onChange: (value: number) => void;
}) {
	return (
		<label className="grid gap-1">
			<span className="flex items-center justify-between gap-2 text-xs">
				<span>{label}</span>
				<output className="font-semibold tabular-nums">
					{formatTokenCount(value)}
				</output>
			</span>
			<input
				className="range range-primary range-xs"
				type="range"
				min={min}
				max={max}
				step={CONTEXT_TOKEN_STEP}
				value={value}
				disabled={disabled}
				onChange={(event) => onChange(Number(event.target.value))}
			/>
		</label>
	);
}

function defaultModelContextPolicy(
	provider: string,
	modelId: string,
	window: number,
): ModelContextPolicy {
	const identity = `${provider} ${modelId}`.toLowerCase();
	const configured = identity.includes("claude")
		? {
				enabled: true,
				softTriggerTokens: 500_000,
				targetTokens: 300_000,
				hardInputTokens: 900_000,
				maxPinnedAttachmentTokens: 64_000,
				outputReserveTokens: 32_000,
			}
		: identity.includes("gpt-5.6")
			? {
					enabled: true,
					softTriggerTokens: 272_000,
					targetTokens: 180_000,
					hardInputTokens: 600_000,
					maxPinnedAttachmentTokens: 64_000,
					outputReserveTokens: 32_000,
				}
			: undefined;
	const outputReserveTokens = Math.min(
		configured?.outputReserveTokens ?? 32_000,
		Math.max(1_000, window - 1_000),
	);
	const hardInputTokens = Math.min(
		configured?.hardInputTokens ?? window - outputReserveTokens,
		window - outputReserveTokens,
	);
	const targetTokens = Math.min(
		configured?.targetTokens ?? Math.floor(window * 0.45),
		hardInputTokens,
	);
	return {
		enabled: configured?.enabled ?? true,
		softTriggerTokens: Math.max(
			targetTokens,
			Math.min(
				configured?.softTriggerTokens ?? Math.floor(window * 0.7),
				hardInputTokens,
			),
		),
		targetTokens,
		hardInputTokens,
		maxPinnedAttachmentTokens: Math.min(
			configured?.maxPinnedAttachmentTokens ?? 64_000,
			hardInputTokens,
		),
		outputReserveTokens,
	};
}

function modelKey(
	model: Pick<ModelDescriptor, "provider" | "endpointId" | "modelId" | "api">,
) {
	return `${model.provider}/${model.endpointId}/${model.modelId}/${model.api}`;
}

function apiLabel(api: string) {
	return (
		{
			"openai-responses": "Responses",
			"openai-completions": "Chat",
			"anthropic-messages": "Messages",
			"google-generative-ai": "Gemini",
		}[api] ?? api
	);
}

function endpointLabel(endpoint: Pick<ProviderEndpoint, "label" | "api">) {
	return endpoint.label && endpoint.label !== endpoint.api
		? endpoint.label
		: apiLabel(endpoint.api);
}

function ModelSettingsModal({
	model,
	provider,
	endpoints,
	onChange,
	onClose,
}: {
	model: AllowlistEntry;
	provider: string;
	endpoints: ProviderEndpoint[];
	onChange: (patch: Partial<AllowlistEntry>) => void;
	onClose: () => void;
}) {
	const contextWindow =
		model.contextWindow ?? model.capabilities?.contextWindow ?? 128_000;
	const policy = model.contextPolicy;
	const policyError = (() => {
		if (!policy) return null;
		if (policy.outputReserveTokens >= contextWindow)
			return "Output reserve must be smaller than the context window.";
		if (policy.hardInputTokens > contextWindow - policy.outputReserveTokens)
			return "Hard input exceeds the usable context window.";
		if (
			policy.targetTokens > policy.softTriggerTokens ||
			policy.softTriggerTokens > policy.hardInputTokens
		)
			return "Target, trigger, and hard input must be ordered.";
		if (policy.maxPinnedAttachmentTokens > policy.hardInputTokens)
			return "Pinned attachment budget cannot exceed hard input.";
		return null;
	})();
	return (
		<div
			className="modal modal-open"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="modal-box max-w-lg">
				<div className="flex items-start justify-between gap-4">
					<div>
						<p className="text-xs tracking-[0.14em] uppercase opacity-60">
							Model settings
						</p>
						<h3 className="mt-1 text-xl font-semibold">
							{model.name ?? model.id}
						</h3>
						<p className="mt-1 break-all text-sm opacity-60">{model.id}</p>
					</div>
					<button
						className="btn btn-ghost btn-sm btn-square"
						onClick={onClose}
						title="Close settings"
					>
						✕
					</button>
				</div>
				<div className="mt-6 grid gap-4">
					<fieldset className="fieldset">
						<legend className="fieldset-legend">Endpoint</legend>
						<select
							className="select w-full"
							value={model.endpointId}
							onChange={(event) => {
								const endpoint = endpoints.find(
									(candidate) => candidate.id === event.target.value,
								);
								if (endpoint)
									onChange({ endpointId: endpoint.id, api: endpoint.api });
							}}
						>
							{endpoints.map((endpoint) => (
								<option key={endpoint.id} value={endpoint.id}>
									{endpointLabel(endpoint)}
								</option>
							))}
						</select>
					</fieldset>
					<label className="flex items-center justify-between gap-4 rounded-box bg-base-200 px-4 py-3">
						<span>
							<span className="block font-medium">Visible to all users</span>
							<span className="block text-sm opacity-60">
								Allow non-admin users to select this model.
							</span>
						</span>
						<input
							className="toggle toggle-primary checked:border-primary checked:bg-primary checked:text-primary-content"
							type="checkbox"
							checked={model.visibility === "public"}
							onChange={(event) =>
								onChange({
									visibility: event.target.checked ? "public" : "private",
								})
							}
						/>
					</label>
					<label className="flex items-center justify-between gap-4 rounded-box bg-base-200 px-4 py-3">
						<span>
							<span className="block font-medium">Documents</span>
							<span className="block text-sm opacity-60">
								Enable document attachments for this model.
							</span>
						</span>
						<input
							className="toggle toggle-primary checked:border-primary checked:bg-primary checked:text-primary-content"
							type="checkbox"
							checked={Boolean(model.documents)}
							onChange={(event) =>
								onChange({ documents: event.target.checked })
							}
						/>
					</label>
					<fieldset className="fieldset">
						<legend className="fieldset-legend">Thinking</legend>
						<select
							className="select w-full"
							value={model.reasoningEffort ?? ""}
							disabled={!model.capabilities?.reasoningLevels.length}
							onChange={(event) =>
								onChange({
									reasoningEffort:
										(event.target.value as AllowlistEntry["reasoningEffort"]) ||
										undefined,
								})
							}
						>
							<option value="">Provider default</option>
							{model.capabilities?.reasoningLevels.map((level) => (
								<option key={level} value={level}>
									{level}
								</option>
							))}
						</select>
					</fieldset>
					<fieldset className="fieldset">
						<legend className="fieldset-legend">Verbosity</legend>
						<select
							className="select w-full"
							value={model.verbosity ?? ""}
							disabled={!model.capabilities?.supportsVerbosity}
							onChange={(event) =>
								onChange({
									verbosity:
										(event.target.value as AllowlistEntry["verbosity"]) ||
										undefined,
								})
							}
						>
							<option value="">Provider default</option>
							{verbosityLevels.map((level) => (
								<option key={level} value={level}>
									{level}
								</option>
							))}
						</select>
					</fieldset>
					<fieldset className="fieldset">
						<legend className="fieldset-legend">Context window</legend>
						<input
							className="input w-full"
							type="number"
							min={1_000}
							max={10_000_000}
							step={1_000}
							value={model.contextWindow ?? contextWindow}
							onChange={(event) => {
								const value = event.target.valueAsNumber;
								onChange({
									contextWindow: Number.isFinite(value) ? value : undefined,
								});
							}}
						/>
						<p className="label">
							{model.contextWindow
								? "Custom model override."
								: `Detected from the model catalog: ${formatTokenCount(contextWindow)}.`}
						</p>
					</fieldset>
					<section className="rounded-box bg-base-200 p-4">
						<div className="flex items-start justify-between gap-3">
							<div>
								<h4 className="font-semibold">Context management</h4>
								<p className="text-sm opacity-60">
									{policy
										? "Custom values for this model."
										: "Using built-in defaults."}
								</p>
							</div>
							<button
								className="btn btn-ghost btn-sm"
								disabled={!policy}
								onClick={() => onChange({ contextPolicy: undefined })}
							>
								Use built-in defaults
							</button>
						</div>
						{!policy ? (
							<button
								className="btn btn-outline btn-sm mt-3"
								onClick={() =>
									onChange({
										contextWindow,
										contextPolicy: defaultModelContextPolicy(
											provider,
											model.id,
											contextWindow,
										),
									})
								}
							>
								Customize context management
							</button>
						) : (
							<>
								<label className="mt-3 flex items-center justify-between gap-3">
									<span className="text-sm">Enabled for this model</span>
									<input
										className="toggle toggle-primary checked:border-primary checked:bg-primary checked:text-primary-content"
										type="checkbox"
										checked={policy.enabled}
										onChange={(event) =>
											onChange({
												contextPolicy: {
													...policy,
													enabled: event.target.checked,
												},
											})
										}
									/>
								</label>
								<div className="mt-4 grid gap-x-4 gap-y-3 sm:grid-cols-2">
									{contextPolicyFields.map(({ field, label, min }) => (
										<ContextPolicySlider
											key={field}
											label={label}
											min={min}
											max={contextWindow}
											value={policy[field]}
											disabled={false}
											onChange={(value) =>
												onChange({
													contextPolicy: { ...policy, [field]: value },
												})
											}
										/>
									))}
								</div>
								{policyError && (
									<div
										role="alert"
										className="alert alert-error alert-soft mt-3 text-sm"
									>
										{policyError}
									</div>
								)}
							</>
						)}
					</section>
				</div>
				<div className="modal-action">
					<button className="btn" onClick={onClose}>
						Done
					</button>
				</div>
			</div>
		</div>
	);
}

function TaskModel() {
	const trpc = useTRPC();
	const qc = useQueryClient();
	const available = useQuery(trpc.model.available.queryOptions());
	const taskModel = useQuery(trpc.model.taskModel.queryOptions());
	const titlePrompt = useQuery(trpc.model.titlePrompt.queryOptions());
	const [prompt, setPrompt] = useState("");
	const [savedPrompt, setSavedPrompt] = useState("");
	useEffect(() => {
		if (titlePrompt.data !== undefined) {
			setPrompt(titlePrompt.data);
			setSavedPrompt(titlePrompt.data);
		}
	}, [titlePrompt.data]);
	const setTaskModel = useMutation(
		trpc.model.setTaskModel.mutationOptions({
			onSuccess: () =>
				qc.invalidateQueries({ queryKey: trpc.model.taskModel.queryKey() }),
		}),
	);
	const saveTitlePrompt = useMutation(
		trpc.model.setTitlePrompt.mutationOptions({
			onSuccess: (_, variables) => {
				setSavedPrompt(variables.prompt);
				qc.invalidateQueries({ queryKey: trpc.model.titlePrompt.queryKey() });
			},
		}),
	);
	const models = available.data ?? [];
	const selected = taskModel.data ? modelKey(taskModel.data) : "";
	const hasTitlePromptChanges = prompt !== savedPrompt;

	return (
		<section className="card card-border bg-base-100 shadow-sm">
			<div className="card-body gap-4 p-5">
				<h3 className="card-title">Task model</h3>
				<p className="text-sm opacity-70">
					Used for future lightweight work such as title generation and context
					management.
				</p>
				<fieldset className="fieldset max-w-lg">
					<legend className="fieldset-legend">Selected model</legend>
					<select
						className="select w-full"
						value={selected}
						disabled={!models.length || setTaskModel.isPending}
						onChange={(event) => {
							const model = models.find(
								(item) => modelKey(item) === event.target.value,
							);
							if (model) setTaskModel.mutate(model);
						}}
					>
						<option value="" disabled>
							{models.length ? "Select a task model" : "No models configured"}
						</option>
						{models.map((model) => (
							<option key={modelKey(model)} value={modelKey(model)}>
								{model.name} · {model.provider}
							</option>
						))}
					</select>
				</fieldset>
				<fieldset className="fieldset gap-2">
					<legend className="fieldset-legend">Chat title prompt</legend>
					<textarea
						className="textarea min-h-64 w-full font-mono text-sm"
						value={prompt}
						disabled={titlePrompt.isLoading || saveTitlePrompt.isPending}
						onChange={(event) => setPrompt(event.target.value)}
						placeholder="Use {{first_message}} where the first user message belongs."
					/>
					<p className="label">
						Use <code>{"{{first_message}}"}</code> to include the first user
						message.
					</p>
				</fieldset>
				{!prompt.includes("{{first_message}}") && (
					<div role="alert" className="alert alert-warning alert-soft text-sm">
						The prompt does not include {"{{first_message}}"}; titles will be
						generated without the first user message.
					</div>
				)}
				<div className="card-actions items-center justify-end">
					{!hasTitlePromptChanges && saveTitlePrompt.isSuccess && (
						<span className="text-sm font-medium text-success">
							Prompt saved
						</span>
					)}
					<button
						className="btn btn-primary"
						disabled={
							!prompt.trim() ||
							saveTitlePrompt.isPending ||
							!hasTitlePromptChanges
						}
						onClick={() => saveTitlePrompt.mutate({ prompt })}
					>
						{saveTitlePrompt.isPending
							? "Saving…"
							: !hasTitlePromptChanges && saveTitlePrompt.isSuccess
								? "Saved"
								: "Save title prompt"}
					</button>
				</div>
				{(setTaskModel.isError || saveTitlePrompt.isError) && (
					<div role="alert" className="alert alert-error alert-soft">
						{setTaskModel.error?.message ?? saveTitlePrompt.error?.message}
					</div>
				)}
			</div>
		</section>
	);
}

function ProviderCard({ initial }: { initial: ProviderForm }) {
	const trpc = useTRPC();
	const qc = useQueryClient();
	const [apiKey, setApiKey] = useState("");
	const [endpoints, setEndpoints] = useState(initial.endpoints);
	const [models, setModels] = useState<AllowlistEntry[]>(initial.enabledModels);
	const [savedConfiguration, setSavedConfiguration] = useState(() =>
		JSON.stringify({
			endpoints: initial.endpoints,
			models: initial.enabledModels,
		}),
	);
	const [discovery, setDiscovery] = useState<{
		endpointId: string;
		models: { id: string; name: string; preferredApi: string | null }[];
	} | null>(null);
	const [imports, setImports] = useState<
		Record<string, { api: string; visibility: "public" | "private" }>
	>({});
	const [settingsIndex, setSettingsIndex] = useState<number | null>(null);
	useEffect(() => {
		setEndpoints(initial.endpoints);
		setModels(initial.enabledModels);
		setSavedConfiguration(
			JSON.stringify({
				endpoints: initial.endpoints,
				models: initial.enabledModels,
			}),
		);
	}, [initial.endpoints, initial.enabledModels]);
	const save = useMutation(
		trpc.admin.setProvider.mutationOptions({
			onSuccess: (_, variables) => {
				setApiKey("");
				setSavedConfiguration(
					JSON.stringify({
						endpoints: variables.endpoints,
						models: variables.enabledModels,
					}),
				);
				qc.invalidateQueries({ queryKey: trpc.admin.listProviders.queryKey() });
				qc.invalidateQueries({ queryKey: trpc.model.available.queryKey() });
			},
		}),
	);
	const remove = useMutation(
		trpc.admin.deleteProvider.mutationOptions({
			onSuccess: () => {
				qc.invalidateQueries({ queryKey: trpc.admin.listProviders.queryKey() });
				qc.invalidateQueries({ queryKey: trpc.model.available.queryKey() });
				qc.invalidateQueries({ queryKey: trpc.model.taskModel.queryKey() });
			},
		}),
	);
	const queryModels = useMutation(
		trpc.admin.queryProviderModels.mutationOptions({
			onSuccess: (result, variables) => {
				setDiscovery({ endpointId: variables.endpointId, models: result });
				setImports({});
			},
		}),
	);
	const importModels = useMutation(
		trpc.admin.importProviderModels.mutationOptions({
			onSuccess: () => {
				setDiscovery(null);
				setImports({});
				qc.invalidateQueries({ queryKey: trpc.admin.listProviders.queryKey() });
				qc.invalidateQueries({ queryKey: trpc.model.available.queryKey() });
			},
		}),
	);
	const addEndpoint = () =>
		setEndpoints((current) => [
			...current,
			{
				id: crypto.randomUUID(),
				label: "",
				baseUrl: "",
				api:
					initial.apis.find(
						(api) => !current.some((endpoint) => endpoint.api === api),
					) ??
					initial.apis[0] ??
					"",
			},
		]);
	const updateEndpoint = (id: string, patch: Partial<ProviderEndpoint>) =>
		setEndpoints((current) =>
			current.map((endpoint) =>
				endpoint.id === id ? { ...endpoint, ...patch } : endpoint,
			),
		);
	const removeEndpoint = (endpoint: ProviderEndpoint) => {
		if (
			!window.confirm(
				`Remove the ${apiLabel(endpoint.api)} endpoint and its imported models?`,
			)
		)
			return;
		setEndpoints((current) =>
			current.filter((candidate) => candidate.id !== endpoint.id),
		);
		setModels((current) =>
			current.filter((model) => model.endpointId !== endpoint.id),
		);
	};
	const updateModel = (index: number, patch: Partial<AllowlistEntry>) =>
		setModels((models) =>
			models.map((model, modelIndex) =>
				modelIndex === index ? { ...model, ...patch } : model,
			),
		);
	const removeModel = (index: number) =>
		setModels((models) =>
			models.filter((_, modelIndex) => modelIndex !== index),
		);
	const importableApis = endpoints.map((endpoint) => endpoint.api);
	const selectedImports = Object.entries(imports).map(([id, selection]) => ({
		id,
		...selection,
	}));
	const hasChanges =
		apiKey.length > 0 ||
		JSON.stringify({ endpoints, models }) !== savedConfiguration;

	return (
		<section className="card card-border bg-base-100 shadow-sm">
			<div className="card-body gap-4 p-4 sm:p-5">
				<h3 className="card-title capitalize">{initial.provider}</h3>
				<fieldset className="fieldset grid min-w-0 content-start gap-1">
					<legend className="fieldset-legend">API key</legend>
					<input
						className="input input-sm w-full"
						type="password"
						value={apiKey}
						onChange={(event) => setApiKey(event.target.value)}
						placeholder={
							initial.hasApiKey ? "Saved — enter to replace" : "sk-…"
						}
					/>
					<p className="label">One key is shared by every endpoint.</p>
				</fieldset>
				<fieldset className="fieldset gap-2">
					<legend className="fieldset-legend">Endpoints</legend>
					{endpoints.map((endpoint) => (
						<div key={endpoint.id} className="rounded-box bg-base-200 p-2">
							<div className="grid items-center gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_11rem_auto]">
								<input
									className="input input-sm min-w-0"
									value={endpoint.label}
									onChange={(event) =>
										updateEndpoint(endpoint.id, { label: event.target.value })
									}
									placeholder="Label"
								/>
								<input
									className="input input-sm min-w-0"
									value={endpoint.baseUrl}
									onChange={(event) =>
										updateEndpoint(endpoint.id, { baseUrl: event.target.value })
									}
									placeholder="https://plexus.example/v1"
								/>
								<select
									className="select select-sm min-w-0"
									value={endpoint.api}
									onChange={(event) =>
										updateEndpoint(endpoint.id, { api: event.target.value })
									}
								>
									{initial.apis.map((api) => (
										<option
											key={api}
											value={api}
											disabled={endpoints.some(
												(candidate) =>
													candidate.id !== endpoint.id && candidate.api === api,
											)}
										>
											{apiLabel(api)}
										</option>
									))}
								</select>
								<div className="flex items-center gap-1">
									<button
										className="btn btn-sm"
										disabled={!endpoint.baseUrl || queryModels.isPending}
										onClick={() =>
											queryModels.mutate({
												provider: initial.provider,
												endpointId: endpoint.id,
											})
										}
									>
										{queryModels.isPending ? "Querying…" : "Query models"}
									</button>
									<button
										className="btn btn-error btn-soft btn-sm btn-square"
										onClick={() => removeEndpoint(endpoint)}
										title="Remove endpoint"
									>
										✕
									</button>
								</div>
							</div>
						</div>
					))}
					<button
						className="btn btn-sm btn-outline w-fit"
						onClick={addEndpoint}
						disabled={endpoints.length === initial.apis.length}
					>
						Add endpoint
					</button>
				</fieldset>
				{discovery && (
					<fieldset className="fieldset gap-2">
						<legend className="fieldset-legend">
							Available text generation models
						</legend>
						<div className="overflow-x-auto">
							<table className="table table-sm">
								<thead>
									<tr>
										<th>Import</th>
										<th>Model</th>
										<th>Preferred API</th>
										<th>Visibility</th>
									</tr>
								</thead>
								<tbody>
									{discovery.models.map((model) => {
										const selected = imports[model.id];
										const preferredApi = importableApis.includes(
											model.preferredApi ?? "",
										)
											? model.preferredApi!
											: (importableApis[0] ?? "");
										return (
											<tr key={model.id}>
												<td>
													<input
														className="checkbox checkbox-sm"
														type="checkbox"
														checked={Boolean(selected)}
														onChange={(event) =>
															setImports((current) => {
																const next = { ...current };
																if (event.target.checked)
																	next[model.id] = {
																		api: preferredApi,
																		visibility: "public",
																	};
																else delete next[model.id];
																return next;
															})
														}
													/>
												</td>
												<td>
													<span className="font-medium">{model.name}</span>
													<span className="block text-xs opacity-60">
														{model.id}
													</span>
												</td>
												<td>
													<select
														className="select select-xs"
														disabled={!selected}
														value={selected?.api ?? preferredApi}
														onChange={(event) =>
															setImports((current) => ({
																...current,
																[model.id]: {
																	api: event.target.value,
																	visibility:
																		current[model.id]?.visibility ?? "public",
																},
															}))
														}
													>
														{importableApis.map((api) => (
															<option key={api} value={api}>
																{api}
															</option>
														))}
													</select>
												</td>
												<td>
													<select
														className="select select-xs"
														disabled={!selected}
														value={selected?.visibility ?? "public"}
														onChange={(event) =>
															setImports((current) => ({
																...current,
																[model.id]: {
																	api: current[model.id]?.api ?? preferredApi,
																	visibility: event.target.value as
																		| "public"
																		| "private",
																},
															}))
														}
													>
														<option value="public">Public</option>
														<option value="private">Private</option>
													</select>
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
						<div className="card-actions justify-end">
							<button
								className="btn btn-primary btn-sm"
								disabled={!selectedImports.length || importModels.isPending}
								onClick={() =>
									importModels.mutate({
										provider: initial.provider,
										endpointId: discovery.endpointId,
										models: selectedImports,
									})
								}
							>
								{importModels.isPending
									? "Importing…"
									: `Import ${selectedImports.length} selected`}
							</button>
						</div>
					</fieldset>
				)}
				<fieldset className="fieldset gap-1">
					<legend className="fieldset-legend">Imported models</legend>
					<ul className="list divide-y divide-base-300 rounded-box border border-base-300 bg-base-100">
						{models.map((model, index) => (
							<li key={index} className="list-row gap-3 px-3 py-3 sm:px-4">
								<div className="list-col-grow min-w-0">
									<p className="truncate font-medium">
										{model.name ?? model.id}
									</p>
									<p className="truncate text-xs opacity-60">
										{endpointLabel(
											endpoints.find(
												(endpoint) => endpoint.id === model.endpointId,
											) ?? { label: model.api, api: model.api },
										)}{" "}
										· {model.id}
									</p>
								</div>
								<div className="hidden items-center gap-1.5 text-xs sm:flex">
									<span
										className={`badge badge-sm ${model.visibility === "public" ? "badge-success badge-soft" : "badge-warning badge-soft"}`}
									>
										{model.visibility}
									</span>
									{model.documents && (
										<span className="badge badge-sm badge-outline">
											Documents
										</span>
									)}
									{model.reasoningEffort && (
										<span className="badge badge-sm badge-outline">
											Thinking: {model.reasoningEffort}
										</span>
									)}
								</div>
								<button
									className="btn btn-ghost btn-sm btn-square"
									onClick={() => setSettingsIndex(index)}
									title={`Configure ${model.name ?? model.id}`}
								>
									<span aria-hidden="true">⚙</span>
								</button>
								<button
									className="btn btn-ghost btn-sm btn-square text-error"
									onClick={() => {
										if (window.confirm(`Remove ${model.name ?? model.id}?`))
											removeModel(index);
									}}
									title="Remove model"
								>
									✕
								</button>
							</li>
						))}
					</ul>
					{settingsIndex !== null && models[settingsIndex] && (
						<ModelSettingsModal
							model={models[settingsIndex]}
							provider={initial.provider}
							endpoints={endpoints}
							onChange={(patch) => updateModel(settingsIndex, patch)}
							onClose={() => setSettingsIndex(null)}
						/>
					)}
				</fieldset>
				<div className="card-actions items-center justify-end">
					{(save.isError ||
						remove.isError ||
						queryModels.isError ||
						importModels.isError) && (
						<div
							role="alert"
							className="alert alert-error alert-soft py-2 text-sm"
						>
							{save.error?.message ??
								remove.error?.message ??
								queryModels.error?.message ??
								importModels.error?.message}
						</div>
					)}
					{!hasChanges && save.isSuccess && (
						<span className="text-sm font-medium text-success">
							Provider saved
						</span>
					)}
					<button
						className="btn btn-error btn-soft"
						disabled={remove.isPending}
						onClick={() => {
							if (
								window.confirm(
									`Delete ${initial.provider} and all of its endpoints and models?`,
								)
							)
								remove.mutate({ provider: initial.provider });
						}}
					>
						{remove.isPending ? "Deleting…" : "Delete provider"}
					</button>
					<button
						className="btn btn-primary"
						onClick={() =>
							save.mutate({
								provider: initial.provider,
								apiKey,
								endpoints,
								enabledModels: models,
							})
						}
						disabled={save.isPending || remove.isPending || !hasChanges}
					>
						{save.isPending
							? "Saving…"
							: !hasChanges && save.isSuccess
								? "Saved"
								: "Save provider"}
					</button>
				</div>
			</div>
		</section>
	);
}

function Users() {
	const trpc = useTRPC();
	const qc = useQueryClient();
	const { data: session } = useSession();
	const [newUser, setNewUser] = useState({ name: "", email: "", password: "" });
	const users = useQuery(trpc.admin.listUsers.queryOptions());
	const invalidate = () =>
		qc.invalidateQueries({ queryKey: trpc.admin.listUsers.queryKey() });
	const setRole = useMutation(
		trpc.admin.setUserRole.mutationOptions({ onSuccess: invalidate }),
	);
	const setDisabled = useMutation(
		trpc.admin.setUserDisabled.mutationOptions({ onSuccess: invalidate }),
	);
	const remove = useMutation(
		trpc.admin.deleteUser.mutationOptions({ onSuccess: invalidate }),
	);
	const create = useMutation(
		trpc.admin.createUser.mutationOptions({
			onSuccess: () => {
				setNewUser({ name: "", email: "", password: "" });
				invalidate();
			},
		}),
	);

	return (
		<section className="card card-border bg-base-100 shadow-sm">
			<div className="card-body p-5">
				<h3 className="card-title">Users</h3>
				<form
					className="grid gap-2 sm:grid-cols-4"
					onSubmit={(event) => {
						event.preventDefault();
						create.mutate(newUser);
					}}
				>
					<input
						className="input input-sm min-w-0"
						placeholder="Name"
						value={newUser.name}
						onChange={(event) =>
							setNewUser({ ...newUser, name: event.target.value })
						}
						required
					/>
					<input
						className="input input-sm min-w-0"
						type="email"
						placeholder="Email"
						value={newUser.email}
						onChange={(event) =>
							setNewUser({ ...newUser, email: event.target.value })
						}
						required
					/>
					<input
						className="input input-sm min-w-0"
						type="password"
						placeholder="Password (min 8)"
						value={newUser.password}
						onChange={(event) =>
							setNewUser({ ...newUser, password: event.target.value })
						}
						minLength={8}
						required
					/>
					<button
						className="btn btn-sm"
						disabled={create.isPending}
						type="submit"
					>
						{create.isPending ? "Adding…" : "Add user"}
					</button>
				</form>
				{create.isError && (
					<div role="alert" className="alert alert-error alert-soft text-sm">
						{create.error.message}
					</div>
				)}
				{users.isError && (
					<div role="alert" className="alert alert-error alert-soft">
						{users.error.message}
					</div>
				)}
				<div className="divide-y divide-base-300">
					{users.data?.map((user) => {
						const isCurrentUser = user.id === session?.user.id;
						return (
							<div
								key={user.id}
								className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center"
							>
								<div className="min-w-0 flex-1">
									<p className="font-medium">{user.name}</p>
									<p className="truncate text-sm opacity-60">{user.email}</p>
								</div>
								<div className="flex flex-wrap gap-2">
									<select
										className="select select-sm"
										value={user.role}
										disabled={isCurrentUser || setRole.isPending}
										onChange={(event) =>
											setRole.mutate({
												userId: user.id,
												role: event.target.value as "admin" | "user",
											})
										}
									>
										<option value="user">User</option>
										<option value="admin">Admin</option>
									</select>
									<button
										className="btn btn-sm"
										disabled={isCurrentUser || setDisabled.isPending}
										onClick={() =>
											setDisabled.mutate({
												userId: user.id,
												isDisabled: !Boolean(user.isDisabled),
											})
										}
									>
										{user.isDisabled ? "Enable" : "Disable"}
									</button>
									<button
										className="btn btn-error btn-soft btn-sm"
										disabled={isCurrentUser || remove.isPending}
										onClick={() => {
											if (
												window.confirm(
													`Delete ${user.email} and all of their data?`,
												)
											)
												remove.mutate({ userId: user.id });
										}}
									>
										Delete
									</button>
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</section>
	);
}

function ApiKeys() {
	const trpc = useTRPC();
	const qc = useQueryClient();
	const [name, setName] = useState("");
	const [revealedKey, setRevealedKey] = useState<string | null>(null);
	const keys = useQuery(trpc.admin.listApiKeys.queryOptions());
	const invalidate = () =>
		qc.invalidateQueries({ queryKey: trpc.admin.listApiKeys.queryKey() });
	const create = useMutation(
		trpc.admin.createApiKey.mutationOptions({
			onSuccess: (result) => {
				setName("");
				setRevealedKey(result.key);
				invalidate();
			},
		}),
	);
	const rotate = useMutation(
		trpc.admin.rotateApiKey.mutationOptions({
			onSuccess: (result) => {
				setRevealedKey(result.key);
				invalidate();
			},
		}),
	);
	const revoke = useMutation(
		trpc.admin.revokeApiKey.mutationOptions({ onSuccess: invalidate }),
	);

	return (
		<section className="card card-border bg-base-100 shadow-sm">
			<div className="card-body gap-4 p-5">
				<div>
					<h3 className="card-title">API keys</h3>
					<p className="text-sm opacity-70">
						Keys grant full administrator access. They never expire and can only
						be used by their creating admin.
					</p>
				</div>
				{revealedKey && (
					<div role="alert" className="alert alert-success alert-soft">
						<div className="min-w-0 flex-1">
							<p className="font-medium">Copy this key now</p>
							<p className="text-sm">It cannot be shown again.</p>
							<input
								className="input mt-2 w-full font-mono text-xs"
								readOnly
								value={revealedKey}
								onFocus={(event) => event.currentTarget.select()}
							/>
						</div>
						<button
							className="btn btn-sm"
							onClick={() => void navigator.clipboard.writeText(revealedKey)}
						>
							Copy
						</button>
					</div>
				)}
				<div className="flex flex-col gap-2 sm:flex-row">
					<input
						className="input input-sm min-w-0 flex-1"
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="Key name"
					/>
					<button
						className="btn btn-sm"
						disabled={!name.trim() || create.isPending}
						onClick={() => create.mutate({ name: name.trim() })}
					>
						{create.isPending ? "Creating…" : "Create key"}
					</button>
				</div>
				{(keys.isError ||
					create.isError ||
					rotate.isError ||
					revoke.isError) && (
					<div role="alert" className="alert alert-error alert-soft text-sm">
						{keys.error?.message ??
							create.error?.message ??
							rotate.error?.message ??
							revoke.error?.message}
					</div>
				)}
				<div className="overflow-x-auto">
					<table className="table table-sm">
						<thead>
							<tr>
								<th>Name</th>
								<th>Key</th>
								<th>Created</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{keys.data?.map((key) => (
								<tr key={key.id}>
									<td>{key.name}</td>
									<td className="font-mono text-xs">{key.start}…</td>
									<td>{new Date(key.createdAt).toLocaleDateString()}</td>
									<td>
										<div className="flex justify-end gap-2">
											<button
												className="btn btn-sm"
												disabled={rotate.isPending || revoke.isPending}
												onClick={() => {
													if (
														window.confirm(
															`Rotate ${key.name}? The old key stops working immediately.`,
														)
													)
														rotate.mutate({ keyId: key.id });
												}}
											>
												Rotate
											</button>
											<button
												className="btn btn-error btn-soft btn-sm"
												disabled={rotate.isPending || revoke.isPending}
												onClick={() => {
													if (
														window.confirm(
															`Revoke ${key.name}? This cannot be undone.`,
														)
													)
														revoke.mutate({ keyId: key.id });
												}}
											>
												Revoke
											</button>
										</div>
									</td>
								</tr>
							))}
							{keys.data?.length === 0 && (
								<tr>
									<td colSpan={4} className="text-center opacity-60">
										No API keys yet.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			</div>
		</section>
	);
}

function Usage() {
	const trpc = useTRPC();
	const usage = useQuery(trpc.admin.usage.queryOptions());
	return (
		<section className="card card-border bg-base-100 shadow-sm">
			<div className="card-body p-5">
				<h3 className="card-title">Usage</h3>
				{usage.isError && (
					<div role="alert" className="alert alert-error alert-soft">
						{usage.error.message}
					</div>
				)}
				<div className="grid gap-3 sm:hidden">
					{usage.data?.map((row) => (
						<div
							key={`${row.userId}:${row.model}`}
							className="rounded-box bg-base-200 p-4"
						>
							<p className="truncate font-medium">{row.email}</p>
							<p className="mt-1 break-words text-sm opacity-60">{row.model}</p>
							<dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
								<div>
									<dt className="opacity-60">Messages</dt>
									<dd className="mt-1 font-medium">{row.messageCount}</dd>
								</div>
								<div>
									<dt className="opacity-60">Input</dt>
									<dd className="mt-1 font-medium">{row.inputTokens}</dd>
								</div>
								<div>
									<dt className="opacity-60">Output</dt>
									<dd className="mt-1 font-medium">{row.outputTokens}</dd>
								</div>
								<div>
									<dt className="opacity-60">Total</dt>
									<dd className="mt-1 font-medium">
										{row.inputTokens + row.outputTokens}
									</dd>
								</div>
							</dl>
						</div>
					))}
				</div>
				<div className="hidden min-w-0 overflow-x-auto sm:block">
					<table className="table table-zebra">
						<thead>
							<tr>
								<th>User</th>
								<th>Model</th>
								<th>Messages</th>
								<th>Input</th>
								<th>Output</th>
								<th>Total</th>
							</tr>
						</thead>
						<tbody>
							{usage.data?.map((row) => (
								<tr key={`${row.userId}:${row.model}`}>
									<td>{row.email}</td>
									<td>{row.model}</td>
									<td>{row.messageCount}</td>
									<td>{row.inputTokens}</td>
									<td>{row.outputTokens}</td>
									<td>{row.inputTokens + row.outputTokens}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</section>
	);
}

function Logging() {
	const trpc = useTRPC();
	const qc = useQueryClient();
	const logLevel = useQuery(trpc.admin.logLevel.queryOptions());
	const setLogLevel = useMutation(
		trpc.admin.setLogLevel.mutationOptions({
			onSuccess: () =>
				qc.invalidateQueries({ queryKey: trpc.admin.logLevel.queryKey() }),
		}),
	);
	return (
		<section className="card card-border bg-base-100 shadow-sm">
			<div className="card-body p-5">
				<h3 className="card-title">Logging</h3>
				<p className="text-sm opacity-70">
					Changes apply immediately and reset when the server restarts.
				</p>
				{logLevel.data && (
					<fieldset className="fieldset max-w-xs">
						<legend className="fieldset-legend">Log level</legend>
						<select
							className="select w-full"
							value={logLevel.data.level}
							disabled={setLogLevel.isPending}
							onChange={(event) =>
								setLogLevel.mutate({
									level: event.target.value as
										| "trace"
										| "debug"
										| "info"
										| "warn"
										| "error",
								})
							}
						>
							<option value="trace">Trace</option>
							<option value="debug">Debug</option>
							<option value="info">Info</option>
							<option value="warn">Warn</option>
							<option value="error">Error</option>
						</select>
					</fieldset>
				)}
				{setLogLevel.isError && (
					<div role="alert" className="alert alert-error alert-soft">
						{setLogLevel.error.message}
					</div>
				)}
			</div>
		</section>
	);
}

function GlobalContextManagement() {
	const trpc = useTRPC();
	const qc = useQueryClient();
	const settings = useQuery(
		trpc.admin.contextManagementSettings.queryOptions(),
	);
	const save = useMutation(
		trpc.admin.setContextManagementGlobal.mutationOptions({
			onSuccess: () =>
				qc.invalidateQueries({
					queryKey: trpc.admin.contextManagementSettings.queryKey(),
				}),
		}),
	);
	const reset = useMutation(
		trpc.admin.resetContextSummaryPrompt.mutationOptions({
			onSuccess: () =>
				qc.invalidateQueries({
					queryKey: trpc.admin.contextManagementSettings.queryKey(),
				}),
		}),
	);
	const [form, setForm] = useState<ContextManagementSettings["global"] | null>(
		null,
	);
	useEffect(() => {
		if (settings.data) setForm(settings.data.global);
	}, [settings.data]);
	if (settings.isError)
		return (
			<div role="alert" className="alert alert-error alert-soft">
				{settings.error.message}
			</div>
		);
	if (!form) return null;
	const changed =
		form.enabled !== settings.data?.global.enabled ||
		form.summaryPromptOverride !== settings.data?.global.summaryPromptOverride;
	return (
		<section className="card card-border bg-base-100 shadow-sm">
			<div className="card-body gap-4 p-5">
				<h3 className="card-title">Global context management</h3>
				<p className="text-sm opacity-70">
					Per-model policies are configured from each model’s settings modal.
				</p>
				<label className="flex items-center gap-3">
					<input
						className="toggle toggle-primary checked:border-primary checked:bg-primary checked:text-primary-content"
						type="checkbox"
						checked={form.enabled}
						disabled={save.isPending}
						onChange={(event) =>
							setForm({ ...form, enabled: event.target.checked })
						}
					/>
					<span className="text-sm">Context management enabled</span>
				</label>
				<fieldset className="fieldset gap-2">
					<legend className="fieldset-legend">Summary prompt</legend>
					<textarea
						className="textarea min-h-48 w-full font-mono text-sm"
						value={form.summaryPromptOverride ?? form.summaryPrompt}
						disabled={save.isPending}
						onChange={(event) =>
							setForm({ ...form, summaryPromptOverride: event.target.value })
						}
					/>
					<p className="label">
						{form.summaryPromptOverridden || form.summaryPromptOverride !== null
							? "Custom version 1 override."
							: "Using the built-in version 1 summary prompt."}
					</p>
				</fieldset>
				{(save.isError || reset.isError) && (
					<div role="alert" className="alert alert-error alert-soft">
						{save.error?.message ?? reset.error?.message}
					</div>
				)}
				<div className="card-actions justify-end">
					<button
						className="btn btn-ghost"
						disabled={!form.summaryPromptOverride || reset.isPending}
						onClick={() => reset.mutate()}
					>
						Reset summary prompt
					</button>
					<button
						className="btn btn-primary"
						disabled={save.isPending || !changed}
						onClick={() =>
							save.mutate({
								enabled: form.enabled,
								summaryPromptOverride: form.summaryPromptOverride,
							})
						}
					>
						{save.isPending ? "Saving…" : "Save global settings"}
					</button>
				</div>
			</div>
		</section>
	);
}

function PasteHandling() {
	const trpc = useTRPC();
	const qc = useQueryClient();
	const settings = useQuery(trpc.admin.pasteSettings.queryOptions());
	const [form, setForm] = useState<PasteSettings | null>(null);
	useEffect(() => {
		if (settings.data) setForm(settings.data);
	}, [settings.data]);
	const save = useMutation(
		trpc.admin.setPasteSettings.mutationOptions({
			onSuccess: async () => {
				await Promise.all([
					qc.invalidateQueries({
						queryKey: trpc.admin.pasteSettings.queryKey(),
					}),
					qc.invalidateQueries({ queryKey: trpc.pasteSettings.queryKey() }),
				]);
			},
		}),
	);

	if (settings.isError)
		return (
			<div role="alert" className="alert alert-error alert-soft">
				{settings.error.message}
			</div>
		);
	if (!form) return null;
	const hasChanges =
		form.enabled !== settings.data?.enabled ||
		form.lineThreshold !== settings.data?.lineThreshold ||
		form.byteThreshold !== settings.data?.byteThreshold;
	const valid =
		Number.isInteger(form.lineThreshold) &&
		form.lineThreshold >= 1 &&
		form.lineThreshold <= 100_000 &&
		Number.isInteger(form.byteThreshold) &&
		form.byteThreshold >= 1 &&
		form.byteThreshold <= 20 * 1024 * 1024;
	return (
		<section className="card card-border bg-base-100 shadow-sm">
			<div className="card-body gap-4 p-5">
				<div>
					<h3 className="card-title">Large pasted text</h3>
					<p className="text-sm opacity-70">
						Convert large text-only pastes into removable text file attachments.
					</p>
				</div>
				<label className="flex items-center gap-3">
					<input
						className="toggle toggle-primary checked:border-primary checked:bg-primary checked:text-primary-content"
						type="checkbox"
						checked={form.enabled}
						disabled={save.isPending}
						onChange={(event) =>
							setForm({ ...form, enabled: event.target.checked })
						}
					/>
					<span className="text-sm">Automatic conversion enabled</span>
				</label>
				<div className="grid gap-3 sm:grid-cols-2">
					<label className="fieldset">
						<span className="fieldset-legend">Line threshold</span>
						<input
							className="input w-full"
							type="number"
							min={1}
							max={100_000}
							value={form.lineThreshold}
							disabled={save.isPending}
							onChange={(event) =>
								setForm({ ...form, lineThreshold: event.target.valueAsNumber })
							}
						/>
						<span className="label">
							Convert when paste exceeds this many lines.
						</span>
					</label>
					<label className="fieldset">
						<span className="fieldset-legend">Size threshold (bytes)</span>
						<input
							className="input w-full"
							type="number"
							min={1}
							max={20 * 1024 * 1024}
							value={form.byteThreshold}
							disabled={save.isPending}
							onChange={(event) =>
								setForm({ ...form, byteThreshold: event.target.valueAsNumber })
							}
						/>
						<span className="label">Uses UTF-8 bytes; maximum is 20 MiB.</span>
					</label>
				</div>
				{save.isError && (
					<div role="alert" className="alert alert-error alert-soft">
						{save.error.message}
					</div>
				)}
				<div className="card-actions items-center justify-end">
					{!hasChanges && save.isSuccess && (
						<span className="text-sm font-medium text-success">Saved</span>
					)}
					<button
						className="btn btn-primary"
						disabled={save.isPending || !hasChanges || !valid}
						onClick={() =>
							save.mutate({
								enabled: form.enabled,
								lineThreshold: form.lineThreshold,
								byteThreshold: form.byteThreshold,
							})
						}
					>
						{save.isPending ? "Saving…" : "Save settings"}
					</button>
				</div>
			</div>
		</section>
	);
}

const sections = [
	"users",
	"api keys",
	"providers",
	"task model",
	"paste handling",
	"usage",
	"logging",
] as const;
type Section = (typeof sections)[number];

export function Settings({ onClose }: { onClose: () => void }) {
	const trpc = useTRPC();
	const qc = useQueryClient();
	const providers = useQuery(trpc.admin.listProviders.queryOptions());
	const [ready, setReady] = useState(false);
	const [section, setSection] = useState<Section>("users");
	const [providerName, setProviderName] = useState("");
	const createProvider = useMutation(
		trpc.admin.setProvider.mutationOptions({
			onSuccess: () => {
				setProviderName("");
				qc.invalidateQueries({ queryKey: trpc.admin.listProviders.queryKey() });
			},
		}),
	);
	useEffect(() => {
		if (providers.isSuccess) setReady(true);
	}, [providers.isSuccess]);

	return (
		<div className="modal modal-open">
			<div className="modal-box flex h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-6xl flex-col p-0 sm:h-[calc(100dvh-2rem)] sm:w-11/12">
				<header className="flex items-center justify-between gap-3 border-b border-base-300 px-4 py-3 sm:px-5">
					<div>
						<p className="text-sm tracking-[0.16em] uppercase opacity-60">
							Administration
						</p>
						<h2 className="m-0 text-2xl sm:text-3xl">Settings</h2>
					</div>
					<button className="btn btn-ghost btn-sm" onClick={onClose}>
						Close
					</button>
				</header>
				<div className="overflow-y-auto p-4 sm:p-5">
					<div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
						<div
							role="tablist"
							className="tabs tabs-box w-fit max-w-full overflow-x-auto"
						>
							{sections.map((name) => (
								<button
									key={name}
									role="tab"
									className={`tab capitalize${section === name ? " tab-active" : ""}`}
									onClick={() => setSection(name)}
								>
									{name}
								</button>
							))}
						</div>
						{section === "users" && <Users />}
						{section === "api keys" && <ApiKeys />}
						{section === "usage" && <Usage />}
						{section === "logging" && <Logging />}
						{section === "task model" && <TaskModel />}
						{section === "paste handling" && <PasteHandling />}
						{section === "providers" && providers.isError && (
							<div role="alert" className="alert alert-error alert-soft">
								{providers.error.message}
							</div>
						)}
						{section === "providers" && ready && (
							<div className="grid gap-4">
								<GlobalContextManagement />
								<section className="card card-border bg-base-100 shadow-sm">
									<div className="card-body gap-3 p-4 sm:p-5">
										<h3 className="card-title">Add provider</h3>
										<p className="text-sm opacity-70">
											A provider shares one API key across one or more API
											endpoints.
										</p>
										<div className="flex flex-col gap-2 sm:flex-row">
											<input
												className="input input-sm min-w-0 flex-1"
												value={providerName}
												onChange={(event) =>
													setProviderName(event.target.value)
												}
												placeholder="Provider name"
											/>
											<button
												className="btn btn-sm"
												disabled={
													!providerName.trim() || createProvider.isPending
												}
												onClick={() =>
													createProvider.mutate({
														provider: providerName.trim(),
														apiKey: "",
														endpoints: [],
														enabledModels: [],
													})
												}
											>
												{createProvider.isPending ? "Adding…" : "Add provider"}
											</button>
										</div>
										{createProvider.isError && (
											<div
												role="alert"
												className="alert alert-error alert-soft text-sm"
											>
												{createProvider.error.message}
											</div>
										)}
									</div>
								</section>
								{providers.data?.map((provider) => (
									<ProviderCard key={provider.provider} initial={provider} />
								))}
							</div>
						)}
						<footer className="px-1 text-xs text-base-content/60">
							Location data ©{" "}
							<a
								className="link link-hover"
								href="https://www.openstreetmap.org/copyright"
								target="_blank"
								rel="noreferrer"
							>
								OpenStreetMap contributors
							</a>
							, ODbL.
						</footer>
					</div>
				</div>
			</div>
			<div className="modal-backdrop" onClick={onClose} />
		</div>
	);
}

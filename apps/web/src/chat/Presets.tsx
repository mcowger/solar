import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { useState } from "react";
import { useTRPC } from "../trpc";
import { sortModelsByName } from "./sortModels";

interface ModelDescriptor {
	provider: string;
	endpointId: string;
	modelId: string;
	api: string;
	name: string;
	reasoning: boolean;
	vision: boolean;
}

const REASONING_LEVELS = [
	"",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

interface PresetForm {
	id?: string;
	name: string;
	scope: "personal" | "shared";
	provider: string;
	endpointId: string;
	modelId: string;
	api: string;
	systemPrompt: string;
	reasoningEffort: string;
	reasoningSummary: boolean;
}

function modelKey(m: {
	provider: string;
	endpointId: string;
	modelId: string;
	api: string;
}) {
	return `${m.provider}/${m.endpointId}/${m.modelId}/${m.api}`;
}

/** Display name for a preset's model, or its stored id when it is gone. */
function presetModelName(
	preset: {
		provider: string;
		endpointId: string | null;
		modelId: string;
		modelApi: string;
	},
	models: ModelDescriptor[],
): string {
	const match = models.find(
		(m) =>
			modelKey(m) ===
			modelKey({
				provider: preset.provider,
				endpointId: preset.endpointId ?? preset.modelApi,
				modelId: preset.modelId,
				api: preset.modelApi,
			}),
	);
	return match?.name ?? preset.modelId;
}

function emptyForm(models: ModelDescriptor[]): PresetForm {
	const first = models[0];
	return {
		name: "",
		scope: "personal",
		provider: first?.provider ?? "",
		endpointId: first?.endpointId ?? "",
		modelId: first?.modelId ?? "",
		api: first?.api ?? "",
		systemPrompt: "",
		reasoningEffort: "",
		reasoningSummary: false,
	};
}

function PresetEditor({
	form,
	models,
	onChange,
	onSave,
	onCancel,
	saving,
}: {
	form: PresetForm;
	models: ModelDescriptor[];
	onChange: (f: PresetForm) => void;
	onSave: () => void;
	onCancel: () => void;
	saving: boolean;
}) {
	const model = models.find((m) => modelKey(m) === modelKey(form));
	// A preset can point at a model a sync has since removed. Keep it visible so
	// the owner can see what broke and pick a replacement instead of finding the
	// preset missing with no way to fix it.
	const modelMissing = !model;
	// Capability gating: only show fields the selected model/api supports.
	const showReasoningEffort = model?.reasoning ?? false;
	const showReasoningSummary =
		form.api === "openai-responses" || form.api === "anthropic-messages";

	return (
		<section className="card card-border bg-base-100 shadow-sm">
			<div className="card-body gap-4">
				<fieldset className="fieldset gap-2">
					<legend className="fieldset-legend">Name</legend>
					<input
						className="input w-full"
						value={form.name}
						onChange={(e) => onChange({ ...form, name: e.target.value })}
					/>
				</fieldset>
				<fieldset className="fieldset gap-2">
					<legend className="fieldset-legend">Model</legend>
					<select
						className="select w-full"
						value={model ? modelKey(model) : ""}
						onChange={(e) => {
							const m = models.find((x) => modelKey(x) === e.target.value);
							if (m)
								onChange({
									...form,
									provider: m.provider,
									endpointId: m.endpointId,
									modelId: m.modelId,
									api: m.api,
								});
						}}
					>
						{modelMissing && (
							<option value="" disabled>
								{form.modelId} — no longer available
							</option>
						)}
						{sortModelsByName(models).map((m) => (
							<option key={modelKey(m)} value={modelKey(m)}>
								{m.name}
							</option>
						))}
					</select>
					{modelMissing && (
						<p className="text-sm text-warning">
							This preset's model ({form.modelId}) is no longer offered by the
							provider. Pick a model above, then save.
						</p>
					)}
				</fieldset>
				<fieldset className="fieldset gap-2">
					<legend className="fieldset-legend">System prompt</legend>
					<textarea
						className="textarea min-h-32 w-full"
						value={form.systemPrompt}
						onChange={(e) =>
							onChange({ ...form, systemPrompt: e.target.value })
						}
						rows={4}
					/>
					<div className="rounded-box border border-base-300 bg-base-200 px-3 py-2 text-sm">
						<p className="font-medium">Live context</p>
						<p className="mt-1 opacity-70">
							Use these values in your prompt. They are refreshed for every
							response.
						</p>
						<ul className="mt-2 space-y-1 font-mono text-xs">
							<li>
								{"{{get_current_datetime}}"} → Monday, January 1, 2024 at
								12:00:00 PM EST
							</li>
							<li>
								{"{{get_timezone_info}}"} → America/New_York (EST, GMT-05:00)
							</li>
							<li>{"{{get_user_location}}"} → New York, United States</li>
						</ul>
						<p className="mt-2 opacity-70">
							Location renders as <span className="font-mono">unknown</span>{" "}
							when it cannot be found.
						</p>
					</div>
				</fieldset>

				{showReasoningEffort && (
					<fieldset className="fieldset gap-2">
						<legend className="fieldset-legend">Reasoning effort</legend>
						<select
							className="select w-full"
							value={form.reasoningEffort}
							onChange={(e) =>
								onChange({ ...form, reasoningEffort: e.target.value })
							}
						>
							{REASONING_LEVELS.map((l) => (
								<option key={l} value={l}>
									{l || "(default)"}
								</option>
							))}
						</select>
					</fieldset>
				)}
				{showReasoningSummary && (
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={form.reasoningSummary}
							onChange={(e) =>
								onChange({ ...form, reasoningSummary: e.target.checked })
							}
						/>
						<span>Request reasoning summary</span>
					</label>
				)}

				<fieldset className="fieldset gap-2">
					<legend className="fieldset-legend">Scope</legend>
					<select
						className="select w-full"
						value={form.scope}
						onChange={(e) =>
							onChange({
								...form,
								scope: e.target.value as "personal" | "shared",
							})
						}
					>
						<option value="personal">Personal</option>
						<option value="shared">Shared (team)</option>
					</select>
				</fieldset>

				<div className="card-actions justify-end gap-2">
					<button className="btn btn-ghost" onClick={onCancel}>
						Cancel
					</button>
					<button
						className="btn btn-primary"
						onClick={onSave}
						disabled={saving || !form.name.trim() || modelMissing}
					>
						{saving ? "Saving…" : "Save preset"}
					</button>
				</div>
			</div>
		</section>
	);
}

export function Presets({ onClose }: { onClose: () => void }) {
	const trpc = useTRPC();
	const qc = useQueryClient();
	const models = useQuery(trpc.model.available.queryOptions());
	const presets = useQuery(trpc.preset.list.queryOptions());
	const userDefault = useQuery(trpc.preset.userDefault.queryOptions());
	const [form, setForm] = useState<PresetForm | null>(null);
	// Every preset action can be rejected by the server (an unavailable model, a
	// shared preset pointing at a private model). Silence here is what made the
	// original New Chat bug look like a dead button, so surface it.
	const [actionError, setActionError] = useState<string | null>(null);

	const invalidate = () =>
		qc.invalidateQueries({ queryKey: trpc.preset.list.queryKey() });

	const create = useMutation(
		trpc.preset.create.mutationOptions({
			onMutate: () => setActionError(null),
			onSuccess: () => {
				invalidate();
				setForm(null);
			},
			onError: (error) => setActionError(error.message),
		}),
	);
	const update = useMutation(
		trpc.preset.update.mutationOptions({
			onMutate: () => setActionError(null),
			onSuccess: () => {
				invalidate();
				setForm(null);
			},
			onError: (error) => setActionError(error.message),
		}),
	);
	const remove = useMutation(
		trpc.preset.remove.mutationOptions({
			onMutate: () => setActionError(null),
			onSuccess: invalidate,
			onError: (error) => setActionError(error.message),
		}),
	);
	const setUserDefault = useMutation(
		trpc.preset.setUserDefault.mutationOptions({
			onMutate: () => setActionError(null),
			onSuccess: () => {
				qc.invalidateQueries({ queryKey: trpc.preset.userDefault.queryKey() });
				qc.invalidateQueries({ queryKey: trpc.model.userDefault.queryKey() });
			},
			onError: (error) => setActionError(error.message),
		}),
	);

	const modelList = models.data ?? [];
	const presetList = presets.data ?? [];
	const saving = create.isPending || update.isPending;

	const save = () => {
		if (!form) return;
		const payload = {
			name: form.name,
			scope: form.scope,
			provider: form.provider,
			endpointId: form.endpointId,
			modelId: form.modelId,
			api: form.api,
			systemPrompt: form.systemPrompt || null,
			reasoningEffort: form.reasoningEffort || null,
			reasoningSummary: form.reasoningSummary,
		};
		if (form.id) update.mutate({ id: form.id, ...payload });
		else create.mutate(payload);
	};

	return (
		<div className="modal modal-open">
			<div className="modal-box flex h-[calc(100dvh-2rem)] w-11/12 max-w-4xl flex-col p-0">
				<header className="flex items-center justify-between gap-4 border-b border-base-300 px-5 py-4 sm:px-6">
					<div>
						<p className="text-sm uppercase tracking-[0.16em] opacity-60">
							Chat setup
						</p>
						<h2 className="m-0 text-3xl">Presets</h2>
					</div>
					<button className="btn btn-ghost" onClick={onClose}>
						Close
					</button>
				</header>
				<div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
					{actionError && (
						<div role="alert" className="alert alert-error alert-soft mb-5">
							<span className="min-w-0 break-words">{actionError}</span>
							<button
								type="button"
								className="btn btn-ghost btn-xs"
								onClick={() => setActionError(null)}
							>
								Dismiss
							</button>
						</div>
					)}
					{form ? (
						<PresetEditor
							form={form}
							models={modelList}
							onChange={setForm}
							onSave={save}
							onCancel={() => setForm(null)}
							saving={saving}
						/>
					) : (
						<button
							className="btn btn-primary"
							onClick={() => setForm(emptyForm(modelList))}
							disabled={modelList.length === 0}
						>
							New preset
						</button>
					)}

					{presetList.map((p) => (
						<div
							key={p.id}
							className="flex items-center gap-3 border-b border-base-300 py-4"
						>
							<div className="min-w-0 flex-1">
								<p className="font-medium">{p.name}</p>
								<p className="text-sm opacity-60">
									<span
										className={p.modelAvailable ? undefined : "text-warning"}
									>
										{presetModelName(p, modelList)}
									</span>{" "}
									· {p.scope}
									{p.reasoningEffort ? ` · ${p.reasoningEffort}` : ""}
								</p>
								{p.modelAvailable ? null : (
									<p className="text-xs text-warning">
										Model unavailable — new chats ignore this preset until it is
										updated.
									</p>
								)}
							</div>
							<div
								className="tooltip tooltip-left"
								data-tip={
									userDefault.data === p.id
										? "Remove as your default preset"
										: p.modelAvailable
											? "Use as your default preset for new chats"
											: "Give this preset a current model before making it your default"
								}
							>
								<button
									type="button"
									className={`btn btn-sm btn-ghost btn-circle${userDefault.data === p.id ? " text-warning" : ""}`}
									onClick={() =>
										setUserDefault.mutate({
											id: userDefault.data === p.id ? null : p.id,
										})
									}
									disabled={
										setUserDefault.isPending ||
										(!p.modelAvailable && userDefault.data !== p.id)
									}
								>
									<Star
										size={16}
										fill={userDefault.data === p.id ? "currentColor" : "none"}
									/>
								</button>
							</div>
							{p.owned ? (
								<>
									<button
										className="btn btn-sm btn-outline"
										onClick={() =>
											setForm({
												id: p.id,
												name: p.name,
												scope: p.scope as "personal" | "shared",
												provider: p.provider,
												endpointId: p.endpointId ?? p.modelApi,
												modelId: p.modelId,
												api: p.modelApi,
												systemPrompt: p.systemPrompt ?? "",
												reasoningEffort: p.reasoningEffort ?? "",
												reasoningSummary: p.reasoningSummary,
											})
										}
									>
										Edit
									</button>
									<button
										className="btn btn-error btn-soft btn-sm"
										onClick={() => remove.mutate({ id: p.id })}
									>
										Delete
									</button>
								</>
							) : (
								<span className="badge badge-sm badge-ghost">Shared</span>
							)}
						</div>
					))}
				</div>
			</div>
			<div className="modal-backdrop" onClick={onClose} />
		</div>
	);
}

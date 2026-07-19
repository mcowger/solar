import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "../trpc";

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
const VERBOSITY_LEVELS = ["", "low", "medium", "high"];

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
	verbosity: string;
}

function modelKey(m: {
	provider: string;
	endpointId: string;
	modelId: string;
	api: string;
}) {
	return `${m.provider}/${m.endpointId}/${m.modelId}/${m.api}`;
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
		verbosity: "",
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
	// Capability gating: only show fields the selected model/api supports.
	const showReasoningEffort = model?.reasoning ?? false;
	const showReasoningSummary =
		form.api === "openai-responses" || form.api === "anthropic-messages";
	const showVerbosity = form.api === "openai-responses";

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
						{models.map((m) => (
							<option key={modelKey(m)} value={modelKey(m)}>
								{m.name}
							</option>
						))}
					</select>
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
				{showVerbosity && (
					<fieldset className="fieldset gap-2">
						<legend className="fieldset-legend">Verbosity</legend>
						<select
							className="select w-full"
							value={form.verbosity}
							onChange={(e) => onChange({ ...form, verbosity: e.target.value })}
						>
							{VERBOSITY_LEVELS.map((l) => (
								<option key={l} value={l}>
									{l || "(default)"}
								</option>
							))}
						</select>
					</fieldset>
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
						disabled={saving || !form.name.trim()}
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
	const [form, setForm] = useState<PresetForm | null>(null);

	const invalidate = () =>
		qc.invalidateQueries({ queryKey: trpc.preset.list.queryKey() });

	const create = useMutation(
		trpc.preset.create.mutationOptions({
			onSuccess: () => {
				invalidate();
				setForm(null);
			},
		}),
	);
	const update = useMutation(
		trpc.preset.update.mutationOptions({
			onSuccess: () => {
				invalidate();
				setForm(null);
			},
		}),
	);
	const remove = useMutation(
		trpc.preset.remove.mutationOptions({ onSuccess: invalidate }),
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
			verbosity: form.verbosity || null,
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
				<div className="overflow-y-auto p-5 sm:p-6">
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
									{modelList.find(
										(m) =>
											modelKey(m) ===
											modelKey({
												provider: p.provider,
												endpointId: p.endpointId ?? p.modelApi,
												modelId: p.modelId,
												api: p.modelApi,
											}),
									)?.name ?? p.modelId}{" "}
									· {p.scope}
									{p.reasoningEffort ? ` · ${p.reasoningEffort}` : ""}
								</p>
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
												verbosity: p.verbosity ?? "",
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

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "../trpc";

interface ModelDescriptor {
  provider: string;
  modelId: string;
  api: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
}

const REASONING_LEVELS = ["", "minimal", "low", "medium", "high", "xhigh", "max"];
const VERBOSITY_LEVELS = ["", "low", "medium", "high"];

interface PresetForm {
  id?: string;
  name: string;
  scope: "personal" | "shared";
  provider: string;
  modelId: string;
  api: string;
  systemPrompt: string;
  reasoningEffort: string;
  reasoningSummary: boolean;
  verbosity: string;
}

function modelKey(m: { provider: string; modelId: string; api: string }) {
  return `${m.provider}/${m.modelId}/${m.api}`;
}

function emptyForm(models: ModelDescriptor[]): PresetForm {
  const first = models[0];
  return {
    name: "",
    scope: "personal",
    provider: first?.provider ?? "",
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
    <div style={{ border: "1px solid #ccc", borderRadius: 8, padding: "1rem", marginBottom: "1rem" }}>
      <label style={{ display: "block", marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: "#666" }}>Name</div>
        <input
          value={form.name}
          onChange={(e) => onChange({ ...form, name: e.target.value })}
          style={{ width: "100%", boxSizing: "border-box" }}
        />
      </label>
      <label style={{ display: "block", marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: "#666" }}>Model</div>
        <select
          value={model ? modelKey(model) : ""}
          onChange={(e) => {
            const m = models.find((x) => modelKey(x) === e.target.value);
            if (m) onChange({ ...form, provider: m.provider, modelId: m.modelId, api: m.api });
          }}
        >
          {models.map((m) => (
            <option key={modelKey(m)} value={modelKey(m)}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "block", marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: "#666" }}>System prompt</div>
        <textarea
          value={form.systemPrompt}
          onChange={(e) => onChange({ ...form, systemPrompt: e.target.value })}
          rows={4}
          style={{ width: "100%", boxSizing: "border-box" }}
        />
      </label>

      {showReasoningEffort && (
        <label style={{ display: "block", marginBottom: 8 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Reasoning effort</div>
          <select
            value={form.reasoningEffort}
            onChange={(e) => onChange({ ...form, reasoningEffort: e.target.value })}
          >
            {REASONING_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l || "(default)"}
              </option>
            ))}
          </select>
        </label>
      )}
      {showReasoningSummary && (
        <label style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={form.reasoningSummary}
            onChange={(e) => onChange({ ...form, reasoningSummary: e.target.checked })}
          />
          <span style={{ fontSize: 13 }}>Request reasoning summary</span>
        </label>
      )}
      {showVerbosity && (
        <label style={{ display: "block", marginBottom: 8 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Verbosity</div>
          <select
            value={form.verbosity}
            onChange={(e) => onChange({ ...form, verbosity: e.target.value })}
          >
            {VERBOSITY_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l || "(default)"}
              </option>
            ))}
          </select>
        </label>
      )}

      <label style={{ display: "block", marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: "#666" }}>Scope</div>
        <select
          value={form.scope}
          onChange={(e) => onChange({ ...form, scope: e.target.value as "personal" | "shared" })}
        >
          <option value="personal">Personal</option>
          <option value="shared">Shared (team)</option>
        </select>
      </label>

      <button onClick={onSave} disabled={saving || !form.name.trim()}>
        {saving ? "Saving…" : "Save preset"}
      </button>
      <button onClick={onCancel} style={{ marginLeft: 8 }}>
        Cancel
      </button>
    </div>
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
    trpc.preset.create.mutationOptions({ onSuccess: () => { invalidate(); setForm(null); } }),
  );
  const update = useMutation(
    trpc.preset.update.mutationOptions({ onSuccess: () => { invalidate(); setForm(null); } }),
  );
  const remove = useMutation(trpc.preset.remove.mutationOptions({ onSuccess: invalidate }));

  const modelList = models.data ?? [];
  const presetList = presets.data ?? [];
  const saving = create.isPending || update.isPending;

  const save = () => {
    if (!form) return;
    const payload = {
      name: form.name,
      scope: form.scope,
      provider: form.provider,
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
    <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", maxWidth: 640 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, flex: 1 }}>Presets</h2>
        <button onClick={onClose}>Close</button>
      </div>

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
          onClick={() => setForm(emptyForm(modelList))}
          disabled={modelList.length === 0}
          style={{ marginBottom: 16 }}
        >
          + New preset
        </button>
      )}

      {presetList.map((p) => (
        <div
          key={p.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0.5rem 0",
            borderBottom: "1px solid #eee",
          }}
        >
          <div style={{ flex: 1 }}>
            <strong>{p.name}</strong>{" "}
            <span style={{ color: "#888", fontSize: 12 }}>
              {p.modelId} · {p.scope}
              {p.reasoningEffort ? ` · ${p.reasoningEffort}` : ""}
            </span>
          </div>
          {p.owned ? (
            <>
              <button
                onClick={() =>
                  setForm({
                    id: p.id,
                    name: p.name,
                    scope: p.scope as "personal" | "shared",
                    provider: p.provider,
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
              <button onClick={() => remove.mutate({ id: p.id })}>Delete</button>
            </>
          ) : (
            <span style={{ fontSize: 11, color: "#bbb" }}>shared</span>
          )}
        </div>
      ))}
    </div>
  );
}

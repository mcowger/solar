import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTRPC } from "../trpc";

interface AllowlistEntry {
  id: string;
  api: string;
}

interface ProviderForm {
  provider: string;
  apiKey: string;
  baseUrl: string;
  enabledModels: AllowlistEntry[];
  apis: string[];
}

function ProviderCard({ initial }: { initial: ProviderForm }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [models, setModels] = useState<AllowlistEntry[]>(initial.enabledModels);

  const save = useMutation(
    trpc.admin.setProvider.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: trpc.admin.listProviders.queryKey() });
        qc.invalidateQueries({ queryKey: trpc.model.available.queryKey() });
      },
    }),
  );

  const addModel = () =>
    setModels((m) => [...m, { id: "", api: initial.apis[0] ?? "" }]);
  const updateModel = (i: number, patch: Partial<AllowlistEntry>) =>
    setModels((m) => m.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  const removeModel = (i: number) =>
    setModels((m) => m.filter((_, idx) => idx !== i));

  return (
    <section
      style={{
        border: "1px solid #ddd",
        borderRadius: 8,
        padding: "1rem",
        marginBottom: "1rem",
      }}
    >
      <h3 style={{ margin: "0 0 0.75rem", textTransform: "capitalize" }}>
        {initial.provider}
      </h3>
      <label style={{ display: "block", marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: "#666" }}>API key</div>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-…"
          style={{ width: "100%", boxSizing: "border-box" }}
        />
      </label>
      <label style={{ display: "block", marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: "#666" }}>Base URL (optional)</div>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="default"
          style={{ width: "100%", boxSizing: "border-box" }}
        />
      </label>

      <div style={{ fontSize: 12, color: "#666", margin: "8px 0 4px" }}>
        Enabled models
      </div>
      {models.map((m, i) => (
        <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <input
            value={m.id}
            onChange={(e) => updateModel(i, { id: e.target.value })}
            placeholder="model id"
            style={{ flex: 1 }}
          />
          <select
            value={m.api}
            onChange={(e) => updateModel(i, { api: e.target.value })}
          >
            {initial.apis.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <button onClick={() => removeModel(i)}>✕</button>
        </div>
      ))}
      <button onClick={addModel} style={{ marginBottom: 8 }}>
        + Add model
      </button>

      <div>
        <button
          onClick={() =>
            save.mutate({
              provider: initial.provider,
              apiKey,
              baseUrl,
              enabledModels: models.filter((m) => m.id.trim()),
            })
          }
          disabled={save.isPending}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {save.isError && (
          <span style={{ color: "crimson", marginLeft: 8 }}>
            {save.error.message}
          </span>
        )}
      </div>
    </section>
  );
}

export function Settings({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC();
  const providers = useQuery(trpc.admin.listProviders.queryOptions());

  // Remount cards when server data arrives so their local form state seeds.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (providers.isSuccess) setReady(true);
  }, [providers.isSuccess]);

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", maxWidth: 640 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, flex: 1 }}>Provider settings</h2>
        <button onClick={onClose}>Close</button>
      </div>
      {providers.isError && (
        <p style={{ color: "crimson" }}>{providers.error.message}</p>
      )}
      {ready &&
        providers.data?.map((p) => <ProviderCard key={p.provider} initial={p} />)}
    </div>
  );
}

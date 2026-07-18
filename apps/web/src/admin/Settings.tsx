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

function modelKey(model: Pick<ModelDescriptor, "provider" | "endpointId" | "modelId" | "api">) {
  return `${model.provider}/${model.endpointId}/${model.modelId}/${model.api}`;
}

function TaskModel() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const available = useQuery(trpc.model.available.queryOptions());
  const taskModel = useQuery(trpc.model.taskModel.queryOptions());
  const titlePrompt = useQuery(trpc.model.titlePrompt.queryOptions());
  const [prompt, setPrompt] = useState("");
  useEffect(() => {
    if (titlePrompt.data !== undefined) setPrompt(titlePrompt.data);
  }, [titlePrompt.data]);
  const setTaskModel = useMutation(
    trpc.model.setTaskModel.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.model.taskModel.queryKey() }),
    }),
  );
  const saveTitlePrompt = useMutation(
    trpc.model.setTitlePrompt.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.model.titlePrompt.queryKey() }),
    }),
  );
  const models = available.data ?? [];
  const selected = taskModel.data ? modelKey(taskModel.data) : "";

  return <section className="card card-border bg-base-100 shadow-sm"><div className="card-body gap-4 p-5"><h3 className="card-title">Task model</h3><p className="text-sm opacity-70">Used for future lightweight work such as title generation and context management.</p>
    <fieldset className="fieldset max-w-lg"><legend className="fieldset-legend">Selected model</legend><select className="select w-full" value={selected} disabled={!models.length || setTaskModel.isPending} onChange={(event) => { const model = models.find((item) => modelKey(item) === event.target.value); if (model) setTaskModel.mutate(model); }}><option value="" disabled>{models.length ? "Select a task model" : "No models configured"}</option>{models.map((model) => <option key={modelKey(model)} value={modelKey(model)}>{model.name} · {model.provider}</option>)}</select></fieldset>
    <fieldset className="fieldset gap-2"><legend className="fieldset-legend">Chat title prompt</legend><textarea className="textarea min-h-64 w-full font-mono text-sm" value={prompt} disabled={titlePrompt.isLoading || saveTitlePrompt.isPending} onChange={(event) => setPrompt(event.target.value)} placeholder="Use {{first_message}} where the first user message belongs." /><p className="label">Use <code>{"{{first_message}}"}</code> to include the first user message.</p></fieldset>
    {!prompt.includes("{{first_message}}") && <div role="alert" className="alert alert-warning alert-soft text-sm">The prompt does not include {"{{first_message}}"}; titles will be generated without the first user message.</div>}
    <div className="card-actions items-center justify-end"><button className="btn btn-primary" disabled={!prompt.trim() || saveTitlePrompt.isPending} onClick={() => saveTitlePrompt.mutate({ prompt })}>{saveTitlePrompt.isPending ? "Saving…" : "Save title prompt"}</button></div>
    {(setTaskModel.isError || saveTitlePrompt.isError) && <div role="alert" className="alert alert-error alert-soft">{setTaskModel.error?.message ?? saveTitlePrompt.error?.message}</div>}
  </div></section>;
}

function ProviderCard({ initial }: { initial: ProviderForm }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [endpoints, setEndpoints] = useState(initial.endpoints);
  const [models, setModels] = useState<AllowlistEntry[]>(initial.enabledModels);
  const [discovery, setDiscovery] = useState<{ endpointId: string; models: { id: string; name: string; preferredApi: string | null }[] } | null>(null);
  const [imports, setImports] = useState<Record<string, { api: string; visibility: "public" | "private" }>>({});
  useEffect(() => {
    setEndpoints(initial.endpoints);
    setModels(initial.enabledModels);
  }, [initial.endpoints, initial.enabledModels]);
  const save = useMutation(
    trpc.admin.setProvider.mutationOptions({
      onSuccess: () => {
        setApiKey("");
        qc.invalidateQueries({ queryKey: trpc.admin.listProviders.queryKey() });
        qc.invalidateQueries({ queryKey: trpc.model.available.queryKey() });
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
  const addEndpoint = () => setEndpoints((current) => [...current, {
    id: crypto.randomUUID(),
    label: "",
    baseUrl: "",
    api: initial.apis.find((api) => !current.some((endpoint) => endpoint.api === api)) ?? initial.apis[0] ?? "",
  }]);
  const updateEndpoint = (id: string, patch: Partial<ProviderEndpoint>) =>
    setEndpoints((current) => current.map((endpoint) => endpoint.id === id ? { ...endpoint, ...patch } : endpoint));
  const removeEndpoint = (id: string) => {
    setEndpoints((current) => current.filter((endpoint) => endpoint.id !== id));
    setModels((current) => current.filter((model) => model.endpointId !== id));
  };
  const updateModel = (index: number, patch: Partial<AllowlistEntry>) =>
    setModels((models) => models.map((model, modelIndex) => modelIndex === index ? { ...model, ...patch } : model));
  const removeModel = (index: number) => setModels((models) => models.filter((_, modelIndex) => modelIndex !== index));
  const importableApis = endpoints.map((endpoint) => endpoint.api);
  const selectedImports = Object.entries(imports).map(([id, selection]) => ({ id, ...selection }));

  return (
    <section className="card card-border bg-base-100 shadow-sm">
      <div className="card-body gap-4 p-4 sm:p-5">
        <h3 className="card-title capitalize">{initial.provider}</h3>
        <fieldset className="fieldset grid min-w-0 content-start gap-1">
          <legend className="fieldset-legend">API key</legend>
          <input className="input input-sm w-full" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={initial.hasApiKey ? "Saved — enter to replace" : "sk-…"} />
          <p className="label">One key is shared by every endpoint.</p>
        </fieldset>
        <fieldset className="fieldset gap-2">
          <legend className="fieldset-legend">Endpoints</legend>
          {endpoints.map((endpoint) => <div key={endpoint.id} className="rounded-box bg-base-200 p-2"><div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_11rem_auto]"><input className="input input-sm min-w-0" value={endpoint.label} onChange={(event) => updateEndpoint(endpoint.id, { label: event.target.value })} placeholder="Label" /><input className="input input-sm min-w-0" value={endpoint.baseUrl} onChange={(event) => updateEndpoint(endpoint.id, { baseUrl: event.target.value })} placeholder="https://plexus.example/v1" /><select className="select select-sm min-w-0" value={endpoint.api} onChange={(event) => updateEndpoint(endpoint.id, { api: event.target.value })}>{initial.apis.map((api) => <option key={api} value={api} disabled={endpoints.some((candidate) => candidate.id !== endpoint.id && candidate.api === api)}>{api}</option>)}</select><div className="flex gap-1"><button className="btn btn-sm" disabled={!endpoint.baseUrl || queryModels.isPending} onClick={() => queryModels.mutate({ provider: initial.provider, endpointId: endpoint.id })}>{queryModels.isPending ? "Querying…" : "Query models"}</button><button className="btn btn-ghost btn-sm btn-square" onClick={() => removeEndpoint(endpoint.id)} title="Remove endpoint">✕</button></div></div></div>)}
          <button className="btn btn-sm btn-outline w-fit" onClick={addEndpoint} disabled={endpoints.length === initial.apis.length}>Add endpoint</button>
        </fieldset>
        {discovery && <fieldset className="fieldset gap-2"><legend className="fieldset-legend">Available text generation models</legend><div className="overflow-x-auto"><table className="table table-sm"><thead><tr><th>Import</th><th>Model</th><th>Preferred API</th><th>Visibility</th></tr></thead><tbody>{discovery.models.map((model) => { const selected = imports[model.id]; const preferredApi = importableApis.includes(model.preferredApi ?? "") ? model.preferredApi! : importableApis[0] ?? ""; return <tr key={model.id}><td><input className="checkbox checkbox-sm" type="checkbox" checked={Boolean(selected)} onChange={(event) => setImports((current) => { const next = { ...current }; if (event.target.checked) next[model.id] = { api: preferredApi, visibility: "public" }; else delete next[model.id]; return next; })} /></td><td><span className="font-medium">{model.name}</span><span className="block text-xs opacity-60">{model.id}</span></td><td><select className="select select-xs" disabled={!selected} value={selected?.api ?? preferredApi} onChange={(event) => setImports((current) => ({ ...current, [model.id]: { api: event.target.value, visibility: current[model.id]?.visibility ?? "public" } }))}>{importableApis.map((api) => <option key={api} value={api}>{api}</option>)}</select></td><td><select className="select select-xs" disabled={!selected} value={selected?.visibility ?? "public"} onChange={(event) => setImports((current) => ({ ...current, [model.id]: { api: current[model.id]?.api ?? preferredApi, visibility: event.target.value as "public" | "private" } }))}><option value="public">Public</option><option value="private">Private</option></select></td></tr>; })}</tbody></table></div><div className="card-actions justify-end"><button className="btn btn-primary btn-sm" disabled={!selectedImports.length || importModels.isPending} onClick={() => importModels.mutate({ provider: initial.provider, endpointId: discovery.endpointId, models: selectedImports })}>{importModels.isPending ? "Importing…" : `Import ${selectedImports.length} selected`}</button></div></fieldset>}
        <fieldset className="fieldset gap-1">
          <legend className="fieldset-legend">Imported models</legend>
          {models.map((model, index) => (
            <div key={index} className="rounded-box bg-base-200 p-2">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_11rem_auto_auto]">
                <p className="min-w-0 truncate text-sm">{model.name ?? model.id}</p>
                <select className="select select-sm min-w-0 w-full" value={model.endpointId} onChange={(event) => { const endpoint = endpoints.find((candidate) => candidate.id === event.target.value); if (endpoint) updateModel(index, { endpointId: endpoint.id, api: endpoint.api }); }}>
                  {endpoints.map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.label || endpoint.api} · {endpoint.api}</option>)}
                </select>
                <label className="flex items-center gap-1.5 whitespace-nowrap text-sm">
                <input className="toggle toggle-sm" type="checkbox" checked={model.visibility === "public"} onChange={(event) => updateModel(index, { visibility: event.target.checked ? "public" : "private" })} />
                <span className="hidden md:inline">Visible to all users</span>
                <span className={`badge badge-sm ${model.visibility === "public" ? "badge-success badge-soft" : "badge-warning badge-soft"}`}>{model.visibility}</span>
              </label>
                <button className="btn btn-ghost btn-sm btn-square" onClick={() => removeModel(index)} title="Remove model">✕</button>
              </div>
            </div>
          ))}
        </fieldset>
        <div className="card-actions items-center justify-end">
          {(save.isError || queryModels.isError || importModels.isError) && <div role="alert" className="alert alert-error alert-soft py-2 text-sm">{save.error?.message ?? queryModels.error?.message ?? importModels.error?.message}</div>}
          <button className="btn btn-primary" onClick={() => save.mutate({ provider: initial.provider, apiKey, endpoints, enabledModels: models })} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save provider"}</button>
        </div>
      </div>
    </section>
  );
}

function Users() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { data: session } = useSession();
  const users = useQuery(trpc.admin.listUsers.queryOptions());
  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.admin.listUsers.queryKey() });
  const setRole = useMutation(trpc.admin.setUserRole.mutationOptions({ onSuccess: invalidate }));
  const setDisabled = useMutation(trpc.admin.setUserDisabled.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(trpc.admin.deleteUser.mutationOptions({ onSuccess: invalidate }));

  return <section className="card card-border bg-base-100 shadow-sm"><div className="card-body p-5"><h3 className="card-title">Users</h3>
    {users.isError && <div role="alert" className="alert alert-error alert-soft">{users.error.message}</div>}
    <div className="divide-y divide-base-300">{users.data?.map((user) => {
      const isCurrentUser = user.id === session?.user.id;
      return <div key={user.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><p className="font-medium">{user.name}</p><p className="truncate text-sm opacity-60">{user.email}</p></div><div className="flex flex-wrap gap-2"><select className="select select-sm" value={user.role} disabled={isCurrentUser || setRole.isPending} onChange={(event) => setRole.mutate({ userId: user.id, role: event.target.value as "admin" | "user" })}><option value="user">User</option><option value="admin">Admin</option></select><button className="btn btn-sm" disabled={isCurrentUser || setDisabled.isPending} onClick={() => setDisabled.mutate({ userId: user.id, isDisabled: !Boolean(user.isDisabled) })}>{user.isDisabled ? "Enable" : "Disable"}</button><button className="btn btn-error btn-soft btn-sm" disabled={isCurrentUser || remove.isPending} onClick={() => { if (window.confirm(`Delete ${user.email} and all of their data?`)) remove.mutate({ userId: user.id }); }}>Delete</button></div></div>;
    })}</div>
  </div></section>;
}

function Usage() {
  const trpc = useTRPC();
  const usage = useQuery(trpc.admin.usage.queryOptions());
  return <section className="card card-border bg-base-100 shadow-sm"><div className="card-body p-5"><h3 className="card-title">Usage</h3>
    {usage.isError && <div role="alert" className="alert alert-error alert-soft">{usage.error.message}</div>}
    <div className="grid gap-3 sm:hidden">{usage.data?.map((row) => <div key={`${row.userId}:${row.model}`} className="rounded-box bg-base-200 p-4"><p className="truncate font-medium">{row.email}</p><p className="mt-1 break-words text-sm opacity-60">{row.model}</p><dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm"><div><dt className="opacity-60">Messages</dt><dd className="mt-1 font-medium">{row.messageCount}</dd></div><div><dt className="opacity-60">Input</dt><dd className="mt-1 font-medium">{row.inputTokens}</dd></div><div><dt className="opacity-60">Output</dt><dd className="mt-1 font-medium">{row.outputTokens}</dd></div><div><dt className="opacity-60">Total</dt><dd className="mt-1 font-medium">{row.inputTokens + row.outputTokens}</dd></div></dl></div>)}</div>
    <div className="hidden min-w-0 overflow-x-auto sm:block"><table className="table table-zebra"><thead><tr><th>User</th><th>Model</th><th>Messages</th><th>Input</th><th>Output</th><th>Total</th></tr></thead><tbody>{usage.data?.map((row) => <tr key={`${row.userId}:${row.model}`}><td>{row.email}</td><td>{row.model}</td><td>{row.messageCount}</td><td>{row.inputTokens}</td><td>{row.outputTokens}</td><td>{row.inputTokens + row.outputTokens}</td></tr>)}</tbody></table></div>
  </div></section>;
}

function Logging() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const logLevel = useQuery(trpc.admin.logLevel.queryOptions());
  const setLogLevel = useMutation(trpc.admin.setLogLevel.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: trpc.admin.logLevel.queryKey() }) }));
  return <section className="card card-border bg-base-100 shadow-sm"><div className="card-body p-5"><h3 className="card-title">Logging</h3><p className="text-sm opacity-70">Changes apply immediately and reset when the server restarts.</p>
    {logLevel.data && <fieldset className="fieldset max-w-xs"><legend className="fieldset-legend">Log level</legend><select className="select w-full" value={logLevel.data.level} disabled={setLogLevel.isPending} onChange={(event) => setLogLevel.mutate({ level: event.target.value as "trace" | "debug" | "info" | "warn" | "error" })}><option value="trace">Trace</option><option value="debug">Debug</option><option value="info">Info</option><option value="warn">Warn</option><option value="error">Error</option></select></fieldset>}
    {setLogLevel.isError && <div role="alert" className="alert alert-error alert-soft">{setLogLevel.error.message}</div>}
  </div></section>;
}

const sections = ["users", "providers", "task model", "usage", "logging"] as const;
type Section = typeof sections[number];

export function Settings({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const providers = useQuery(trpc.admin.listProviders.queryOptions());
  const [ready, setReady] = useState(false);
  const [section, setSection] = useState<Section>("users");
  const [providerName, setProviderName] = useState("");
  const createProvider = useMutation(trpc.admin.setProvider.mutationOptions({
    onSuccess: () => {
      setProviderName("");
      qc.invalidateQueries({ queryKey: trpc.admin.listProviders.queryKey() });
    },
  }));
  useEffect(() => { if (providers.isSuccess) setReady(true); }, [providers.isSuccess]);

  return <div className="modal modal-open"><div className="modal-box flex h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-6xl flex-col p-0 sm:h-[calc(100dvh-2rem)] sm:w-11/12"><header className="flex items-center justify-between gap-3 border-b border-base-300 px-4 py-3 sm:px-5"><div><p className="text-sm tracking-[0.16em] uppercase opacity-60">Administration</p><h2 className="m-0 text-2xl sm:text-3xl">Settings</h2></div><button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button></header><div className="overflow-y-auto p-4 sm:p-5"><div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
    <div role="tablist" className="tabs tabs-box w-fit max-w-full overflow-x-auto">{sections.map((name) => <button key={name} role="tab" className={`tab capitalize${section === name ? " tab-active" : ""}`} onClick={() => setSection(name)}>{name}</button>)}</div>
    {section === "users" && <Users />}
    {section === "usage" && <Usage />}
    {section === "logging" && <Logging />}
    {section === "task model" && <TaskModel />}
    {section === "providers" && providers.isError && <div role="alert" className="alert alert-error alert-soft">{providers.error.message}</div>}
    {section === "providers" && ready && <div className="grid gap-4"><section className="card card-border bg-base-100 shadow-sm"><div className="card-body gap-3 p-4 sm:p-5"><h3 className="card-title">Add provider</h3><p className="text-sm opacity-70">A provider shares one API key across one or more API endpoints.</p><div className="flex flex-col gap-2 sm:flex-row"><input className="input input-sm min-w-0 flex-1" value={providerName} onChange={(event) => setProviderName(event.target.value)} placeholder="Provider name" /><button className="btn btn-sm" disabled={!providerName.trim() || createProvider.isPending} onClick={() => createProvider.mutate({ provider: providerName.trim(), apiKey: "", endpoints: [], enabledModels: [] })}>{createProvider.isPending ? "Adding…" : "Add provider"}</button></div>{createProvider.isError && <div role="alert" className="alert alert-error alert-soft text-sm">{createProvider.error.message}</div>}</div></section>{providers.data?.map((provider) => <ProviderCard key={provider.provider} initial={provider} />)}</div>}
  </div></div></div><div className="modal-backdrop" onClick={onClose} /></div>;
}

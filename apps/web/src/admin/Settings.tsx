import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSession } from "../auth";
import { useTRPC } from "../trpc";

interface AllowlistEntry {
  id: string;
  api: string;
  visibility: "public" | "private";
}

interface ProviderForm {
  provider: string;
  hasApiKey: boolean;
  baseUrl: string;
  enabledModels: AllowlistEntry[];
  apis: string[];
}

function ProviderCard({ initial }: { initial: ProviderForm }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [models, setModels] = useState<AllowlistEntry[]>(initial.enabledModels);
  const save = useMutation(
    trpc.admin.setProvider.mutationOptions({
      onSuccess: () => {
        setApiKey("");
        qc.invalidateQueries({ queryKey: trpc.admin.listProviders.queryKey() });
        qc.invalidateQueries({ queryKey: trpc.model.available.queryKey() });
      },
    }),
  );
  const addModel = () => setModels((models) => [...models, { id: "", api: initial.apis[0] ?? "", visibility: "public" }]);
  const updateModel = (index: number, patch: Partial<AllowlistEntry>) =>
    setModels((models) => models.map((model, modelIndex) => modelIndex === index ? { ...model, ...patch } : model));
  const removeModel = (index: number) => setModels((models) => models.filter((_, modelIndex) => modelIndex !== index));

  return (
    <section className="card card-border bg-base-100 shadow-sm">
      <div className="card-body gap-5 p-5">
        <h3 className="card-title capitalize">{initial.provider}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset className="fieldset grid min-w-0 content-start gap-2">
            <legend className="fieldset-legend">API key</legend>
            <input className="input w-full" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={initial.hasApiKey ? "Saved — enter to replace" : "sk-…"} />
            <p className="label">Leave blank to keep the existing key.</p>
          </fieldset>
          <fieldset className="fieldset grid min-w-0 content-start gap-2">
            <legend className="fieldset-legend">Base URL</legend>
            <input className="input w-full" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="Default provider URL" />
            <p className="label">Optional provider endpoint override.</p>
          </fieldset>
        </div>
        <fieldset className="fieldset gap-2">
          <legend className="fieldset-legend">Enabled models</legend>
          {models.map((model, index) => (
            <div key={index} className="rounded-box bg-base-200 p-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <input className="input flex-1" value={model.id} onChange={(event) => updateModel(index, { id: event.target.value })} placeholder="Model ID" />
                <select className="select sm:w-44" value={model.api} onChange={(event) => updateModel(index, { api: event.target.value })}>
                  {initial.apis.map((api) => <option key={api} value={api}>{api}</option>)}
                </select>
                <button className="btn btn-ghost btn-square" onClick={() => removeModel(index)} title="Remove model">✕</button>
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input className="toggle toggle-sm" type="checkbox" checked={model.visibility === "public"} onChange={(event) => updateModel(index, { visibility: event.target.checked ? "public" : "private" })} />
                <span>Visible to all users</span>
                <span className={`badge badge-sm ${model.visibility === "public" ? "badge-success badge-soft" : "badge-warning badge-soft"}`}>{model.visibility}</span>
              </label>
            </div>
          ))}
          <button className="btn btn-sm btn-outline w-fit" onClick={addModel}>Add model</button>
        </fieldset>
        <div className="card-actions items-center justify-end">
          {save.isError && <div role="alert" className="alert alert-error alert-soft py-2 text-sm">{save.error.message}</div>}
          <button className="btn btn-primary" onClick={() => save.mutate({ provider: initial.provider, apiKey, baseUrl, enabledModels: models.filter((model) => model.id.trim()) })} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save provider"}</button>
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

const sections = ["users", "providers", "usage", "logging"] as const;
type Section = typeof sections[number];

export function Settings({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC();
  const providers = useQuery(trpc.admin.listProviders.queryOptions());
  const [ready, setReady] = useState(false);
  const [section, setSection] = useState<Section>("users");
  useEffect(() => { if (providers.isSuccess) setReady(true); }, [providers.isSuccess]);

  return <main className="flex-1 overflow-auto p-4 sm:p-6"><div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
    <header className="flex items-center justify-between gap-4"><div><p className="text-sm tracking-[0.16em] uppercase opacity-60">Administration</p><h2 className="m-0 text-3xl">Settings</h2></div><button className="btn btn-ghost" onClick={onClose}>Close</button></header>
    <div role="tablist" className="tabs tabs-box w-fit max-w-full overflow-x-auto">{sections.map((name) => <button key={name} role="tab" className={`tab capitalize${section === name ? " tab-active" : ""}`} onClick={() => setSection(name)}>{name}</button>)}</div>
    {section === "users" && <Users />}
    {section === "usage" && <Usage />}
    {section === "logging" && <Logging />}
    {section === "providers" && providers.isError && <div role="alert" className="alert alert-error alert-soft">{providers.error.message}</div>}
    {section === "providers" && ready && <div className="grid gap-4">{providers.data?.map((provider) => <ProviderCard key={provider.provider} initial={provider} />)}</div>}
  </div></main>;
}

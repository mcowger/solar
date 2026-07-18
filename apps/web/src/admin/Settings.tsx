import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSession } from "../auth";
import { useTRPC } from "../trpc";

interface AllowlistEntry {
  id: string;
  api: string;
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
          placeholder={initial.hasApiKey ? "Saved — enter to replace" : "sk-…"}
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

function Users() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { data: session } = useSession();
  const users = useQuery(trpc.admin.listUsers.queryOptions());
  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.admin.listUsers.queryKey() });
  const setRole = useMutation(trpc.admin.setUserRole.mutationOptions({ onSuccess: invalidate }));
  const setDisabled = useMutation(trpc.admin.setUserDisabled.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(trpc.admin.deleteUser.mutationOptions({ onSuccess: invalidate }));
  const currentUserId = session?.user.id;

  return (
    <section>
      <h3>Users</h3>
      {users.isError && <p style={{ color: "crimson" }}>{users.error.message}</p>}
      {users.data?.map((user) => {
        const isCurrentUser = user.id === currentUserId;
        return (
          <div key={user.id} style={{ borderBottom: "1px solid #ddd", padding: "0.75rem 0" }}>
            <strong>{user.name}</strong> <span style={{ color: "#666" }}>{user.email}</span>
            <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
              <select
                value={user.role}
                disabled={isCurrentUser || setRole.isPending}
                onChange={(event) => setRole.mutate({ userId: user.id, role: event.target.value as "admin" | "user" })}
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
              <button
                disabled={isCurrentUser || setDisabled.isPending}
                onClick={() => setDisabled.mutate({ userId: user.id, isDisabled: !Boolean(user.isDisabled) })}
              >
                {user.isDisabled ? "Enable" : "Disable"}
              </button>
              <button
                disabled={isCurrentUser || remove.isPending}
                onClick={() => {
                  if (window.confirm(`Delete ${user.email} and all of their data?`)) remove.mutate({ userId: user.id });
                }}
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function Usage() {
  const trpc = useTRPC();
  const usage = useQuery(trpc.admin.usage.queryOptions());
  return (
    <section>
      <h3>Usage</h3>
      {usage.isError && <p style={{ color: "crimson" }}>{usage.error.message}</p>}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr><th>User</th><th>Model</th><th>Messages</th><th>Input</th><th>Output</th><th>Total</th></tr></thead>
        <tbody>{usage.data?.map((row) => (
          <tr key={`${row.userId}:${row.model}`}>
            <td>{row.email}</td><td>{row.model}</td><td>{row.messageCount}</td>
            <td>{row.inputTokens}</td><td>{row.outputTokens}</td><td>{row.inputTokens + row.outputTokens}</td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}

function Logging() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const logLevel = useQuery(trpc.admin.logLevel.queryOptions());
  const setLogLevel = useMutation(
    trpc.admin.setLogLevel.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.admin.logLevel.queryKey() }),
    }),
  );
  return (
    <section>
      <h3>Logging</h3>
      <p>Changes apply immediately and reset when the server restarts.</p>
      {logLevel.data && (
        <select
          value={logLevel.data.level}
          disabled={setLogLevel.isPending}
          onChange={(event) => setLogLevel.mutate({ level: event.target.value as "trace" | "debug" | "info" | "warn" | "error" })}
        >
          <option value="trace">Trace</option>
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>
      )}
      {setLogLevel.isError && <p style={{ color: "crimson" }}>{setLogLevel.error.message}</p>}
    </section>
  );
}

export function Settings({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC();
  const providers = useQuery(trpc.admin.listProviders.queryOptions());

  // Remount cards when server data arrives so their local form state seeds.
  const [ready, setReady] = useState(false);
  const [section, setSection] = useState<"users" | "providers" | "usage" | "logging">("users");
  useEffect(() => {
    if (providers.isSuccess) setReady(true);
  }, [providers.isSuccess]);

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", maxWidth: 640 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, flex: 1 }}>Admin settings</h2>
        <button onClick={onClose}>Close</button>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={() => setSection("users")}>Users</button>
        <button onClick={() => setSection("providers")}>Providers</button>
        <button onClick={() => setSection("usage")}>Usage</button>
        <button onClick={() => setSection("logging")}>Logging</button>
      </div>
      {section === "users" && <Users />}
      {section === "usage" && <Usage />}
      {section === "logging" && <Logging />}
      {section === "providers" && providers.isError && (
        <p style={{ color: "crimson" }}>{providers.error.message}</p>
      )}
      {section === "providers" && ready &&
        providers.data?.map((p) => <ProviderCard key={p.provider} initial={p} />)}
    </div>
  );
}

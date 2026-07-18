import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "./trpc";

/**
 * M0 placeholder surface. Proves the full round-trip: React → tRPC → Kysely →
 * solar.db → back. Real chat UI (assistant-ui) arrives in M1.
 */
export function App() {
  const trpc = useTRPC();
  const health = useQuery(trpc.health.queryOptions());
  const me = useQuery(trpc.me.queryOptions());

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 640, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>Solar</h1>
      <p>M0 foundations — single Bun process, Hono + tRPC + Kysely + Better Auth.</p>

      <section>
        <h2>Server health</h2>
        {health.isPending && <p>checking…</p>}
        {health.error && <p>error: {health.error.message}</p>}
        {health.data && (
          <pre>{JSON.stringify(health.data, null, 2)}</pre>
        )}
      </section>

      <section>
        <h2>Session</h2>
        {me.data && (
          <p>{me.data.user ? `signed in as ${me.data.user.email}` : "not signed in"}</p>
        )}
      </section>
    </main>
  );
}

import { useState } from "react";
import { signIn, signUp } from "./auth";

/** Minimal email/password login + register (M1). */
export function AuthForm() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res =
      mode === "signin"
        ? await signIn.email({ email, password })
        : await signUp.email({ email, password, name });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Authentication failed");
  }

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 360, margin: "6rem auto", padding: "0 1rem" }}>
      <h1>Solar</h1>
      <form onSubmit={submit} style={{ display: "grid", gap: 8 }}>
        {mode === "signup" && (
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        )}
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" placeholder="Password (min 8)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        <button type="submit" disabled={busy}>
          {mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      <button
        style={{ marginTop: 12, background: "none", border: "none", color: "#06c", cursor: "pointer", padding: 0 }}
        onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
      >
        {mode === "signin" ? "Need an account? Register" : "Have an account? Sign in"}
      </button>
    </main>
  );
}

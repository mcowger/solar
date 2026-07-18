import { useState } from "react";
import { signIn, signUp } from "./auth";
import { ThemeToggle } from "./ThemeToggle";

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
    <main className="solar-auth grid min-h-dvh place-items-center p-5">
      <section className="solar-panel card w-full max-w-sm border shadow-sm">
        <div className="card-body gap-5">
          <div className="flex items-start justify-between"><div><p className="mb-1 text-sm tracking-[0.18em] uppercase opacity-60">A place to think</p><h1 className="solar-wordmark m-0 text-5xl">Solar</h1></div><ThemeToggle /></div>
      <form onSubmit={submit} className="grid gap-3">
        {mode === "signup" && (
          <input className="input w-full" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        )}
        <input className="input w-full" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="input w-full" type="password" placeholder="Password (min 8)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        <button className="btn btn-primary w-full" type="submit" disabled={busy}>
          {mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>
      {error && <p className="text-error">{error}</p>}
      <button
        className="btn btn-link justify-start px-0"
        onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
      >
        {mode === "signin" ? "Need an account? Register" : "Have an account? Sign in"}
      </button></div>
      </section>
    </main>
  );
}

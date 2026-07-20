import { useState } from "react";
import { signIn } from "./auth";
import { useGoogleAuthEnabled } from "./authProviders";
import { ThemeToggle } from "./ThemeToggle";

/** Minimal email/password login. */
export function AuthForm() {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const googleEnabled = useGoogleAuthEnabled();

	async function signInWithGoogle() {
		setBusy(true);
		setError(null);
		const res = await signIn.social({ provider: "google" });
		setBusy(false);
		if (res.error) setError(res.error.message ?? "Authentication failed");
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		if (document.activeElement instanceof HTMLElement)
			document.activeElement.blur();
		setBusy(true);
		setError(null);
		const res = await signIn.email({ email, password });
		setBusy(false);
		if (res.error) setError(res.error.message ?? "Authentication failed");
	}

	return (
		<main className="solar-auth grid min-h-dvh place-items-center p-5">
			<section className="solar-panel card w-full max-w-sm border shadow-sm">
				<div className="card-body gap-5">
					<div className="flex items-start justify-between">
						<div>
							<p className="mb-1 text-sm tracking-[0.18em] uppercase opacity-60">
								A place to think
							</p>
							<h1 className="solar-wordmark m-0 text-5xl">Solar</h1>
						</div>
						<ThemeToggle />
					</div>
					<form onSubmit={submit} className="grid gap-3">
						<input
							className="input w-full"
							type="email"
							placeholder="Email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
						/>
						<input
							className="input w-full"
							type="password"
							placeholder="Password (min 8)"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
							minLength={8}
						/>
						<button
							className="btn btn-primary w-full"
							type="submit"
							disabled={busy}
						>
							Sign in
						</button>
					</form>
					{googleEnabled && (
						<>
							<div className="divider my-0">or</div>
							<button
								className="btn w-full"
								type="button"
								onClick={signInWithGoogle}
								disabled={busy}
							>
								{busy && (
									<span className="loading loading-spinner loading-sm" />
								)}
								Continue with Google
							</button>
						</>
					)}
					{error && <p className="text-error">{error}</p>}
				</div>
			</section>
		</main>
	);
}

import type { Context } from "hono";
import { auth } from "../auth";
import { sqlite } from "../db";

/**
 * Per-request tRPC context. Resolves the Better Auth session (if any) so
 * procedures can read the current user. Auth-gated procedures arrive in M1.
 */
export async function createContext(_opts: unknown, c: Context) {
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session) return { user: null, session: null };
	const user = sqlite
		.query("SELECT role, isDisabled FROM user WHERE id = ?")
		.get(session.user.id) as { role: string; isDisabled: number } | null;
	return {
		user: user?.isDisabled
			? null
			: { ...session.user, role: user?.role ?? "user" },
		session: user?.isDisabled ? null : session.session,
	};
}

export type TrpcContext = Awaited<ReturnType<typeof createContext>>;

import type { Context } from "hono";
import { getSolarSession } from "../auth";

/**
 * Per-request tRPC context. Resolves the Better Auth session (if any) so
 * procedures can read the current user. Auth-gated procedures arrive in M1.
 */
export async function createContext(_opts: unknown, c: Context) {
	return (
		(await getSolarSession(c.req.raw.headers)) ?? { user: null, session: null }
	);
}

export type TrpcContext = Awaited<ReturnType<typeof createContext>>;

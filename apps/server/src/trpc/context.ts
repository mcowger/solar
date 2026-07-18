import type { Context } from "hono";
import { auth } from "../auth";

/**
 * Per-request tRPC context. Resolves the Better Auth session (if any) so
 * procedures can read the current user. Auth-gated procedures arrive in M1.
 */
export async function createContext(_opts: unknown, c: Context) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return {
    user: session?.user ?? null,
    session: session?.session ?? null,
  };
}

export type TrpcContext = Awaited<ReturnType<typeof createContext>>;

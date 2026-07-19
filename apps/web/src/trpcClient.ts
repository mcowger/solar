import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@solar/server";

/** Singleton vanilla tRPC client for both the provider and imperative calls. */
export const trpcClient = createTRPCClient<AppRouter>({
	links: [httpBatchLink({ url: "/trpc" })],
});

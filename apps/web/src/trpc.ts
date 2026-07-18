import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { AppRouter } from "@solar/server";

/**
 * Typed tRPC + TanStack Query bindings for the app. `AppRouter` is imported
 * type-only from the server package, giving end-to-end type safety with no
 * codegen.
 */
export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

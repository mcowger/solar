import { createAuthClient } from "better-auth/react";

/** Better Auth browser client. Same-origin; talks to /api/auth/*. */
export const authClient = createAuthClient();
export const { useSession, signIn, signUp, signOut } = authClient;

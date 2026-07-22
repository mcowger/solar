import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "./trpc";

/** Whether Google OAuth is configured on the server. False until loaded. */
export function useGoogleAuthEnabled(): boolean {
	const trpc = useTRPC();
	const { data } = useQuery(trpc.authProviders.queryOptions());
	return data?.google ?? false;
}

/** Whether Airgap Mode is enabled on the server. False until loaded. */
export function useAirgapMode(): boolean {
	const trpc = useTRPC();
	const { data } = useQuery(trpc.authProviders.queryOptions());
	return data?.airgap ?? false;
}

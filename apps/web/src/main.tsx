import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { trpcClient } from "./trpcClient";
import { TRPCProvider } from "./trpc";

if (import.meta.hot) {
	import.meta.hot.on("bun:afterUpdate", () => window.location.reload());
} else if ("serviceWorker" in navigator) {
	let reloading = false;

	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (!reloading) {
			reloading = true;
			sessionStorage.setItem("solar:service-worker-updated", "true");
			window.location.reload();
		}
	});
	window.addEventListener("pageshow", (event) => {
		if (event.persisted) {
			void navigator.serviceWorker.getRegistration().then((registration) => {
				if (registration) void registration.update();
			});
		}
	});

	void navigator.serviceWorker
		.register("/sw.js", { updateViaCache: "none" })
		.then((registration) => {
			void registration.update();
		})
		.catch((error: unknown) => {
			console.error("Solar service worker registration failed", error);
		});
}

function Root() {
	const [queryClient] = useState(() => new QueryClient());

	return (
		<QueryClientProvider client={queryClient}>
			<TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
				<App />
			</TRPCProvider>
		</QueryClientProvider>
	);
}

const el = document.getElementById("root");
if (el) {
	createRoot(el).render(
		<StrictMode>
			<Root />
		</StrictMode>,
	);
}

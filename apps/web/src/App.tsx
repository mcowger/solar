import { useSession } from "./auth";
import { AuthForm } from "./AuthForm";
import { ChatApp } from "./chat/ChatApp";
import { useEffect, useState } from "react";

const serviceWorkerUpdatedKey = "solar:service-worker-updated";
const updateNotificationDuration = 2_000;

export function App() {
	const { data: session, isPending } = useSession();
	const [showUpdateNotification, setShowUpdateNotification] = useState(
		() => sessionStorage.getItem(serviceWorkerUpdatedKey) === "true",
	);

	useEffect(() => {
		if (!showUpdateNotification) return;
		sessionStorage.removeItem(serviceWorkerUpdatedKey);
		const timeout = window.setTimeout(
			() => setShowUpdateNotification(false),
			updateNotificationDuration,
		);
		return () => window.clearTimeout(timeout);
	}, [showUpdateNotification]);

	return (
		<>
			{isPending ? (
				<p style={{ fontFamily: "system-ui", padding: "2rem" }}>Loading…</p>
			) : session ? (
				<ChatApp />
			) : (
				<AuthForm />
			)}
			{showUpdateNotification && (
				<div className="toast toast-bottom toast-start solar-update-toast">
					<div className="solar-update-notice">Updated</div>
				</div>
			)}
		</>
	);
}

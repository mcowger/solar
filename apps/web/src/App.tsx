import { useSession } from "./auth";
import { AuthForm } from "./AuthForm";
import { ChatApp } from "./chat/ChatApp";

export function App() {
	const { data: session, isPending } = useSession();
	if (isPending)
		return <p style={{ fontFamily: "system-ui", padding: "2rem" }}>Loading…</p>;
	return session ? <ChatApp /> : <AuthForm />;
}

import { useEffect } from "react";

const DESKTOP_MEDIA_QUERY = "(min-width: 650px)";

/** Starts a new chat with the platform-standard Command/Ctrl+N shortcut. */
export function useNewChatHotkey(onNewChat: () => void) {
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (
				!window.matchMedia(DESKTOP_MEDIA_QUERY).matches ||
				event.repeat ||
				event.key.toLowerCase() !== "n" ||
				(!event.metaKey && !event.ctrlKey) ||
				event.altKey ||
				event.shiftKey
			) {
				return;
			}

			event.preventDefault();
			onNewChat();
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onNewChat]);
}

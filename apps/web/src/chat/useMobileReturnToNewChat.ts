import { useEffect, useRef } from "react";

const MOBILE_MEDIA_QUERY = "(max-width: 649px)";
const RETURNED_AT_KEY = "solar:mobile-hidden-at";
const INACTIVITY_THRESHOLD_MS = 5 * 60 * 1_000;

export function useMobileReturnToNewChat(onReturn: () => void) {
	const onReturnRef = useRef(onReturn);

	useEffect(() => {
		onReturnRef.current = onReturn;
	}, [onReturn]);

	useEffect(() => {
		const isMobile = () => window.matchMedia(MOBILE_MEDIA_QUERY).matches;
		const markHidden = () => {
			if (isMobile())
				sessionStorage.setItem(RETURNED_AT_KEY, String(Date.now()));
		};
		const handleReturn = () => {
			if (!isMobile()) return;
			const hiddenAt = Number(sessionStorage.getItem(RETURNED_AT_KEY));
			if (!hiddenAt) return;
			sessionStorage.removeItem(RETURNED_AT_KEY);
			if (Date.now() - hiddenAt > INACTIVITY_THRESHOLD_MS) {
				onReturnRef.current();
			}
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState === "hidden") markHidden();
			else handleReturn();
		};

		window.addEventListener("pagehide", markHidden);
		document.addEventListener("visibilitychange", handleVisibilityChange);
		window.addEventListener("pageshow", handleReturn);
		handleReturn();

		return () => {
			window.removeEventListener("pagehide", markHidden);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			window.removeEventListener("pageshow", handleReturn);
		};
	}, []);
}

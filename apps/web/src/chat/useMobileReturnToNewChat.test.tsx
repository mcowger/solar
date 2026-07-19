import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useMobileReturnToNewChat } from "./useMobileReturnToNewChat";

const threshold = 5 * 60 * 1_000;
const originalMatchMedia = window.matchMedia;

const matchMedia = (matches: boolean) =>
	mock(
		(query: string) =>
			({
				matches,
				media: query,
				onchange: null,
				addListener: () => {},
				removeListener: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				dispatchEvent: () => true,
			}) as MediaQueryList,
	);

describe("useMobileReturnToNewChat", () => {
	beforeEach(() => {
		sessionStorage.clear();
		window.matchMedia = matchMedia(true) as typeof window.matchMedia;
		spyOn(Date, "now").mockReturnValue(1_000_000);
	});

	afterEach(() => {
		window.matchMedia = originalMatchMedia;
		mock.restore();
	});

	test("starts a new chat after more than five minutes away", () => {
		const now = Date.now();
		sessionStorage.setItem(
			"solar:mobile-hidden-at",
			String(now - threshold - 1),
		);
		const onReturn = mock();

		renderHook(() => useMobileReturnToNewChat(onReturn));

		expect(onReturn).toHaveBeenCalledTimes(1);
		expect(sessionStorage.getItem("solar:mobile-hidden-at")).toBeNull();
	});

	test("does not start a new chat at or below five minutes", () => {
		sessionStorage.setItem(
			"solar:mobile-hidden-at",
			String(Date.now() - threshold),
		);
		const onReturn = mock();

		renderHook(() => useMobileReturnToNewChat(onReturn));

		expect(onReturn).not.toHaveBeenCalled();
	});

	test("does not start a new chat on desktop", () => {
		window.matchMedia = matchMedia(false) as typeof window.matchMedia;
		sessionStorage.setItem(
			"solar:mobile-hidden-at",
			String(Date.now() - threshold - 1),
		);
		const onReturn = mock();

		renderHook(() => useMobileReturnToNewChat(onReturn));

		expect(onReturn).not.toHaveBeenCalled();
	});

	test("records mobile page hides and handles the return once", () => {
		const onReturn = mock();
		renderHook(() => useMobileReturnToNewChat(onReturn));

		act(() => window.dispatchEvent(new Event("pagehide")));
		expect(sessionStorage.getItem("solar:mobile-hidden-at")).not.toBeNull();

		const hiddenAt = Number(sessionStorage.getItem("solar:mobile-hidden-at"));
		sessionStorage.setItem(
			"solar:mobile-hidden-at",
			String(hiddenAt - threshold - 1),
		);
		act(() => window.dispatchEvent(new Event("pageshow")));
		act(() => window.dispatchEvent(new Event("pageshow")));

		expect(onReturn).toHaveBeenCalledTimes(1);
	});
});

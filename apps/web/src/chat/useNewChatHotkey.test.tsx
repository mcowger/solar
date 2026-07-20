import { afterEach, describe, expect, mock, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useNewChatHotkey } from "./useNewChatHotkey";

const originalMatchMedia = window.matchMedia;

function setDesktop(matches: boolean) {
	window.matchMedia = mock(
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
	) as typeof window.matchMedia;
}

function pressN(options: KeyboardEventInit) {
	const event = new KeyboardEvent("keydown", {
		key: "n",
		cancelable: true,
		...options,
	});
	window.dispatchEvent(event);
	return event;
}

afterEach(() => {
	window.matchMedia = originalMatchMedia;
	mock.restore();
});

describe("useNewChatHotkey", () => {
	test.each([
		["Command+N", { metaKey: true }],
		["Control+N", { ctrlKey: true }],
	])("starts a new chat with %s on desktop", (_name, options) => {
		setDesktop(true);
		const onNewChat = mock();
		renderHook(() => useNewChatHotkey(onNewChat));

		const event = pressN(options);

		expect(onNewChat).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
	});

	test("does not override the shortcut on mobile", () => {
		setDesktop(false);
		const onNewChat = mock();
		renderHook(() => useNewChatHotkey(onNewChat));

		const event = pressN({ ctrlKey: true });

		expect(onNewChat).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	test.each([
		["plain N", {}],
		["Shift+Control+N", { ctrlKey: true, shiftKey: true }],
		["Alt+Command+N", { metaKey: true, altKey: true }],
		["a repeated Control+N", { ctrlKey: true, repeat: true }],
	])("ignores %s", (_name, options) => {
		setDesktop(true);
		const onNewChat = mock();
		renderHook(() => useNewChatHotkey(onNewChat));

		pressN(options);

		expect(onNewChat).not.toHaveBeenCalled();
	});
});

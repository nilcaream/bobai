import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "@testing-library/react";
import { useProgressIndicator } from "../src/hooks/useProgressIndicator";
import { renderTestHook } from "./hookHelpers";

describe("useProgressIndicator", () => {
	const originalNow = Date.now;
	const originalSetInterval = window.setInterval;
	const originalClearInterval = window.clearInterval;

	let nowValue: number;
	let intervalCallback: (() => void) | undefined;

	beforeEach(() => {
		nowValue = 1_000_000;
		intervalCallback = undefined;
		Date.now = mock(() => nowValue) as typeof Date.now;
		window.setInterval = mock((cb: () => void) => {
			intervalCallback = cb;
			return 1;
		}) as typeof setInterval;
		window.clearInterval = mock(() => {}) as typeof clearInterval;
	});

	afterEach(() => {
		Date.now = originalNow;
		window.setInterval = originalSetInterval;
		window.clearInterval = originalClearInterval;
	});

	test("starts idle and renders nothing", async () => {
		const hook = await renderTestHook(() => useProgressIndicator());
		expect(hook.getValue().progressText).toBeNull();
		await hook.unmount();
	});

	test("beginWaiting starts a timer that appears after the threshold", async () => {
		const hook = await renderTestHook(() => useProgressIndicator());

		await act(async () => {
			hook.getValue().beginWaiting();
		});
		// Immediately after beginWaiting — under the 200ms threshold, still hidden.
		expect(hook.getValue().progressText).toBeNull();

		nowValue += 1500;
		await act(async () => {
			intervalCallback?.();
		});

		expect(hook.getValue().progressText).toBe("Waiting 1.5 s");
		await hook.unmount();
	});

	test("observe drives phase transitions", async () => {
		const hook = await renderTestHook(() => useProgressIndicator());

		await act(async () => {
			hook.getValue().observe({ type: "token", text: "a" });
			hook.getValue().observe({ type: "token", text: "b" });
			hook.getValue().observe({ type: "token", text: "c" });
		});

		nowValue += 2000;
		await act(async () => {
			intervalCallback?.();
		});

		expect(hook.getValue().progressText).toBe("Processing 3 events");
		await hook.unmount();
	});

	test("reset clears an active phase", async () => {
		const hook = await renderTestHook(() => useProgressIndicator());

		await act(async () => {
			hook.getValue().observe({ type: "tool_call", id: "t1", output: "run", mergeable: false });
		});
		await act(async () => {
			hook.getValue().reset();
		});

		expect(hook.getValue().progressText).toBeNull();
		await hook.unmount();
	});
});

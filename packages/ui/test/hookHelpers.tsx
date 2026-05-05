import { act } from "@testing-library/react";
import { createRoot } from "react-dom/client";

export interface HookHarnessResult<T> {
	getValue: () => T;
	render: () => Promise<void>;
	unmount: () => Promise<void>;
}

export async function renderTestHook<T>(useHook: () => T): Promise<HookHarnessResult<T>> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	let currentValue: T | undefined;

	function TestComponent() {
		currentValue = useHook();
		return null;
	}

	await act(async () => {
		root.render(<TestComponent />);
	});

	return {
		getValue: () => {
			if (currentValue === undefined) {
				throw new Error("Hook value is not available yet");
			}
			return currentValue;
		},
		render: async () => {
			await act(async () => {
				root.render(<TestComponent />);
			});
		},
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		},
	};
}

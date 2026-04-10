import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { SlashCommandPanel } from "../src/SlashCommandPanel";

describe("SlashCommandPanel", () => {
	test("returns null when parsed is null", () => {
		const { container } = render(<SlashCommandPanel parsed={null} />);
		expect(container.innerHTML).toBe("");
	});

	test("shows 'No matching skills' when matches is empty", () => {
		render(<SlashCommandPanel parsed={{ prefix: "foo", matches: [] }} />);
		expect(screen.queryByText("No matching skills")).not.toBeNull();
	});

	test("shows skill names and descriptions when matches exist", () => {
		const parsed = {
			prefix: "d",
			matches: [{ name: "debug", description: "Debug the code" }],
		};
		render(<SlashCommandPanel parsed={parsed} />);
		expect(screen.queryByText(/debug/)).not.toBeNull();
		expect(screen.queryByText(/Debug the code/)).not.toBeNull();
	});

	test("shows multiple skills in order", () => {
		const parsed = {
			prefix: "",
			matches: [
				{ name: "alpha", description: "First skill" },
				{ name: "beta", description: "Second skill" },
				{ name: "gamma", description: "Third skill" },
			],
		};
		const { container } = render(<SlashCommandPanel parsed={parsed} />);
		const rows = container.querySelectorAll(".slash-skill-row");
		expect(rows.length).toBe(3);
		expect(rows[0].textContent).toContain("alpha");
		expect(rows[1].textContent).toContain("beta");
		expect(rows[2].textContent).toContain("gamma");
	});
});

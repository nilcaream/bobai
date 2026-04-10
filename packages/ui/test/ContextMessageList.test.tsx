import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ContextMessageList } from "../src/ContextMessageList";
import type { ContextMessage } from "../src/formatUtils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopCompaction = null;
const noopContext = null;

function mkMsg(role: ContextMessage["role"], content: string, metadata: Record<string, unknown> | null = null): ContextMessage {
	return { role, content, metadata };
}

// ---------------------------------------------------------------------------
// Context mode
// ---------------------------------------------------------------------------
describe("ContextMessageList — context mode", () => {
	test("shows empty state when contextMessages is null", () => {
		render(
			<ContextMessageList contextMessages={noopContext} compactionData={noopCompaction} viewMode="context" lineLimit={0} />,
		);
		expect(screen.queryByText("No session context available.")).not.toBeNull();
	});

	test("renders system message with 'system' header", () => {
		const msgs: ContextMessage[] = [mkMsg("system", "You are a helpful assistant.")];
		const { container } = render(
			<ContextMessageList contextMessages={msgs} compactionData={noopCompaction} viewMode="context" lineLimit={0} />,
		);
		const headers = container.querySelectorAll(".context-header");
		expect(headers).toHaveLength(1);
		expect(headers[0]?.textContent).toBe("system");

		const bodies = container.querySelectorAll(".context-body");
		expect(bodies[0]?.textContent).toBe("You are a helpful assistant.");
	});

	test("renders user message with 'user' header", () => {
		const msgs: ContextMessage[] = [mkMsg("user", "Hello world")];
		const { container } = render(
			<ContextMessageList contextMessages={msgs} compactionData={noopCompaction} viewMode="context" lineLimit={0} />,
		);
		const headers = container.querySelectorAll(".context-header");
		expect(headers).toHaveLength(1);
		expect(headers[0]?.textContent).toBe("user");
	});

	test("renders assistant text message with 'assistant' header", () => {
		const msgs: ContextMessage[] = [mkMsg("assistant", "Sure, I can help.", null)];
		const { container } = render(
			<ContextMessageList contextMessages={msgs} compactionData={noopCompaction} viewMode="context" lineLimit={0} />,
		);
		const headers = container.querySelectorAll(".context-header");
		expect(headers).toHaveLength(1);
		expect(headers[0]?.textContent).toBe("assistant");

		const bodies = container.querySelectorAll(".context-body");
		expect(bodies[0]?.textContent).toBe("Sure, I can help.");
	});

	test("renders assistant tool_calls with 'assistant | {id}' header", () => {
		const msgs: ContextMessage[] = [
			mkMsg("assistant", "", {
				tool_calls: [{ id: "call_123", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
			}),
		];
		const { container } = render(
			<ContextMessageList contextMessages={msgs} compactionData={noopCompaction} viewMode="context" lineLimit={0} />,
		);
		const headers = container.querySelectorAll(".context-header");
		// Empty content means no text panel, only the tool_call panel
		expect(headers).toHaveLength(1);
		expect(headers[0]?.textContent).toBe("assistant | call_123");
	});

	test("renders tool message with 'tool | {id} | {name}' header", () => {
		const msgs: ContextMessage[] = [
			// The assistant message is needed to populate the toolCallNames map
			mkMsg("assistant", "", {
				tool_calls: [{ id: "call_abc", type: "function", function: { name: "read_file", arguments: "{}" } }],
			}),
			mkMsg("tool", "file content here", { tool_call_id: "call_abc" }),
		];
		const { container } = render(
			<ContextMessageList contextMessages={msgs} compactionData={noopCompaction} viewMode="context" lineLimit={0} />,
		);
		const headers = container.querySelectorAll(".context-header");
		// 1 for assistant tool_call panel + 1 for tool panel
		expect(headers).toHaveLength(2);
		expect(headers[1]?.textContent).toBe("tool | call_abc | read_file");
	});

	test("truncates content when lineLimit is set", () => {
		// Generate 60 lines of content (truncateContent keeps 20 head + 20 tail when lineLimit > 0)
		const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
		const content = lines.join("\n");
		const msgs: ContextMessage[] = [mkMsg("user", content)];
		const { container } = render(
			<ContextMessageList contextMessages={msgs} compactionData={noopCompaction} viewMode="context" lineLimit={40} />,
		);
		const body = container.querySelector(".context-body");
		expect(body).not.toBeNull();
		const text = body?.textContent ?? "";
		// Should contain the truncation marker
		expect(text).toContain("more lines");
		// Should NOT contain all 60 lines
		expect(text).not.toContain("line 30");
	});
});

// ---------------------------------------------------------------------------
// Compaction mode
// ---------------------------------------------------------------------------
describe("ContextMessageList — compaction mode", () => {
	test("shows empty state when compactionData is null", () => {
		render(
			<ContextMessageList contextMessages={noopContext} compactionData={noopCompaction} viewMode="compaction" lineLimit={0} />,
		);
		expect(screen.queryByText("No compaction data available.")).not.toBeNull();
	});

	test("renders system message with 'system | excluded from compaction' header", () => {
		const data = {
			messages: [mkMsg("system", "System prompt")],
			stats: null,
			details: null,
		};
		const { container } = render(
			<ContextMessageList contextMessages={noopContext} compactionData={data} viewMode="compaction" lineLimit={0} />,
		);
		const headers = container.querySelectorAll(".context-header");
		expect(headers).toHaveLength(1);
		expect(headers[0]?.textContent).toBe("system | excluded from compaction");
	});

	test("renders user message with 'user | excluded from compaction' header", () => {
		const data = {
			messages: [mkMsg("user", "Hello")],
			stats: null,
			details: null,
		};
		const { container } = render(
			<ContextMessageList contextMessages={noopContext} compactionData={data} viewMode="compaction" lineLimit={0} />,
		);
		const headers = container.querySelectorAll(".context-header");
		expect(headers).toHaveLength(1);
		expect(headers[0]?.textContent).toBe("user | excluded from compaction");
	});

	test("renders tool message with formatToolHeader output", () => {
		const data = {
			messages: [
				mkMsg("assistant", "", {
					tool_calls: [{ id: "call_x", type: "function", function: { name: "bash", arguments: "{}" } }],
				}),
				mkMsg("tool", "output", { tool_call_id: "call_x" }),
			],
			stats: null,
			details: {
				call_x: {
					age: 0.5,
					compactionFactor: 0.3,
					position: 0.1,
					normalizedPosition: 0.2,
					wasCompacted: false,
				},
			},
		};
		const { container } = render(
			<ContextMessageList contextMessages={noopContext} compactionData={data} viewMode="compaction" lineLimit={0} />,
		);
		const headers = container.querySelectorAll(".context-header");
		// 1 for assistant tool_call + 1 for tool
		const toolHeader = headers[headers.length - 1]?.textContent ?? "";
		expect(toolHeader.startsWith("tool |")).toBe(true);
		// Should contain position/age info from formatToolHeader, NOT "excluded from compaction"
		expect(toolHeader).toContain("call_x");
		expect(toolHeader).toContain("bash");
	});

	test("does NOT truncate content in compaction mode", () => {
		const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
		const content = lines.join("\n");
		const data = {
			messages: [mkMsg("user", content)],
			stats: null,
			details: null,
		};
		const { container } = render(
			<ContextMessageList contextMessages={noopContext} compactionData={data} viewMode="compaction" lineLimit={40} />,
		);
		const body = container.querySelector(".context-body");
		expect(body).not.toBeNull();
		const text = body?.textContent ?? "";
		// In compaction mode, content is trimmed but NOT truncated
		expect(text).not.toContain("more lines");
		// All lines should be present
		expect(text).toContain("line 30");
		expect(text).toContain("line 60");
	});
});

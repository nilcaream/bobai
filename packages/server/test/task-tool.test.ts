import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentEvent } from "../src/agent-loop";
import type { ServerMessage } from "../src/protocol";
import type { Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";
import { createSession, getMessages, listSubagentSessions } from "../src/session/repository";
import { SubagentStatus } from "../src/subagent-status";
import { createTaskTool } from "../src/tool/task";
import { createTestDb } from "./helpers";

// Minimal mock provider: yields text, done.
function textOnlyProvider(text: string): Provider {
	return {
		id: "mock",
		async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			yield { type: "text", text };
			yield { type: "finish", reason: "stop" };
		},
		beginTurn() {},
		getTurnSummary() {
			return " | test-model | agent: 1 | user: 0 | 0.01s";
		},
		saveTurnState() {
			return {};
		},
		restoreTurnState() {},
	};
}

describe("createTaskTool", () => {
	let db: Database;
	let parentSessionId: string;

	beforeAll(() => {
		db = createTestDb();
		// Create a parent session so FK constraints are satisfied
		const parent = createSession(db, "system prompt");
		parentSessionId = parent.id;
	});

	afterAll(() => {
		db.close();
	});

	test("returns a Tool with correct definition", () => {
		const tool = createTaskTool({
			db,
			provider: textOnlyProvider("ok"),
			model: "test-model",
			parentSessionId,
			projectRoot: "/tmp",
			systemPrompt: "You are a subagent.",
			onEvent: () => {},
			subagentStatus: new SubagentStatus(),
		});
		expect(tool.definition.function.name).toBe("task");
		expect(tool.definition.function.parameters).toBeTruthy();
	});

	test("executes and creates a child session", async () => {
		const events: AgentEvent[] = [];
		const status = new SubagentStatus();
		const tool = createTaskTool({
			db,
			provider: textOnlyProvider("I found 3 files."),
			model: "test-model",
			parentSessionId,
			projectRoot: "/tmp",
			systemPrompt: "You are a subagent.",
			onEvent: (e) => events.push(e),
			subagentStatus: status,
		});

		const result = await tool.execute(
			{ description: "Explore the codebase", prompt: "Find all TypeScript files" },
			{ projectRoot: "/tmp" },
		);

		// Result should contain the agent's final text
		expect(result.llmOutput).toContain("I found 3 files.");
		expect(result.llmOutput).toContain("task_id");

		// Should have created a subagent session
		const subagents = listSubagentSessions(db, parentSessionId);
		expect(subagents.length).toBeGreaterThanOrEqual(1);

		// Status should be "done"
		const latestSubagent = subagents[0];
		expect(status.get(latestSubagent.id)).toBe("done");

		// Summary should contain model and timing info
		expect(result.summary).toBeDefined();
		expect(result.summary).toContain("test-model");
		expect(result.summary).toContain("agent:");
	});

	test("formatCall returns description", () => {
		const tool = createTaskTool({
			db,
			provider: textOnlyProvider("ok"),
			model: "test-model",
			parentSessionId,
			projectRoot: "/tmp",
			systemPrompt: "sys",
			onEvent: () => {},
			subagentStatus: new SubagentStatus(),
		});

		const output = tool.formatCall({ description: "Explore codebase", prompt: "find files" });
		expect(output).toContain("Explore codebase");
	});

	test("child session has system prompt and task prompt as messages", async () => {
		const tool = createTaskTool({
			db,
			provider: textOnlyProvider("done"),
			model: "test-model",
			parentSessionId,
			projectRoot: "/tmp",
			systemPrompt: "You are a subagent.",
			onEvent: () => {},
			subagentStatus: new SubagentStatus(),
		});

		const result = await tool.execute({ description: "Test task", prompt: "Do the thing" }, { projectRoot: "/tmp" });

		// Extract task_id from result to get the exact child session
		const taskIdMatch = result.llmOutput.match(/\[task_id: ([^\]]+)\]/);
		expect(taskIdMatch).toBeTruthy();
		const childSessionId = taskIdMatch?.[1] as string;

		const messages = getMessages(db, childSessionId);

		// Messages: system + task user + agent assistant
		expect(messages.length).toBeGreaterThanOrEqual(3);
		expect(messages[0].role).toBe("system");
		expect(messages[0].content).toBe("You are a subagent.");

		// Task prompt (directly after system)
		expect(messages[1].role).toBe("user");
		expect(messages[1].content).toBe("Do the thing");
		expect(messages[1].metadata).toEqual({ source: "agent", parentSessionId });
	});

	test("sets error status when agent loop throws", async () => {
		const failAgentProvider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				yield { type: "text", text: "" };
				throw new Error("agent loop exploded");
			},
			beginTurn() {},
			getTurnSummary() {
				return " | test-model | agent: 0 | 0.01s";
			},
			saveTurnState() {
				return {};
			},
			restoreTurnState() {},
		};

		const status = new SubagentStatus();
		const tool = createTaskTool({
			db,
			provider: failAgentProvider,
			model: "test-model",
			parentSessionId,
			projectRoot: "/tmp",
			systemPrompt: "sys",
			onEvent: () => {},
			subagentStatus: status,
		});

		const result = await tool.execute(
			{ description: "Failing task", prompt: "do something that fails" },
			{ projectRoot: "/tmp" },
		);

		// Should return error message, not throw
		expect(result.llmOutput).toContain("Subagent failed");
		expect(result.llmOutput).toContain("agent loop exploded");
		expect(result.llmOutput).toContain("task_id");

		// Extract task_id and verify error status
		const taskIdMatch = result.llmOutput.match(/\[task_id: ([^\]]+)\]/);
		expect(taskIdMatch).toBeTruthy();
		expect(status.get(taskIdMatch?.[1] as string)).toBe("error");

		// Error summary should include timing and error indicator
		expect(result.summary).toBeDefined();
		expect(result.summary).toContain("error");
		expect(result.summary).toContain("test-model");
	});

	test("resume rejects non-existent session", async () => {
		const tool = createTaskTool({
			db,
			provider: textOnlyProvider("ok"),
			model: "test-model",
			parentSessionId,
			projectRoot: "/tmp",
			systemPrompt: "sys",
			onEvent: () => {},
			subagentStatus: new SubagentStatus(),
		});

		const result = await tool.execute(
			{ description: "Resume", prompt: "continue", task_id: "non-existent-id" },
			{ projectRoot: "/tmp" },
		);

		expect(result.llmOutput).toContain("not found");
	});

	test("resume rejects non-subagent session", async () => {
		// parentSessionId is a regular session (no parent_id), not a subagent
		const tool = createTaskTool({
			db,
			provider: textOnlyProvider("ok"),
			model: "test-model",
			parentSessionId,
			projectRoot: "/tmp",
			systemPrompt: "sys",
			onEvent: () => {},
			subagentStatus: new SubagentStatus(),
		});

		const result = await tool.execute(
			{ description: "Resume", prompt: "continue", task_id: parentSessionId },
			{ projectRoot: "/tmp" },
		);

		expect(result.llmOutput).toContain("not a subagent session");
	});

	test("saves and restores provider turn state around subagent execution", async () => {
		const stateOps: string[] = [];
		let savedState: unknown = null;
		const statefulProvider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				yield { type: "text", text: "agent result" };
				yield { type: "finish", reason: "stop" };
			},
			beginTurn() {
				stateOps.push("beginTurn");
			},
			getTurnSummary() {
				return " | mock-model | agent: 1 | 0.50s";
			},
			saveTurnState() {
				stateOps.push("save");
				return { saved: true };
			},
			restoreTurnState(state: unknown) {
				stateOps.push("restore");
				savedState = state;
			},
		};

		const tool = createTaskTool({
			db,
			provider: statefulProvider,
			model: "test-model",
			parentSessionId,
			projectRoot: "/tmp",
			systemPrompt: "sys",
			onEvent: () => {},
			subagentStatus: new SubagentStatus(),
		});

		const result = await tool.execute({ description: "Test", prompt: "do it" }, { projectRoot: "/tmp" });

		// Should have saved before subagent run, then restored after
		expect(stateOps).toContain("save");
		expect(stateOps).toContain("beginTurn");
		expect(stateOps).toContain("restore");

		// save should come before beginTurn which should come before restore
		const saveIdx = stateOps.indexOf("save");
		const beginIdx = stateOps.indexOf("beginTurn");
		const restoreIdx = stateOps.indexOf("restore");
		expect(saveIdx).toBeLessThan(beginIdx);
		expect(beginIdx).toBeLessThan(restoreIdx);

		// Restored state should be the same object that was saved
		expect(savedState).toEqual({ saved: true });

		// Summary should come from getTurnSummary() with timestamp prefix
		expect(result.summary).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| mock-model \| agent: 1 \| 0\.50s$/);
	});

	test("summary includes a timestamp prefix", async () => {
		const tool = createTaskTool({
			db,
			provider: textOnlyProvider("result"),
			model: "test-model",
			parentSessionId,
			projectRoot: "/tmp",
			systemPrompt: "sys",
			onEvent: () => {},
			subagentStatus: new SubagentStatus(),
		});

		const result = await tool.execute({ description: "Test", prompt: "do it" }, { projectRoot: "/tmp" });

		expect(result.summary).toBeDefined();
		// Summary should start with a timestamp like "2026-03-06 09:07:41 |"
		expect(result.summary).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
	});

	test("error summary includes a timestamp prefix", async () => {
		const failProvider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				yield { type: "text", text: "" };
				throw new Error("boom");
			},
			beginTurn() {},
			getTurnSummary() {
				return " | test-model | agent: 0 | 0.01s";
			},
			saveTurnState() {
				return {};
			},
			restoreTurnState() {},
		};

		const tool = createTaskTool({
			db,
			provider: failProvider,
			model: "test-model",
			parentSessionId,
			projectRoot: "/tmp",
			systemPrompt: "sys",
			onEvent: () => {},
			subagentStatus: new SubagentStatus(),
		});

		const result = await tool.execute({ description: "Test", prompt: "do it" }, { projectRoot: "/tmp" });
		expect(result.summary).toBeDefined();
		expect(result.summary).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
		expect(result.summary).toContain("error");
	});

	test("emits subagent_start and subagent_done via sendWs", async () => {
		const wsMsgs: ServerMessage[] = [];
		const tool = createTaskTool({
			db,
			provider: textOnlyProvider("result"),
			model: "test-model",
			parentSessionId,
			projectRoot: "/tmp",
			systemPrompt: "sys",
			onEvent: () => {},
			sendWs: (msg) => wsMsgs.push(msg),
			subagentStatus: new SubagentStatus(),
		});

		await tool.execute({ description: "Test", prompt: "do it" }, { projectRoot: "/tmp" });

		const startMsg = wsMsgs.find((m) => m.type === "subagent_start");
		expect(startMsg).toBeTruthy();
		expect(startMsg.title).toBeTruthy();
		expect(startMsg.sessionId).toBeTruthy();

		const doneMsg = wsMsgs.find((m) => m.type === "subagent_done");
		expect(doneMsg).toBeTruthy();
		expect(doneMsg.sessionId).toBe(startMsg.sessionId);
	});

	test("persists tool metadata and turn summary in child session messages", async () => {
		// Provider that triggers a bash tool call on first request, then responds with text
		let callCount = 0;
		const toolCallingProvider: Provider = {
			id: "mock",
			async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				if (callCount === 1 && opts.tools?.length) {
					// Trigger a bash tool call
					yield { type: "tool_call_start", index: 0, id: "call_bash_1", name: "bash" };
					yield { type: "tool_call_delta", index: 0, arguments: '{"command":"echo hi"}' };
					yield { type: "finish", reason: "tool_calls" };
					return;
				}
				yield { type: "text", text: "The command output hi." };
				yield { type: "finish", reason: "stop" };
			},
			beginTurn() {},
			getTurnSummary() {
				return " | test-model | agent: 2 | user: 0 | 0.05s";
			},
			saveTurnState() {
				return {};
			},
			restoreTurnState() {},
		};

		const tool = createTaskTool({
			db,
			provider: toolCallingProvider,
			model: "test-model",
			parentSessionId,
			projectRoot: "/tmp",
			systemPrompt: "You are a subagent.",
			onEvent: () => {},
			subagentStatus: new SubagentStatus(),
		});

		const result = await tool.execute(
			{ description: "Run echo command", prompt: "Run echo hi and report the output" },
			{ projectRoot: "/tmp" },
		);

		const taskIdMatch = result.llmOutput.match(/\[task_id: ([^\]]+)\]/);
		expect(taskIdMatch).toBeTruthy();
		const childSessionId = taskIdMatch?.[1] as string;

		const messages = getMessages(db, childSessionId);

		// Find the tool message — should have metadata with format_call, ui_output, mergeable
		const toolMsg = messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeTruthy();
		expect(toolMsg?.metadata?.tool_call_id).toBe("call_bash_1");
		expect(toolMsg?.metadata?.format_call).toBeDefined();
		// bash tool formatCall returns something like "$ `echo hi`"
		expect(typeof toolMsg?.metadata?.format_call).toBe("string");
		// ui_output should be a string (bash produces output)
		expect(toolMsg?.metadata).toHaveProperty("ui_output");
		// mergeable should be present
		expect(toolMsg?.metadata).toHaveProperty("mergeable");

		// Find the last assistant message — should have summary and turn_model
		const assistantMsgs = messages.filter((m) => m.role === "assistant");
		const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
		expect(lastAssistant).toBeTruthy();
		expect(lastAssistant?.metadata?.summary).toContain("test-model");
		expect(lastAssistant?.metadata?.summary).toContain("agent: 2");
		expect(lastAssistant?.metadata?.turn_model).toBe("test-model");
	});
});

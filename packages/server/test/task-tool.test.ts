import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentEvent } from "../src/agent-loop";
import type { ServerMessage } from "../src/protocol";
import type { Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";
import { createSession, getMessages, listSubagentSessions } from "../src/session/repository";
import { SubagentStatus } from "../src/subagent-status";
import { createTaskTool } from "../src/tool/task";
import { createTestDb } from "./helpers";

// Minimal mock provider: first call yields text, done.
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

// Title-generating provider: returns a short title on first call, then agent text
function titleAndAgentProvider(titleText: string, agentText: string): Provider {
	let callCount = 0;
	let agentCalls = 0;
	return {
		id: "mock",
		async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
			callCount++;
			// First call is title generation (single user message with "Generate" prefix)
			const lastMsg = opts.messages[opts.messages.length - 1];
			if (callCount === 1 && lastMsg?.role === "user" && (lastMsg as { content: string }).content.startsWith("Generate")) {
				yield { type: "text", text: titleText };
				yield { type: "finish", reason: "stop" };
				return;
			}
			// Agent loop call
			agentCalls++;
			yield { type: "text", text: agentText };
			yield { type: "finish", reason: "stop" };
		},
		beginTurn() {
			agentCalls = 0;
		},
		getTurnSummary() {
			return ` | test-model | agent: ${agentCalls} | user: 0 | 0.01s`;
		},
		saveTurnState() {
			return { agentCalls };
		},
		restoreTurnState(state: unknown) {
			agentCalls = (state as { agentCalls: number }).agentCalls;
		},
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
			provider: titleAndAgentProvider("Code explorer", "I found 3 files."),
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

	test("uses description as title fallback on title generation failure", async () => {
		// Provider that throws on first call (title gen) and succeeds on agent call
		let callCount = 0;
		const failTitleProvider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				if (callCount === 1) {
					throw new Error("title gen failed");
				}
				yield { type: "text", text: "result" };
				yield { type: "finish", reason: "stop" };
			},
		};

		const tool = createTaskTool({
			db,
			provider: failTitleProvider,
			model: "test-model",
			parentSessionId,
			projectRoot: "/tmp",
			systemPrompt: "sys",
			onEvent: () => {},
			subagentStatus: new SubagentStatus(),
		});

		const result = await tool.execute({ description: "My fallback title", prompt: "do something" }, { projectRoot: "/tmp" });

		expect(result.llmOutput).toContain("result");
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
			provider: titleAndAgentProvider("title", "done"),
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

		// Messages: system + title-gen user + title-gen assistant + task user + agent assistant
		expect(messages.length).toBeGreaterThanOrEqual(5);
		expect(messages[0].role).toBe("system");
		expect(messages[0].content).toBe("You are a subagent.");

		// Title gen messages
		expect(messages[1].role).toBe("user");
		expect(messages[1].metadata?.purpose).toBe("title-generation");
		expect(messages[2].role).toBe("assistant");
		expect(messages[2].metadata?.purpose).toBe("title-generation");

		// Task prompt (after title gen)
		const taskUserMsg = messages.find((m) => m.role === "user" && m.metadata?.source === "agent");
		expect(taskUserMsg).toBeTruthy();
		expect(taskUserMsg?.content).toBe("Do the thing");
		expect(taskUserMsg?.metadata).toEqual({ source: "agent", parentSessionId });
	});

	test("sets error status when agent loop throws", async () => {
		// Provider that succeeds for title gen but throws during agent loop
		let callCount = 0;
		const failAgentProvider: Provider = {
			id: "mock",
			async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				const lastMsg = opts.messages[opts.messages.length - 1];
				if (callCount === 1 && lastMsg?.role === "user" && (lastMsg as { content: string }).content.startsWith("Generate")) {
					yield { type: "text", text: "title" };
					yield { type: "finish", reason: "stop" };
					return;
				}
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

	test("title generation uses initiator: agent", async () => {
		const initiators: Array<"user" | "agent" | undefined> = [];
		const capturingProvider: Provider = {
			id: "mock",
			async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				initiators.push(opts.initiator);
				yield { type: "text", text: "title" };
				yield { type: "finish", reason: "stop" };
			},
		};

		const tool = createTaskTool({
			db,
			provider: capturingProvider,
			model: "test-model",
			parentSessionId,
			projectRoot: "/tmp",
			systemPrompt: "sys",
			onEvent: () => {},
			subagentStatus: new SubagentStatus(),
		});

		await tool.execute({ description: "Test", prompt: "do it" }, { projectRoot: "/tmp" });

		// First call is title generation — it must use initiator: "agent"
		expect(initiators[0]).toBe("agent");
		// Agent loop calls should also be "agent"
		for (const i of initiators) {
			expect(i).toBe("agent");
		}
	});

	test("persists title generation exchange in child session", async () => {
		const tool = createTaskTool({
			db,
			provider: titleAndAgentProvider("Explore TypeScript Files", "I found stuff."),
			model: "test-model",
			parentSessionId,
			projectRoot: "/tmp",
			systemPrompt: "You are a subagent.",
			onEvent: () => {},
			subagentStatus: new SubagentStatus(),
		});

		const result = await tool.execute(
			{ description: "Explore codebase", prompt: "Find all TS files" },
			{ projectRoot: "/tmp" },
		);

		const taskIdMatch = result.llmOutput.match(/\[task_id: ([^\]]+)\]/);
		expect(taskIdMatch).toBeTruthy();
		const childSessionId = taskIdMatch?.[1] as string;

		const messages = getMessages(db, childSessionId);

		// Title gen messages should be persisted with purpose: "title-generation" metadata
		const titleUserMsg = messages.find((m) => m.role === "user" && m.metadata?.purpose === "title-generation");
		expect(titleUserMsg).toBeTruthy();
		expect(titleUserMsg?.content as string).toContain("Generate");

		const titleAssistantMsg = messages.find((m) => m.role === "assistant" && m.metadata?.purpose === "title-generation");
		expect(titleAssistantMsg).toBeTruthy();
		expect(titleAssistantMsg?.content).toBe("Explore TypeScript Files");
	});

	test("title generation messages are excluded from agent loop messages", async () => {
		// Track what messages the provider receives for the agent loop call
		const agentLoopMessages: Array<{ role: string; content: string | null }> = [];
		let callCount = 0;
		const capturingProvider: Provider = {
			id: "mock",
			async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				const lastMsg = opts.messages[opts.messages.length - 1];
				if (callCount === 1 && lastMsg?.role === "user" && (lastMsg as { content: string }).content.startsWith("Generate")) {
					yield { type: "text", text: "My Title" };
					yield { type: "finish", reason: "stop" };
					return;
				}
				// This is the agent loop call — capture messages
				for (const m of opts.messages) {
					agentLoopMessages.push({ role: m.role, content: (m as { content: string | null }).content });
				}
				yield { type: "text", text: "done" };
				yield { type: "finish", reason: "stop" };
			},
		};

		const tool = createTaskTool({
			db,
			provider: capturingProvider,
			model: "test-model",
			parentSessionId,
			projectRoot: "/tmp",
			systemPrompt: "You are a subagent.",
			onEvent: () => {},
			subagentStatus: new SubagentStatus(),
		});

		await tool.execute({ description: "Test", prompt: "Do something" }, { projectRoot: "/tmp" });

		// Agent loop messages should NOT contain any title-generation messages
		const hasGenerateMsg = agentLoopMessages.some((m) => m.role === "user" && m.content?.startsWith("Generate"));
		expect(hasGenerateMsg).toBe(false);

		// Should have system + user(prompt) only
		expect(agentLoopMessages[0].role).toBe("system");
		expect(agentLoopMessages[1].role).toBe("user");
		expect(agentLoopMessages[1].content).toBe("Do something");
	});

	test("saves and restores provider turn state around subagent execution", async () => {
		const stateOps: string[] = [];
		let savedState: unknown = null;
		const statefulProvider: Provider = {
			id: "mock",
			async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				const lastMsg = opts.messages[opts.messages.length - 1];
				if (lastMsg?.role === "user" && (lastMsg as { content: string }).content.startsWith("Generate")) {
					yield { type: "text", text: "title" };
					yield { type: "finish", reason: "stop" };
					return;
				}
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
			provider: titleAndAgentProvider("title", "result"),
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
		let callCount = 0;
		const failProvider: Provider = {
			id: "mock",
			async *stream(opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				const lastMsg = opts.messages[opts.messages.length - 1];
				if (callCount === 1 && lastMsg?.role === "user" && (lastMsg as { content: string }).content.startsWith("Generate")) {
					yield { type: "text", text: "title" };
					yield { type: "finish", reason: "stop" };
					return;
				}
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
			provider: titleAndAgentProvider("title", "result"),
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
});

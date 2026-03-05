import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentEvent } from "../src/agent-loop";
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
	};
}

// Title-generating provider: returns a short title on first call, then agent text
function titleAndAgentProvider(titleText: string, agentText: string): Provider {
	let callCount = 0;
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
			yield { type: "text", text: agentText };
			yield { type: "finish", reason: "stop" };
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
		const subagents = listSubagentSessions(db);
		expect(subagents.length).toBeGreaterThanOrEqual(1);

		// Status should be "done"
		const latestSubagent = subagents[0];
		expect(status.get(latestSubagent.id)).toBe("done");
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

		await tool.execute({ description: "Test task", prompt: "Do the thing" }, { projectRoot: "/tmp" });

		// Find the child session
		const subagents = listSubagentSessions(db);
		const child = subagents[0];
		const messages = getMessages(db, child.id);

		// Should have: system + user(prompt) + assistant(result)
		expect(messages.length).toBeGreaterThanOrEqual(3);
		expect(messages[0].role).toBe("system");
		expect(messages[0].content).toBe("You are a subagent.");
		expect(messages[1].role).toBe("user");
		expect(messages[1].content).toBe("Do the thing");
		expect(messages[1].metadata).toEqual({ source: "agent", parentSessionId });
	});
});

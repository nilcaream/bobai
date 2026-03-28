import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handlePrompt } from "../src/handler";
import type { ServerMessage } from "../src/protocol";
import type { Provider, ProviderOptions, StreamEvent } from "../src/provider/provider";
import { getMessages, listSubagentSessions } from "../src/session/repository";
import type { SkillRegistry } from "../src/skill/skill";
import { createTestDb } from "./helpers";

const emptySkills: SkillRegistry = { get: () => undefined, list: () => [] };

function mockWs() {
	const sent: string[] = [];
	return {
		send(msg: string) {
			sent.push(msg);
		},
		messages(): ServerMessage[] {
			return sent.map((s) => JSON.parse(s) as ServerMessage);
		},
	};
}

describe("subagent integration", () => {
	let db: Database;

	beforeAll(() => {
		db = createTestDb();
	});

	afterAll(() => {
		db.close();
	});

	test("full subagent flow: parent spawns child, child runs, parent receives result", async () => {
		let callCount = 0;
		const provider: Provider = {
			id: "mock",
			async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
				callCount++;
				if (callCount === 1) {
					// Parent: call the task tool
					yield { type: "tool_call_start", index: 0, id: "call_task_1", name: "task" };
					yield {
						type: "tool_call_delta",
						index: 0,
						arguments: JSON.stringify({
							description: "Explore project structure",
							prompt: "List all files in the project root and summarize what you find.",
						}),
					};
					yield { type: "finish", reason: "tool_calls" };
				} else if (callCount === 2) {
					// Title generation
					yield { type: "text", text: "Project structure overview" };
					yield { type: "finish", reason: "stop" };
				} else if (callCount === 3) {
					// Child agent loop
					yield { type: "text", text: "I found 5 files in the project root." };
					yield { type: "finish", reason: "stop" };
				} else {
					// Parent continues after tool result
					yield { type: "text", text: "The subagent found 5 files." };
					yield { type: "finish", reason: "stop" };
				}
			},
		};

		const ws = mockWs();
		await handlePrompt({
			ws,
			db,
			provider,
			model: "test-model",
			text: "Explore the project",
			projectRoot: "/tmp",
			configDir: "/tmp",
			skills: emptySkills,
		});

		const msgs = ws.messages();

		// Should have completed successfully
		const done = msgs.find((m) => m.type === "done");
		expect(done).toBeTruthy();

		// Get parentId from the done message
		const parentId = done?.sessionId as string;
		expect(parentId).toBeTruthy();

		// Should have a subagent session in the DB
		const subagents = listSubagentSessions(db, parentId);
		expect(subagents.length).toBeGreaterThanOrEqual(1);

		// The latest subagent should have the generated title
		const latestSubagent = subagents[0];
		expect(latestSubagent.title).toBeTruthy();

		// Child session should have messages
		const childMessages = getMessages(db, latestSubagent.id);
		expect(childMessages.length).toBeGreaterThanOrEqual(2); // user + assistant (system prompt is dynamic, not stored)

		// Parent's final response should reference the subagent result
		const tokens = msgs.filter((m) => m.type === "token" && !m.sessionId);
		const parentText = tokens.map((t) => ("text" in t ? t.text : "")).join("");
		expect(parentText).toContain("5 files");

		// Should have emitted subagent_start and subagent_done WS events
		const startEvent = msgs.find((m) => m.type === "subagent_start");
		expect(startEvent).toBeTruthy();
		expect(startEvent?.sessionId).toBe(latestSubagent.id);
		if (startEvent?.type === "subagent_start") {
			expect(startEvent.toolCallId).toBe("call_task_1");
		}

		const doneEvent = msgs.find((m) => m.type === "subagent_done");
		expect(doneEvent).toBeTruthy();
		expect(doneEvent?.sessionId).toBe(latestSubagent.id);
	});
});

# Incremental Message Persistence

> **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Persist each message the moment it's complete so the agent can resume after errors like HTTP 429.

**Architecture:** Add an `onMessage` callback to `runAgentLoop()` called at each message creation point. The handler passes a callback that calls `appendMessage()` directly. The batch persistence loop in the handler disappears. On error, the handler persists an error assistant message and sends `done` with the sessionId so the UI can resume.

**Tech Stack:** TypeScript, Bun, bun:test

---

### Task 1: Add `onMessage` callback to agent loop

**Files:**
- Modify: `packages/server/src/agent-loop.ts`
- Modify: `packages/server/test/agent-loop.test.ts`

**Step 1: Add `onMessage` to `AgentLoopOptions`**

In `agent-loop.ts`, add to the `AgentLoopOptions` interface:

```ts
onMessage?: (msg: Message) => void;
```

Optional so existing tests don't break immediately.

**Step 2: Call `onMessage` at each message creation point**

There are four places where messages are pushed to `newMessages`:

1. Line 70 — text-only assistant message (finish_reason=stop)
2. Line 90 — assistant message with tool_calls
3. Line 125 — tool result message
4. Line 137 — max-iterations warning message

After each `newMessages.push(...)`, add `onMessage?.(msg)`.

**Step 3: Update all agent loop tests to pass `onMessage`**

Add `onMessage() {}` (no-op) to every `runAgentLoop()` call in the test file. This isn't strictly necessary since the callback is optional, but makes the tests explicit about the new interface.

**Step 4: Add test — `onMessage is called for each completed message`**

Use `toolThenTextProvider` (produces assistant+tool+assistant = 3 messages). Collect messages via `onMessage` and verify they arrive in order, matching the return value.

**Step 5: Run tests**

Run: `bun test packages/server/test/agent-loop.test.ts`
Expected: all pass

---

### Task 2: Move persistence from batch to incremental in handler

**Files:**
- Modify: `packages/server/src/handler.ts`
- Modify: `packages/server/test/handler.test.ts`

**Step 1: Replace batch persistence with `onMessage` callback**

In `handlePrompt()`, replace:
```ts
const newMessages = await runAgentLoop({...});
// Persist all new messages
for (const msg of newMessages) { ... }
```

With:
```ts
await runAgentLoop({
    ...
    onMessage(msg: Message) {
        if (msg.role === "assistant") {
            const am = msg as AssistantMessage;
            const metadata = am.tool_calls ? { tool_calls: am.tool_calls } : undefined;
            appendMessage(db, currentSessionId, "assistant", am.content ?? "", metadata);
        } else if (msg.role === "tool") {
            const tm = msg as ToolMessage;
            appendMessage(db, currentSessionId, "tool", tm.content, { tool_call_id: tm.tool_call_id });
        }
    },
});
```

The `runAgentLoop` return value is no longer used for persistence but still returned (no API change needed).

**Step 2: Persist error as assistant message in catch block**

In the catch block, before sending the error to the UI:

```ts
if (currentSessionId) {
    const errorText = err instanceof ProviderError
        ? `[Error: Provider error (${err.status}): ${err.body}]`
        : `[Error: ${(err as Error).message}]`;
    appendMessage(db, currentSessionId, "assistant", errorText);
}
```

**Step 3: Send `done` after error when sessionId exists**

After sending the error message to the UI, also send `done` so the UI gets the sessionId:

```ts
if (currentSessionId) {
    send(ws, { type: "done", sessionId: currentSessionId, model });
}
```

This lets the user resume the conversation on the same session.

**Step 4: Run existing handler tests**

Run: `bun test packages/server/test/handler.test.ts`
Expected: all pass (existing behavior preserved)

---

### Task 3: Add tests for error persistence and resume

**Files:**
- Modify: `packages/server/test/handler.test.ts`

**Step 1: Test — provider error persists error message to DB**

```ts
test("persists error message to DB on provider error", async () => {
    const ws = mockWs();
    const provider = failingProvider(429, "Rate limited");
    await handlePrompt({ ws, db, provider, model: "test-model", text: "hi", projectRoot: "/tmp" });

    const msgs = ws.messages();
    const done = msgs.find((m) => m.type === "done");
    expect(done).toBeTruthy();
    expect(done.sessionId).toBeTruthy();

    const stored = getMessages(db, done.sessionId);
    // system + user + assistant(error)
    expect(stored).toHaveLength(3);
    expect(stored[2].role).toBe("assistant");
    expect(stored[2].content).toContain("429");
});
```

**Step 2: Test — mid-stream error persists partial work + error**

Use a provider that does tool_call → tool_result → then 429 on second LLM call.

```ts
test("persists partial messages and error on mid-stream failure", async () => {
    let callCount = 0;
    const provider: Provider = {
        id: "mock",
        async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
            callCount++;
            if (callCount === 1) {
                yield { type: "tool_call_start", index: 0, id: "call_1", name: "list_directory" };
                yield { type: "tool_call_delta", index: 0, arguments: '{"path":"."}' };
                yield { type: "finish", reason: "tool_calls" };
            } else {
                throw new ProviderError(429, "Rate limited");
            }
        },
    };

    const ws = mockWs();
    await handlePrompt({ ws, db, provider, model: "test-model", text: "list files", projectRoot: "/tmp" });

    const done = ws.messages().find((m) => m.type === "done");
    const stored = getMessages(db, done.sessionId);

    // system + user + assistant(tool_calls) + tool(result) + assistant(error)
    expect(stored).toHaveLength(5);
    expect(stored[2].role).toBe("assistant");
    expect(stored[2].metadata?.tool_calls).toBeTruthy();
    expect(stored[3].role).toBe("tool");
    expect(stored[4].role).toBe("assistant");
    expect(stored[4].content).toContain("429");
});
```

**Step 3: Test — resume after error sends full history to provider**

```ts
test("resume after error includes persisted messages in context", async () => {
    // First prompt: provider errors after tool call
    let callCount = 0;
    const failProvider: Provider = {
        id: "mock",
        async *stream(_opts: ProviderOptions): AsyncGenerator<StreamEvent> {
            callCount++;
            if (callCount === 1) {
                yield { type: "tool_call_start", index: 0, id: "call_1", name: "list_directory" };
                yield { type: "tool_call_delta", index: 0, arguments: '{"path":"."}' };
                yield { type: "finish", reason: "tool_calls" };
            } else {
                throw new ProviderError(429, "Rate limited");
            }
        },
    };

    const ws1 = mockWs();
    await handlePrompt({ ws: ws1, db, provider: failProvider, model: "test-model", text: "list files", projectRoot: "/tmp" });
    const sessionId = ws1.messages().find((m) => m.type === "done").sessionId;

    // Second prompt: "resume" — provider succeeds
    const resumeProvider = capturingProvider(["Resuming where I left off"]);
    const ws2 = mockWs();
    await handlePrompt({ ws: ws2, db, provider: resumeProvider, model: "test-model", text: "resume", sessionId, projectRoot: "/tmp" });

    // Provider should see: system + user + assistant(tool_calls) + tool + assistant(error) + user("resume")
    const sentMessages = resumeProvider.captured[0].messages;
    expect(sentMessages.length).toBeGreaterThanOrEqual(6);
    expect(sentMessages.some((m) => m.role === "tool")).toBe(true);
    expect(sentMessages.some((m) => m.content?.includes("429"))).toBe(true);
    expect(sentMessages.at(-2)?.content).toBe("resume");
});
```

**Step 4: Run all tests**

Run: `bun test packages/server/test/`
Expected: all 174+ tests pass

---

### Task 4: Commit

```
feat(server): incremental message persistence for error recovery

Persist each message as it completes instead of batching after the
agent loop. On provider errors (e.g. 429), partial work and the error
itself are preserved so the agent can resume with full context.
```

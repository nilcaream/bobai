import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../../src/tool/tool";
import { createWebSearchTool } from "../../src/tool/web-search";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
	const root = mkdtempSync(join(tmpdir(), "bobai-test-web-search-"));
	mkdirSync(join(root, ".bobai"), { recursive: true });
	return { projectRoot: root, sessionId: "test-session", toolCallId: "call_001", ...overrides };
}

function cleanup(ctx: ToolContext) {
	rmSync(ctx.projectRoot, { recursive: true, force: true });
}

function mockResult(overrides: Record<string, unknown> = {}) {
	return {
		title: "Test Page",
		url: "https://example.com/test",
		content: "Extracted content.",
		score: 0.95,
		raw_content: null,
		...overrides,
	};
}

function mockResponse(results: unknown[], overrides: Record<string, unknown> = {}) {
	return {
		query: "test",
		answer: null,
		images: [] as string[],
		results,
		response_time: 1.5,
		...overrides,
	};
}

describe("createWebSearchTool", () => {
	// --- Error cases ---

	test("returns error when no API key is configured", async () => {
		const tool = createWebSearchTool(undefined);
		const ctx = makeContext();
		const result = await tool.execute({ query: "hello" }, ctx);
		expect(result.llmOutput).toContain("bobai auth tavily");
		expect(result.mergeable).toBe(false);
		cleanup(ctx);
	});

	test("returns error for empty query", async () => {
		const tool = createWebSearchTool("test-key");
		const ctx = makeContext();
		const result = await tool.execute({}, ctx);
		expect(result.llmOutput).toContain("query");
		cleanup(ctx);
	});

	test("handles HTTP errors gracefully", async () => {
		const mockFetch = mock().mockResolvedValue({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
			text: async () => "Invalid key",
		});
		const tool = createWebSearchTool("bad-key", mockFetch as unknown as typeof fetch);
		const ctx = makeContext();
		const result = await tool.execute({ query: "test" }, ctx);
		expect(result.llmOutput).toContain("Error");
		expect(result.llmOutput).toContain("401");
		expect(result.summary).toContain("401");
		cleanup(ctx);
	});

	test("handles network errors gracefully", async () => {
		const mockFetch = mock().mockRejectedValue(new Error("Connection refused"));
		const tool = createWebSearchTool("test-key", mockFetch as unknown as typeof fetch);
		const ctx = makeContext();
		const result = await tool.execute({ query: "test" }, ctx);
		expect(result.llmOutput).toContain("Error");
		expect(result.llmOutput).toContain("Connection refused");
		cleanup(ctx);
	});

	// --- Parameter mapping ---

	test("calls Tavily API with correct mapped parameters", async () => {
		const mockFetch = mock().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => mockResponse([mockResult()]),
		});
		const tool = createWebSearchTool("test-key", mockFetch as unknown as typeof fetch);
		const ctx = makeContext();

		await tool.execute(
			{
				query: "bun sqlite",
				maxResults: 3,
				includeSummary: true,
				advanced: true,
				includeImages: true,
				domains: ["bun.sh"],
				timeout: 20,
			},
			ctx,
		);

		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.query).toBe("bun sqlite");
		expect(body.max_results).toBe(3);
		expect(body.include_answer).toBe("basic");
		expect(body.search_depth).toBe("advanced");
		expect(body.include_images).toBe(true);
		expect(body.include_domains).toEqual(["bun.sh"]);
		cleanup(ctx);
	});

	test("sets include_raw_content=markdown when fullPages is true", async () => {
		const mockFetch = mock().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => mockResponse([mockResult()]),
		});
		const tool = createWebSearchTool("test-key", mockFetch as unknown as typeof fetch);
		const ctx = makeContext();
		await tool.execute({ query: "test", fullPages: true }, ctx);
		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.include_raw_content).toBe("markdown");
		cleanup(ctx);
	});

	test("does not send falsy boolean params when false", async () => {
		const mockFetch = mock().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => mockResponse([mockResult()]),
		});
		const tool = createWebSearchTool("test-key", mockFetch as unknown as typeof fetch);
		const ctx = makeContext();
		await tool.execute({ query: "test" }, ctx);
		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.include_answer).toBeUndefined();
		expect(body.search_depth).toBeUndefined();
		expect(body.include_raw_content).toBeUndefined();
		cleanup(ctx);
	});

	// --- File storage ---

	test("saves raw content to .bobai/searches when fullPages is true", async () => {
		const raw = "# Page\n\nContent.";
		const mockFetch = mock().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => mockResponse([mockResult({ raw_content: raw })]),
		});
		const tool = createWebSearchTool("test-key", mockFetch as unknown as typeof fetch);
		const ctx = makeContext();
		await tool.execute({ query: "test", fullPages: true }, ctx);

		const filePath = join(ctx.projectRoot, ".bobai", "searches", ctx.sessionId, ctx.toolCallId ?? "", "0.md");
		expect(readFileSync(filePath, "utf8")).toBe(raw);
		cleanup(ctx);
	});

	test("llmOutput references file paths for fullPages results", async () => {
		const mockFetch = mock().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => mockResponse([mockResult({ raw_content: "content" })]),
		});
		const tool = createWebSearchTool("test-key", mockFetch as unknown as typeof fetch);
		const ctx = makeContext();
		const result = await tool.execute({ query: "test", fullPages: true }, ctx);
		expect(result.llmOutput).toContain(".bobai/searches/");
		expect(result.llmOutput).toContain("read_file");
		cleanup(ctx);
	});

	test("llmOutput does NOT inline raw_content", async () => {
		const longContent = "x".repeat(5000);
		const mockFetch = mock().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => mockResponse([mockResult({ raw_content: longContent })]),
		});
		const tool = createWebSearchTool("test-key", mockFetch as unknown as typeof fetch);
		const ctx = makeContext();
		const result = await tool.execute({ query: "test", fullPages: true }, ctx);
		expect(result.llmOutput).not.toContain(longContent);
		cleanup(ctx);
	});

	// --- Output formatting ---

	test("includeSummary adds answer to llmOutput", async () => {
		const mockFetch = mock().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => mockResponse([mockResult()], { answer: "LLM summary text." }),
		});
		const tool = createWebSearchTool("test-key", mockFetch as unknown as typeof fetch);
		const ctx = makeContext();
		const result = await tool.execute({ query: "test", includeSummary: true }, ctx);
		expect(result.llmOutput).toContain("LLM summary text");
		cleanup(ctx);
	});

	test("uiOutput contains clickable markdown links", async () => {
		const mockFetch = mock().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => mockResponse([mockResult({ title: "Bun Docs", url: "https://bun.sh" })]),
		});
		const tool = createWebSearchTool("test-key", mockFetch as unknown as typeof fetch);
		const ctx = makeContext();
		const result = await tool.execute({ query: "test" }, ctx);
		expect(result.uiOutput).toContain("[Bun Docs](https://bun.sh)");
		cleanup(ctx);
	});

	// --- Tool metadata ---

	test("definition has correct function name and required params", () => {
		const tool = createWebSearchTool("test-key");
		const def = tool.definition.function;
		expect(def.name).toBe("web_search");
		expect(def.parameters.required).toEqual(["query"]);
		expect(def.parameters.properties.query.type).toBe("string");
	});

	test("formatCall shows query text", () => {
		const tool = createWebSearchTool("test-key");
		expect(tool.formatCall({ query: "bun sqlite" })).toContain("bun sqlite");
	});

	test("mergeable defaults to false", () => {
		expect(createWebSearchTool("test-key").mergeable).toBe(false);
	});

	// --- Timeout clamping ---

	test("signals timeout on the fetch request", async () => {
		const mockFetch = mock().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => mockResponse([mockResult()]),
		});
		const tool = createWebSearchTool("test-key", mockFetch as unknown as typeof fetch);
		const ctx = makeContext();
		await tool.execute({ query: "test", timeout: 10 }, ctx);
		const init = mockFetch.mock.calls[0][1];
		expect(init.signal).toBeDefined();
		expect(init.signal).toBeInstanceOf(AbortSignal);
		cleanup(ctx);
	});

	// --- Compact ---

	test("compact preserves header and drops body", () => {
		const tool = createWebSearchTool("test-key");
		const output = '## Web Search Results for "test" — 3 results in 1.5s\n\nextra content';
		const result = tool.compact?.(output, { query: "test" });
		expect(result).toContain("Web search results (compacted)");
		expect(result).toContain("## Web Search Results");
		expect(result).not.toContain("extra content");
	});

	test("compact returns output unchanged when no header found", () => {
		const tool = createWebSearchTool("test-key");
		const output = "Error: something went wrong";
		expect(tool.compact?.(output, { query: "test" })).toBe(output);
	});

	// --- Images in output ---

	test("llmOutput includes images section when images are present", async () => {
		const mockFetch = mock().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () =>
				mockResponse([mockResult()], {
					images: ["https://example.com/img.jpg"],
				}),
		});
		const tool = createWebSearchTool("test-key", mockFetch as unknown as typeof fetch);
		const ctx = makeContext();
		const result = await tool.execute({ query: "test" }, ctx);
		expect(result.llmOutput).toContain("## Images");
		expect(result.llmOutput).toContain("https://example.com/img.jpg");
		cleanup(ctx);
	});

	test("uiOutput includes images section when images are present", async () => {
		const mockFetch = mock().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () =>
				mockResponse([mockResult()], {
					images: ["https://example.com/img.jpg"],
				}),
		});
		const tool = createWebSearchTool("test-key", mockFetch as unknown as typeof fetch);
		const ctx = makeContext();
		const result = await tool.execute({ query: "test" }, ctx);
		expect(result.uiOutput).toContain("**Images:**");
		expect(result.uiOutput).toContain("[https://example.com/img.jpg]");
		cleanup(ctx);
	});
});

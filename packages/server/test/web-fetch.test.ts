import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { COMPACTION_MARKER } from "../src/compaction/default-strategy";
import type { ToolContext } from "../src/tool/tool";
import { htmlToMarkdown, htmlToText, truncateOutput, webFetchTool } from "../src/tool/web-fetch";

const ctx: ToolContext = { projectRoot: "/tmp/test", sessionId: "test-session" };

// ---------- Conversion helpers ----------

describe("htmlToMarkdown", () => {
	test("converts HTML heading to ATX markdown", () => {
		expect(htmlToMarkdown("<h1>Hello</h1>")).toBe("# Hello");
	});

	test("strips script and style tags", () => {
		const html = "<p>visible</p><script>alert(1)</script><style>.x{}</style>";
		const md = htmlToMarkdown(html);
		expect(md).not.toContain("alert");
		expect(md).not.toContain(".x{}");
		expect(md).toContain("visible");
	});

	test("converts links", () => {
		const html = '<a href="https://example.com">click</a>';
		expect(htmlToMarkdown(html)).toBe("[click](https://example.com)");
	});

	test("converts emphasis", () => {
		expect(htmlToMarkdown("<em>text</em>")).toBe("*text*");
	});

	test("converts code blocks to fenced code blocks", () => {
		const html = "<pre><code>const x = 1;</code></pre>";
		const md = htmlToMarkdown(html);
		expect(md).toContain("```");
		expect(md).toContain("const x = 1;");
	});
});

describe("htmlToText", () => {
	test("extracts visible text from HTML", async () => {
		const html = "<p>Hello</p><p>World</p>";
		const text = await htmlToText(html);
		expect(text).toContain("Hello");
		expect(text).toContain("World");
	});

	test("strips script content", async () => {
		const html = "<p>visible</p><script>hidden();</script>";
		const text = await htmlToText(html);
		expect(text).not.toContain("hidden");
		expect(text).toContain("visible");
	});

	test("strips style content", async () => {
		const html = "<p>visible</p><style>.x { color: red; }</style>";
		const text = await htmlToText(html);
		expect(text).not.toContain("color");
		expect(text).toContain("visible");
	});

	test("strips noscript content", async () => {
		const html = "<p>visible</p><noscript>Enable JS</noscript>";
		const text = await htmlToText(html);
		expect(text).not.toContain("Enable JS");
		expect(text).toContain("visible");
	});

	test("handles nested elements inside script tags", async () => {
		const html = "<script><div>hidden</div></script><p>visible</p>";
		const text = await htmlToText(html);
		expect(text).not.toContain("hidden");
		expect(text).toContain("visible");
	});

	test("handles empty input", async () => {
		const text = await htmlToText("");
		expect(text).toBe("");
	});
});

describe("truncateOutput", () => {
	test("returns short content unchanged", () => {
		const short = "Hello\nWorld";
		expect(truncateOutput(short)).toBe(short);
	});

	test("truncates at MAX_OUTPUT_LINES (2000)", () => {
		const lines = Array.from({ length: 2500 }, (_, i) => `line ${i}`);
		const input = lines.join("\n");
		const result = truncateOutput(input);
		const resultLines = result.split("\n");

		// First 2000 lines should be intact
		expect(resultLines[0]).toBe("line 0");
		expect(resultLines[1999]).toBe("line 1999");

		// Should contain truncation notice
		expect(result).toContain("lines truncated");
		expect(result).toContain("total: 2500 lines");
	});

	test("truncates at MAX_OUTPUT_CHARS (50000)", () => {
		// Each line is ~100 chars, so 600 lines > 50000 chars but < 2000 lines
		const longLine = "x".repeat(99);
		const lines = Array.from({ length: 600 }, () => longLine);
		const input = lines.join("\n");
		expect(input.length).toBeGreaterThan(50_000);

		const result = truncateOutput(input);
		expect(result).toContain("lines truncated");
		// Should have cut well before 600 lines
		const keptLines = result.split("\n\n...")[0].split("\n");
		expect(keptLines.length).toBeLessThan(600);
	});

	test("includes truncation notice with line count", () => {
		const lines = Array.from({ length: 2500 }, (_, i) => `line ${i}`);
		const input = lines.join("\n");
		const result = truncateOutput(input);
		expect(result).toMatch(/\.\.\. \d+ lines truncated \(total: 2500 lines, \d+ bytes\)$/);
	});
});

// ---------- Tool execute (mocking fetch) ----------

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

describe("webFetchTool.execute", () => {
	beforeEach(() => {
		mockFetch = mock();
		globalThis.fetch = mockFetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	// --- Happy paths ---

	test("server returns markdown directly (text/markdown content-type)", async () => {
		const md = "# Title\n\nSome content";
		mockFetch.mockResolvedValueOnce(
			new Response(md, {
				status: 200,
				headers: { "content-type": "text/markdown" },
			}),
		);

		const result = await webFetchTool.execute({ url: "https://example.com/doc.md", format: "markdown" }, ctx);
		expect(result.llmOutput).toBe(md);
	});

	test("server returns HTML with format=markdown triggers Turndown conversion", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response("<h1>Title</h1><p>Body</p>", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		);

		const result = await webFetchTool.execute({ url: "https://example.com", format: "markdown" }, ctx);
		expect(result.llmOutput).toContain("# Title");
		expect(result.llmOutput).toContain("Body");
	});

	test("server returns HTML with format=text triggers text extraction", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response("<h1>Title</h1><p>Body text</p>", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		);

		const result = await webFetchTool.execute({ url: "https://example.com", format: "text" }, ctx);
		expect(result.llmOutput).toContain("Title");
		expect(result.llmOutput).toContain("Body text");
		// Should NOT contain HTML tags
		expect(result.llmOutput).not.toContain("<h1>");
		expect(result.llmOutput).not.toContain("<p>");
	});

	test("format=html returns raw HTML as-is", async () => {
		const html = "<h1>Title</h1><p>Body</p>";
		mockFetch.mockResolvedValueOnce(
			new Response(html, {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		);

		const result = await webFetchTool.execute({ url: "https://example.com", format: "html" }, ctx);
		expect(result.llmOutput).toBe(html);
	});

	test("plain text response returned as-is", async () => {
		const text = "Plain text content here";
		mockFetch.mockResolvedValueOnce(
			new Response(text, {
				status: 200,
				headers: { "content-type": "text/plain" },
			}),
		);

		const result = await webFetchTool.execute({ url: "https://example.com/file.txt", format: "markdown" }, ctx);
		expect(result.llmOutput).toBe(text);
	});

	// --- Error handling ---

	test("invalid URL (no http/https) returns error", async () => {
		const result = await webFetchTool.execute({ url: "ftp://example.com" }, ctx);
		expect(result.llmOutput).toContain("http:// or https://");
	});

	test("empty URL returns error", async () => {
		const result = await webFetchTool.execute({ url: "" }, ctx);
		expect(result.llmOutput).toContain("http:// or https://");
	});

	test("HTTP 404 response returns error with status code", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response("Not Found", {
				status: 404,
				statusText: "Not Found",
			}),
		);

		const result = await webFetchTool.execute({ url: "https://example.com/missing" }, ctx);
		expect(result.llmOutput).toContain("404");
		expect(result.llmOutput).toContain("Error");
	});

	test("response too large (Content-Length header) returns error", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response("", {
				status: 200,
				headers: { "content-length": "10000000", "content-type": "text/html" },
			}),
		);

		const result = await webFetchTool.execute({ url: "https://example.com/huge" }, ctx);
		expect(result.llmOutput).toContain("too large");
		expect(result.llmOutput).toContain("Content-Length");
	});

	test("response body too large (no Content-Length) returns error", async () => {
		// Create a buffer larger than 5MB
		const bigSize = 6 * 1024 * 1024;
		const bigBuffer = new ArrayBuffer(bigSize);

		// Create a mock Response object with overridden arrayBuffer
		const fakeResponse = {
			ok: true,
			status: 200,
			statusText: "OK",
			headers: new Headers({ "content-type": "text/plain" }),
			arrayBuffer: mock().mockResolvedValueOnce(bigBuffer),
		};
		mockFetch.mockResolvedValueOnce(fakeResponse as unknown as Response);

		const result = await webFetchTool.execute({ url: "https://example.com/stream" }, ctx);
		expect(result.llmOutput).toContain("too large");
		expect(result.llmOutput).toContain("Error");
	});

	test("fetch throws network error", async () => {
		mockFetch.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND example.invalid"));

		const result = await webFetchTool.execute({ url: "https://example.invalid" }, ctx);
		expect(result.llmOutput).toContain("Error");
		expect(result.llmOutput).toContain("ENOTFOUND");
	});

	// --- Edge cases ---

	test("format defaults to markdown when not provided", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response("<h1>Hello</h1>", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		);

		const result = await webFetchTool.execute({ url: "https://example.com" }, ctx);
		// Should convert HTML to markdown since default format is "markdown"
		expect(result.llmOutput).toContain("# Hello");
	});

	test("unknown format falls back to markdown Accept header", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response("content", {
				status: 200,
				headers: { "content-type": "text/plain" },
			}),
		);

		await webFetchTool.execute({ url: "https://example.com", format: "unknown" }, ctx);
		const callArgs = mockFetch.mock.calls[0];
		const headers = callArgs[1]?.headers as Record<string, string>;
		// Should use the markdown Accept header as fallback
		expect(headers.Accept).toContain("text/markdown");
	});
});

// ---------- formatCall ----------

describe("webFetchTool.formatCall", () => {
	test("returns expected string with url and format", () => {
		const result = webFetchTool.formatCall({ url: "https://example.com", format: "text" });
		expect(result).toContain("https://example.com");
		expect(result).toContain("text");
		expect(result).toContain("▸ Fetching");
	});

	test("defaults to markdown when format not specified", () => {
		const result = webFetchTool.formatCall({ url: "https://example.com" });
		expect(result).toContain("markdown");
	});
});

// ---------- compact ----------

describe("webFetchTool.compact", () => {
	// biome prefers optional chaining over non-null assertion; extract once
	const compact = webFetchTool.compact as (output: string, callArgs: Record<string, unknown>) => string;

	test("preserves short output (≤20 lines)", () => {
		const short = "Line 1\nLine 2\nLine 3";
		const result = compact(short, { url: "https://example.com" });
		expect(result).toBe(short);
	});

	test("truncates long output (>20 lines) with COMPACTION_MARKER prefix", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}`);
		const long = lines.join("\n");
		const result = compact(long, { url: "https://example.com" });
		expect(result).toStartWith(COMPACTION_MARKER);
		expect(result).toContain("web_fetch(https://example.com)");
		expect(result).toContain("showing first 15 of 50 lines");
		// Should contain exactly the first 15 lines of content after the marker line
		const resultLines = result.split("\n");
		expect(resultLines[1]).toBe("Line 0");
		expect(resultLines[15]).toBe("Line 14");
		// Total: 1 marker line + 15 content lines = 16
		expect(resultLines).toHaveLength(16);
	});

	test("preserves error output unchanged", () => {
		const error = "Error: HTTP 500 Internal Server Error";
		const result = compact(error, { url: "https://example.com" });
		expect(result).toBe(error);
	});
});

// ---------- Tool metadata ----------

describe("webFetchTool metadata", () => {
	test("mergeable is false", () => {
		expect(webFetchTool.mergeable).toBe(false);
	});

	test("baseDistance is 150", () => {
		expect(webFetchTool.baseDistance).toBe(150);
	});

	test("outputThreshold is 0.35", () => {
		expect(webFetchTool.outputThreshold).toBe(0.35);
	});

	test("definition.function.name is web_fetch", () => {
		expect(webFetchTool.definition.function.name).toBe("web_fetch");
	});
});

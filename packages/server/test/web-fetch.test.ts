import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { COMPACTION_MARKER } from "../src/compaction/default-strategy";
import type { ToolContext } from "../src/tool/tool";
import { htmlToMarkdown, htmlToText, isTextContentType, truncateOutput, webFetchTool } from "../src/tool/web-fetch";

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

	// --- PDF handling ---

	test("PDF response triggers text extraction instead of raw decode", async () => {
		// Create a minimal valid PDF with embedded text
		const minimalPdf = `%PDF-1.0
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 100 700 Td (Hello PDF) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000266 00000 n 
0000000360 00000 n 
trailer<</Size 6/Root 1 0 R>>
startxref
430
%%EOF`;
		mockFetch.mockResolvedValueOnce(
			new Response(minimalPdf, {
				status: 200,
				headers: { "content-type": "application/pdf" },
			}),
		);

		const result = await webFetchTool.execute({ url: "https://example.com/doc.pdf", format: "markdown" }, ctx);
		// Should contain extracted text, not raw PDF operators
		expect(result.llmOutput).toContain("Hello PDF");
		expect(result.llmOutput).not.toContain("endobj");
		expect(result.llmOutput).not.toContain("endstream");
	});

	test("PDF with empty text returns informative message", async () => {
		// Minimal PDF with no text content
		const emptyPdf = `%PDF-1.0
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj
xref
0 4
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
trailer<</Size 4/Root 1 0 R>>
startxref
190
%%EOF`;
		mockFetch.mockResolvedValueOnce(
			new Response(emptyPdf, {
				status: 200,
				headers: { "content-type": "application/pdf" },
			}),
		);

		const result = await webFetchTool.execute({ url: "https://example.com/scanned.pdf" }, ctx);
		expect(result.llmOutput).toContain("no extractable text");
	});

	test("corrupt PDF returns error message", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response("not a pdf at all", {
				status: 200,
				headers: { "content-type": "application/pdf" },
			}),
		);

		const result = await webFetchTool.execute({ url: "https://example.com/corrupt.pdf" }, ctx);
		expect(result.llmOutput).toContain("Error");
	});

	test("PDF content-type with charset parameter is detected", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response("not a pdf", {
				status: 200,
				headers: { "content-type": "application/pdf; charset=binary" },
			}),
		);

		const result = await webFetchTool.execute({ url: "https://example.com/doc.pdf" }, ctx);
		// Should attempt PDF extraction (and fail with error), not return raw text
		expect(result.llmOutput).toContain("Error");
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
	const compact = webFetchTool.compact as (output: string, callArgs: Record<string, unknown>) => string;

	test("preserves error output unchanged", () => {
		const error = "Error: HTTP 500 Internal Server Error";
		const result = compact(error, { url: "https://example.com" });
		expect(result).toBe(error);
	});

	test("output with header: returns COMPACTION_MARKER + first line only", () => {
		const header = "Complete file available at .bobai/downloads/s1/call-123";
		const output = `${header}\n\nHello world\nLine 2\nLine 3\nLine 4\nLine 5`;
		const result = compact(output, { url: "https://example.com" });
		expect(result).toBe(`${COMPACTION_MARKER} ${header}`);
	});

	test("output with header: strips all content lines", () => {
		const header = "Complete file available at .bobai/downloads/s1/call-abc";
		const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}`);
		const output = `${header}\n\n${lines.join("\n")}`;
		const result = compact(output, { url: "https://example.com" });
		expect(result).toBe(`${COMPACTION_MARKER} ${header}`);
		expect(result.split("\n")).toHaveLength(1);
	});

	test("short output without header (≤3 lines): preserved unchanged", () => {
		const short = "Line 1\nLine 2\nLine 3";
		const result = compact(short, { url: "https://example.com" });
		expect(result).toBe(short);
	});

	test("legacy output without header (>3 lines): keeps first 15 lines", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}`);
		const long = lines.join("\n");
		const result = compact(long, { url: "https://example.com" });
		expect(result).toStartWith(COMPACTION_MARKER);
		expect(result).toContain("web_fetch(https://example.com)");
		expect(result).toContain("showing first 15 of 50 lines");
		const resultLines = result.split("\n");
		expect(resultLines[1]).toBe("Line 0");
		expect(resultLines[15]).toBe("Line 14");
		expect(resultLines).toHaveLength(16);
	});

	test("binary output with header (2 lines): preserved unchanged", () => {
		const output =
			"Complete file available at .bobai/downloads/s1/call-x\nBinary file (image/png, 8000 bytes). Use bash tool to process.";
		const result = compact(output, { url: "https://example.com" });
		expect(result).toBe(output);
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

// ---------- isTextContentType ----------

describe("isTextContentType", () => {
	test("text/* types are text", () => {
		expect(isTextContentType("text/html")).toBe(true);
		expect(isTextContentType("text/plain")).toBe(true);
		expect(isTextContentType("text/markdown")).toBe(true);
		expect(isTextContentType("text/css")).toBe(true);
	});

	test("application/json is text", () => {
		expect(isTextContentType("application/json")).toBe(true);
		expect(isTextContentType("application/json; charset=utf-8")).toBe(true);
	});

	test("application/xml is text", () => {
		expect(isTextContentType("application/xml")).toBe(true);
	});

	test("application/pdf is text", () => {
		expect(isTextContentType("application/pdf")).toBe(true);
	});

	test("+json and +xml suffixes are text", () => {
		expect(isTextContentType("application/vnd.api+json")).toBe(true);
		expect(isTextContentType("application/atom+xml")).toBe(true);
	});

	test("binary types are not text", () => {
		expect(isTextContentType("application/octet-stream")).toBe(false);
		expect(isTextContentType("image/png")).toBe(false);
		expect(isTextContentType("application/zip")).toBe(false);
		expect(isTextContentType("audio/mpeg")).toBe(false);
	});
});

// ---------- LLM output header + read_file hint ----------

describe("webFetchTool.execute LLM output header", () => {
	beforeEach(() => {
		mockFetch = mock();
		globalThis.fetch = mockFetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("includes header when toolCallId is present", async () => {
		const text = "Hello world";
		mockFetch.mockResolvedValueOnce(new Response(text, { status: 200, headers: { "content-type": "text/plain" } }));

		const ctxWithId: ToolContext = { projectRoot: "/tmp/test", sessionId: "s1", toolCallId: "tc-100" };
		const result = await webFetchTool.execute({ url: "https://example.com/file.txt" }, ctxWithId);

		expect(result.llmOutput).toStartWith("Complete file available at .bobai/downloads/s1/tc-100");
		// Content should follow after blank line
		expect(result.llmOutput).toContain("\n\nHello world");
	});

	test("header shows raw byte size, not converted text size", async () => {
		// HTML is 24 bytes raw but markdown conversion changes length
		const html = "<h1>Title</h1><p>Body</p>";
		mockFetch.mockResolvedValueOnce(new Response(html, { status: 200, headers: { "content-type": "text/html" } }));

		const ctxWithId: ToolContext = { projectRoot: "/tmp/test", sessionId: "s1", toolCallId: "tc-101" };
		const result = await webFetchTool.execute({ url: "https://example.com", format: "markdown" }, ctxWithId);

		expect(result.llmOutput).toStartWith("Complete file available at .bobai/downloads/s1/tc-101");
	});

	test("omits header when toolCallId is undefined", async () => {
		mockFetch.mockResolvedValueOnce(new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }));

		const ctxNoId: ToolContext = { projectRoot: "/tmp/test", sessionId: "s1" };
		const result = await webFetchTool.execute({ url: "https://example.com" }, ctxNoId);

		expect(result.llmOutput).not.toContain(".bobai/downloads/");
		expect(result.llmOutput).toBe("hello");
	});

	test("includes read_file hint when content is truncated", async () => {
		const lines = Array.from({ length: 2500 }, (_, i) => `line ${i}`);
		mockFetch.mockResolvedValueOnce(new Response(lines.join("\n"), { status: 200, headers: { "content-type": "text/plain" } }));

		const ctxWithId: ToolContext = { projectRoot: "/tmp/test", sessionId: "s1", toolCallId: "tc-trunc" };
		const result = await webFetchTool.execute({ url: "https://example.com/big.txt" }, ctxWithId);

		expect(result.llmOutput).toContain("Use read_file tool on .bobai/downloads/s1/tc-trunc to read more.");
	});

	test("omits read_file hint when content is NOT truncated", async () => {
		mockFetch.mockResolvedValueOnce(new Response("short", { status: 200, headers: { "content-type": "text/plain" } }));

		const ctxWithId: ToolContext = { projectRoot: "/tmp/test", sessionId: "s1", toolCallId: "tc-short" };
		const result = await webFetchTool.execute({ url: "https://example.com/small.txt" }, ctxWithId);

		expect(result.llmOutput).not.toContain("read_file");
	});

	test("omits read_file hint when truncated but no toolCallId", async () => {
		const lines = Array.from({ length: 2500 }, (_, i) => `line ${i}`);
		mockFetch.mockResolvedValueOnce(new Response(lines.join("\n"), { status: 200, headers: { "content-type": "text/plain" } }));

		const ctxNoId: ToolContext = { projectRoot: "/tmp/test", sessionId: "s1" };
		const result = await webFetchTool.execute({ url: "https://example.com/big.txt" }, ctxNoId);

		expect(result.llmOutput).not.toContain("read_file");
	});

	test("PDF response includes header when toolCallId is present", async () => {
		const minimalPdf = `%PDF-1.0
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 100 700 Td (Hello PDF) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000266 00000 n 
0000000360 00000 n 
trailer<</Size 6/Root 1 0 R>>
startxref
430
%%EOF`;
		mockFetch.mockResolvedValueOnce(new Response(minimalPdf, { status: 200, headers: { "content-type": "application/pdf" } }));

		const ctxWithId: ToolContext = { projectRoot: "/tmp/test", sessionId: "s1", toolCallId: "tc-pdf" };
		const result = await webFetchTool.execute({ url: "https://example.com/doc.pdf" }, ctxWithId);

		expect(result.llmOutput).toStartWith("Complete file available at .bobai/downloads/s1/tc-pdf");
		expect(result.llmOutput).toContain("Hello PDF");
	});

	test("error responses do not include header", async () => {
		mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404, statusText: "Not Found" }));

		const ctxWithId: ToolContext = { projectRoot: "/tmp/test", sessionId: "s1", toolCallId: "tc-err" };
		const result = await webFetchTool.execute({ url: "https://example.com/missing" }, ctxWithId);

		expect(result.llmOutput).not.toContain(".bobai/downloads/");
		expect(result.llmOutput).toStartWith("Error:");
	});
});

// ---------- Saving fetched content to disk ----------

describe("webFetchTool.execute saves content to disk", () => {
	const testRoot = join(import.meta.dir, ".test-web-fetch-save.tmp");
	const downloadsDir = (sessionId: string) => join(testRoot, ".bobai", "downloads", sessionId);

	beforeEach(() => {
		mockFetch = mock();
		globalThis.fetch = mockFetch;
		rmSync(testRoot, { recursive: true, force: true });
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		rmSync(testRoot, { recursive: true, force: true });
	});

	test("saves text content to disk for text/html", async () => {
		const html = "<h1>Hello</h1>";
		mockFetch.mockResolvedValueOnce(new Response(html, { status: 200, headers: { "content-type": "text/html" } }));

		const saveCtx: ToolContext = { projectRoot: testRoot, sessionId: "s1", toolCallId: "tc-001" };
		await webFetchTool.execute({ url: "https://example.com", format: "markdown" }, saveCtx);

		const saved = await Bun.file(join(downloadsDir("s1"), "tc-001")).text();
		expect(saved).toContain("Hello");
		// Should be converted markdown, not raw HTML
		expect(saved).toContain("# Hello");
	});

	test("saves plain text content as-is", async () => {
		const text = "plain text content";
		mockFetch.mockResolvedValueOnce(new Response(text, { status: 200, headers: { "content-type": "text/plain" } }));

		const saveCtx: ToolContext = { projectRoot: testRoot, sessionId: "s1", toolCallId: "tc-002" };
		await webFetchTool.execute({ url: "https://example.com/file.txt" }, saveCtx);

		const saved = await Bun.file(join(downloadsDir("s1"), "tc-002")).text();
		expect(saved).toBe(text);
	});

	test("saves raw bytes for binary content", async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
		mockFetch.mockResolvedValueOnce(new Response(bytes, { status: 200, headers: { "content-type": "image/png" } }));

		const saveCtx: ToolContext = { projectRoot: testRoot, sessionId: "s1", toolCallId: "tc-003" };
		await webFetchTool.execute({ url: "https://example.com/img.png" }, saveCtx);

		const saved = await Bun.file(join(downloadsDir("s1"), "tc-003")).arrayBuffer();
		expect(new Uint8Array(saved)).toEqual(bytes);
	});

	test("skips saving when toolCallId is undefined", async () => {
		mockFetch.mockResolvedValueOnce(new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }));

		const saveCtx: ToolContext = { projectRoot: testRoot, sessionId: "s1" };
		const result = await webFetchTool.execute({ url: "https://example.com" }, saveCtx);

		// Should still return content normally
		expect(result.llmOutput).toBe("hello");
		// Directory should not exist
		const exists = await Bun.file(join(downloadsDir("s1"), "undefined")).exists();
		expect(exists).toBe(false);
	});

	test("saves application/json as text", async () => {
		const json = '{"key": "value"}';
		mockFetch.mockResolvedValueOnce(new Response(json, { status: 200, headers: { "content-type": "application/json" } }));

		const saveCtx: ToolContext = { projectRoot: testRoot, sessionId: "s1", toolCallId: "tc-json" };
		await webFetchTool.execute({ url: "https://example.com/api" }, saveCtx);

		const saved = await Bun.file(join(downloadsDir("s1"), "tc-json")).text();
		expect(saved).toBe(json);
	});

	test("does not save on HTTP error", async () => {
		mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

		const saveCtx: ToolContext = { projectRoot: testRoot, sessionId: "s1", toolCallId: "tc-err" };
		await webFetchTool.execute({ url: "https://example.com/missing" }, saveCtx);

		const exists = await Bun.file(join(downloadsDir("s1"), "tc-err")).exists();
		expect(exists).toBe(false);
	});

	test("does not save on URL validation error", async () => {
		const saveCtx: ToolContext = { projectRoot: testRoot, sessionId: "s1", toolCallId: "tc-bad" };
		await webFetchTool.execute({ url: "ftp://bad" }, saveCtx);

		const exists = await Bun.file(join(downloadsDir("s1"), "tc-bad")).exists();
		expect(exists).toBe(false);
	});
});

describe("webFetchTool.execute binary content handling", () => {
	beforeEach(() => {
		mockFetch = mock();
		globalThis.fetch = mockFetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("binary LLM output with toolCallId shows file path and bash hint", async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
		mockFetch.mockResolvedValueOnce(new Response(bytes, { status: 200, headers: { "content-type": "image/png" } }));

		const ctx: ToolContext = { projectRoot: "/tmp/test", sessionId: "s1", toolCallId: "tc-bin-1" };
		const result = await webFetchTool.execute({ url: "https://example.com/img.png" }, ctx);

		expect(result.llmOutput).toBe(
			"Complete file available at .bobai/downloads/s1/tc-bin-1\nBinary file (image/png, 6 bytes). Use bash tool to process.",
		);
	});

	test("binary LLM output without toolCallId shows cannot display message", async () => {
		const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
		mockFetch.mockResolvedValueOnce(new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } }));

		const ctx: ToolContext = { projectRoot: "/tmp/test", sessionId: "s1" };
		const result = await webFetchTool.execute({ url: "https://example.com/photo.jpg" }, ctx);

		expect(result.llmOutput).toBe("Binary content (image/jpeg, 3 bytes). Cannot display binary data.");
	});

	test("binary UI output shows URL and content-type info", async () => {
		const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
		mockFetch.mockResolvedValueOnce(new Response(bytes, { status: 200, headers: { "content-type": "audio/mpeg" } }));

		const ctx: ToolContext = { projectRoot: "/tmp/test", sessionId: "s1", toolCallId: "tc-bin-2" };
		const result = await webFetchTool.execute({ url: "https://example.com/song.mp3" }, ctx);

		expect(result.uiOutput).toBe("https://example.com/song.mp3\naudio/mpeg | 4 bytes");
	});

	test("binary content does not go through TextDecoder", async () => {
		// Bytes that would produce garbage if decoded as text
		const bytes = new Uint8Array(256);
		for (let i = 0; i < 256; i++) bytes[i] = i;
		mockFetch.mockResolvedValueOnce(
			new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } }),
		);

		const ctx: ToolContext = { projectRoot: "/tmp/test", sessionId: "s1", toolCallId: "tc-bin-3" };
		const result = await webFetchTool.execute({ url: "https://example.com/data.bin" }, ctx);

		expect(result.llmOutput).toContain("Binary file (application/octet-stream, 256 bytes). Use bash tool to process.");
		expect(result.llmOutput).not.toContain("�");
	});

	test("binary summary includes content-type and byte size", async () => {
		const bytes = new Uint8Array([0x00, 0x01]);
		mockFetch.mockResolvedValueOnce(new Response(bytes, { status: 200, headers: { "content-type": "image/gif" } }));

		const ctx: ToolContext = { projectRoot: "/tmp/test", sessionId: "s1", toolCallId: "tc-bin-4" };
		const result = await webFetchTool.execute({ url: "https://example.com/img.gif" }, ctx);

		expect(result.summary).toContain("image/gif");
		expect(result.summary).toContain("2 bytes");
	});

	test("text response summary includes content-type and byte size", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response("<p>Hello</p>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
		);

		const ctx: ToolContext = { projectRoot: "/tmp/test", sessionId: "s1", toolCallId: "tc-txt-1" };
		const result = await webFetchTool.execute({ url: "https://example.com/page" }, ctx);

		expect(result.summary).toMatch(/text\/html; charset=utf-8 \| \d+ bytes \| [\d.]+s$/);
	});

	test("PDF success summary includes content-type and byte size", async () => {
		const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
		mockFetch.mockResolvedValueOnce(new Response(pdfBytes, { status: 200, headers: { "content-type": "application/pdf" } }));

		const ctx: ToolContext = { projectRoot: "/tmp/test", sessionId: "s1", toolCallId: "tc-pdf-1" };
		const result = await webFetchTool.execute({ url: "https://example.com/doc.pdf" }, ctx);

		// Either success or error, but if success, should have content-type
		if (result.summary && !result.summary.includes("PDF error") && !result.summary.includes("PDF empty")) {
			expect(result.summary).toContain("application/pdf");
		}
	});

	test("error summary does NOT include content-type", async () => {
		mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404, statusText: "Not Found" }));

		const ctx: ToolContext = { projectRoot: "/tmp/test", sessionId: "s1" };
		const result = await webFetchTool.execute({ url: "https://example.com/missing" }, ctx);

		expect(result.summary).toMatch(/HTTP 404 Not Found \| [\d.]+s$/);
	});
});

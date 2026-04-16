import { maskAuthHeader, writeDump } from "./dump";
import type { Logger } from "./logger";

export interface FetchInterceptorOptions {
	logger: Logger;
	logDir: string;
	debug: boolean;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
	if (!headers) return {};
	if (headers instanceof Headers) {
		const result: Record<string, string> = {};
		headers.forEach((value, key) => {
			result[key] = value;
		});
		return result;
	}
	if (Array.isArray(headers)) {
		return Object.fromEntries(headers);
	}
	return { ...headers } as Record<string, string>;
}

// ── Recording stream ────────────────────────────────────────────────────
//
// History: this module originally used response.body.tee() to split the
// stream into two branches — one for the caller, one for the dump
// collector. While tee() worked, it introduced unnecessary complexity:
//
//  1. Backpressure coupling — if the dump reader fell behind the caller
//     reader, the runtime had to buffer the delta in memory invisibly.
//  2. Two independent error channels — network errors propagated to both
//     branches separately, and cleanup behaviour varied across runtimes
//     (especially Bun, where tee edge cases have been observed).
//  3. Fire-and-forget timing — the dump side ran independently of the
//     caller, so on process exit or abort the dump could be incomplete.
//
// The recording stream replaces tee() with a pass-through wrapper. Each
// chunk flows to the caller exactly once; the wrapper accumulates a copy
// as a side effect. When the caller finishes reading (or an error
// occurs), the recorded payload is flushed to disk. This gives us:
//
//  - Single reader path: no extra buffering, natural backpressure.
//  - One error channel: the caller's error IS the recording's error.
//  - Deterministic dump timing: written right after stream completion.
//
// If you're considering switching back to tee(), check git history for
// the original implementation and weigh the trade-offs above.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Wrap a ReadableStream so every chunk is forwarded to the caller while
 * also being recorded. On stream completion the full text is passed to
 * `onComplete`; on error it goes to `onError`.
 */
function createRecordingStream(
	original: ReadableStream<Uint8Array>,
	onComplete: (body: string) => void,
	onError: (err: unknown) => void,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	let recorded = "";

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const chunk of original) {
					recorded += decoder.decode(chunk, { stream: true });
					controller.enqueue(chunk);
				}
				recorded += decoder.decode(); // flush incomplete multi-byte sequences
				controller.close();
				onComplete(recorded);
			} catch (err) {
				controller.error(err);
				onError(err);
			}
		},
	});
}

export function createFetchInterceptor(originalFetch: typeof fetch, options: FetchInterceptorOptions): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

		if (!url.includes("githubcopilot.com") && !url.includes("github.com")) {
			return originalFetch(input, init);
		}

		// When a wrapper collapses fetch(url, opts) into fetch(new Request(...)),
		// init is undefined. Fall back to extracting from the Request object.
		const isRequest = input instanceof Request;
		const method = init?.method ?? (isRequest ? input.method : "GET");
		const requestBody = typeof init?.body === "string" ? init.body : undefined;
		const startTime = Date.now();

		options.logger.debug("HTTP", `>>> ${method} ${url}`);

		let response: Response;
		try {
			response = await originalFetch(input, init);
		} catch (err) {
			const latencyMs = Date.now() - startTime;
			options.logger.error("HTTP", `${method} ${url} FAILED ${latencyMs}ms: ${err}`);
			throw err;
		}
		const latencyMs = Date.now() - startTime;

		options.logger.info("HTTP", `${method} ${url} ${response.status} ${latencyMs}ms`);

		if (!options.debug) return response;

		const reqHeaders = maskAuthHeader(headersToRecord(init?.headers ?? (isRequest ? input.headers : undefined)));
		const respHeaders = headersToRecord(response.headers);

		if (response.body) {
			// Record the response body as it streams through to the caller.
			// The dump is written once the caller finishes consuming the stream
			// (or on error). No parallel reader, no tee — see comment above.
			const recordingStream = createRecordingStream(
				response.body,
				(responseBody) => {
					const filename = writeDump(
						options.logDir,
						{ method, url, headers: reqHeaders, body: requestBody },
						{
							status: response.status,
							statusText: response.statusText,
							headers: respHeaders,
							body: responseBody,
							latencyMs,
						},
					);
					options.logger.debug("HTTP", `Dumped to ${filename}`);
				},
				(err) => {
					// Suppress abort errors — these are expected when our rolling timer
					// or the caller cancels mid-stream. The retry logic logs the real cause.
					const isAbort =
						(err instanceof DOMException && err.name === "AbortError") ||
						(err instanceof Error && err.message === "The operation was aborted.");
					if (!isAbort) {
						options.logger.error("HTTP", `Dump failed: ${err}`);
					}
				},
			);

			return new Response(recordingStream, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		}

		writeDump(
			options.logDir,
			{ method, url, headers: reqHeaders, body: requestBody },
			{ status: response.status, statusText: response.statusText, headers: respHeaders, body: "", latencyMs },
		);

		return response;
	};
}

export function installFetchInterceptor(options: FetchInterceptorOptions): void {
	globalThis.fetch = createFetchInterceptor(globalThis.fetch, options);
}

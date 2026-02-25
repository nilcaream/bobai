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

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	return text;
}

export function createFetchInterceptor(originalFetch: typeof fetch, options: FetchInterceptorOptions): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

		if (!url.includes("githubcopilot.com") && !url.includes("github.com")) {
			return originalFetch(input, init);
		}

		const method = init?.method ?? "GET";
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

		const reqHeaders = maskAuthHeader(headersToRecord(init?.headers));
		const respHeaders = headersToRecord(response.headers);

		if (response.body) {
			const [callerStream, dumpStream] = response.body.tee();

			collectStream(dumpStream)
				.then((responseBody) => {
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
				})
				.catch((err) => {
					options.logger.error("HTTP", `Dump failed: ${err}`);
				});

			return new Response(callerStream, {
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

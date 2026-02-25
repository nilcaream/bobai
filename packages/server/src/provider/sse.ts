export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
	const decoder = new TextDecoder();
	let buffer = "";

	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		const parts = buffer.split("\n\n");
		buffer = parts.pop() ?? "";

		for (const part of parts) {
			const line = part.trim();
			if (!line.startsWith("data: ")) continue;

			const data = line.slice("data: ".length);
			if (data === "[DONE]") return;

			yield JSON.parse(data);
		}
	}
}

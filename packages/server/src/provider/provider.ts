export interface Message {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ProviderOptions {
	model: string;
	messages: Message[];
	signal?: AbortSignal;
}

export interface Provider {
	readonly id: string;
	stream(options: ProviderOptions): AsyncIterable<string>;
}

export class ProviderError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: string,
	) {
		super(`Provider error (${status}): ${body}`);
		this.name = "ProviderError";
	}
}

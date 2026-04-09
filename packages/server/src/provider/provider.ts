// --- Message types (OpenAI-compatible) ---

export interface SystemMessage {
	role: "system";
	content: string;
}

export interface UserMessage {
	role: "user";
	content: string;
}

export interface ToolCallContent {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface AssistantMessage {
	role: "assistant";
	content: string | null;
	tool_calls?: ToolCallContent[];
}

export interface ToolMessage {
	role: "tool";
	content: string;
	tool_call_id: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// --- Tool definition (OpenAI function-calling format) ---

export interface ToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

// --- Stream events ---

export type StreamEvent =
	| { type: "text"; text: string }
	| { type: "tool_call_start"; index: number; id: string; name: string }
	| { type: "tool_call_delta"; index: number; arguments: string }
	| { type: "usage"; tokenCount: number; tokenLimit: number; display: string }
	| { type: "finish"; reason: "stop" | "tool_calls" };

// --- Provider interface ---

export interface StreamMetrics {
	model: string;
	promptTokens: number;
	totalTokens: number;
	initiator: "user" | "agent";
}

export interface ProviderOptions {
	model: string;
	messages: Message[];
	tools?: ToolDefinition[];
	signal?: AbortSignal;
	initiator?: "user" | "agent";
	/** When set, per-call metrics are routed to this callback instead of the provider's
	 *  internal turn accumulator. Used by isolated turn providers for parallel execution. */
	onMetrics?(metrics: StreamMetrics): void;
}

export interface Provider {
	readonly id: string;
	stream(options: ProviderOptions): AsyncIterable<StreamEvent>;
	/** Reset per-turn stats. Called before the agent loop starts.
	 *  @param sessionPromptTokens — last known prompt token count from the DB,
	 *  used as baseline when no in-memory state exists (e.g. after server restart). */
	beginTurn?(sessionPromptTokens?: number): void;
	/** Format accumulated turn stats into a display string (e.g. " | model | agent: 3 | ..."). */
	getTurnSummary?(): string | undefined;
	/** Return the prompt token count from the last LLM call in this turn. */
	getTurnPromptTokens?(): number;
	/** Return the total content character count from the last LLM call in this turn. */
	getTurnPromptChars?(): number;
	/** Save current turn tracking state (so it can be restored after a subagent run). */
	saveTurnState?(): unknown;
	/** Restore previously saved turn tracking state. */
	restoreTurnState?(state: unknown): void;
}

// --- Errors ---

export class ProviderError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: string,
	) {
		super(`Provider error (${status}): ${body}`);
		this.name = "ProviderError";
	}
}

export class AuthError extends ProviderError {
	constructor(
		status: number,
		body: string,
		public readonly permanent: boolean,
	) {
		super(status, body);
		this.name = "AuthError";
	}
}

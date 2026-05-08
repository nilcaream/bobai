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

export type InterleavedChatReasoningField = "reasoning" | "reasoning_content" | "reasoning_details";

export interface ResponsesItemReasoningState {
	kind: "responses-item";
	id?: string;
	summary?: string;
	encryptedContent?: string;
}

export interface InterleavedChatReasoningState {
	kind: "interleaved-chat";
	field: InterleavedChatReasoningField;
	text?: string;
	details?: unknown;
}

export interface TextSummaryReasoningState {
	kind: "text-summary";
	text: string;
}

export type ReasoningState = ResponsesItemReasoningState | InterleavedChatReasoningState | TextSummaryReasoningState;

export interface AssistantMessage {
	role: "assistant";
	content: string | null;
	tool_calls?: ToolCallContent[];
	reasoning?: ReasoningState[];
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

export type ReasoningDelta =
	| { kind: "text"; text: string }
	| { kind: "details"; details: unknown }
	| { kind: "summary"; summary: string }
	| { kind: "encrypted-content"; encryptedContent: string };

export type StreamEvent =
	| { type: "text"; text: string }
	| { type: "reasoning_start"; index: number; reasoning: ReasoningState }
	| { type: "reasoning_delta"; index: number; delta: ReasoningDelta }
	| {
			type: "reasoning_end";
			index: number;
			reasoning?: ReasoningState;
	  }
	| { type: "tool_call_start"; index: number; id: string; name: string }
	| { type: "tool_call_delta"; index: number; arguments: string }
	| { type: "usage"; tokenCount: number; tokenLimit: number; display: string; outputTokens?: number; totalTokens?: number }
	| { type: "finish"; reason: "stop" | "tool_calls" };

// --- Provider interface ---

export interface StreamMetrics {
	model: string;
	promptTokens: number;
	outputTokens: number;
	promptChars: number;
	totalTokens: number;
}

export interface ProviderOptions {
	model: string;
	messages: Message[];
	tools?: ToolDefinition[];
	signal?: AbortSignal;
	/** Session ID for API provider session affinity (truncated to first 8 characters). */
	sessionId?: string;
	/** Computed per-call output cap after accounting for remaining context window. */
	maxOutputTokens?: number;
	reasoningDefaults?: {
		anthropic?: {
			budgetTokens?: number;
			display?: "summarized" | "omitted";
		};
	};
	/** User-overridden context limit for display purposes. */
	contextLimit?: number | null;
	/** When set, per-call metrics are routed to this callback instead of the provider's
	 *  internal turn accumulator. Used by isolated turn providers for parallel execution. */
	onMetrics?(metrics: StreamMetrics): void;
}

export interface Provider {
	readonly id: string;
	readonly configDir?: string;
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
	/** Return structured token metrics for this turn. */
	getTurnMetrics?(): {
		inputTokensTotal: number;
		outputTokensTotal: number;
		inputTokensLast: number;
		outputTokensLast: number;
		contextDelta: number;
	};
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

export class TimeoutError extends ProviderError {
	constructor(attempts: number, cause?: unknown) {
		const causeMsg = cause instanceof Error ? `: ${cause.message}` : "";
		super(0, `Request timed out after ${attempts} attempt${attempts > 1 ? "s" : ""}${causeMsg}`);
		this.name = "TimeoutError";
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

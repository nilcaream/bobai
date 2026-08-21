import type { ApiFamily } from "./registry";

// Endpoint routing for the OpenCode Go and OpenCode Zen gateways.
//
// Both gateways serve each model on a specific API surface, and reject calls
// to the wrong one (e.g. Grok 4.5 on /chat/completions returns 503, since it
// moved to the Responses API). The reference OpenCode client derives this from
// the per-model `provider.npm` field of the models.dev catalog:
//
//   @ai-sdk/openai            -> /v1/responses        (Responses API)
//   @ai-sdk/anthropic         -> /v1/messages         (Anthropic Messages)
//   @ai-sdk/openai-compatible -> /v1/chat/completions (Chat Completions)
//   @ai-sdk/google            -> /v1/models/<id>      (Gemini — unsupported here)
//
// Source: https://models.opencode.ai/api.json (mirrored by models.dev).

const OPENCODE_GO_RESPONSES_MODELS = new Set(["grok-4.5", "gpt-5.6-luna", "muse-spark-1.2-contributor"]);

// Verified live (2026-08-21): grok-4.5 (503) and grok-build-0.1 (400) reject
// /chat/completions and are only served on the Responses API. grok-4.6 also
// serves /chat/completions today, so it intentionally stays on the chat path.
const OPENCODE_ZEN_RESPONSES_MODELS = new Set(["grok-4.5", "grok-build-0.1"]);

export function getOpenCodeGoApiFamily(modelId: string): ApiFamily {
	if (modelId.startsWith("minimax-")) return "anthropic-messages";
	if (OPENCODE_GO_RESPONSES_MODELS.has(modelId)) return "openai-responses";
	return "openai-chat-completions";
}

export function getOpenCodeZenApiFamily(modelId: string): ApiFamily {
	if (modelId.startsWith("claude-")) return "anthropic-messages";
	if (modelId.startsWith("gpt-") || OPENCODE_ZEN_RESPONSES_MODELS.has(modelId)) return "openai-responses";
	return "openai-chat-completions";
}

# GitHub Copilot API Integration Guide

A reference for implementing tools that call the GitHub Copilot Chat Completions API. Covers authentication, required headers, billing, and advanced patterns like vision and streaming.

---

## Authentication

GitHub Copilot rejects plain Personal Access Tokens. Clients must authenticate through the **OAuth Device Code Flow** (RFC 8628).

### Device Code Flow

1. **Request a device code.** POST to `https://github.com/login/device/code` with:
   - `client_id` — your registered GitHub OAuth App's Client ID
   - `scope` — typically empty (Copilot access is implicit to the app)

   The response contains `device_code`, `user_code`, `verification_uri`, and `interval` (polling seconds).

2. **Present the code to the user.** Display the `user_code` and direct them to `verification_uri` (usually `https://github.com/login/device`).

3. **Poll for the access token.** POST to `https://github.com/login/oauth/access_token` with:
   - `client_id`
   - `device_code`
   - `grant_type`: `urn:ietf:params:oauth:grant-type:device_code`

   Poll at the `interval` from step 1. Expect these transient states:
   - `authorization_pending` — user has not yet entered the code; keep polling
   - `slow_down` — increase interval by 5 seconds
   - `expired_token` — device code expired; restart the flow

   On success, the response contains `access_token` (prefix `gho_`).

4. **Persist the token.** Store `access_token` to disk (e.g., `~/.config/<app>/auth.json`). Set file permissions to `0o600`.

### Token Usage

The `access_token` from the OAuth flow is a GitHub OAuth token (prefix `gho_`). Use it directly as a Bearer token in API requests. No separate "Copilot token exchange" step exists — the OAuth token works with the Copilot API.

---

## API Endpoint

```
POST https://api.githubcopilot.com/chat/completions
```

The API follows the OpenAI Chat Completions format and supports `stream: true` for Server-Sent Events streaming.

---

## Required Headers

Every request to the Copilot API requires these headers:

| Header | Value | Purpose |
|--------|-------|---------|
| `Authorization` | `Bearer <gho_token>` | OAuth token from device flow |
| `Content-Type` | `application/json` | Standard for JSON body |
| `User-Agent` | `<app>/<version>` | Identifies the client application |
| `Openai-Intent` | `conversation-edits` | Required by the Copilot gateway; always use this literal value |
| `x-initiator` | `user` or `agent` | Indicates who initiated the request; affects billing |

### x-initiator

This header tells Copilot whether a human or the tool triggered the request. The value affects billing.

**Determining the value:** Inspect the last message in the `messages` array:

- **`user`** — the last message has `role: "user"`. The human typed a prompt.
- **`agent`** — the last message has any other role (`assistant`, `tool`, etc.). The tool continues autonomously — processing tool results, generating follow-up requests, or running as a subagent.

```ts
function resolveInitiator(messages: Message[]): "user" | "agent" {
    const last = messages[messages.length - 1];
    return last?.role === "user" ? "user" : "agent";
}
```

For tools that support multi-turn with tool use, the Messages API variant applies a stricter check: the last message must have `role: "user"` **and** contain non-tool-result content to qualify as `"user"`. All other cases resolve to `"agent"`.

Subagent sessions (where the tool spawns a child session) should always send `x-initiator: agent`, regardless of message roles.

---

## Billing

### Premium Requests

GitHub Copilot uses a **premium request** quota system. Each paid plan includes a fixed monthly allowance (e.g., Copilot Pro: 300 premium requests). Counters reset on the 1st of each month at 00:00:00 UTC. Unused requests do not carry over.

Each user prompt consumes premium requests equal to the model's **multiplier**. Context window size and token count are irrelevant — billing is per-prompt, not per-token.

### Model Multipliers (Paid Plans)

Models with a multiplier of **0** are included — unlimited prompts at no premium request cost. All other models deduct from the monthly quota.

| Model | Multiplier | Notes |
|-------|-----------|-------|
| GPT-4o | 0 | Included |
| GPT-4.1 | 0 | Included |
| GPT-5 mini | 0 | Included |
| Grok Code Fast 1 | 0.25 | |
| Claude Haiku 4.5 | 0.33 | |
| Gemini 3 Flash | 0.33 | |
| GPT-5.1-Codex-Mini | 0.33 | |
| Claude Sonnet 4 | 1 | |
| Claude Sonnet 4.5 | 1 | |
| Claude Sonnet 4.6 | 1 | |
| Gemini 2.5 Pro | 1 | |
| Gemini 3 Pro | 1 | |
| GPT-5.1 | 1 | |
| GPT-5.1-Codex | 1 | |
| GPT-5.2 | 1 | |
| GPT-5.2-Codex | 1 | |
| Claude Opus 4.5 | 3 | |
| Claude Opus 4.6 | 3 | |

Source: https://docs.github.com/en/copilot/concepts/billing/copilot-requests

When the monthly allowance runs out, the API continues to work for included models (multiplier 0) but rejects premium models until the next reset.

### x-initiator and Billing

Only prompts with `x-initiator: user` consume premium requests. Agent-initiated requests (`x-initiator: agent`) cost zero, regardless of model.

A single user prompt may trigger many agent follow-up calls (tool use loops, retries, subagent work). Charging for each would be prohibitive.

---

## Conditional Headers

These headers are required only in specific scenarios:

| Header | Value | When |
|--------|-------|------|
| `Copilot-Vision-Request` | `true` | The request body contains image content (`image_url`, `input_image`, or `image`-type parts) |
| `anthropic-beta` | `interleaved-thinking-2025-05-14` | Using a Claude model through the Copilot API |

---

## Request Body

Standard OpenAI Chat Completions format:

```json
{
    "model": "gpt-4o",
    "messages": [
        { "role": "system", "content": "You are a helpful assistant." },
        { "role": "user", "content": "What is 2+2?" }
    ],
    "stream": true
}
```

### Available Models

The Copilot API exposes models from multiple providers. Use model names directly (no provider prefix).

**Model availability depends on the OAuth App `client_id` used during authentication.** The access token returned by the device flow is bound to the OAuth App that requested it. GitHub grants each registered OAuth App its own set of allowed models. Two apps using the same user account and the same OAuth scope can receive different model entitlements.

If a model returns `400 model_not_supported`, the token's associated OAuth App may lack access to that model. There is no API endpoint to list which models an app can use — the only way to verify is to send a request and check the response status.

See the test procedure in [Verifying Model Access](#verifying-model-access) below.

---

## Streaming (SSE)

With `stream: true`, the response arrives as Server-Sent Events:

```
data: {"id":"...","choices":[{"delta":{"role":"assistant","content":"Hello"}}]}

data: {"id":"...","choices":[{"delta":{"content":" world"}}]}

data: [DONE]
```

Each `data:` line contains a JSON object (except the terminal `[DONE]`). Extract content from `choices[0].delta.content`. Skip chunks with empty deltas (e.g., role-only first chunk, finish_reason-only last chunk).

### Consuming streams without blocking

To capture the full response for logging or debugging without blocking the caller, use `ReadableStream.tee()`:

```ts
const [callerStream, captureStream] = response.body.tee();

// Fire-and-forget: collect the capture stream asynchronously
collectStream(captureStream)
    .then((fullBody) => writeDumpFile(fullBody))
    .catch((err) => logger.error(err));

// Return the caller stream as the response body
return new Response(callerStream, {
    status: response.status,
    headers: response.headers,
});
```

This prevents consuming the response body before the caller reads it.

---

## Verifying Model Access

The following script tests which models an OAuth App token can access. Replace `gho_xxxx` with the token obtained through the device flow for the `client_id` under test. The token is bound to the OAuth App that issued it — results reflect that app's entitlements, not the user's Copilot plan.

```bash
TOKEN="gho_xxxx"

for model in "gpt-4o" "gpt-4o-mini" "gpt-5-mini" "gpt-4.1" \
             "claude-haiku-4.5" "claude-sonnet-4" "grok-code-fast-1" \
             "gemini-2.5-pro" "gpt-5.1"; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    https://api.githubcopilot.com/chat/completions \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -H "User-Agent: bobai/0.0.1" \
    -H "Openai-Intent: conversation-edits" \
    -H "x-initiator: user" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hi\"}],\"stream\":false,\"max_tokens\":10}")
  echo "$model: $STATUS"
done
```

**Expected results for included models (multiplier 0) with a correctly provisioned app:**

```
gpt-4o: 200
gpt-4o-mini: 200
gpt-5-mini: 200
gpt-4.1: 200
claude-haiku-4.5: 200
claude-sonnet-4: 200
grok-code-fast-1: 200
gemini-2.5-pro: 200
gpt-5.1: 200
```

A `400` response for a model that should work indicates the OAuth App lacks access to that model. A `401` indicates an expired or invalid token. Models with a non-zero multiplier (e.g., `claude-sonnet-4`, `gpt-5.1`) consume premium requests on each `200` response — use them sparingly in automated tests.

---

## Error Handling

Common error responses from the Copilot API:

| Status | Meaning | Action |
|--------|---------|--------|
| 400 | Bad request — often `model_not_supported` | Check model name; verify the OAuth App has access to that model |
| 401 | Invalid or expired token | Re-run the OAuth device flow |
| 403 | Copilot not enabled for the user/org | Check Copilot subscription |
| 429 | Rate limited | Back off and retry |
| 500+ | Server error | Retry with backoff |

---

## Security Considerations

### Token Masking in Logs

Never log OAuth tokens in plain text. When logging or dumping HTTP exchanges, mask the Authorization header:

```ts
// Long tokens (>8 chars): preserve first 4 + last 4
"Bearer gho_abcdefghijkl" → "Bearer gho_***ijkl"

// Short tokens (≤8 chars): fully mask
"Bearer short" → "Bearer ***"
```

### File Permissions

Set auth token files to `0o600` permissions (owner read/write only). Log files containing masked tokens can use default permissions.

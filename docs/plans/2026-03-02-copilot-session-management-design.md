# Copilot Session Management — Design

## Problem

Bob AI sends the raw GitHub OAuth token directly to the Copilot API. The correct flow requires a two-tier token system: exchange the OAuth token for a short-lived Copilot session token, then use that session token for all API calls. Without this, most models return 403 because they require explicit enablement via a policy API that also needs the session token.

Current state: 3 of 7 curated models work (only those previously enabled through VS Code).

## Architecture

### Auth Storage (`store.ts`)

Replace `{ token: string }` with:

```typescript
interface StoredAuth {
    refresh: string;   // GitHub OAuth token (long-lived)
    access: string;    // Copilot session token (short-lived, ~30 min)
    expires: number;   // Expiry in ms (actual expiry minus 5 min buffer)
}
```

- `saveAuth(configDir, auth)` replaces `saveToken()`
- `loadAuth(configDir)` replaces `loadToken()` — returns `StoredAuth | undefined`
- Old format `{ token }` detected as invalid shape → returns `undefined` → forces re-auth

### Token Exchange (`copilot.ts`)

New export:

```
exchangeToken(refreshToken, configHeaders?) → { access, expires, baseUrl }
```

- `GET https://api.github.com/copilot_internal/v2/token` with `Authorization: Bearer <refreshToken>`
- Response: `{ token: string, expires_at: number }`
- Parses `proxy-ep` from token string (`/proxy-ep=([^;]+)/`), converts `proxy.xxx` → `api.xxx`
- Falls back to `https://api.individual.githubcopilot.com`
- Returns `{ access: token, expires: expires_at * 1000 - 5 * 60 * 1000, baseUrl }`

### Model Enablement (`copilot.ts`)

New export:

```
enableModels(sessionToken, baseUrl, modelIds, configHeaders?) → void
```

- `POST {baseUrl}/models/{id}/policy` with `{"state":"enabled"}` for each model
- All requests run in parallel
- Failures are non-fatal (logged, not thrown)

### Headers

No hardcoded VS Code headers. Bob AI's default header is `User-Agent: bobai/<version>`. Config headers from `bobai.json` merge on top and flow through to **all** Copilot calls: token exchange, model enablement, and LLM streaming. Users who want VS Code impersonation configure it in `bobai.json`.

### Provider (`createCopilotProvider`)

Constructor changes from `(token, configHeaders, configDir)` to `(auth: StoredAuth, configHeaders, configDir)`.

Internal mutable state:

```typescript
let sessionToken = auth.access;
let sessionExpires = auth.expires;
let baseUrl = deriveBaseUrl(auth.access);
const refreshToken = auth.refresh;
```

Before each `stream()` call, the provider checks `Date.now() >= sessionExpires`. If expired:
1. Calls `exchangeToken(refreshToken, configHeaders)`
2. Updates `sessionToken`, `sessionExpires`, `baseUrl`
3. Persists refreshed auth via `saveAuth()`

API endpoint changes from hardcoded `https://api.githubcopilot.com/chat/completions` to `${baseUrl}/chat/completions`.

### Auth Flow

**`authorize()` changes:**
1. OAuth device flow → GitHub token (unchanged)
2. `exchangeToken(githubToken, configHeaders)` → session token + expiry + base URL
3. `enableModels(sessionToken, baseUrl, curatedModelIds, configHeaders)`
4. `saveAuth(configDir, { refresh, access, expires })`
5. Returns `StoredAuth`

**`index.ts` changes:**
- `loadAuth()` replaces `loadToken()`
- If undefined → `authorize()` (full exchange flow)
- `createCopilotProvider(auth, config.headers)` replaces `createCopilotProvider(token, config.headers)`
- `auth` and `refresh` commands load `bobai.json` for config headers before calling exchange/enable

**`refreshModels()` changes:**
- Takes session token + base URL (not raw OAuth token)
- Calls `enableModels()` before probing
- Probes use session token and derived base URL

### Testing

1. Token exchange — mock `api.github.com` endpoint, verify headers, verify token/expiry parsing
2. Base URL derivation — unit test `proxy-ep` → `api.xxx` conversion
3. Auto-refresh — provider with expired session token exchanges before streaming
4. Model enablement — verify POST to `/models/{id}/policy`, parallel execution, non-fatal failures
5. Auth store — new format round-trip, old format returns undefined
6. Existing provider tests — updated to pass `StoredAuth` instead of plain token

## Affected Files

- `packages/server/src/auth/store.ts` — new StoredAuth interface and functions
- `packages/server/src/auth/authorize.ts` — full exchange flow after OAuth
- `packages/server/src/provider/copilot.ts` — exchangeToken, enableModels, provider session management
- `packages/server/src/index.ts` — loadAuth, pass StoredAuth to provider, load config for auth/refresh commands
- `packages/server/test/` — new and updated tests

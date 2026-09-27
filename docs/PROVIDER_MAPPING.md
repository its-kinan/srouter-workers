# Provider mapping

Model ids on the wire are `<alias>/<upstream-id>` (e.g.
`antigravity/gemini-3-pro`, `gcli/grok-build`). The prefix selects the provider
type; the remainder is passed upstream unchanged. Bare ids (no prefix) resolve
via the aggregated catalog.

## Wired providers

| `provider_id` | Alias | Category | Executor | Transport |
|---|---|---|---|---|
| `antigravity` | `antigravity` | oauth | vendored `AntigravityExecutor` | Gemini-protocol via `daily-cloudcode-pa.googleapis.com` |
| `qoder` | `qd` | oauth | vendored `QoderExecutor` | Qoder API (AES-CBC/RSA device auth) |
| `openai_codex` | `codex` | oauth | vendored `CodexExecutor` | OpenAI Responses API |
| `commandcode` | `commandcode` | oauth | vendored `CommandCodeExecutor` | CommandCode API |
| `grok-cli` | `gcli` | oauth | **new** `GrokCliExecutor` | OpenAI Responses API |
| `gemini-cli` | `gemini-cli` | oauth | scaffold `GeminiCliAdapter` | cloudcode-pa (Phase 2) |
| `openai-compatible` | per-row `alias` | api_key | vendored `OpenAIExecutor` | Any OpenAI-compatible base URL |

Row-level `alias` in D1 overrides the builtin alias for prefix routing.

## grok-cli (new adapter)

SRouter has no grok-cli provider. Mapping was derived from 9router's
`open-sse/providers/registry/grok-cli.js`, captured from official
`@xai-official/grok` CLI wire traffic:

- Base: `https://cli-chat-proxy.grok.com/v1`
- Chat: `POST {base}/responses` (streaming, Responses API)
- Models: `GET {base}/models`
- Headers: `Authorization: Bearer <token>`, `x-xai-token-auth: xai-grok-cli`,
  `x-grok-client-version: 0.2.99`, `x-grok-client-identifier: grok-shell`
- OAuth: xAI device-code flow (`https://auth.x.ai/oauth2/device/code`,
  client `b1a00492-073a-47ea-816f-4c329264a828`) — onboarding is Phase 2;
  Phase 1 serves migrated accounts whose tokens the cron sweeper will refresh
  once the xAI refresh flow lands.
- Fallback catalog when `/models` is unreachable: `grok-build`,
  `grok-4.5`, `grok-4.5-high/medium/low`.

Request translation reuses the vendored Responses translator
(`ChatToResponsesBody` / `ResponsesEventToChunk`), same as the Codex executor.

## gemini-cli (scaffold)

SRouter has no gemini-cli provider. 9router's mapping: Google OAuth, project
discovery via `POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`,
chat over the Gemini protocol against `cloudcode-pa.googleapis.com/v1internal`.
This is the same Cloud Code protocol family the vendored Antigravity executor
already speaks, so Phase 2 reuses that translator plumbing with a cloudcode-pa
transport. The scaffold is registered so accounts can be stored and listed;
chat calls fail with a clear error until then.

## Adding a provider (Phase 2 pattern)

1. Add the executor under `src/providers/` (or vendor it under
   `src/vendor/executors/`).
2. Register it in `src/providers/registry.ts` (`buildExecutor` +
   `SUPPORTED_PROVIDERS` + `PROVIDER_ALIASES`).
3. If OAuth: add refresh logic in `src/providers/oauth-refresh.ts`.
4. Update this file and `docs/PORT_MATRIX.md`.

# Providers

Model ids on the wire are `<alias>/<upstream-id>` (e.g.
`antigravity/gemini-3-pro`, `qd/some-model`). The prefix selects the
provider type; the remainder is passed upstream unchanged. Bare ids (no
prefix) resolve via the aggregated catalog. Row-level `alias` in D1
overrides the builtin alias for prefix routing.

## Provider types

| `provider_id` | Alias | Category |
|---|---|---|
| `antigravity` | `antigravity` | oauth (Google) |
| `qoder` | `qd` | oauth (device flow) |
| `openai_codex` | `codex` | oauth (OpenAI) |
| `commandcode` | `commandcode` | oauth |
| `grok-cli` | `gcli` | oauth (xAI device flow) |
| `gemini-cli` | `gemini-cli` | oauth (Google; chat transport pending) |
| `cline` | `cline` | api_key + oauth |
| `anthropic` | `anthropic` | api_key |
| `atria` | `atria` | api_key |
| `bai` | `bai` | api_key |
| `codebuddy` | `codebuddy` | oauth |
| `codebuddy-cn` | `codebuddy-cn` | oauth (Tencent) |
| `experientiallabs` | `explabs` | api_key |
| `genspark` | `gs` | api_key |
| `gmicloud` | `gmi` | api_key |
| `gorouter` | `gr` | api_key |
| `kiro` | `kiro` | oauth |
| `minimax` | `minimax` | api_key |
| `neosantara` | `neosantara` | api_key |
| `opencode_zen` | `opencode_zen` | api_key |
| `orcarouter` | `orca` | api_key |
| `tabitoken` | `tb` | api_key |
| `tokenharbor` | `th` | api_key |
| `tokenrouter` | `tre` | api_key |
| `openai-compatible` | per-row `alias` | api_key (any OpenAI-compatible base URL) |

The old shared `openai-compatible` bucket was split by base URL into
first-class provider types; generic `openai-compatible` remains for
future custom URLs.

## Account pinning

Append `#` + account id (exact) or name/alias (case-insensitive) to pin a
request to specific accounts: `th/some-model#my-main-key`. Invalid pins
return 404 `model_not_found` — pinned accounts never silently fail over.
Fallback targets can be pinned too.

## OAuth notes

- **antigravity** — Google OAuth. Needs a Google web client with
  `https://<worker>/v1/auth/antigravity/callback` registered; set
  `ANTIGRAVITY_OAUTH_CLIENT_ID` (+ `_SECRET`, `_REDIRECT_URI`).
- **openai_codex** — OpenAI OAuth; bring-your-own client via
  `CODEX_OAUTH_CLIENT_ID` / `CODEX_OAUTH_REDIRECT_URI`.
- **claude/anthropic OAuth** — bring-your-own via `CLAUDE_OAUTH_CLIENT_ID`.
- **qoder** — device flow; tokens don't refresh (upstream no-op).
- **grok-cli** — xAI device flow, implemented.
- **gemini-cli** — classified as OAuth; the chat transport is not yet
  implemented.

Token refresh runs on the per-minute cron; per-account DO locks dedup
across isolates.

## Adding a provider

1. Add the executor under `src/providers/` (or vendor it under
   `src/vendor/executors/`).
2. Register it in `src/providers/registry.ts` (`buildExecutor` +
   `SUPPORTED_PROVIDERS` + `PROVIDER_ALIASES`).
3. If OAuth: add refresh logic in `src/providers/oauth-refresh.ts`.
4. Update this file.

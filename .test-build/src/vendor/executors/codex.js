import { CODEX_BASE_URL, CODEX_MODELS_URL } from "../constants.js";
import { accumulateChunks, ChatToResponsesBody, CreateResponsesStreamState, NormalizeReasoningEffort, NormalizeResponsesInput, ResponsesEventToChunk } from "../translator/index.js";
import { parseDataLine, streamLines } from "./base.js";
import { extractSseErrorMessage, MODEL_CAPACITY_MESSAGE } from "./sse.js";
import { FetchWithBudget } from "./retry.js";
import { applyStealth } from "../../providers/fingerprints.js";
const CODEX_CLIENT_VERSION = "0.136.0";
// SSE error patterns inside 200-OK bodies. Some retry same account first; capacity rotates accounts.
const SSE_RETRY_PATTERNS = ["server_is_overloaded", "service_unavailable_error"];
const SSE_ACCOUNT_FALLBACK_PATTERNS = ["selected model is at capacity", "model_at_capacity"];
const SSE_USER_OUTPUT_PATTERNS = [
    "event: response.output_text.delta",
    "event: response.function_call_arguments.delta",
    '"type":"response.output_text.delta"',
    '"type":"response.function_call_arguments.delta"'
];
const SSE_PEEK_BYTES = 256 * 1024;
// Default Codex instructions injected when the request has none (port of 9router codexInstructions.js)
const CODEX_DEFAULT_INSTRUCTIONS = `You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer.

## General

- When searching for text or files, prefer using \`rg\` or \`rg --files\` respectively because \`rg\` is much faster than alternatives like \`grep\`. (If the \`rg\` command is not found, then use alternatives.)

## Editing constraints

- Default to ASCII when editing or creating files. Only introduce non-ASCII or other Unicode characters when there is a clear justification and the file already uses them.
- Add succinct code comments that explain what is going on if code is not self-explanatory.
- Try to use apply_patch for single file edits, but it is fine to explore other options to make the edit if it does not work well.
- You may be in a dirty git worktree.
    * NEVER revert existing changes you did not make unless explicitly requested.
    * If asked to make a commit or code edits and there are unrelated changes to your work, don't revert those changes.
- Do not amend a commit unless explicitly requested to do so.

## Presenting your work and final message

- Default: be very concise; friendly coding teammate tone.
- Ask only when needed; suggest ideas; mirror the user's style.
- For substantial work, summarize clearly.
- Skip heavy formatting for simple confirmations.
- Don't dump large files you've written; reference paths only.
- For code changes:
  * Lead with a quick explanation of the change, and then give more details on the context.
  * If there are natural next steps the user may want to take, suggest them at the end.`;
/**
 * Codex Executor — talks to ChatGPT backend Responses API.
 * Ported from 9router open-sse/executors/codex.js (simplified for SRouter).
 */
export class CodexExecutor {
    id;
    name;
    category = "oauth";
    protocol = "openai";
    baseUrl;
    modelsUrl;
    apiKey;
    accessToken;
    refreshToken;
    accountId;
    sessionId;
    _currentSessionId = null;
    stealth;
    constructor(options = {}) {
        this.id = options.id ?? "openai_codex";
        this.name = options.name ?? "OpenAI Codex / ChatGPT";
        this.baseUrl = (options.baseUrl ?? process.env.CODEX_BASE_URL ?? CODEX_BASE_URL).replace(/\/$/, "");
        this.modelsUrl = (process.env.CODEX_MODELS_URL ?? CODEX_MODELS_URL).replace(/\/$/, "");
        this.apiKey = options.apiKey ?? process.env.CODEX_API_KEY ?? "";
        this.accessToken = options.accessToken ?? process.env.CODEX_ACCESS_TOKEN ?? "";
        this.refreshToken = options.refreshToken;
        this.accountId = options.accountId;
        this.sessionId = options.sessionId;
        this.stealth = options.stealth;
    }
    /**
     * Update tokens after a refresh — called by TokenRefreshService.
     */
    updateToken(accessToken, refreshToken) {
        if (accessToken)
            this.accessToken = accessToken;
        if (refreshToken)
            this.refreshToken = refreshToken;
    }
    getHeaders(extra) {
        const headers = applyStealth({
            "Content-Type": "application/json",
            originator: "codex_cli_rs",
            "User-Agent": `codex_cli_rs/${CODEX_CLIENT_VERSION}`,
            session_id: this.sessionId || this._currentSessionId || this.id || "default"
        }, this.stealth);
        const token = this.accessToken || this.apiKey;
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }
        if (this.accountId) {
            headers["ChatGPT-Account-ID"] = this.accountId;
        }
        if (extra) {
            Object.assign(headers, extra);
        }
        return headers;
    }
    async listModels() {
        const token = this.accessToken || this.apiKey;
        if (!token)
            return [];
        try {
            // client_version query param is REQUIRED — without it the endpoint returns 400
            const url = new URL(this.modelsUrl);
            url.searchParams.set("client_version", CODEX_CLIENT_VERSION);
            const res = await fetch(url.toString(), {
                method: "GET",
                headers: this.getHeaders({ Accept: "application/json" })
            });
            if (!res.ok)
                return [];
            const json = (await res.json());
            const rawModels = Array.isArray(json.data)
                ? json.data
                : Array.isArray(json.models)
                    ? json.models
                    : [];
            return rawModels
                .map((m) => ({
                id: m.slug || m.id || "",
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "openai"
            }))
                .filter((m) => m.id.length > 0);
        }
        catch {
            return [];
        }
    }
    async chatCompletion(req, budget) {
        // Codex upstream is streaming-only — accumulate the stream for non-streaming callers
        const chunks = [];
        for await (const chunk of this.chatCompletionStream(req, budget)) {
            chunks.push(chunk);
        }
        return accumulateChunks(chunks, req.model);
    }
    async *chatCompletionStream(req, budget) {
        const body = this.transformRequest(req);
        this._currentSessionId = this.sessionId || body.prompt_cache_key || null;
        const retryDelayMs = 3000;
        let attempt = 0;
        const maxAttempts = 2;
        while (true) {
            const res = await FetchWithBudget(this.baseUrl, {
                method: "POST",
                headers: this.getHeaders(),
                body: JSON.stringify(body)
            }, budget);
            // Non-OK — surface error immediately
            if (!res.ok) {
                const errorText = await res.text();
                // Parse usage_limit_reached for resetsAtMs (port of 9router parseError)
                const parsed = this.parseError(res.status, errorText);
                if (parsed) {
                    throw new Error(`Codex Provider Error (${res.status}): ${parsed.message}`);
                }
                throw new Error(`Codex Provider Error (${res.status}): ${errorText}`);
            }
            if (!res.body) {
                throw new Error("No response body received for streaming");
            }
            // Peek first bytes for transient SSE errors (200-OK body may contain error events)
            const peek = await this.peekSseTransientError(res);
            if (!peek.matched) {
                // Re-assemble stream from peeked chunks + rest
                if (peek.replacementBody) {
                    yield* this.streamResponses(peek.replacementBody, req.model);
                }
                else {
                    yield* this.streamResponses(res.body, req.model);
                }
                return;
            }
            if (peek.accountFallback) {
                throw new Error(`Codex Provider Error (503): ${peek.message || MODEL_CAPACITY_MESSAGE}`);
            }
            if (attempt >= maxAttempts) {
                throw new Error(`Codex Provider Error (503): ${peek.message || peek.matched}`);
            }
            attempt++;
            await new Promise((r) => setTimeout(r, retryDelayMs));
        }
    }
    /**
     * Transform ChatCompletionRequest → Responses API body (port of 9router transformRequest).
     */
    transformRequest(req) {
        let body = ChatToResponsesBody(req);
        const targetModel = req.model.includes("/")
            ? (req.model.split("/")[1] ?? req.model)
            : req.model;
        // model: strip suffix thinking levels (e.g. gpt-5.3-codex-high → gpt-5.3-codex)
        const effortLevels = ["none", "minimal", "low", "medium", "high", "xhigh"];
        let modelEffort = null;
        let model = targetModel;
        for (const level of effortLevels) {
            if (model.endsWith(`-${level}`)) {
                modelEffort = level;
                model = model.replace(`-${level}`, "");
                break;
            }
        }
        body.model = model;
        body.stream = true;
        body.store = false;
        // Ensure input present (Codex rejects empty)
        const normalized = NormalizeResponsesInput(body.input);
        if (normalized)
            body.input = normalized;
        // Inject default instructions
        if (!body.instructions || body.instructions.trim() === "") {
            body.instructions = CODEX_DEFAULT_INSTRUCTIONS;
        }
        // Reasoning effort — priority: explicit reasoning > model suffix > default (low)
        const reasoningEffort = req.reasoning_effort || req.reasoning?.effort;
        if (!body.reasoning) {
            const effort = NormalizeReasoningEffort(reasoningEffort || modelEffort || "low");
            body.reasoning = { effort, summary: "auto" };
        }
        else {
            body.reasoning.effort = NormalizeReasoningEffort(body.reasoning.effort);
            if (!body.reasoning.summary)
                body.reasoning.summary = "auto";
        }
        // Include reasoning encrypted content (required by Codex backend for reasoning models)
        if (body.reasoning && body.reasoning.effort && body.reasoning.effort !== "none") {
            body.include = ["reasoning.encrypted_content"];
        }
        // Remove unsupported params
        delete body.temperature;
        delete body.top_p;
        delete body.frequency_penalty;
        delete body.presence_penalty;
        delete body.logprobs;
        delete body.top_logprobs;
        delete body.n;
        delete body.seed;
        delete body.max_tokens;
        delete body.max_completion_tokens;
        delete body.max_output_tokens;
        delete body.user;
        delete body.prompt_cache_retention;
        delete body.metadata;
        delete body.stream_options;
        delete body.safety_identifier;
        delete body.previous_response_id;
        if (body.service_tier === "fast")
            body.service_tier = "priority";
        if (body.service_tier && body.service_tier !== "priority")
            delete body.service_tier;
        // Final allowlist filter
        const ALLOWLIST = new Set([
            "model",
            "input",
            "instructions",
            "tools",
            "tool_choice",
            "stream",
            "store",
            "reasoning",
            "service_tier",
            "include",
            "prompt_cache_key",
            "client_metadata",
            "text"
        ]);
        for (const k of Object.keys(body)) {
            if (!ALLOWLIST.has(k))
                delete body[k];
        }
        return body;
    }
    /**
     * Peek first N bytes of SSE body to detect transient upstream errors.
     * Returns { matched, message, accountFallback, replacementBody }.
     */
    async peekSseTransientError(response) {
        if (!response || !response.ok || !response.body) {
            return { matched: null, message: null, accountFallback: false, replacementBody: null };
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const chunks = [];
        let text = "";
        let matched = null;
        let accountFallback = false;
        try {
            while (text.length < SSE_PEEK_BYTES) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                chunks.push(value);
                text += decoder.decode(value, { stream: true });
                const lowerText = text.toLowerCase();
                const accountHit = SSE_ACCOUNT_FALLBACK_PATTERNS.find((p) => lowerText.includes(p));
                if (accountHit) {
                    matched = accountHit;
                    accountFallback = true;
                    break;
                }
                const retryHit = SSE_RETRY_PATTERNS.find((p) => lowerText.includes(p));
                if (retryHit) {
                    matched = retryHit;
                    break;
                }
                if (SSE_USER_OUTPUT_PATTERNS.some((p) => lowerText.includes(p)))
                    break;
            }
        }
        catch {
            // fall through
        }
        if (matched) {
            try {
                await reader.cancel();
            }
            catch {
                /* noop */
            }
            try {
                reader.releaseLock();
            }
            catch {
                /* noop */
            }
            return {
                matched,
                message: extractSseErrorMessage(text, matched),
                accountFallback,
                replacementBody: null
            };
        }
        reader.releaseLock();
        // Re-assemble stream: prefix chunks + remaining upstream body
        const upstream = response.body;
        let upstreamReader = null;
        const replacementBody = new ReadableStream({
            start(controller) {
                for (const c of chunks)
                    controller.enqueue(c);
                upstreamReader = upstream.getReader();
            },
            async pull(controller) {
                if (!upstreamReader) {
                    controller.close();
                    return;
                }
                try {
                    const { done, value } = await upstreamReader.read();
                    if (done) {
                        controller.close();
                        return;
                    }
                    controller.enqueue(value);
                }
                catch (e) {
                    controller.error(e);
                }
            },
            cancel(reason) {
                try {
                    void upstreamReader?.cancel(reason);
                }
                catch {
                    /* noop */
                }
            }
        });
        return { matched: null, message: null, accountFallback: false, replacementBody };
    }
    /**
     * Parse 429 usage_limit_reached for precise resetsAtMs.
     */
    parseError(status, bodyText) {
        if (status === 429 && bodyText) {
            try {
                const json = JSON.parse(bodyText);
                const err = json?.error;
                if (err?.type === "usage_limit_reached") {
                    const now = Date.now();
                    let resetsAtMs = null;
                    if (typeof err.resets_at === "number" && err.resets_at > 0) {
                        const ms = err.resets_at * 1000;
                        if (ms > now)
                            resetsAtMs = ms;
                    }
                    if (!resetsAtMs &&
                        typeof err.resets_in_seconds === "number" &&
                        err.resets_in_seconds > 0) {
                        resetsAtMs = now + err.resets_in_seconds * 1000;
                    }
                    if (resetsAtMs) {
                        return { status: 429, message: err.message || bodyText, resetsAtMs };
                    }
                }
            }
            catch {
                /* fall through */
            }
        }
        return null;
    }
    /**
     * Stream a Responses API SSE body, converting each event to a ChatCompletionChunk.
     */
    async *streamResponses(body, requestedModel) {
        const state = CreateResponsesStreamState(requestedModel);
        let pendingEvent = "";
        for await (const line of streamLines(body)) {
            // Handle both "data: {...}" and "event: ..." framing
            if (line.startsWith("data:")) {
                const jsonStr = parseDataLine(line);
                if (jsonStr === null)
                    continue;
                try {
                    const parsed = JSON.parse(jsonStr);
                    const eventType = parsed.type || pendingEvent || "response.output_text.delta";
                    const chunk = ResponsesEventToChunk(eventType, parsed, state);
                    if (chunk)
                        yield chunk;
                }
                catch {
                    // ignore malformed JSON
                }
            }
            else if (line.startsWith("event:")) {
                pendingEvent = line.slice(6).trim();
            }
            else {
                // Raw JSON line (no data: prefix)
                try {
                    const parsed = JSON.parse(line);
                    const eventType = parsed.type || pendingEvent || "response.output_text.delta";
                    const chunk = ResponsesEventToChunk(eventType, parsed, state);
                    if (chunk)
                        yield chunk;
                }
                catch {
                    // ignore
                }
            }
        }
    }
}

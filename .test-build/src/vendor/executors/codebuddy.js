import { CODEBUDDY_BASE_URL, CODEBUDDY_MODELS } from "../constants.js";
import { accumulateChunks } from "../translator/index.js";
import { parseDataLine, streamLines } from "./base.js";
import { FetchWithBudget } from "./retry.js";
import { applyStealth } from "../../providers/fingerprints.js";
function stripProviderPrefix(model) {
    const slash = model.indexOf("/");
    return slash >= 0 ? model.slice(slash + 1) : model;
}
export class CodeBuddyExecutor {
    id;
    name;
    baseUrl;
    apiKey;
    accessToken;
    modelPrefix;
    domain;
    userAgent;
    flavor;
    stealth;
    constructor(options = {}) {
        this.id = options.id ?? "codebuddy";
        this.name = options.name ?? "CodeBuddy Provider";
        this.baseUrl = (options.baseUrl ?? CODEBUDDY_BASE_URL).replace(/\/$/, "");
        this.apiKey = options.apiKey ?? "";
        this.accessToken = options.accessToken ?? "";
        this.modelPrefix = options.modelPrefix ?? this.id.split("_")[0]?.split("-")[0] ?? this.id;
        this.domain = options.domain;
        this.userAgent = options.userAgent ?? "IDE/2.108.1 CodeBuddy/2.108.1";
        this.flavor = options.flavor ?? "ide";
        this.stealth = options.stealth;
    }
    updateToken(accessToken) {
        if (accessToken)
            this.accessToken = accessToken;
    }
    getHeaders() {
        const ideName = this.flavor === "cli" ? "CLI" : "IDE";
        const headers = applyStealth({
            "Content-Type": "application/json",
            "User-Agent": this.userAgent,
            "X-Product": "SaaS",
            "X-IDE-Type": ideName,
            "X-IDE-Name": ideName,
            "x-requested-with": "XMLHttpRequest",
            "x-codebuddy-request": "1",
            ...(this.domain ? { "X-Domain": this.domain } : {})
        }, this.stealth);
        const token = this.accessToken || this.apiKey;
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }
        return headers;
    }
    getChatUrl() {
        if (this.baseUrl.endsWith("/chat/completions")) {
            return this.baseUrl;
        }
        if (this.baseUrl.endsWith("/v2")) {
            return `${this.baseUrl}/chat/completions`;
        }
        return `${this.baseUrl}/v2/chat/completions`;
    }
    transformRequestBody(req) {
        const targetModel = stripProviderPrefix(req.model);
        const transformed = {
            ...req,
            model: targetModel,
            stream: true // CodeBuddy requires stream: true
        };
        // Handle reasoning effort
        const eff = req.reasoning_effort;
        if (eff === "none" || eff === "off") {
            delete transformed.reasoning_effort;
        }
        else if (eff) {
            transformed.reasoning_summary = "auto";
        }
        // CodeBuddy requires a leading system prompt and typed blocks for user content.
        // If the caller provided their own system/developer prompt, preserve it alongside CodeBuddy's identity.
        const source = Array.isArray(req.messages) ? req.messages : [];
        const systemPrompts = [];
        for (const m of source) {
            if (m &&
                typeof m === "object" &&
                ["system", "developer"].includes(m.role ?? "")) {
                const content = m.content;
                if (typeof content === "string" && content.trim()) {
                    systemPrompts.push(content.trim());
                }
            }
        }
        const combinedSystem = systemPrompts.length > 0
            ? `You are CodeBuddy Code.\n\n${systemPrompts.join("\n\n")}`
            : "You are CodeBuddy Code.";
        const messages = [{ role: "system", content: combinedSystem }];
        for (const message of source) {
            if (!message ||
                typeof message !== "object" ||
                ["system", "developer"].includes(message.role ?? "")) {
                continue;
            }
            if (message.role === "user" &&
                typeof message.content === "string") {
                messages.push({
                    ...message,
                    content: [{ type: "text", text: message.content }]
                });
            }
            else {
                messages.push({ ...message });
            }
        }
        transformed.messages = messages;
        // CodeBuddy upstream is stream-only and ignores/breaks on response_format
        // (models answer in prose when it is present, even with the schema in the
        // user turn — verified empirically). So: drop response_format entirely and
        // mirror the schema/directive into the last user text instead, which is the
        // only lever these models actually follow.
        const rf = req.response_format;
        if (rf?.type === "json_schema" || rf?.type === "json_object") {
            delete transformed.response_format;
            let directive = rf.type === "json_object" ? "Respond only in valid JSON." : "";
            if (rf.type === "json_schema") {
                const schemaObj = rf.json_schema?.schema ?? rf.json_schema;
                if (schemaObj) {
                    directive =
                        `You must respond with valid JSON matching this schema:\n` +
                            JSON.stringify(schemaObj, null, 2);
                }
            }
            if (directive) {
                for (let i = messages.length - 1; i >= 0; i--) {
                    const content = messages[i].content;
                    if (messages[i].role !== "user")
                        continue;
                    if (Array.isArray(content)) {
                        const parts = content;
                        for (let j = parts.length - 1; j >= 0; j--) {
                            if (parts[j]?.type === "text" && typeof parts[j].text === "string") {
                                parts[j] = {
                                    type: "text",
                                    text: `${parts[j].text}\n\n${directive}`
                                };
                                break;
                            }
                        }
                    }
                    else if (typeof content === "string") {
                        messages[i].content = `${content}\n\n${directive}`;
                    }
                    break;
                }
            }
        }
        return transformed;
    }
    async listModels() {
        return CODEBUDDY_MODELS.map((m) => ({
            id: `${this.modelPrefix}/${m.id}`,
            object: "model",
            owned_by: this.modelPrefix
        }));
    }
    async chatCompletion(req, budget) {
        // CodeBuddy upstream is stream-only (forceStream). Run the stream and
        // accumulate the final response for non-streaming callers.
        const chunks = [];
        for await (const chunk of this.chatCompletionStream(req, budget)) {
            chunks.push(chunk);
        }
        return accumulateChunks(chunks, req.model);
    }
    async *chatCompletionStream(req, budget) {
        const body = this.transformRequestBody(req);
        const res = await FetchWithBudget(this.getChatUrl(), {
            method: "POST",
            headers: this.getHeaders(),
            body: JSON.stringify(body)
        }, budget);
        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`CodeBuddy Provider Error (${res.status}): ${errorText}`);
        }
        if (!res.body) {
            throw new Error("No response body received for streaming");
        }
        for await (const line of streamLines(res.body)) {
            const jsonStr = parseDataLine(line);
            if (jsonStr === null)
                continue;
            try {
                const parsed = JSON.parse(jsonStr);
                yield parsed;
            }
            catch {
                // ignore malformed chunk
            }
        }
    }
}

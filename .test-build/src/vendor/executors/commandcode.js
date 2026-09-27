import { randomUUID } from "node:crypto";
import { COMMANDCODE_BASE_URL, COMMANDCODE_MODELS_URL } from "../constants.js";
import { accumulateChunks, buildRequestBody, commandCodeEventToOpenAIChunk, createCommandCodeStreamState } from "../translator/index.js";
import { parseDataLine, streamLines } from "./base.js";
import { FetchWithBudget } from "./retry.js";
export class CommandCodeExecutor {
    id;
    name;
    baseUrl;
    apiKey;
    accessToken;
    constructor(options = {}) {
        this.id = options.id ?? "commandcode";
        this.name = options.name ?? "Command Code Provider";
        this.baseUrl = (options.baseUrl ?? COMMANDCODE_BASE_URL).replace(/\/$/, "");
        this.apiKey = options.apiKey ?? "";
        this.accessToken = options.accessToken ?? "";
    }
    getHeaders() {
        const headers = {
            "Content-Type": "application/json",
            "x-command-code-version": "0.25.7",
            "x-cli-environment": "cli",
            "x-session-id": randomUUID()
        };
        const token = this.accessToken || this.apiKey;
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }
        return headers;
    }
    getModelsUrl() {
        if (this.baseUrl === COMMANDCODE_BASE_URL ||
            this.baseUrl.startsWith("https://api.commandcode.ai")) {
            return COMMANDCODE_MODELS_URL;
        }
        if (this.baseUrl.endsWith("/alpha/generate")) {
            return this.baseUrl.replace(/\/alpha\/generate$/, "/provider/v1/models");
        }
        return `${this.baseUrl}/models`;
    }
    async listModels() {
        try {
            const res = await fetch(this.getModelsUrl(), {
                method: "GET",
                headers: this.getHeaders()
            });
            if (!res.ok) {
                return [];
            }
            const data = (await res.json());
            if (!data.data || !Array.isArray(data.data)) {
                return [];
            }
            const baseId = this.id.split("_")[0]?.split("-")[0] ?? this.id;
            return data.data.map((m) => ({
                id: `${baseId}/${m.id}`,
                object: "model",
                owned_by: baseId
            }));
        }
        catch {
            return [];
        }
    }
    async chatCompletion(req, budget) {
        // CommandCode upstream is streaming-only (forceStream). Run the stream and
        // accumulate the final response for non-streaming callers.
        const chunks = [];
        for await (const chunk of this.chatCompletionStream(req, budget)) {
            chunks.push(chunk);
        }
        return accumulateChunks(chunks, req.model);
    }
    async *chatCompletionStream(req, budget) {
        const body = buildRequestBody(req);
        const res = await FetchWithBudget(this.baseUrl, {
            method: "POST",
            headers: this.getHeaders(),
            body: JSON.stringify(body)
        }, budget);
        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`CommandCode Provider Error (${res.status}): ${errorText}`);
        }
        if (!res.body) {
            throw new Error("No response body received for streaming");
        }
        const state = createCommandCodeStreamState();
        for await (const line of streamLines(res.body)) {
            const jsonStr = parseDataLine(line);
            if (jsonStr === null)
                continue;
            let event;
            try {
                event = JSON.parse(jsonStr);
            }
            catch {
                continue;
            }
            for (const chunk of commandCodeEventToOpenAIChunk(event, state)) {
                yield chunk;
            }
        }
    }
}

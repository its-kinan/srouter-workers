import { CLINE_BASE_URL } from "../constants.js";
import { DescribeErrorPayload } from "./base.js";
import { OpenAIExecutor } from "./openai.js";
function IsClineEnvelope(payload) {
    if (typeof payload !== "object" || payload === null)
        return false;
    const candidate = payload;
    return "success" in candidate && typeof candidate.success === "boolean";
}
/**
 * The hosted Cline API answers non-streaming requests with a `{ data, success }`
 * envelope (`{"data":{"choices":[...]},"success":true}`) while its SSE frames
 * stay unwrapped. Every consumer downstream — the chat route, the Anthropic
 * `/v1/messages` translator, usage accounting — expects the bare OpenAI payload,
 * so unwrap the envelope here.
 */
export function UnwrapClineEnvelope(payload) {
    if (!IsClineEnvelope(payload))
        return payload;
    if (payload.success)
        return payload.data;
    throw new Error(`Cline Provider Error: ${DescribeErrorPayload(payload.error ?? payload.data)}`);
}
export class ClineExecutor extends OpenAIExecutor {
    constructor(options = {}) {
        super({
            ...options,
            id: options.id ?? "cline",
            name: options.name ?? "Cline",
            alias: options.alias ?? "cline",
            baseUrl: options.baseUrl ?? CLINE_BASE_URL,
            additionalHeaders: {
                "User-Agent": "Cline/3.0.62",
                "HTTP-Referer": "https://cline.bot",
                "X-Title": "Cline",
                "X-IS-MULTIROOT": "false",
                "X-CLIENT-TYPE": "cline-sdk",
                "X-CLIENT-VERSION": "3.0.62",
                "X-PLATFORM": "cli",
                "X-PLATFORM-VERSION": "3.0.62",
                "X-CORE-VERSION": "0.0.83",
                // Workers runtime provides the WebCrypto global; no node:crypto import needed.
                "X-Task-ID": crypto.randomUUID()
            }
        });
    }
    async listModels() {
        const headers = this.getHeaders();
        const [modelsResponse, recommendedResponse] = await Promise.all([
            fetch(`${CLINE_BASE_URL}/models`, { method: "GET", headers }),
            fetch(`${CLINE_BASE_URL}/ai/cline/recommended-models`, {
                method: "GET",
                headers
            })
        ]);
        const modelIds = new Set();
        if (modelsResponse.ok) {
            const payload = (await modelsResponse.json());
            if (Array.isArray(payload.data)) {
                for (const model of payload.data)
                    modelIds.add(model.id);
            }
        }
        if (recommendedResponse.ok) {
            const payload = (await recommendedResponse.json());
            for (const model of payload.free ?? []) {
                if (model.id)
                    modelIds.add(model.id);
            }
        }
        return Array.from(modelIds, (id) => ({
            id: `cline/${id}`,
            object: "model",
            owned_by: "cline"
        }));
    }
    NormalizeResponsePayload(payload) {
        return UnwrapClineEnvelope(payload);
    }
}

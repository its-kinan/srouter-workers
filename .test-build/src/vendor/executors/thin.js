// Thin provider executors ported 1:1 from @srouter/executors.
// Atria, B.AI, OpenCode Zen, TokenRouter, Experiential Labs, MiniMax,
// Neosantara — OpenAI-compatible with custom listModels.
import { OpenAIExecutor } from "./openai.js";
export class AtriaExecutor extends OpenAIExecutor {
    constructor(options = {}) {
        super({
            id: options.id ?? "atria",
            name: options.name ?? "Atria",
            alias: options.alias ?? "atria",
            baseUrl: options.baseUrl ?? "https://api.atria-asi.ai/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken
        });
    }
    async listModels() {
        return [{ id: "atria/Atria-Dawn-Preview", object: "model", owned_by: "atria" }];
    }
}
// ---------------------------------------------------------------------------
// B.AI
// ---------------------------------------------------------------------------
const BAI_DEFAULT_MODELS = [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (Free)" },
    { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision Exp (Free)" },
    { id: "mimo-v2.5", name: "MiMo V2.5 (Free)" },
    { id: "qwen3.8-flash", name: "Qwen 3.8 Flash (Free/Low-tier)" }
];
export class BAIExecutor extends OpenAIExecutor {
    constructor(options = {}) {
        super({
            id: options.id ?? "bai",
            name: options.name ?? "B.AI",
            baseUrl: options.baseUrl ?? "https://api.b.ai/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken
        });
    }
    async listModels() {
        const liveModels = await super.listModels();
        if (liveModels && liveModels.length > 0) {
            return liveModels;
        }
        const baseId = this.id.split("_")[0]?.split("-")[0] ?? this.id;
        return BAI_DEFAULT_MODELS.map((m) => ({
            id: `${baseId}/${m.id}`,
            object: "model",
            owned_by: baseId
        }));
    }
}
// ---------------------------------------------------------------------------
// OpenCode Zen
// ---------------------------------------------------------------------------
export const OPENCODE_ZEN_MODELS = [
    { id: "big-pickle", name: "Big Pickle (Free)" },
    { id: "laguna-s-2.1-free", name: "Poolside Laguna S 2.1 (Free)" },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning (Free)" },
    { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra (Free)" },
    { id: "mimo-v2.5-free", name: "Xiaomi MiMo V2.5 (Free)" }
];
export class OpenCodeZenExecutor extends OpenAIExecutor {
    constructor(options = {}) {
        super({
            id: options.id ?? "opencode_zen",
            name: options.name ?? "OpenCode Zen (Free)",
            baseUrl: options.baseUrl ?? "https://opencode.ai/zen/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken ?? ""
        });
    }
    async listModels() {
        const baseId = this.id.split("_")[0]?.split("-")[0] ?? this.id;
        return OPENCODE_ZEN_MODELS.map((m) => ({
            id: `${baseId}/${m.id}`,
            object: "model",
            owned_by: baseId
        }));
    }
}
export class TokenRouterExecutor extends OpenAIExecutor {
    constructor(options = {}) {
        super({
            id: options.id ?? "tokenrouter",
            name: options.name ?? "TokenRouter",
            baseUrl: options.baseUrl ?? "https://api.tokenrouter.com/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken
        });
    }
}
export class ExperientialLabsExecutor extends OpenAIExecutor {
    constructor(options = {}) {
        super({
            id: options.id ?? "experientiallabs",
            name: options.name ?? "Experiential Labs",
            baseUrl: options.baseUrl ?? "https://api.experientiallabs.ai/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken
        });
    }
}
export class MiniMaxExecutor extends OpenAIExecutor {
    constructor(options = {}) {
        super({
            id: options.id ?? "minimax",
            name: options.name ?? "MiniMax",
            baseUrl: options.baseUrl ?? "https://api.minimax.io/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken
        });
    }
}
export class NeosantaraExecutor extends OpenAIExecutor {
    constructor(options = {}) {
        super({
            id: options.id ?? "neosantara",
            name: options.name ?? "Neosantara",
            baseUrl: options.baseUrl ?? "https://api.neosantara.xyz/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken
        });
    }
}
export class TokenHarborExecutor extends OpenAIExecutor {
    constructor(options = {}) {
        super({
            id: options.id ?? "tokenharbor",
            name: options.name ?? "TokenHarbor",
            baseUrl: options.baseUrl ?? "https://tokenharbor.ai/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken
        });
    }
}
export class TabiTokenExecutor extends OpenAIExecutor {
    constructor(options = {}) {
        super({
            id: options.id ?? "tabitoken",
            name: options.name ?? "TabiToken",
            baseUrl: options.baseUrl ?? "https://tabitoken.com/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken
        });
    }
}
export class GoRouterExecutor extends OpenAIExecutor {
    constructor(options = {}) {
        super({
            id: options.id ?? "gorouter",
            name: options.name ?? "GoRouter",
            baseUrl: options.baseUrl ?? "https://gorouter.app/v1/",
            apiKey: options.apiKey,
            accessToken: options.accessToken
        });
    }
}
export class OrcaRouterExecutor extends OpenAIExecutor {
    constructor(options = {}) {
        super({
            id: options.id ?? "orcarouter",
            name: options.name ?? "OrcaRouter",
            baseUrl: options.baseUrl ?? "https://api.orcarouter.ai/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken
        });
    }
}
export class GMICloudExecutor extends OpenAIExecutor {
    constructor(options = {}) {
        super({
            id: options.id ?? "gmicloud",
            name: options.name ?? "GMICloud",
            baseUrl: options.baseUrl ?? "https://api.gmi-serving.com/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken
        });
    }
}
export class GensparkExecutor extends OpenAIExecutor {
    constructor(options = {}) {
        super({
            id: options.id ?? "genspark",
            name: options.name ?? "Genspark",
            baseUrl: options.baseUrl ?? "https://www.genspark.ai/api/llm_proxy/v1",
            apiKey: options.apiKey,
            accessToken: options.accessToken
        });
    }
}

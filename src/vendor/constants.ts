// Vendored from @srouter/constants (its-kinan/SRouter). OAuth app secrets omitted
// (OAuth login flows are a later phase); only runtime endpoint/model constants.

export const QODER_OPENAPI_BASE = "https://openapi.qoder.sh";
export const ANTIGRAVITY_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const ANTIGRAVITY_IDE_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
export const QODER_CHAT_BASE = "https://api3.qoder.sh";
export const QODER_CHAT_BASE_ALT = "https://api2.qoder.sh";
export const QODER_CHAT_SIG_PATH = "/api/v2/service/pro/sse/agent_chat_generation";
export const QODER_CLIENT_TYPE = "5";
export const QODER_DATA_POLICY = "disagree";
export const QODER_IDE_VERSION = "1.0.0";
export const QODER_JOB_TOKEN_EXCHANGE_URL = `${QODER_OPENAPI_BASE}/api/v1/jobToken/exchange`;
export const QODER_LOGIN_VERSION = "v2";
export const QODER_MACHINE_OS = "x86_64_windows";
export const QODER_MACHINE_TYPE = "5";
export const QODER_USERINFO_URL = `${QODER_OPENAPI_BASE}/api/v1/userinfo`;
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
export const COMMANDCODE_BASE_URL = "https://api.commandcode.ai/alpha/generate";
export const COMMANDCODE_MODELS_URL = "https://api.commandcode.ai/provider/v1/models";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

export const ANTIGRAVITY_MODELS: { id: string; name: string }[] = [
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
    { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
    { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)" },
    { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)" },
    { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)" },
    { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)" },
    { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)" },
    { id: "gemini-3.5-flash-high", name: "Gemini 3.5 Flash (High)" },
    { id: "gemini-3.5-flash-medium", name: "Gemini 3.5 Flash (Medium)" },
    { id: "gemini-3.5-flash-low", name: "Gemini 3.5 Flash (Low)" },
    { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
    { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
    { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" }
];

export const QODER_MODELS: { id: string; name: string; level?: string }[] = [
    { id: "qwen3.8-max-preview", name: "Qwen 3.8 Max Preview", level: "qmodel_preview" },
    { id: "qwen3.7-max", name: "Qwen 3.7 Max", level: "qmodel_latest" },
    { id: "qwen3.7-plus", name: "Qwen 3.7 Plus", level: "qmodel" },
    { id: "kimi-k3", name: "Kimi K3", level: "kmodel_latest" },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", level: "kmodel" },
    { id: "glm-5.2", name: "GLM 5.2", level: "gm51model" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", level: "dmodel" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", level: "dfmodel" },
    { id: "minimax-m3", name: "MiniMax M3", level: "mmodel" },
    { id: "ultimate", name: "Qoder Ultimate" },
    { id: "qmodel_38max", name: "Qwen 3.8 Max" },
    { id: "qmodel_preview", name: "Qwen Preview" },
    { id: "qmodel_latest", name: "Qwen Latest" },
    { id: "qmodel", name: "Qwen Standard" },
    { id: "auto", name: "Qoder Auto" },
    { id: "performance", name: "Qoder Performance" },
    { id: "efficient", name: "Qoder Efficient" },
    { id: "lite", name: "Qoder Lite" },
    { id: "kmodel_latest", name: "Kimi K3 (Raw)" },
    { id: "kmodel", name: "Kimi K2.7 (Raw)" },
    { id: "gmodel", name: "GLM (Raw)" },
    { id: "gm51model", name: "GLM 5.2 (Raw)" },
    { id: "dmodel", name: "DeepSeek Pro (Raw)" },
    { id: "dfmodel", name: "DeepSeek Flash (Raw)" },
    { id: "mmodel", name: "MiniMax (Raw)" }
];

export const QODER_MODEL_ALIASES: Record<string, string> = {
    "qwen3.8-max-preview": "qmodel_preview",
    "qwen-3.8-max-preview": "qmodel_preview",
    "qwen3.8-max": "qmodel_38max",
    "qwen-3.8-max": "qmodel_38max",
    "qwen3.7-max": "qmodel_latest",
    "qwen-3.7-max": "qmodel_latest",
    "qwen3.7-plus": "qmodel",
    "qwen-3.7-plus": "qmodel",
    "kimi-k3": "kmodel_latest",
    "kimi-k2.7-code": "kmodel",
    "glm-5.2": "gm51model",
    "deepseek-v4-pro": "dmodel",
    "deepseek-v4-flash": "dfmodel",
    "minimax-m3": "mmodel",
    ultimate: "ultimate",
    auto: "auto",
    performance: "performance",
    efficient: "efficient",
    lite: "lite"
};

export const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

export const ANTIGRAVITY_IDE_VERSION = "2.1.1";
export const ANTIGRAVITY_IDE_USER_AGENT = `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} darwin/arm64`;

// Image generation types (shape mirrors @srouter/types schemas/images.ts;
// runtime validation schemas arrive with the images endpoint in a later phase).
export interface ImageGenerationRequest {
    prompt: string;
    model?: string;
    image?: string | string[];
    images?: string[];
    mask?: string;
    n?: number;
    quality?: "standard" | "hd" | "low" | "medium" | "high" | "auto";
    response_format?: "url" | "b64_json";
    size?: string;
    style?: "vivid" | "natural";
    user?: string;
    partial_images?: number;
}

export interface ImageGenerationItem {
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
}

export interface ImageGenerationUsage {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
}

export interface ImageGenerationResponse {
    created: number;
    data: ImageGenerationItem[];
    usage?: ImageGenerationUsage;
}

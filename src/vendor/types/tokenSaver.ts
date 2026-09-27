
export interface CompressToolOutputSettings {
    compressGit: boolean;
    compressGrep: boolean;
    compressFileLists: boolean;
    compressLogs: boolean;
    stripAnsiAndWhitespace: boolean;
    minCharacterThreshold: number;
}

export interface LazySeniorDevSettings {
    mode: "balanced" | "strict";
    customInstructions?: string;
}

export interface CompressLlmOutputSettings {
    mode: "terse" | "ultra_terse";
    stripPleasantries: boolean;
    customPrompt?: string;
}

export interface TokenSaverSettings {
    compressToolOutput: CompressToolOutputSettings;
    lazySeniorDev: LazySeniorDevSettings;
    compressLlmOutput: CompressLlmOutputSettings;
}

export const DEFAULT_TOKEN_SAVER_SETTINGS: TokenSaverSettings = {
    compressToolOutput: {
        compressGit: true,
        compressGrep: true,
        compressFileLists: true,
        compressLogs: true,
        stripAnsiAndWhitespace: true,
        minCharacterThreshold: 50
    },
    lazySeniorDev: { mode: "balanced" },
    compressLlmOutput: { mode: "terse", stripPleasantries: true }
};

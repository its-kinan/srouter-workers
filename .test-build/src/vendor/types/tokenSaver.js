export const DEFAULT_TOKEN_SAVER_SETTINGS = {
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

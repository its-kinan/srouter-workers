// Provider adapter contracts for the Workers port.
//
// The vendored SRouter executors already implement the AIProvider shape
// (listModels / chatCompletion / chatCompletionStream). This module defines
// the decrypted account record handed to them and the factory table that maps
// a provider type to its executor.
export function asAdapter(executor, adapterId) {
    return {
        adapterId,
        listModels: () => executor.listModels(),
        chatCompletion: (req, budget) => executor.chatCompletion(req, budget),
        chatCompletionStream: (req, budget) => executor.chatCompletionStream(req, budget),
        generateImage: executor.generateImage
            ? (req, budget) => executor.generateImage(req, budget)
            : undefined
    };
}
/** Routing prefixes for a provider type: "<type>/" and "<alias>/" model prefixes. */
export function routingPrefixes(providerType, alias) {
    const prefixes = [providerType];
    if (alias && alias !== providerType)
        prefixes.push(alias);
    return prefixes;
}

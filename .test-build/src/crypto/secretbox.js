// AES-GCM credential encryption (WebCrypto).
// Provider secrets are encrypted with the MASTER_KEY Worker secret before
// being stored in D1. Envelope format stored in DB TEXT columns:
//   {"v":1,"iv":"<base64>","ct":"<base64>"}
// SRouter stored these values plaintext; the port must not.
function b64encode(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++)
        s += String.fromCharCode(bytes[i]);
    return btoa(s);
}
function b64decode(b64) {
    const s = atob(b64);
    const out = new Uint8Array(new ArrayBuffer(s.length));
    for (let i = 0; i < s.length; i++)
        out[i] = s.charCodeAt(i);
    return out;
}
/**
 * Module-level import cache: importing a CryptoKey costs a base64 decode +
 * a subtle.importKey call, and the master key never changes at runtime.
 * Previously every decryptSecretsObject() call re-imported the key — with
 * ~342 accounts decrypted per request, that alone was a large share of the
 * per-request CPU that caused Cloudflare 1102s under load.
 */
const masterKeyCache = new Map();
async function importMasterKey(masterKeyB64) {
    const cached = masterKeyCache.get(masterKeyB64);
    if (cached)
        return cached;
    const pending = (async () => {
        const raw = b64decode(masterKeyB64);
        if (raw.length !== 32) {
            throw new Error("MASTER_KEY must be 32 bytes, base64-encoded");
        }
        return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
            "encrypt",
            "decrypt"
        ]);
    })();
    masterKeyCache.set(masterKeyB64, pending);
    // Don't poison the cache: if the import rejects, drop it so a later
    // call retries instead of serving the same rejection forever.
    pending.catch(() => {
        if (masterKeyCache.get(masterKeyB64) === pending) {
            masterKeyCache.delete(masterKeyB64);
        }
    });
    return pending;
}
/** Encrypt a UTF-8 string; returns the JSON envelope string for DB storage. */
export async function encryptSecret(plaintext, masterKeyB64) {
    const key = await importMasterKey(masterKeyB64);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
    const envelope = {
        v: 1,
        iv: b64encode(iv),
        ct: b64encode(new Uint8Array(ct))
    };
    return JSON.stringify(envelope);
}
/** Decrypt a JSON envelope string produced by encryptSecret. */
export async function decryptSecret(envelopeJson, masterKeyB64) {
    const key = await importMasterKey(masterKeyB64);
    const envelope = JSON.parse(envelopeJson);
    if (envelope.v !== 1 || !envelope.iv || !envelope.ct) {
        throw new Error("Unsupported secret envelope version");
    }
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(envelope.iv) }, key, b64decode(envelope.ct));
    return new TextDecoder().decode(pt);
}
/** Encrypt a JSON-serializable secrets object (provider account credentials). */
export async function encryptSecretsObject(secrets, masterKeyB64) {
    return encryptSecret(JSON.stringify(secrets), masterKeyB64);
}
/** Decrypt into a secrets object. */
export async function decryptSecretsObject(envelopeJson, masterKeyB64) {
    return JSON.parse(await decryptSecret(envelopeJson, masterKeyB64));
}
/** Generate a fresh 32-byte master key, base64-encoded (for `wrangler secret put`). */
export function generateMasterKey() {
    return b64encode(crypto.getRandomValues(new Uint8Array(32)));
}

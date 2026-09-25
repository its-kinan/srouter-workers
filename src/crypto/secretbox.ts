// AES-GCM credential encryption (WebCrypto).
// Provider secrets are encrypted with the MASTER_KEY Worker secret before
// being stored in D1. Envelope format stored in DB TEXT columns:
//   {"v":1,"iv":"<base64>","ct":"<base64>"}
// SRouter stored these values plaintext; the port must not.

export interface SecretEnvelope {
    v: 1;
    iv: string;
    ct: string;
}

function b64encode(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
    return btoa(s);
}

function b64decode(b64: string): Uint8Array<ArrayBuffer> {
    const s = atob(b64);
    const out = new Uint8Array(new ArrayBuffer(s.length));
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

async function importMasterKey(masterKeyB64: string): Promise<CryptoKey> {
    const raw = b64decode(masterKeyB64);
    if (raw.length !== 32) {
        throw new Error("MASTER_KEY must be 32 bytes, base64-encoded");
    }
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt"
    ]);
}

/** Encrypt a UTF-8 string; returns the JSON envelope string for DB storage. */
export async function encryptSecret(
    plaintext: string,
    masterKeyB64: string
): Promise<string> {
    const key = await importMasterKey(masterKeyB64);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(plaintext)
    );
    const envelope: SecretEnvelope = {
        v: 1,
        iv: b64encode(iv),
        ct: b64encode(new Uint8Array(ct))
    };
    return JSON.stringify(envelope);
}

/** Decrypt a JSON envelope string produced by encryptSecret. */
export async function decryptSecret(
    envelopeJson: string,
    masterKeyB64: string
): Promise<string> {
    const key = await importMasterKey(masterKeyB64);
    const envelope = JSON.parse(envelopeJson) as SecretEnvelope;
    if (envelope.v !== 1 || !envelope.iv || !envelope.ct) {
        throw new Error("Unsupported secret envelope version");
    }
    const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64decode(envelope.iv) },
        key,
        b64decode(envelope.ct)
    );
    return new TextDecoder().decode(pt);
}

/** Encrypt a JSON-serializable secrets object (provider account credentials). */
export async function encryptSecretsObject(
    secrets: Record<string, unknown>,
    masterKeyB64: string
): Promise<string> {
    return encryptSecret(JSON.stringify(secrets), masterKeyB64);
}

/** Decrypt into a secrets object. */
export async function decryptSecretsObject<T = Record<string, string>>(
    envelopeJson: string,
    masterKeyB64: string
): Promise<T> {
    return JSON.parse(await decryptSecret(envelopeJson, masterKeyB64)) as T;
}

/** Generate a fresh 32-byte master key, base64-encoded (for `wrangler secret put`). */
export function generateMasterKey(): string {
    return b64encode(crypto.getRandomValues(new Uint8Array(32)));
}

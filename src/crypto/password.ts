// Admin password hashing with WebCrypto PBKDF2-SHA256.
// SRouter used node:crypto scryptSync, which has no WebCrypto equivalent, so
// password hashes are NOT portable: admins reset their password on first deploy
// (the setup endpoint creates the account when none exists).
// Stored format: "pbkdf2$<iterations>$<salt_b64>$<hash_b64>"

const ITERATIONS = 210_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

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

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
    return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
        key,
        HASH_BYTES * 8
    );
    return `pbkdf2$${ITERATIONS}$${b64encode(salt)}$${b64encode(new Uint8Array(bits))}`;
}

export async function verifyPassword(
    password: string,
    stored: string
): Promise<boolean> {
    const parts = stored.split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
    const iterations = parseInt(parts[1]!, 10);
    if (!Number.isFinite(iterations) || iterations <= 0) return false;
    const salt = b64decode(parts[2]!);
    const expected = b64decode(parts[3]!);
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
        key,
        expected.length * 8
    );
    return timingSafeEqual(new Uint8Array(bits), expected);
}

/** SHA-256 hex digest (virtual API key lookup hashes, admin session tokens). */
export async function sha256Hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(input)
    );
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

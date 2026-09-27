// Body size limit middleware. Ported from SRouter's
// apps/api/src/middleware/BodyLimit.ts: rejects oversized bodies from the
// Content-Length header before the body is buffered into memory.
import { apiError } from "../lib/api-error.js";
/** Max accepted request body in bytes (25 MB). Large enough for base64 image payloads. */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;
export function createBodyLimitMiddleware(maxBytes = MAX_BODY_BYTES) {
    return async (c, next) => {
        const lengthHeader = c.req.header("content-length");
        if (lengthHeader) {
            const length = Number(lengthHeader);
            if (Number.isFinite(length) && length > maxBytes) {
                return apiError(c, 413, "Request body too large", "request_too_large");
            }
        }
        return next();
    };
}

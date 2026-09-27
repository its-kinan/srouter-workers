// OpenAI-style error responses, matching SRouter's conventions:
//   { error: { message, type, code? } }
// where `type` derives from the HTTP status.
function typeForStatus(status) {
    if (status === 401)
        return "authentication_error";
    if (status === 403)
        return "permission_error";
    if (status === 429)
        return "rate_limit_error";
    return "invalid_request_error";
}
export function apiError(c, status, message, code) {
    return c.json({
        error: {
            message,
            type: typeForStatus(status),
            ...(code ? { code } : {})
        }
    }, status);
}

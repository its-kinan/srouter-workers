export const DEFAULT_REQUEST_ATTEMPT_LIMIT = 6;
class AttemptBudget {
    limit;
    used = 0;
    providerAttempts = 0;
    transportAttempts = 0;
    constructor(limit) {
        this.limit = limit;
    }
    get remaining() {
        return Math.max(0, this.limit - this.used);
    }
    consume() {
        if (this.remaining <= 0) {
            throw new Error(`Request upstream attempt budget exhausted after ${this.limit} attempts`);
        }
        this.used += 1;
        this.transportAttempts += 1;
    }
    recordProviderAttempt() {
        this.providerAttempts += 1;
    }
}
export function CreateRequestAttemptBudget(limit = DEFAULT_REQUEST_ATTEMPT_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
        throw new Error("Request attempt limit must be a positive integer");
    }
    return new AttemptBudget(limit);
}

import { isServerFailureMessage } from "../contracts.ts";

/** Copy for a heart or a comment the server refused. */
const RATE_LIMIT_TOAST = "Slow down, tiger.";
const FAILURE_TOAST = "Cats are napping — try again.";

const isRateLimited = (error: Error): boolean => /rate limit|429|too many/i.test(error.message);

/**
 * Message to surface for a rejected server call: the fixed rate-limit phrase,
 * otherwise the server's own phrase when it is one this site approves,
 * otherwise a generic cat-flavoured fallback.
 *
 * Approved phrases are matched as text, never by `instanceof`: server functions
 * reject with `ServerFailure`, but a serialized rejection arrives as a plain
 * `Error`, and a framework, transport, or validator message must stay hidden.
 */
export function failureMessage(error: Error): string {
    if (isRateLimited(error)) return RATE_LIMIT_TOAST;
    return isServerFailureMessage(error.message) ? error.message : FAILURE_TOAST;
}

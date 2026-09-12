/** Copy for a heart or a comment the server refused. */
const RATE_LIMIT_TOAST = "Slow down, tiger.";
const FAILURE_TOAST = "Cats are napping — try again.";

const isRateLimited = (error: Error): boolean => /rate limit|429|too many/i.test(error.message);

/**
 * Message to surface for a rejected server call: the fixed rate-limit phrase,
 * otherwise the server's own phrase, otherwise a generic cat-flavoured
 * fallback. Server functions reject with `ServerFailure`, an `Error` subclass.
 */
export function failureMessage(error: Error): string {
    if (isRateLimited(error)) return RATE_LIMIT_TOAST;
    return error.message.length > 0 ? error.message : FAILURE_TOAST;
}

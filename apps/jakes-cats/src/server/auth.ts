/**
 * The upload route's one gate: an exact bearer token, read from the request
 * header the Shortcut sends. An unset or empty secret never authorizes, so a
 * missing binding fails closed instead of opening the bucket.
 */
import * as Redacted from "effect/Redacted";

const BEARER_PREFIX = "Bearer ";

/** Whether `request` carries exactly the writer token. */
export function isAuthorized(request: Request, token: Redacted.Redacted<string>): boolean {
    const secret = Redacted.value(token);
    if (secret.length === 0) return false;
    return request.headers.get("authorization") === `${BEARER_PREFIX}${secret}`;
}

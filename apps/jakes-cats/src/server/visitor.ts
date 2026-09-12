/**
 * Anonymous visitor identity. A visitor is a random 32-hex-character id in an
 * HttpOnly cookie the server mints the first time a request without one runs a
 * server function. The browser never sends it explicitly and nothing is kept
 * in localStorage, so the id is what makes a repeat heart on one photo a no-op
 * and what marks a comment as the reader's own.
 */
import { getCookie, getRequest, getRequestIP, setCookie } from "@tanstack/react-start/server";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The HttpOnly cookie carrying the visitor id. */
export const VISITOR_COOKIE = "jc_visitor";

/** How long a visitor id survives, in seconds (one year). */
export const VISITOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Entropy per minted id; 16 bytes render as 32 hex characters. */
const VISITOR_ID_BYTES = 16;

/** The visitor id grammar: 32 lowercase hex characters. */
export const VisitorId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));

export type VisitorId = typeof VisitorId.Type;

/**
 * Decode a candidate visitor id, or `None` for anything else. The cookie is
 * trusted only through this: a hand-edited or truncated value is replaced
 * rather than used as an identity.
 */
export const decodeVisitorId = Schema.decodeUnknownOption(VisitorId);

/** Bytes as a visitor id: 32 lowercase hex characters, zero-padded per byte. */
export function visitorIdFromBytes(bytes: Uint8Array): string {
    let id = "";
    for (const byte of bytes) id += byte.toString(16).padStart(2, "0");
    return id;
}

/**
 * This request's visitor id: the cookie when it already carries a well-formed
 * id, else a freshly minted one, also written to the response cookie. Runs
 * synchronously in the Start request context, so it must be read inside a
 * server function's handler.
 */
export const currentVisitor: Effect.Effect<string> = Effect.sync(() => {
    const existing = getCookie(VISITOR_COOKIE);
    const known = existing === undefined ? Option.none<string>() : decodeVisitorId(existing);
    if (Option.isSome(known)) return known.value;

    const minted = visitorIdFromBytes(crypto.getRandomValues(new Uint8Array(VISITOR_ID_BYTES)));
    setCookie(VISITOR_COOKIE, minted, {
        httpOnly: true,
        // Secure only on HTTPS: browsers refuse to resend a Secure cookie over
        // plain HTTP, which would mint a new visitor on every local-dev call.
        secure: new URL(getRequest().url).protocol === "https:",
        sameSite: "lax",
        path: "/",
        maxAge: VISITOR_COOKIE_MAX_AGE_SECONDS,
    });
    return minted;
});

/** The key the edge rate limiter buckets: the client IP, else one shared bucket. */
export function clientKey(): string {
    const request = getRequest();
    return (
        request.headers.get("cf-connecting-ip") ??
        getRequestIP({ xForwardedFor: false }) ??
        "unknown-client"
    );
}

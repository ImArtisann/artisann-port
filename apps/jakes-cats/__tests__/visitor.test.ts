/**
 * The visitor id: its grammar, its byte renderer, and the cookie round trip.
 * The request-scoped parts run inside a real Start request context (the same
 * `requestHandler` the Worker uses), so what is proven here is the deployed
 * behavior: a hand-edited cookie never becomes an identity, a fresh visitor
 * gets an HttpOnly cookie, and a known visitor is left alone.
 */
import { describe, expect, it } from "vite-plus/test";
import { requestHandler } from "@tanstack/react-start/server";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
    VISITOR_COOKIE,
    VISITOR_COOKIE_MAX_AGE_SECONDS,
    clientKey,
    currentVisitor,
    decodeVisitorId,
    visitorIdFromBytes,
} from "../src/server/visitor.ts";

const KNOWN_ID = "0123456789abcdef0123456789abcdef";

/** Run one request through the Start context and read what came back. */
async function getWithVisitor(request: Request): Promise<{ id: string; setCookie: string | null }> {
    const handler = requestHandler(() =>
        Effect.runPromise(currentVisitor).then((id) => new Response(id)),
    );
    const response = await handler(request, {});
    return { id: await response.text(), setCookie: response.headers.get("set-cookie") };
}

describe("visitor identity", () => {
    it("decodes exactly 32 lowercase hex characters", () => {
        expect(Option.isSome(decodeVisitorId(KNOWN_ID))).toBe(true);

        expect(Option.isNone(decodeVisitorId(""))).toBe(true);
        expect(Option.isNone(decodeVisitorId("0123456789abcdef0123456789abcde"))).toBe(true);
        expect(Option.isNone(decodeVisitorId(`${KNOWN_ID}0`))).toBe(true);
        expect(Option.isNone(decodeVisitorId(KNOWN_ID.toUpperCase()))).toBe(true);
        expect(Option.isNone(decodeVisitorId("0123456789abcdef0123456789abcdeg"))).toBe(true);
    });

    it("renders 16 bytes as zero-padded hex", () => {
        const bytes = new Uint8Array([0, 1, 15, 16, 255, 0, 1, 15, 16, 255, 0, 1, 15, 16, 255, 7]);

        const id = visitorIdFromBytes(bytes);

        expect(id).toBe("00010f10ff00010f10ff00010f10ff07");
        expect(id).toHaveLength(32);
    });

    it("mints ids its own grammar accepts", () => {
        const bytes = new Uint8Array(16);
        for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 37) % 256;

        expect(Option.isSome(decodeVisitorId(visitorIdFromBytes(bytes)))).toBe(true);
    });

    it("mints an HttpOnly cookie for a request that arrives without one", async () => {
        const { id, setCookie } = await getWithVisitor(new Request("https://jakes.cat/"));

        expect(Option.isSome(decodeVisitorId(id))).toBe(true);
        expect(setCookie).toContain(`${VISITOR_COOKIE}=${id}`);
        expect(setCookie).toContain("HttpOnly");
        expect(setCookie).toContain("Secure");
        expect(setCookie).toContain("SameSite=Lax");
        expect(setCookie).toContain("Path=/");
        expect(setCookie).toContain(`Max-Age=${VISITOR_COOKIE_MAX_AGE_SECONDS}`);
    });

    it("reuses a well-formed cookie instead of minting another", async () => {
        const request = new Request("https://jakes.cat/", {
            headers: { cookie: `${VISITOR_COOKIE}=${KNOWN_ID}` },
        });

        const { id, setCookie } = await getWithVisitor(request);

        expect(id).toBe(KNOWN_ID);
        expect(setCookie).toBeNull();
    });

    it("replaces a malformed cookie with a fresh identity", async () => {
        const request = new Request("https://jakes.cat/", {
            headers: { cookie: `${VISITOR_COOKIE}=not-a-visitor` },
        });

        const { id, setCookie } = await getWithVisitor(request);

        expect(id).not.toBe("not-a-visitor");
        expect(Option.isSome(decodeVisitorId(id))).toBe(true);
        expect(setCookie).toContain(`${VISITOR_COOKIE}=${id}`);
    });
});

describe("rate limit key", () => {
    it("buckets on Cloudflare's client IP header", async () => {
        const request = new Request("https://jakes.cat/", {
            headers: { "cf-connecting-ip": "203.0.113.7" },
        });

        const response = await requestHandler(() => new Response(clientKey()))(request, {});

        expect(await response.text()).toBe("203.0.113.7");
    });
});

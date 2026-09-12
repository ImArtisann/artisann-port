/**
 * The upload route's only gate. An unset or empty secret must fail closed, and
 * nothing short of an exact bearer match may open the bucket.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Redacted from "effect/Redacted";
import { isAuthorized } from "../src/server/auth.ts";

/** Every case builds the same request shape, so only the header varies. */
function requestWith(headers: Record<string, string>): Request {
    return new Request("https://jakes.cat/api/photos", { method: "POST", headers });
}

const TOKEN = "writer-token";

describe("isAuthorized", () => {
    it("rejects an unset or empty token", () => {
        expect(isAuthorized(requestWith({}), Redacted.make(""))).toBe(false);
        expect(isAuthorized(requestWith({ authorization: "Bearer " }), Redacted.make(""))).toBe(
            false,
        );
    });

    it("rejects a wrong scheme, a bare token, and a wrong token", () => {
        expect(
            isAuthorized(
                requestWith({ authorization: "Basic writer-token" }),
                Redacted.make(TOKEN),
            ),
        ).toBe(false);
        expect(isAuthorized(requestWith({ authorization: TOKEN }), Redacted.make(TOKEN))).toBe(
            false,
        );
        expect(
            isAuthorized(requestWith({ authorization: "Bearer other" }), Redacted.make(TOKEN)),
        ).toBe(false);
    });

    it("accepts the exact bearer token", () => {
        expect(
            isAuthorized(requestWith({ authorization: `Bearer ${TOKEN}` }), Redacted.make(TOKEN)),
        ).toBe(true);
    });
});

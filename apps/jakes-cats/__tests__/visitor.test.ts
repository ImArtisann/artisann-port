import { describe, expect, it } from "vite-plus/test";
import { clientKey, resolveVisitor } from "../src/server/visitor.ts";

const KNOWN_ID = "0123456789abcdef0123456789abcdef";
describe("native visitor cookie boundary", () => {
    it("mints a private cookie and reuses its identity on the next request", () => {
        const first = resolveVisitor(new Request("https://jakes.cat/api/deck"));
        expect(first.id).toMatch(/^[0-9a-f]{32}$/u);
        expect(first.cookie).toContain("HttpOnly");
        expect(first.cookie).toContain("SameSite=Lax");
        expect(first.cookie).toContain("Secure");
        expect(first.cookie).toContain("Max-Age=31536000");
        const second = resolveVisitor(
            new Request("https://jakes.cat/api/hearts", {
                headers: { cookie: first.cookie ?? "" },
            }),
        );
        expect(second).toEqual({ id: first.id, cookie: null });
    });
    it("preserves existing identities and replaces malformed cookies", () => {
        expect(
            resolveVisitor(
                new Request("https://jakes.cat/api/top", {
                    headers: { cookie: `other=x; jc_visitor=${KNOWN_ID}` },
                }),
            ),
        ).toEqual({ id: KNOWN_ID, cookie: null });
        const invalid = resolveVisitor(
            new Request("http://localhost/api/deck", {
                headers: { cookie: "jc_visitor=not-valid" },
            }),
        );
        expect(invalid.id).toMatch(/^[0-9a-f]{32}$/u);
        expect(invalid.cookie).not.toContain("Secure");
    });
    it("buckets by the trusted edge header, never user supplied forwarded headers", () => {
        expect(
            clientKey(
                new Request("https://jakes.cat", {
                    headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "attacker" },
                }),
            ),
        ).toBe("203.0.113.7");
        expect(
            clientKey(
                new Request("https://jakes.cat", { headers: { "x-forwarded-for": "attacker" } }),
            ),
        ).toBe("unknown-client");
    });
});

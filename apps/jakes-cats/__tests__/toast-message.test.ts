/**
 * What a visitor reads when a server call is refused. The client must show this
 * site's own phrases and the friendly rate-limit copy, and must never surface a
 * framework, transport, or storage message — even though a rejection reaches it
 * as a plain `Error` once the server function's error class has been
 * serialized away.
 */
import { describe, expect, it } from "vite-plus/test";
import { SERVER_FAILURE_MESSAGES } from "../src/contracts.ts";
import { failureMessage } from "../src/components/toast-message.ts";

describe("failureMessage", () => {
    it("shows an approved server phrase that arrives as a plain Error", () => {
        // Serialization drops `ServerFailure`, leaving only the message.
        const serialized = new Error(SERVER_FAILURE_MESSAGES.commentTooLong);
        serialized.name = "Error";

        expect(failureMessage(serialized)).toBe(SERVER_FAILURE_MESSAGES.commentTooLong);
    });

    it("hides a storage message that is not approved copy", () => {
        const internal = new Error("SQLITE_ERROR: no such table: comments");
        expect(failureMessage(internal)).not.toContain("SQLITE");
        expect(failureMessage(internal).length).toBeGreaterThan(0);
    });

    it("hides an approved phrase with a detail appended to it", () => {
        const leaked = new Error(`${SERVER_FAILURE_MESSAGES.unknownPhoto}: cats/1.webp`);
        expect(failureMessage(leaked)).not.toContain("cats/1.webp");
    });

    it("falls back the same way for an empty message and for unapproved text", () => {
        const fallback = failureMessage(new Error(""));
        expect(failureMessage(new Error("Validation failed: expected string"))).toBe(fallback);
        expect(fallback.length).toBeGreaterThan(0);
    });

    it("shows the friendly rate-limit copy instead of the raw phrase", () => {
        const friendly = failureMessage(new Error("429 Too Many Requests"));

        expect(friendly).not.toContain("429");
        expect(failureMessage(new Error(SERVER_FAILURE_MESSAGES.rateLimited))).toBe(friendly);
    });
});

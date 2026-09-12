/**
 * The browser-safe contract every screen, server function, and the upload API
 * shares: the site mark must track the generated manifest, comment input bounds
 * apply after trimming, and the failure allowlist matches exactly.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { DEFAULT_ASSETS_HOST } from "@artisann-port/assets/config";
import { assetKey } from "@artisann-port/assets/urls";
import {
    CommentInput,
    MAX_COMMENT_LENGTH,
    SERVER_FAILURE_MESSAGES,
    SITE_MARK_URL,
    isServerFailureMessage,
} from "../src/contracts.ts";

const decodeComment = Schema.decodeUnknownSync(CommentInput);

/** Managed key shape the comment action always receives. */
const KEY = "cats/123456789012345678.webp";

describe("SITE_MARK_URL", () => {
    it("resolves the cat mark through the manifest on the assets host", () => {
        const mark = new URL(SITE_MARK_URL);
        expect(mark.origin).toBe(`https://${DEFAULT_ASSETS_HOST}`);
        // Content-addressed: a stale hardcoded hash would fail this.
        expect(mark.pathname).toBe(`/${assetKey("portfolio/cats.webp")}`);
        expect(mark.search).toBe("");
    });
});

describe("CommentInput", () => {
    it("accepts a max-length body wrapped in whitespace and decodes it trimmed", () => {
        const body = "x".repeat(MAX_COMMENT_LENGTH);
        const decoded = decodeComment({ key: KEY, body: `  \n${body}\t ` });

        expect(decoded.body).toBe(body);
        // The decoded input is plain JSON: no wrapper survives the transform.
        expect(JSON.parse(JSON.stringify(decoded))).toEqual(decoded);
        expect(Object.keys(decoded).sort()).toEqual(["body", "key"]);
    });

    it("rejects a body that only fits while padded", () => {
        const body = "x".repeat(MAX_COMMENT_LENGTH + 1);
        expect(() => decodeComment({ key: KEY, body: ` ${body} ` })).toThrow();
    });

    it("rejects a whitespace-only body", () => {
        expect(() => decodeComment({ key: KEY, body: "  \n\t " })).toThrow();
    });
});

describe("isServerFailureMessage", () => {
    it("recognizes every approved phrase and refuses near misses", () => {
        expect(isServerFailureMessage(SERVER_FAILURE_MESSAGES.photoUnavailable)).toBe(true);
        expect(isServerFailureMessage(SERVER_FAILURE_MESSAGES.commentNotAllowed)).toBe(true);
        // Exact match only: padding or an appended detail is not approved copy.
        expect(isServerFailureMessage(`${SERVER_FAILURE_MESSAGES.photoUnavailable} `)).toBe(false);
        expect(isServerFailureMessage("")).toBe(false);
    });
});

/**
 * The comment spam filter runs before any storage write, so these cases pin
 * both directions: vandalism shapes are refused, and ordinary text is allowed.
 * Profanity is judged remotely by the moderation service, whose vocabulary
 * deliberately lives outside this repo.
 */
import { describe, expect, it } from "vite-plus/test";
import { spamProblem } from "../src/server/comment-filter.ts";

describe("spamProblem", () => {
    it("rejects character floods as spam", () => {
        expect(spamProblem("aaaaaaaaaa")).toBe("spam");
        expect(spamProblem("looooooooooooooooool")).toBe("spam");
        expect(spamProblem("~~~~~~~~~~~~~~~~~")).toBe("spam");
    });

    it("counts astral characters the same as ASCII in floods", () => {
        // Ten copies of one astral character is the same flood as "aaaaaaaaaa".
        expect(spamProblem("🐱".repeat(10))).toBe("spam");
        // 60% threshold: 12 astral + 8 ASCII still floods, 11 + 8 does not.
        expect(spamProblem("🐱".repeat(12) + "abcdefgh")).toBe("spam");
        expect(spamProblem("🐱".repeat(11) + "abcdefgh")).toBeNull();
    });

    it("rejects link dumps as spam", () => {
        expect(spamProblem("https://free-cats.example")).toBe("spam");
        expect(spamProblem("buy now https://a.example and https://b.example")).toBe("spam");
        // Nine astral characters beside one URL is still under ten.
        expect(spamProblem(`https://a.example ${"🐱".repeat(9)}`)).toBe("spam");
    });

    it("rejects symbol floods as spam", () => {
        expect(spamProblem("🎉🎉🎉🎉🎉🎉🎉🎉")).toBe("spam");
        // Astral letters count once each, so this is not a symbol flood.
        expect(spamProblem("𝐜𝐚𝐭𝐬 𝐚𝐫𝐞 𝐠𝐫𝐞𝐚𝐭")).toBeNull();
    });

    it("allows ordinary comments", () => {
        expect(spamProblem("Your cat looks so cozy in that sunbeam!")).toBeNull();
        expect(spamProblem("what a lovely class of cats")).toBeNull();
        expect(spamProblem("dang, that cat is fast for a nap champion")).toBeNull();
        expect(spamProblem("")).toBeNull();
    });

    it("allows a normal comment at the maximum length", () => {
        const longest = "meow ".repeat(56);
        expect(longest.length).toBe(280);
        expect(spamProblem(longest)).toBeNull();
    });
});

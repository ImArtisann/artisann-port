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

    it("rejects link dumps as spam", () => {
        expect(spamProblem("https://free-cats.example")).toBe("spam");
        expect(spamProblem("buy now https://a.example and https://b.example")).toBe("spam");
    });

    it("rejects symbol floods as spam", () => {
        expect(spamProblem("🎉🎉🎉🎉🎉🎉🎉🎉")).toBe("spam");
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

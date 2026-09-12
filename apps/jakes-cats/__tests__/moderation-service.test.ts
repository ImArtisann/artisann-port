/**
 * The moderation provider only accepts 35 whitespace-separated words per
 * request, but comments can reach 280 characters. These cases pin the
 * windowing contract: every word is judged inside a compliant request, a flag
 * anywhere rejects the comment, and a provider failure in any window fails
 * closed. The scripted client records real request bodies; no network calls
 * leave the process.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { describe, expect, it } from "vite-plus/test";
import { ModerationLive, ModerationService } from "../src/server/moderation-service.ts";

/** Provider limit under test: at most 35 words per request. */
const PROVIDER_WORD_LIMIT = 35;

/** Reads the `message` field the service put on the wire. */
const decodeMessage = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ message: Schema.String })),
);

/**
 * Provider double: records each request's `message` field and answers with
 * the caller's script, indexed by request order.
 */
function scriptedModeration(answer: (index: number, message: string) => Response) {
    const requests: Array<{ readonly url: string; readonly message: string }> = [];
    const client = HttpClient.make((request, url) =>
        Effect.sync(() => {
            const raw =
                request.body._tag === "Uint8Array"
                    ? new TextDecoder().decode(request.body.body)
                    : "";
            const message = decodeMessage(raw).message;
            requests.push({ url: url.toString(), message });
            return HttpClientResponse.fromWeb(request, answer(requests.length - 1, message));
        }),
    );
    return { client, requests };
}

const clean = () => Response.json({ isProfanity: false, score: 0.01 });

function layerFor(peer: { client: HttpClient.HttpClient }) {
    return ModerationLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, peer.client)));
}

const isProfane = (body: string) => Effect.flatMap(ModerationService, (s) => s.isProfane(body));

function runIsProfane(body: string, answer: (index: number, message: string) => Response) {
    const peer = scriptedModeration(answer);
    const result = Effect.runPromise(isProfane(body).pipe(Effect.provide(layerFor(peer))));
    return { result, peer };
}

/** Same, but resolves with the failure so error cases assert a typed value. */
function runIsProfaneError(body: string, answer: (index: number, message: string) => Response) {
    const peer = scriptedModeration(answer);
    const error = Effect.runPromise(
        Effect.flip(isProfane(body)).pipe(Effect.provide(layerFor(peer))),
    );
    return { error, peer };
}

const words = (message: string) => message.split(" ");

/** The consumer maximum: 56 four-character words + 55 spaces = 279 characters. */
const longComment = () =>
    Array.from({ length: 56 }, (_, index) => `w${String(index).padStart(3, "0")}`).join(" ");

describe("ModerationService", () => {
    it("judges a short comment in a single request", async () => {
        const { result, peer } = runIsProfane("what a lovely cat", clean);
        expect(await result).toBe(false);
        expect(peer.requests).toHaveLength(1);
        expect(peer.requests[0]?.message).toBe("what a lovely cat");
    });

    it("normalizes whitespace before sending", async () => {
        const { result, peer } = runIsProfane("  what\ta   lovely\n\n cat  ", clean);
        expect(await result).toBe(false);
        expect(peer.requests.map((r) => r.message)).toEqual(["what a lovely cat"]);
    });

    it("covers a 56-word comment in compliant overlapping windows", async () => {
        const body = longComment();
        expect(body.length).toBe(279);
        const { result, peer } = runIsProfane(body, clean);
        expect(await result).toBe(false);
        expect(peer.requests.length).toBeGreaterThan(1);
        for (const request of peer.requests) {
            expect(words(request.message).length).toBeLessThanOrEqual(PROVIDER_WORD_LIMIT);
        }
        // Boundary context: the second window repeats the last five words of
        // the first so a phrase spanning the split is judged whole.
        const first = words(peer.requests[0]!.message);
        const second = words(peer.requests[1]!.message);
        expect(second.slice(0, 5)).toEqual(first.slice(-5));
        // Coverage: every word of the comment appears in some window.
        const covered = new Set(peer.requests.flatMap((r) => words(r.message)));
        for (const word of words(body)) expect(covered.has(word)).toBe(true);
    });

    it("rejects when only a later window is flagged", async () => {
        const body = longComment();
        const { result } = runIsProfane(body, (index) =>
            index === 0 ? clean() : Response.json({ isProfanity: true, score: 0.97 }),
        );
        expect(await result).toBe(true);
    });

    it("keeps the shortest-word 279-character comment within five requests", async () => {
        // 140 single-character words + 139 spaces = 279 characters: the most
        // windows the provider limit can force out of any comment.
        const body = Array.from({ length: 140 }, (_, index) =>
            String.fromCharCode(97 + (index % 26)),
        ).join(" ");
        expect(body.length).toBe(279);
        const { result, peer } = runIsProfane(body, clean);
        expect(await result).toBe(false);
        expect(peer.requests.length).toBeLessThanOrEqual(5);
        for (const request of peer.requests) {
            expect(words(request.message).length).toBeLessThanOrEqual(PROVIDER_WORD_LIMIT);
        }
        const covered = new Set(peer.requests.flatMap((r) => words(r.message)));
        for (const word of words(body)) expect(covered.has(word)).toBe(true);
    });

    it("fails closed when a later window's request fails", async () => {
        const body = longComment();
        const { error, peer } = runIsProfaneError(body, (index) =>
            index === 0 ? clean() : new Response("upstream down", { status: 500 }),
        );
        expect(await error).toMatchObject({ _tag: "Moderation.Error", reason: "Unavailable" });
        expect(peer.requests.length).toBeGreaterThan(1);
    });

    it("fails closed on an unparseable verdict", async () => {
        const { error } = runIsProfaneError(
            "hello cat",
            () => new Response("not json", { status: 200 }),
        );
        expect(await error).toMatchObject({ _tag: "Moderation.Error", reason: "Unavailable" });
    });
});

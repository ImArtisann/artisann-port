import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
    decodeNotePayload,
    decodeNoteSubmission,
    encodeNotePayload,
    noteReviewMessage,
    type NoteSubmissionInput,
    type NoteReviewPayload,
} from "../src/notes.ts";
import {
    NotesConfig,
    NotesLive,
    NotesRateLimit,
    NotesService,
    type NotesRateLimitBinding,
    type NotesSubmissionContext,
} from "../src/notes-service.ts";

const submissionId = "0123456789abcdef0123456789abcdef";
const channelId = "100000000000000004";
const messageId = "100000000000000009";
const websiteOrigin = "https://www.artisann.dev";

const submission = () => ({
    id: submissionId,
    name: "Visitor",
    body: "A kind note.",
    turnstileToken: "isolated-turnstile-fixture",
});

function transport(siteverify: Response, webhook: Response) {
    const requests: Array<{ url: string; body: string }> = [];
    const client = HttpClient.make((request, url) =>
        Effect.sync(() => {
            requests.push({
                url: url.toString(),
                body:
                    request.body._tag === "Uint8Array"
                        ? new TextDecoder().decode(request.body.body)
                        : "",
            });
            const response = Match.value(url.hostname).pipe(
                Match.when("challenges.cloudflare.com", () => siteverify),
                Match.when("discord.com", () => webhook),
                Match.orElse(() => new Response(null, { status: 404 })),
            );
            return HttpClientResponse.fromWeb(request, response);
        }),
    );
    return { client, requests };
}

const successfulVerification = () =>
    Response.json({ success: true, hostname: "www.artisann.dev", action: "submit-note" });
const confirmedMessage = () => Response.json({ id: messageId, channel_id: channelId });
const decodeDeliveredReview = Schema.decodeUnknownSync(
    Schema.fromJsonString(
        Schema.Struct({
            embeds: Schema.Array(Schema.Struct({ footer: Schema.Struct({ text: Schema.String }) })),
        }),
    ),
);

function config() {
    return {
        discordNotesWebhookUrl: Redacted.make(
            "https://discord.com/api/webhooks/100000000000000005/isolated-webhook-fixture",
        ),
        discordNotesChannelId: channelId,
        turnstileSecretKey: Redacted.make("isolated-secret-fixture"),
        websiteOrigin,
    };
}

function submit(
    raw: NoteSubmissionInput,
    context: NotesSubmissionContext = { origin: websiteOrigin, ip: "192.0.2.1" },
    options: {
        readonly client?: HttpClient.HttpClient;
        readonly limiter?: NotesRateLimitBinding;
        readonly websiteOrigin?: string;
    } = {},
) {
    const requests: Array<{ url: string; body: string }> = [];
    const peer =
        options.client === undefined
            ? transport(successfulVerification(), confirmedMessage())
            : { client: options.client, requests };
    const layer = Layer.provide(
        NotesLive,
        Layer.mergeAll(
            Layer.succeed(NotesConfig, {
                ...config(),
                websiteOrigin: options.websiteOrigin ?? websiteOrigin,
            }),
            Layer.succeed(NotesRateLimit, {
                binding: options.limiter ?? { limit: () => Promise.resolve({ success: true }) },
            }),
            Layer.succeed(HttpClient.HttpClient, peer.client),
        ),
    );
    const effect = Effect.gen(function* () {
        const service = yield* NotesService;
        return yield* service.submit(raw, context);
    }).pipe(Effect.provide(layer));
    return { effect, peer };
}

async function runSubmit(
    raw: NoteSubmissionInput,
    context?: NotesSubmissionContext,
    options?: Parameters<typeof submit>[2],
) {
    const invocation = submit(raw, context, options);
    return { result: await Effect.runPromise(invocation.effect), peer: invocation.peer };
}

describe("visitor submission contract", () => {
    it("normalizes anonymous names and trims body before applying the shared limit", async () => {
        const blank = await Effect.runPromise(
            decodeNoteSubmission({ ...submission(), name: "  ", body: `  ${"a".repeat(120)}  ` }),
        );
        const omitted = submission();
        const { name: _name, ...withoutName } = omitted;
        const anonymous = await Effect.runPromise(decodeNoteSubmission(withoutName));
        expect(blank.name).toBeNull();
        expect(blank.body).toBe("a".repeat(120));
        expect(anonymous.name).toBeNull();
    });

    it("rejects excess text, forged server fields, and identifiers with trailing whitespace", async () => {
        await expect(
            Effect.runPromise(decodeNoteSubmission({ ...submission(), body: "a".repeat(121) })),
        ).rejects.toThrow();
        await expect(
            Effect.runPromise(
                decodeNoteSubmission({ ...submission(), approvedAt: "2026-09-08T00:00:00.000Z" }),
            ),
        ).rejects.toThrow();
        await expect(
            Effect.runPromise(decodeNoteSubmission({ ...submission(), id: `${submissionId}\n` })),
        ).rejects.toThrow();
    });

    it("round-trips Unicode and Discord formatting without publishing escaped text", () => {
        const payload: NoteReviewPayload = {
            v: 1,
            id: submissionId,
            name: "Zoë 雪",
            body: "Hello 👋 **kind** \\ _world_ <@123>\nSecond line.",
            submittedAt: "2026-09-08T03:00:00.000Z",
            state: "pending",
        };
        const encoded = encodeNotePayload(payload);
        expect(encoded).not.toBeNull();
        expect(decodeNotePayload(encoded ?? "")).toEqual(payload);
        const review = noteReviewMessage(payload);
        expect(decodeNotePayload(review?.embeds[0]?.footer?.text ?? "")).toEqual(payload);
        expect(review?.allowed_mentions.parse).toEqual([]);
        expect(decodeNotePayload("note.v1:invalid-base64%")).toBeNull();
    });
});

describe("notes service", () => {
    it("confirms the private review before returning the pending value", async () => {
        const { result, peer } = await runSubmit({
            ...submission(),
            name: "  Visitor  ",
            body: "  **Hello** 雪  ",
        });
        expect(result).toEqual({ status: "pending", id: submissionId });
        const reviewRequest = peer.requests.find(
            (request) => new URL(request.url).hostname === "discord.com",
        );
        expect(
            new URL(reviewRequest?.url ?? "https://invalid.local").searchParams.get("wait"),
        ).toBe("true");
        expect(
            new URL(reviewRequest?.url ?? "https://invalid.local").searchParams.get(
                "with_components",
            ),
        ).toBe("true");
        const delivered = decodeDeliveredReview(reviewRequest?.body ?? "");
        const note = decodeNotePayload(delivered.embeds[0]?.footer.text ?? "");
        expect(note?.name).toBe("Visitor");
        expect(note?.body).toBe("**Hello** 雪");
        const verificationRequest = peer.requests.find(
            (request) => new URL(request.url).hostname === "challenges.cloudflare.com",
        );
        expect(JSON.parse(verificationRequest?.body ?? "{}")).toMatchObject({
            response: "isolated-turnstile-fixture",
            remoteip: "192.0.2.1",
        });
    });

    it("rejects malformed input before either verification or Discord access", async () => {
        const invocation = submit({ ...submission(), body: 42 });
        await expect(Effect.runPromise(invocation.effect)).rejects.toMatchObject({
            reason: "invalid",
        });
        expect(invocation.peer.requests).toEqual([]);
    });

    it("enforces the canonical input byte budget before provider access", async () => {
        const invocation = submit({ ...submission(), extra: "x".repeat(4096) });
        await expect(Effect.runPromise(invocation.effect)).rejects.toMatchObject({
            reason: "invalid",
        });
        expect(invocation.peer.requests).toEqual([]);
    });

    it("rejects an unrelated or missing origin before provider access", async () => {
        let limiterCalls = 0;
        for (const origin of ["https://attacker.example", null]) {
            const invocation = submit(
                { ...submission() },
                { origin, ip: "192.0.2.1" },
                {
                    limiter: {
                        limit: async () => {
                            limiterCalls += 1;
                            return { success: true };
                        },
                    },
                },
            );
            await expect(Effect.runPromise(invocation.effect)).rejects.toMatchObject({
                reason: "forbidden",
            });
            expect(invocation.peer.requests).toEqual([]);
        }
        expect(limiterCalls).toBe(0);
    });

    it("allows local development to use the local origin rate-limit key without an IP", async () => {
        const peer = transport(
            Response.json({ success: true, hostname: "localhost", action: "submit-note" }),
            confirmedMessage(),
        );
        const invocation = submit(
            { ...submission() },
            { origin: "http://localhost:3000", ip: null },
            {
                websiteOrigin: "http://localhost:3000",
                client: peer.client,
            },
        );
        expect(await Effect.runPromise(invocation.effect)).toEqual({
            status: "pending",
            id: submissionId,
        });
    });

    it("throttles before forwarding a submission", async () => {
        const invocation = submit({ ...submission() }, undefined, {
            limiter: { limit: () => Promise.resolve({ success: false }) },
        });
        await expect(Effect.runPromise(invocation.effect)).rejects.toMatchObject({
            reason: "throttled",
        });
        expect(invocation.peer.requests).toEqual([]);
    });

    it("maps limiter failures and malformed provider results to unavailable", async () => {
        const failed = submit({ ...submission() }, undefined, {
            limiter: { limit: () => Promise.reject(new Error("limiter down")) },
        });
        await expect(Effect.runPromise(failed.effect)).rejects.toMatchObject({
            reason: "unavailable",
        });
        const malformed = submit({ ...submission() }, undefined, {
            limiter: {
                limit: () => Promise.resolve("yes"),
            },
        });
        await expect(Effect.runPromise(malformed.effect)).rejects.toMatchObject({
            reason: "unavailable",
        });
    });

    it.each([
        ["wrong action", { success: true, hostname: "www.artisann.dev", action: "other-action" }],
        ["wrong hostname", { success: true, hostname: "attacker.example", action: "submit-note" }],
    ])("rejects a token with %s without sending Discord a message", async (_name, verification) => {
        const peer = transport(Response.json(verification), confirmedMessage());
        const invocation = submit({ ...submission() }, undefined, { client: peer.client });
        await expect(Effect.runPromise(invocation.effect)).rejects.toMatchObject({
            reason: "forbidden",
        });
        expect(peer.requests).toHaveLength(1);
        expect(new URL(peer.requests[0]?.url ?? "https://invalid.local").hostname).toBe(
            "challenges.cloudflare.com",
        );
    });

    it.each<[string, () => Response]>([
        ["provider failure", () => new Response(null, { status: 503 })],
        ["malformed response", () => Response.json({})],
    ])("maps Turnstile %s to unavailable", async (_name, response) => {
        const peer = transport(response(), confirmedMessage());
        const invocation = submit({ ...submission() }, undefined, { client: peer.client });
        await expect(Effect.runPromise(invocation.effect)).rejects.toMatchObject({
            reason: "unavailable",
        });
        expect(peer.requests).toHaveLength(1);
    });

    it.each<[string, () => Response]>([
        ["provider failure", () => new Response(null, { status: 503 })],
        ["wrong channel", () => Response.json({ id: messageId, channel_id: "100000000000000010" })],
        ["missing message identity", () => Response.json({ id: "", channel_id: channelId })],
    ])("never claims pending after %s and never retries", async (_name, response) => {
        const peer = transport(successfulVerification(), response());
        const invocation = submit({ ...submission() }, undefined, { client: peer.client });
        await expect(Effect.runPromise(invocation.effect)).rejects.toMatchObject({
            reason: "unavailable",
        });
        expect(
            peer.requests.filter((request) => new URL(request.url).hostname === "discord.com"),
        ).toHaveLength(1);
    });
});

import { PhotoPage } from "../src/photos.ts";
import * as Fiber from "effect/Fiber";
import type { ClientOf } from "@alchemy.run/domain/Api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PortfolioApi } from "@artisann-port/portfolio-domain/portfolio.api";
import {
    DEFAULT_SITE_CONTENT,
    MAX_NOTES,
    SiteContent,
} from "@artisann-port/portfolio-domain/content";
import { SiteContentAggregate } from "@artisann-port/portfolio-domain/content/site-content.aggregate";
import { SITE_CONTENT_ID } from "@artisann-port/portfolio-domain/content/site-content.id";
import { NoteReview } from "@artisann-port/portfolio-domain/notes/note-review.aggregate";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
    ContentDocumentUnavailable,
    ContentDocumentStore,
} from "@artisann-port/portfolio-domain/content/content-document-store";
import { ContentWriterResult, ContentWriterState } from "../src/content-writer.ts";
import { PortfolioMigrationStatus } from "../src/content-migration-service.ts";
import { ContentMigrationPage } from "../src/content-migration-source.ts";
import { handlePortfolioHttp } from "../src/http-server.ts";
import { PhotoUploadReceipt } from "../src/photos-service.ts";
import { decodeNotePayload } from "../src/notes.ts";
import {
    EPOCH,
    NOW,
    ORIGIN,
    TOKEN,
    approval,
    noteId,
    ownerRequest,
    portfolioWorld,
    publicGet,
} from "./portfolio-world.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

function body<A, I>(response: Response, schema: Schema.Codec<A, I>, status = 200) {
    expect(response.status).toBe(status);
    return Effect.promise(() => response.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    );
}
function write(action: Parameters<typeof ownerRequest>[1], id: string) {
    return ownerRequest("/api/writer/content", action, id).pipe(
        Effect.flatMap((response) => body(response, ContentWriterResult)),
    );
}
function migration(path: string, input?: Parameters<typeof ownerRequest>[1]) {
    return ownerRequest(`/api/migration/${path}`, input).pipe(
        Effect.flatMap((response) =>
            body(
                response,
                PortfolioMigrationStatus,
                path === "handoff" && response.status === 202 ? 202 : 200,
            ),
        ),
    );
}
function publishAtLeast(client: ClientOf<typeof PortfolioApi>, revision: number) {
    return client.PublishedContent.watch(SITE_CONTENT_ID).pipe(
        Stream.filter((snapshot) => snapshot.state !== null && snapshot.state.revision >= revision),
        Stream.runHead,
    );
}
function activate(waitForPublication: (revision: number) => Effect.Effect<void>) {
    return Effect.gen(function* () {
        yield* migration("prepare", { epoch: EPOCH });
        const transferred = yield* migration("handoff", {});
        yield* waitForPublication(transferred.target.revision);
        const client = yield* PortfolioApi.clientInProcess;
        yield* publishAtLeast(client, transferred.target.revision);
        return client;
    });
}

it("keeps acknowledged source writes across copy, restart, a racing fence and forward-only handoff recovery", async () => {
    const world = portfolioWorld();
    await Effect.runPromise(
        Effect.gen(function* () {
            yield* write(approval(1), "legacy-approve-1");
            yield* write({ action: "reject", id: noteId(2) }, "legacy-reject-2");
            yield* write(approval(3), "legacy-approve-3");
            yield* write({ action: "delete", id: noteId(3) }, "legacy-delete-3");
            const baseline = yield* migration("prepare", { epoch: EPOCH });
            expect(baseline).toMatchObject({
                converged: true,
                source: { control: { epoch: EPOCH, mode: "legacy", sequence: 0 } },
                target: {
                    active: false,
                    revision: 4,
                    publishedRevision: 4,
                    sourceSequence: 0,
                    decisionsImported: true,
                    content: {
                        notes: [
                            {
                                id: noteId(1),
                                body: "Published note 1",
                                submittedAt: "2026-09-08T03:00:00.000Z",
                                approvedAt: NOW,
                            },
                        ],
                        updatedAt: "2026-11-12T04:00:00.002Z",
                    },
                },
            });
            const oldController = world.restartSource();
            const copied = yield* write(
                {
                    action: "replace",
                    revision: 4,
                    content: {
                        ...baseline.target.content,
                        records: { bench: 341, squat: 499, deadlift: 563 },
                    },
                },
                "source-during-copy",
            );
            expect(copied.state.revision).toBe(5);
            yield* write(approval(4), "source-during-import");
            const resumed = yield* migration("prepare", { epoch: EPOCH });
            expect(resumed.target.sourceSequence).toBe(0);
            expect(resumed.converged).toBe(false);
            const exported = yield* ownerRequest("/api/migration/export", {
                after: 0,
                take: 100,
            }).pipe(Effect.flatMap((response) => body(response, ContentMigrationPage)));
            expect(exported.entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);
            expect(exported.entries[0]?.snapshot).toMatchObject({
                revision: 5,
                publishedRevision: 4,
            });
            expect(exported.entries[3]?.snapshot).toMatchObject({
                revision: 6,
                publishedRevision: 6,
            });
            expect(exported.entries.map((entry) => entry.decision)).toEqual([
                null,
                null,
                null,
                null,
            ]);
            const firstPage = yield* migration("import", { take: 1 });
            expect(firstPage.target).toMatchObject({
                sourceSequence: 1,
                revision: 5,
                publishedRevision: 4,
                active: false,
            });
            expect(firstPage.converged).toBe(false);
            const sourceRead = yield* publicGet().pipe(
                Effect.flatMap((response) => body(response, SiteContent)),
            );
            expect(sourceRead).toMatchObject({
                records: { bench: 341, squat: 499, deadlift: 563 },
                notes: [{ id: noteId(1) }, { id: noteId(4) }],
            });
            const caughtUp = yield* migration("import", { take: 100 });
            expect(caughtUp).toMatchObject({
                converged: true,
                target: { sourceSequence: 4, revision: 6, publishedRevision: 6 },
            });
            const commits = world.memory.control.commits.length;
            expect((yield* migration("import", { take: 100 })).converged).toBe(true);
            expect((yield* migration("prepare", { epoch: EPOCH })).target.sourceSequence).toBe(4);
            expect(world.memory.control.commits.length).toBe(commits);
            world.faults.beforeFence = async () => {
                world.faults.beforeFence = undefined;
                const result = await world.source.apply(approval(5));
                expect(result).toMatchObject({
                    outcome: "approved",
                    state: { revision: 7, publishedRevision: 7 },
                });
            };
            const raced = yield* ownerRequest("/api/migration/handoff", {});
            expect(raced.status).toBe(503);
            const afterRace = yield* migration("status");
            expect(afterRace).toMatchObject({
                converged: false,
                source: { control: { mode: "legacy", sequence: 6 } },
                target: { active: false, revision: 6 },
            });
            yield* migration("import", { take: 100 });
            world.faults.failComplete = true;
            const lostCompletion = yield* ownerRequest("/api/migration/handoff", {});
            expect(lostCompletion.status).toBe(503);
            const client = yield* PortfolioApi.clientInProcess;
            yield* publishAtLeast(client, 7);
            yield* world.published(7);
            expect(yield* migration("status")).toMatchObject({
                source: { control: { mode: "fenced" } },
                target: { active: true, revision: 7, publishedRevision: 7 },
            });
            const projectedBeforeStaleWrite = world.kv.writes.length;
            expect(yield* Effect.promise(() => oldController.apply(approval(6)))).toEqual({
                error: "unavailable",
            });
            yield* Effect.promise(() => oldController.alarm());
            expect(world.kv.writes.length).toBe(projectedBeforeStaleWrite);
            const domainWrite = yield* write(approval(6), "domain-after-fence");
            expect(domainWrite).toMatchObject({
                outcome: "approved",
                state: {
                    revision: 8,
                    publishedRevision: 8,
                    content: {
                        notes: [
                            { id: noteId(1) },
                            { id: noteId(4) },
                            { id: noteId(5) },
                            { id: noteId(6) },
                        ],
                    },
                },
            });
            world.faults.failComplete = false;
            const completed = yield* migration("handoff", {});
            expect(completed).toMatchObject({
                source: { control: { mode: "domain", sequence: 6 }, snapshot: { revision: 7 } },
                target: { active: true, revision: 8, sourceSequence: 6 },
            });
            expect((yield* migration("handoff", {})).target.revision).toBe(8);
            const publicState = yield* client.PublishedContent.get(SITE_CONTENT_ID);
            expect(publicState).toEqual({ content: domainWrite.state.content, revision: 8 });
            expect(
                yield* publicGet().pipe(Effect.flatMap((response) => body(response, SiteContent))),
            ).toEqual(domainWrite.state.content);
            expect(domainWrite.state.content.updatedAt).toBe("2026-11-12T04:00:00.006Z");
            expect(
                (yield* world.history("SiteContent", SITE_CONTENT_ID)).filter(
                    (entry) => entry.event._tag === "VisitorNoteApproved",
                ),
            ).toHaveLength(1);
        }).pipe(Effect.scoped, Effect.provide(world.layer)),
    );
    world.restartSource();
    await Effect.runPromise(
        Effect.gen(function* () {
            const client = yield* PortfolioApi.clientInProcess;
            const restarted = yield* ownerRequest("/api/writer/content").pipe(
                Effect.flatMap((response) => body(response, ContentWriterState)),
            );
            expect(restarted).toMatchObject({
                revision: 8,
                publishedRevision: 8,
                content: {
                    records: { bench: 341, squat: 499, deadlift: 563 },
                    notes: [
                        { id: noteId(1) },
                        { id: noteId(4) },
                        { id: noteId(5) },
                        { id: noteId(6) },
                    ],
                    updatedAt: "2026-11-12T04:00:00.006Z",
                },
            });
            expect((yield* write(approval(6), "domain-after-fence")).state).toEqual(restarted);
            expect((yield* migration("prepare", { epoch: EPOCH })).target).toMatchObject({
                active: true,
                revision: 8,
            });
            const reviews = yield* NoteReview;
            expect(yield* reviews.state(noteId(2))).toMatchObject({ rejected: true });
            expect(yield* reviews.state(noteId(3))).toMatchObject({ deleted: true });
            expect(yield* client.PublishedContent.get(SITE_CONTENT_ID)).toEqual({
                content: restarted.content,
                revision: 8,
            });
            expect(yield* Effect.promise(() => world.source.apply(approval(7)))).toEqual({
                error: "unavailable",
            });
            const edited = yield* write(
                {
                    action: "replace",
                    revision: 8,
                    content: {
                        ...restarted.content,
                        records: { bench: 363, squat: 519, deadlift: 587 },
                    },
                },
                "domain-after-restart",
            );
            expect(edited.state).toMatchObject({
                revision: 9,
                publishedRevision: 9,
                content: {
                    records: { bench: 363, squat: 519, deadlift: 587 },
                    updatedAt: "2026-11-12T04:00:00.007Z",
                },
            });
            expect(edited.state.content.notes).toEqual(restarted.content.notes);
        }).pipe(Effect.scoped, Effect.provide(world.layer)),
    );
});

it("migrates a long decision history in bounded pages and keeps every decision final", async () => {
    const world = portfolioWorld();
    await Effect.runPromise(
        Effect.gen(function* () {
            for (let number = 1; number <= 150; number++)
                yield* write({ action: "reject", id: noteId(number) }, `reject-${number}`);
            yield* write(approval(151), "approve-151");
            yield* write({ action: "delete", id: noteId(151) }, "delete-151");
            const prepared = yield* migration("prepare", { epoch: EPOCH });
            expect(prepared).toMatchObject({
                converged: false,
                target: { decisionsImported: false, decisionCursor: `rejected:${noteId(99)}` },
            });
            expect(Object.keys(prepared.source.snapshot)).toEqual([
                "content",
                "revision",
                "publishedRevision",
            ]);
            expect((yield* ownerRequest("/api/migration/handoff", {})).status).toBe(409);
            // Captured after the scan passed its key: only the journal entry carries it.
            yield* write({ action: "reject", id: noteId(0) }, "reject-during-capture");
            const exported = yield* ownerRequest("/api/migration/export", {
                after: 0,
                take: 100,
            }).pipe(Effect.flatMap((response) => body(response, ContentMigrationPage)));
            expect(exported.entries.map((entry) => entry.decision)).toEqual([
                { id: noteId(0), decision: "rejected" },
            ]);
            const scanned = yield* migration("import", { take: 100 });
            expect(scanned).toMatchObject({
                converged: false,
                target: { decisionsImported: true, sourceSequence: 0 },
            });
            expect((yield* migration("import", { take: 100 })).converged).toBe(true);
            yield* world.published((yield* migration("handoff", {})).target.revision);
            for (const [id, outcome] of [
                [noteId(0), "already-rejected"],
                [noteId(1), "already-rejected"],
                [noteId(150), "already-rejected"],
                [noteId(151), "not-found"],
            ] as const)
                expect(
                    (yield* write(approval(Number.parseInt(id, 16)), `stale-${id}`)).outcome,
                ).toBe(outcome);
        }).pipe(Effect.scoped, Effect.provide(world.layer)),
    );
});

it("enforces capacity, CAS and note finality after migrating a nearly full approved collection", async () => {
    const existing = Array.from({ length: MAX_NOTES - 1 }, (_, index) => ({
        id: noteId(index + 1),
        name: null,
        body: `Existing approval ${index + 1}`,
        submittedAt: "2026-09-08T03:00:00.000Z",
        approvedAt: "2026-09-08T03:01:00.000Z",
    }));
    const world = portfolioWorld({ ...DEFAULT_SITE_CONTENT, notes: existing });
    await Effect.runPromise(
        Effect.gen(function* () {
            const client = yield* activate(world.published);
            const full = yield* write(approval(100), "last-slot");
            expect(full.state).toMatchObject({ revision: 2, publishedRevision: 2 });
            expect(full.state.content.notes).toHaveLength(100);
            expect(full.state.content.notes.at(-1)).toEqual({
                id: noteId(100),
                name: "Ada",
                body: "Published note 100",
                submittedAt: "2026-09-08T03:00:00.000Z",
                approvedAt: NOW,
            });
            const capacity = yield* ownerRequest(
                "/api/writer/content",
                approval(101),
                "over-capacity",
            );
            expect(capacity.status).toBe(422);
            expect(yield* Effect.promise(() => capacity.json())).toEqual({
                _tag: "ContentWriteError",
                kind: "capacity",
            });
            expect(
                (yield* client.PublishedContent.get(SITE_CONTENT_ID))?.content.notes,
            ).toHaveLength(100);
            const stale = yield* ownerRequest(
                "/api/writer/content",
                {
                    action: "replace",
                    revision: 1,
                    content: {
                        ...full.state.content,
                        records: { bench: 352, squat: 501, deadlift: 572 },
                    },
                },
                "stale-cas",
            );
            expect(stale.status).toBe(409);
            expect(yield* Effect.promise(() => stale.json())).toEqual({
                _tag: "ContentWriteError",
                kind: "conflict",
            });
            const forged = yield* ownerRequest(
                "/api/writer/content",
                { action: "replace", revision: 2, content: { ...full.state.content, notes: [] } },
                "forged-notes",
            );
            expect(forged.status).toBe(422);
            expect(yield* Effect.promise(() => forged.json())).toEqual({
                _tag: "ContentWriteError",
                kind: "validation",
            });
            expect(
                (yield* write({ action: "reject", id: noteId(100) }, "reject-published")).outcome,
            ).toBe("already-approved");
            expect((yield* write(approval(100), "approval-retry")).outcome).toBe(
                "already-approved",
            );
            const changed = yield* ownerRequest(
                "/api/writer/content",
                approval(100, "Changed review payload"),
                "changed-approval",
            );
            expect(changed.status).toBe(422);
            expect(yield* Effect.promise(() => changed.json())).toEqual({
                _tag: "ContentWriteError",
                kind: "validation",
            });
            yield* write({ action: "delete", id: noteId(100) }, "delete-last-slot");
            world.restartSource();
            expect((yield* write(approval(100), "stale-after-delete")).outcome).toBe("not-found");
            expect(
                (yield* write({ action: "delete", id: noteId(100) }, "delete-retry")).outcome,
            ).toBe("not-found");
            const replacement = yield* write(approval(101), "freed-slot");
            expect(replacement.state).toMatchObject({ revision: 4, publishedRevision: 4 });
            expect(replacement.state.content.notes).toHaveLength(100);
            expect(replacement.state.content.notes.some((note) => note.id === noteId(100))).toBe(
                false,
            );
            yield* write({ action: "reject", id: noteId(102) }, "reject-pending");
            expect(
                (yield* write({ action: "reject", id: noteId(102) }, "reject-retry")).outcome,
            ).toBe("already-rejected");
            expect((yield* write(approval(102), "approval-after-reject")).outcome).toBe(
                "already-rejected",
            );
            expect((yield* (yield* SiteContentAggregate).state(SITE_CONTENT_ID)).revision).toBe(4);
            const reviews = yield* NoteReview;
            expect(yield* reviews.state(noteId(102))).toMatchObject({ rejected: true });
            expect(yield* reviews.state(noteId(100))).toMatchObject({
                approval: "approved",
                deleted: true,
            });
            expect(
                (yield* client.PublishedContent.get(SITE_CONTENT_ID))?.content.notes.at(-1)?.id,
            ).toBe(noteId(101));
        }).pipe(Effect.scoped, Effect.provide(world.layer)),
    );
});

it("returns unavailable for an acknowledged source approval until restart reconciliation publishes it", async () => {
    const world = portfolioWorld();
    await Effect.runPromise(
        Effect.gen(function* () {
            world.kv.failWrites = true;
            const refused = yield* ownerRequest(
                "/api/writer/content",
                approval(11),
                "lost-source-publication",
            );
            expect(refused.status).toBe(503);
            expect(yield* Effect.promise(() => refused.json())).toEqual({
                _tag: "ContentWriteError",
                kind: "unavailable",
            });
            expect((yield* publicGet()).status).toBe(503);
            const state = yield* ownerRequest("/api/writer/content").pipe(
                Effect.flatMap((response) => body(response, ContentWriterState)),
            );
            expect(state).toMatchObject({
                revision: 2,
                publishedRevision: 1,
                content: { notes: [{ id: noteId(11), approvedAt: NOW }] },
            });
            world.restartSource();
            world.kv.failWrites = false;
            const recovered = yield* write(approval(11), "source-publication-retry");
            expect(recovered).toMatchObject({
                outcome: "already-approved",
                state: { revision: 2, publishedRevision: 2 },
            });
            expect(recovered.state.content.notes).toHaveLength(1);
            expect(
                yield* publicGet().pipe(Effect.flatMap((response) => body(response, SiteContent))),
            ).toEqual(recovered.state.content);
        }).pipe(Effect.scoped, Effect.provide(world.layer)),
    );
});

it("never lets a timed-out KV publication land after a newer one", async () => {
    const world = portfolioWorld();
    let release = () => {};
    const stalled = new Promise<void>((resolve) => {
        release = resolve;
    });
    let puts = 0;
    world.kv.put = (key, value) => {
        puts += 1;
        const commit = () => {
            world.kv.documents.set(key, value);
        };
        if (puts === 1) return stalled.then(commit);
        commit();
        return Promise.resolve();
    };
    const older = { ...DEFAULT_SITE_CONTENT, updatedAt: "2026-11-12T01:00:00.000Z" };
    const newer = { ...DEFAULT_SITE_CONTENT, updatedAt: "2026-11-12T02:00:00.000Z" };
    await Effect.runPromise(
        Effect.gen(function* () {
            const documents = yield* ContentDocumentStore;
            const timedOut = yield* documents.write(older).pipe(Effect.flip, Effect.forkChild);
            yield* Effect.yieldNow;
            yield* TestClock.adjust("10 seconds");
            expect(yield* Fiber.join(timedOut)).toBeInstanceOf(ContentDocumentUnavailable);
            const retry = yield* documents.write(newer).pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            release();
            yield* Fiber.join(retry);
            // The stalled put commits in a callback registered before this await.
            yield* Effect.promise(() => stalled);
            expect(
                yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SiteContent))(
                    world.kv.documents.get("site-content"),
                ),
            ).toEqual(newer);
        }).pipe(Effect.scoped, Effect.provide(world.layer), Effect.provide(TestClock.layer())),
    );
});

it("withholds a failed Domain projection, preserves the committed approval and recovers forward on the next write", async () => {
    const world = portfolioWorld();
    await Effect.runPromise(
        Effect.gen(function* () {
            const client = yield* activate(world.published);
            vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
            vi.setSystemTime(new Date(NOW));
            world.kv.failWrites = true;
            const pending = yield* ownerRequest(
                "/api/writer/content",
                approval(21),
                "domain-publication-outage",
            ).pipe(Effect.forkChild);
            for (
                let attempt = 0;
                world.memory.control.failures.length === 0 && attempt < 1000;
                attempt++
            )
                yield* Effect.yieldNow;
            expect(world.memory.control.failures.length).toBeGreaterThan(0);
            yield* Effect.promise(() => vi.advanceTimersByTimeAsync(10_010));
            const unavailable = yield* Fiber.join(pending);
            expect(unavailable.status).toBe(503);
            expect(yield* Effect.promise(() => unavailable.json())).toEqual({
                _tag: "ApiUnavailable",
                operation: "content",
            });
            expect((yield* publicGet()).status).toBe(503);
            const authority = yield* ownerRequest("/api/writer/content").pipe(
                Effect.flatMap((response) => body(response, ContentWriterState)),
            );
            expect(authority).toMatchObject({
                revision: 2,
                publishedRevision: 1,
                content: { notes: [{ id: noteId(21), approvedAt: NOW }] },
            });
            expect(yield* client.PublishedContent.get(SITE_CONTENT_ID)).toEqual({
                content: DEFAULT_SITE_CONTENT,
                revision: 1,
            });
            world.kv.failWrites = false;
            vi.useRealTimers();
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(new Date(NOW));
            const recovered = yield* write(
                {
                    action: "replace",
                    revision: 2,
                    content: {
                        ...authority.content,
                        records: { bench: 361, squat: 512, deadlift: 581 },
                    },
                },
                "projection-recovery-edit",
            );
            expect(recovered.state).toMatchObject({
                revision: 3,
                publishedRevision: 3,
                content: { records: { bench: 361, squat: 512, deadlift: 581 } },
            });
            const retried = yield* write(approval(21), "domain-publication-outage");
            expect(retried.state.content.notes).toEqual([
                {
                    id: noteId(21),
                    name: "Ada",
                    body: "Published note 21",
                    submittedAt: "2026-09-08T03:00:00.000Z",
                    approvedAt: NOW,
                },
            ]);
            expect(retried.state.revision).toBe(3);
            expect(
                (yield* world.history("SiteContent", SITE_CONTENT_ID)).filter(
                    (entry) => entry.event._tag === "VisitorNoteApproved",
                ),
            ).toHaveLength(1);
            expect(yield* client.PublishedContent.get(SITE_CONTENT_ID)).toEqual({
                content: recovered.state.content,
                revision: 3,
            });
            expect(
                yield* publicGet().pipe(Effect.flatMap((response) => body(response, SiteContent))),
            ).toEqual(recovered.state.content);
        }).pipe(Effect.scoped, Effect.provide(world.layer)),
    );
});

it("keeps pending and rejected text in private review delivery and refuses public content history", async () => {
    const world = portfolioWorld();
    await Effect.runPromise(
        Effect.gen(function* () {
            const client = yield* activate(world.published);
            const privateText = "Private rejected note, never public.";
            const submission = yield* handlePortfolioHttp(
                new Request("https://portfolio.invalid/api/notes", {
                    method: "POST",
                    headers: {
                        origin: ORIGIN,
                        "content-type": "application/json",
                        "cf-connecting-ip": "192.0.2.7",
                    },
                    body: JSON.stringify({
                        id: noteId(201),
                        name: "Private visitor",
                        body: privateText,
                        turnstileToken: "isolated-turnstile-proof",
                    }),
                }),
            );
            expect(submission.status).toBe(200);
            const review = world.outgoing.find((request) =>
                request.url.startsWith("https://discord.com/"),
            );
            const delivered = Schema.decodeUnknownSync(
                Schema.fromJsonString(
                    Schema.Struct({
                        embeds: Schema.Array(
                            Schema.Struct({ footer: Schema.Struct({ text: Schema.String }) }),
                        ),
                    }),
                ),
            )(review?.body ?? "");
            expect(decodeNotePayload(delivered.embeds[0]?.footer.text ?? "")).toMatchObject({
                id: noteId(201),
                name: "Private visitor",
                body: privateText,
                state: "pending",
                submittedAt: NOW,
            });
            const queued = yield* world.history("NoteReview", noteId(201));
            expect(queued.map((entry) => entry.event)).toEqual([{ _tag: "NoteReviewQueued" }]);
            expect(
                JSON.stringify(yield* client.PublishedContent.get(SITE_CONTENT_ID)),
            ).not.toContain(privateText);
            yield* write({ action: "reject", id: noteId(201) }, "reject-private-review");
            const decisions = yield* world.history("NoteReview", noteId(201));
            expect(decisions.map((entry) => entry.event._tag)).toContain("NoteRejected");
            const events = [
                ...decisions,
                ...(yield* world.history("SiteContent", SITE_CONTENT_ID)),
            ];
            expect(JSON.stringify(events)).not.toContain(privateText);
            expect(JSON.stringify(events)).not.toContain("Private visitor");
            expect(world.kv.writes.every((entry) => !entry.value.includes(privateText))).toBe(true);
            expect(
                yield* client.PublishedContent.list(SITE_CONTENT_ID).pipe(Effect.flip),
            ).toMatchObject({ _tag: "ContentHistoryPrivate" });
            expect(
                yield* client.PublishedContent.events(SITE_CONTENT_ID).pipe(
                    Stream.runHead,
                    Effect.flip,
                ),
            ).toMatchObject({ _tag: "ContentHistoryPrivate" });
            const publicSnapshot = yield* client.PublishedContent.snapshot(SITE_CONTENT_ID);
            expect(publicSnapshot.state).toEqual({ content: DEFAULT_SITE_CONTENT, revision: 1 });
            expect(
                yield* publicGet().pipe(Effect.flatMap((response) => body(response, SiteContent))),
            ).toEqual(DEFAULT_SITE_CONTENT);
            expect(
                (yield* handlePortfolioHttp(
                    new Request("https://portfolio.invalid/api/domain/SiteContent"),
                )).status,
            ).toBe(404);
        }).pipe(Effect.scoped, Effect.provide(world.layer)),
    );
});

describe("HTTP guards and permanent binary photo route", () => {
    it("answers project preview HEAD requests with image headers and no body", async () => {
        const world = portfolioWorld();
        vi.stubGlobal("caches", {
            default: {
                match: async () =>
                    new Response(new Uint8Array([1, 2]), {
                        headers: { "content-type": "image/png" },
                    }),
                put: async () => undefined,
            },
        });
        try {
            await Effect.runPromise(
                Effect.gen(function* () {
                    const url = "https://portfolio.invalid/projects/blocky/og-image";
                    const head = yield* handlePortfolioHttp(new Request(url, { method: "HEAD" }));
                    expect(head.status).toBe(200);
                    expect(head.headers.get("content-type")).toBe("image/png");
                    expect(head.headers.get("x-preview-cache")).toBe("HIT");
                    expect(head.body).toBeNull();
                    const post = yield* handlePortfolioHttp(new Request(url, { method: "POST" }));
                    expect(post.status).toBe(405);
                }).pipe(Effect.scoped, Effect.provide(world.layer)),
            );
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("authorizes before consuming bodies and caps actual bytes before any mutation", async () => {
        const world = portfolioWorld();
        await Effect.runPromise(
            Effect.gen(function* () {
                for (const [path, headers, expected] of [
                    ["/api/writer/content", { "x-command-id": "untrusted" }, 401],
                    ["/api/migration/prepare", { authorization: "Bearer incorrect" }, 401],
                    [
                        "/api/writer/photos?tag=cats&key=cats/12345678901234567.webp",
                        { authorization: "Bearer incorrect" },
                        401,
                    ],
                    ["/api/notes", { origin: "https://attacker.invalid" }, 403],
                ] as const) {
                    let reads = 0;
                    const request = new Request(`https://portfolio.invalid${path}`, {
                        method: "POST",
                        headers,
                        body: new ReadableStream<Uint8Array>(
                            {
                                pull(controller) {
                                    reads++;
                                    controller.enqueue(new Uint8Array([0]));
                                },
                            },
                            { highWaterMark: 0 },
                        ),
                        duplex: "half",
                    });
                    const response = yield* handlePortfolioHttp(request);
                    expect(response.status).toBe(expected);
                    expect(reads).toBe(0);
                    expect(response.headers.get("access-control-allow-origin")).toBeNull();
                    yield* Effect.promise(() => request.body?.cancel() ?? Promise.resolve());
                }
                for (const [path, maximum, headers] of [
                    [
                        "/api/writer/content",
                        1_048_576,
                        { authorization: `Bearer ${TOKEN}`, "x-command-id": "oversized-content" },
                    ],
                    ["/api/migration/prepare", 8 * 1024, { authorization: `Bearer ${TOKEN}` }],
                    ["/api/notes", 8 * 1024, { origin: ORIGIN }],
                    [
                        "/api/writer/photos?tag=cats&key=cats/12345678901234567.webp",
                        32 * 1024 * 1024,
                        {
                            authorization: `Bearer ${TOKEN}`,
                            "x-photo-operation-id": "oversized-photo",
                        },
                    ],
                ] as const) {
                    const response = yield* handlePortfolioHttp(
                        new Request(`https://portfolio.invalid${path}`, {
                            method: "POST",
                            headers: { ...headers, "content-length": "1" },
                            body: new Uint8Array(maximum + 1),
                        }),
                    );
                    expect(response.status).toBe(413);
                    expect(yield* Effect.promise(() => response.json())).toEqual({
                        _tag: "HttpRequestFailure",
                        code: "BodyTooLarge",
                    });
                }
                expect(world.photos.puts).toBe(0);
                expect(world.outgoing).toEqual([]);
                expect(yield* Effect.promise(() => world.source.getState())).toMatchObject({
                    revision: 1,
                    publishedRevision: 1,
                    content: DEFAULT_SITE_CONTENT,
                });
            }).pipe(Effect.scoped, Effect.provide(world.layer)),
        );
    });

    it("carries operation identity, create-only and conditional delete headers through real photo ownership", async () => {
        const world = portfolioWorld();
        const key = "cats/12345678901234567.webp";
        const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
        await Effect.runPromise(
            Effect.gen(function* () {
                const upload = (id: string) =>
                    handlePortfolioHttp(
                        new Request(
                            `https://portfolio.invalid/api/writer/photos?tag=cats&key=${key}`,
                            {
                                method: "POST",
                                headers: {
                                    authorization: `Bearer ${TOKEN}`,
                                    "x-photo-operation-id": id,
                                    "x-photo-writer": "cats",
                                    "if-none-match": "*",
                                    "content-type": "image/webp",
                                },
                                body: bytes,
                            },
                        ),
                    );
                const missingIdentity = yield* handlePortfolioHttp(
                    new Request(`https://portfolio.invalid/api/writer/photos?tag=cats&key=${key}`, {
                        method: "POST",
                        headers: { authorization: `Bearer ${TOKEN}` },
                        body: bytes,
                    }),
                );
                expect(missingIdentity.status).toBe(400);
                const invalidActor = yield* handlePortfolioHttp(
                    new Request(`https://portfolio.invalid/api/writer/photos?tag=cats&key=${key}`, {
                        method: "POST",
                        headers: {
                            authorization: `Bearer ${TOKEN}`,
                            "x-photo-operation-id": "invalid-actor",
                            "x-photo-writer": "visitor",
                        },
                        body: bytes,
                    }),
                );
                expect(invalidActor.status).toBe(400);
                expect(world.photos.puts).toBe(0);
                const receipt = yield* upload("http-photo-upload").pipe(
                    Effect.flatMap((response) => body(response, PhotoUploadReceipt, 201)),
                );
                expect(receipt).toEqual({
                    key,
                    url: `https://assets.artisann.dev/${key}`,
                    tag: "cats",
                    operationId: "http-photo-upload",
                    etag: "portfolio-photo-1",
                });
                expect(world.photos.objects.get(key)).toMatchObject({
                    bytes,
                    httpMetadata: {
                        contentType: "image/webp",
                        cacheControl: "public, max-age=60, must-revalidate",
                    },
                    customMetadata: { photoOperationId: "http-photo-upload" },
                });
                expect(
                    yield* publicGet("/api/photos?tag=cats").pipe(
                        Effect.flatMap((response) => body(response, PhotoPage)),
                    ),
                ).toEqual({
                    tag: "cats",
                    photos: [{ key, url: `https://assets.artisann.dev/${key}`, uploadedAt: NOW }],
                    nextCursor: null,
                });
                expect((yield* upload("http-photo-collision")).status).toBe(409);
                expect(world.photos.puts).toBe(1);
                const remove = (id: string, etag: string) =>
                    handlePortfolioHttp(
                        new Request(`https://portfolio.invalid/api/writer/photos?key=${key}`, {
                            method: "DELETE",
                            headers: {
                                authorization: `Bearer ${TOKEN}`,
                                "x-photo-operation-id": id,
                                "x-photo-writer": "cats",
                                "if-match": etag,
                            },
                        }),
                    );
                expect((yield* remove("wrong-object-delete", "stale-etag")).status).toBe(409);
                expect(world.photos.deletes).toBe(0);
                const deleted = yield* remove("http-photo-delete", receipt.etag);
                expect(deleted.status).toBe(200);
                expect(world.photos.objects.has(key)).toBe(false);
                expect(world.photos.deletes).toBe(1);
                expect(
                    yield* publicGet("/api/photos?tag=cats").pipe(
                        Effect.flatMap((response) => body(response, PhotoPage)),
                    ),
                ).toEqual({ tag: "cats", photos: [], nextCursor: null });
                const maximum = new Uint8Array(32 * 1024 * 1024);
                maximum.set(bytes);
                const atCapacity = yield* handlePortfolioHttp(
                    new Request(`https://portfolio.invalid/api/writer/photos?tag=cats&key=${key}`, {
                        method: "POST",
                        headers: {
                            authorization: `Bearer ${TOKEN}`,
                            "x-photo-operation-id": "photo-exact-cap",
                            "x-photo-writer": "owner",
                            "if-none-match": "*",
                            "content-type": "image/webp",
                        },
                        body: maximum,
                    }),
                );
                expect(atCapacity.status).toBe(201);
                expect(world.photos.objects.get(key)?.bytes.byteLength).toBe(32 * 1024 * 1024);
                expect(world.photos.puts).toBe(2);
            }).pipe(Effect.scoped, Effect.provide(world.layer)),
        );
    });
});

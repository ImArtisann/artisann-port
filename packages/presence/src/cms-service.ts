import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { SiteContent } from "@artisann-port/portfolio-domain/content";
import { CurrentPortfolioActor } from "@artisann-port/portfolio-domain/portfolio-actor.context";
import { SiteContentAggregate } from "@artisann-port/portfolio-domain/content/site-content.aggregate";
import { SITE_CONTENT_ID } from "@artisann-port/portfolio-domain/content/site-content.id";
import { PublishedContent } from "@artisann-port/portfolio-domain/content/published-content.view";
import { ReplaceContent } from "@artisann-port/portfolio-domain/content/replace-content.command";
import { ApproveNote } from "@artisann-port/portfolio-domain/content/approve-note.command";
import { ReviewFinal } from "@artisann-port/portfolio-domain/content/review-final.rejection";
import { DeleteNote } from "@artisann-port/portfolio-domain/content/delete-note.command";
import { NoteReview } from "@artisann-port/portfolio-domain/notes/note-review.aggregate";
import { ConfirmNoteReviewQueued } from "@artisann-port/portfolio-domain/notes/confirm-note-review-queued.command";
import { ClaimNoteApproval } from "@artisann-port/portfolio-domain/notes/claim-note-approval.command";
import { SettleNoteApproval } from "@artisann-port/portfolio-domain/notes/settle-note-approval.command";
import { RecordNoteRejection } from "@artisann-port/portfolio-domain/notes/record-note-rejection.command";
import { RecordNoteDeletion } from "@artisann-port/portfolio-domain/notes/record-note-deletion.command";
import { ApiUnavailable, ContentWriteError } from "./api-errors.ts";
import {
    CONTENT_WRITER_BODY_BYTES_MAX,
    ContentWriterAction,
    ContentWriterErrorKind,
    ContentWriterResult,
    ContentWriterState,
} from "./content-writer.ts";
import type { ContentMigrationSource } from "./content-migration-source.ts";
import type { PresenceKvBinding } from "./store.ts";

export class CmsBindings extends Context.Service<
    CmsBindings,
    {
        readonly snapshots: PresenceKvBinding;
        readonly writer: ContentMigrationSource;
    }
>()("Cms.Bindings") {}

export class CmsContentService extends Context.Service<
    CmsContentService,
    {
        readonly get: Effect.Effect<SiteContent, ApiUnavailable>;
        readonly readState: Effect.Effect<ContentWriterState, ApiUnavailable>;
        readonly apply: (
            action: ContentWriterAction,
            commandId: string,
        ) => Effect.Effect<ContentWriterResult, ContentWriteError | ApiUnavailable>;
        readonly recordReview: (id: string) => Effect.Effect<void, ApiUnavailable>;
    }
>()("Cms.ContentService") {}

const PrivateResult = Schema.Union([
    ContentWriterResult,
    Schema.Struct({ error: ContentWriterErrorKind }),
]);

export const CmsContentLive = Layer.effect(
    CmsContentService,
    Effect.gen(function* () {
        const bindings = yield* CmsBindings;
        const content = yield* SiteContentAggregate;
        const published = yield* PublishedContent;
        const reviews = yield* NoteReview;
        const ref = SiteContentAggregate.ref(SITE_CONTENT_ID);
        const unavailable = () => new ApiUnavailable({ operation: "content" });

        const readState = Effect.gen(function* () {
            const state = yield* content.state(SITE_CONTENT_ID);
            if (state.active)
                return {
                    content: state.content,
                    revision: state.revision,
                    publishedRevision: state.publishedRevision,
                };
            return yield* Effect.tryPromise({
                try: () => bindings.writer.getState(),
                catch: unavailable,
            }).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(ContentWriterState)),
                Effect.mapError(unavailable),
                Effect.timeoutOrElse({
                    duration: "10 seconds",
                    orElse: () => Effect.fail(unavailable()),
                }),
            );
        }).pipe(
            Effect.catchDefect(() => Effect.fail(unavailable())),
            Effect.withSpan("Cms.readState"),
        );

        const get = readState.pipe(
            Effect.flatMap((state) =>
                state.publishedRevision < state.revision
                    ? Effect.fail(unavailable())
                    : Effect.succeed(state.content),
            ),
        );

        const afterPublication = Effect.fn("Cms.afterPublication")(function* (
            outcome: ContentWriterResult["outcome"],
            minimum: number,
        ) {
            const ready = yield* published.watch(ref).pipe(
                Stream.filter(Option.isSome),
                Stream.filter(
                    (snapshot) => snapshot.value !== null && snapshot.value.revision >= minimum,
                ),
                Stream.runHead,
                Effect.timeoutOrElse({
                    duration: "10 seconds",
                    orElse: () => Effect.fail(unavailable()),
                }),
            );
            if (Option.isNone(ready)) return yield* unavailable();
            const state = yield* readState;
            if (state.publishedRevision < state.revision) return yield* unavailable();
            return { outcome, state } satisfies ContentWriterResult;
        });

        const apply = Effect.fn("Cms.apply")(
            function* (action: ContentWriterAction, commandId: string) {
                const value = yield* Schema.decodeEffect(ContentWriterAction)(action).pipe(
                    Effect.mapError(() => new ContentWriteError({ kind: "validation" })),
                );
                const document = yield* Schema.encodeEffect(
                    Schema.fromJsonString(ContentWriterAction),
                )(value).pipe(Effect.mapError(() => new ContentWriteError({ kind: "validation" })));
                if (new TextEncoder().encode(document).byteLength > CONTENT_WRITER_BODY_BYTES_MAX)
                    return yield* new ContentWriteError({ kind: "capacity" });
                const state = yield* content.state(SITE_CONTENT_ID);
                if (!state.active) {
                    const result = yield* Effect.tryPromise({
                        try: () => bindings.writer.apply(value),
                        catch: unavailable,
                    }).pipe(
                        Effect.flatMap(Schema.decodeUnknownEffect(PrivateResult)),
                        Effect.mapError(unavailable),
                        Effect.timeoutOrElse({
                            duration: "12 seconds",
                            orElse: () => Effect.fail(unavailable()),
                        }),
                    );
                    if ("error" in result)
                        return yield* new ContentWriteError({ kind: result.error });
                    return result;
                }
                const owner = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                    effect.pipe(Effect.provideService(CurrentPortfolioActor, "owner"));
                const decided = (outcome: ContentWriterResult["outcome"], revision: number) => ({
                    outcome,
                    revision,
                });
                const final = (rejection: ReviewFinal) =>
                    content.state(SITE_CONTENT_ID).pipe(
                        Effect.map((current) =>
                            decided(
                                Match.value(rejection.decision).pipe(
                                    Match.when(
                                        "approved",
                                        (): ContentWriterResult["outcome"] => "already-approved",
                                    ),
                                    Match.when(
                                        "rejected",
                                        (): ContentWriterResult["outcome"] => "already-rejected",
                                    ),
                                    Match.when(
                                        "deleted",
                                        (): ContentWriterResult["outcome"] => "not-found",
                                    ),
                                    Match.exhaustive,
                                ),
                                current.revision,
                            ),
                        ),
                    );
                /** The current revision while the note is not published; none once it is. */
                const unpublishedRevision = (id: string) =>
                    content
                        .state(SITE_CONTENT_ID)
                        .pipe(
                            Effect.map((current) =>
                                current.content.notes.some((note) => note.id === id)
                                    ? Option.none<number>()
                                    : Option.some(current.revision),
                            ),
                        );
                // Each note's NoteReview decides finality first; SiteContent then owns the notes.
                const result = yield* Match.value(value).pipe(
                    Match.when({ action: "replace" }, (action) =>
                        owner(
                            content.send(
                                SITE_CONTENT_ID,
                                new ReplaceContent({
                                    revision: action.revision,
                                    content: action.content,
                                }),
                                { commandId },
                            ),
                        ).pipe(Effect.map((receipt) => decided("updated", receipt.reply.revision))),
                    ),
                    Match.when({ action: "approve" }, (action) =>
                        Effect.gen(function* () {
                            const settle = (approved: boolean) =>
                                owner(
                                    reviews.send(action.id, new SettleNoteApproval({ approved }), {
                                        commandId: `${commandId}:settle:${approved}`,
                                    }),
                                );
                            const refused = yield* owner(
                                reviews.send(action.id, new ClaimNoteApproval(), {
                                    commandId: `${commandId}:claim`,
                                }),
                            ).pipe(
                                Effect.as(
                                    Option.none<{
                                        outcome: ContentWriterResult["outcome"];
                                        revision: number;
                                    }>(),
                                ),
                                Effect.catchTag("ReviewFinal", (rejection) =>
                                    Effect.asSome(final(rejection)),
                                ),
                            );
                            if (Option.isSome(refused)) return refused.value;
                            return yield* owner(
                                content.send(
                                    SITE_CONTENT_ID,
                                    new ApproveNote({
                                        id: action.id,
                                        name: action.name,
                                        body: action.body,
                                        submittedAt: action.submittedAt,
                                    }),
                                    { commandId },
                                ),
                            ).pipe(
                                Effect.map((receipt) =>
                                    decided("approved", receipt.reply.revision),
                                ),
                                Effect.catchTag("ReviewFinal", final),
                                Effect.tap(() => settle(true)),
                                // A refused approval releases its claim unless the note is published.
                                Effect.tapError((error) =>
                                    Match.value(error._tag).pipe(
                                        Match.when("NoteReviewPayloadChanged", () => settle(true)),
                                        Match.when("NotesCapacityReached", () => settle(false)),
                                        Match.orElse(() => Effect.void),
                                    ),
                                ),
                            );
                        }),
                    ),
                    Match.when({ action: "reject" }, (action) =>
                        Effect.gen(function* () {
                            const unpublished = yield* unpublishedRevision(action.id);
                            if (Option.isNone(unpublished))
                                return yield* final(
                                    new ReviewFinal({ id: action.id, decision: "approved" }),
                                );
                            return yield* owner(
                                reviews.send(action.id, new RecordNoteRejection(), { commandId }),
                            ).pipe(
                                Effect.as(decided("rejected", unpublished.value)),
                                Effect.catchTag("ReviewFinal", final),
                            );
                        }),
                    ),
                    Match.when({ action: "delete" }, (action) =>
                        Effect.gen(function* () {
                            if (Option.isSome(yield* unpublishedRevision(action.id)))
                                return yield* final(
                                    new ReviewFinal({ id: action.id, decision: "deleted" }),
                                );
                            // Final before removal: a crash in between leaves a retryable deletion.
                            yield* owner(
                                reviews.send(action.id, new RecordNoteDeletion(), {
                                    commandId: `${commandId}:final`,
                                }),
                            );
                            return yield* owner(
                                content.send(SITE_CONTENT_ID, new DeleteNote({ id: action.id }), {
                                    commandId,
                                }),
                            ).pipe(
                                Effect.map((receipt) => decided("deleted", receipt.reply.revision)),
                                Effect.catchTag("ReviewFinal", final),
                            );
                        }),
                    ),
                    Match.exhaustive,
                    Effect.mapError((error) =>
                        error._tag === "ContentRevisionConflict"
                            ? new ContentWriteError({ kind: "conflict" })
                            : error._tag === "ModeratedNotesImmutable" ||
                                error._tag === "NoteReviewPayloadChanged"
                              ? new ContentWriteError({ kind: "validation" })
                              : error._tag === "NotesCapacityReached"
                                ? new ContentWriteError({ kind: "capacity" })
                                : unavailable(),
                    ),
                );
                if (result.outcome === "rejected" || result.outcome === "already-rejected")
                    return {
                        outcome: result.outcome,
                        state: yield* readState,
                    } satisfies ContentWriterResult;
                return yield* afterPublication(result.outcome, result.revision);
            },
            Effect.catchDefect(() => Effect.fail(unavailable())),
        );

        const recordReview = Effect.fn("Cms.recordReview")(
            function* (id: string) {
                yield* reviews
                    .send(id, new ConfirmNoteReviewQueued(), { commandId: `review:${id}:queued` })
                    .pipe(
                        Effect.provideService(CurrentPortfolioActor, "notes"),
                        Effect.mapError(unavailable),
                        Effect.timeoutOrElse({
                            duration: "10 seconds",
                            orElse: () => Effect.fail(unavailable()),
                        }),
                    );
            },
            Effect.catchDefect(() => Effect.fail(unavailable())),
        );

        return CmsContentService.of({ get, readState, apply, recordReview });
    }),
);

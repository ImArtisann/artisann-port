import { expect, it } from "vite-plus/test";
import { Story } from "@alchemy.run/domain/Story";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DEFAULT_SITE_CONTENT, type SiteContent } from "../src/content.ts";
import { Portfolio, PortfolioHandlers } from "../src/portfolio.model.ts";
import { CurrentPortfolioActor } from "../src/portfolio-actor.context.ts";
import { PortfolioDenied } from "../src/portfolio-authority.middleware.ts";
import { ContentDocumentStore } from "../src/content/content-document-store.ts";
import { ContentInactive } from "../src/content/content-inactive.rejection.ts";
import {
    ImportContent,
    LegacyContentImported,
    ContentImportConflict,
} from "../src/content/import-content.command.ts";
import { ReplaceContent } from "../src/content/replace-content.command.ts";
import { ActivateContent } from "../src/content/activate-content.command.ts";
import { SiteContentAggregate } from "../src/content/site-content.aggregate.ts";
import { SITE_CONTENT_ID } from "../src/content/site-content.id.ts";
import { PublishedContent, PublicContentChanged } from "../src/content/published-content.view.ts";
import { NoteReview } from "../src/notes/note-review.aggregate.ts";
import {
    ConfirmNoteReviewQueued,
    NoteReviewQueued,
} from "../src/notes/confirm-note-review-queued.command.ts";

const contentRef = SiteContentAggregate.ref(SITE_CONTENT_ID);
const snapshot = {
    content: { ...DEFAULT_SITE_CONTENT, updatedAt: "2026-09-08T03:01:00.000Z" },
    revision: 17,
    publishedRevision: 17,
    rejected: ["00000000000000000000000000000002"],
    deleted: ["00000000000000000000000000000003"],
};

it("keeps imported authority inactive, checks migration actors and rejects conflicting replay without changing public state", async () => {
    const projected: SiteContent[] = [];
    const pending = { ...snapshot, publishedRevision: 16 };
    const documents = Layer.succeed(ContentDocumentStore, {
        write: (content) =>
            Effect.sync(() => {
                projected.push(content);
            }),
    });
    const story = Story.make(Portfolio, {
        layer: PortfolioHandlers.pipe(Layer.provide(documents)),
    });
    await Effect.runPromise(
        story(
            Story.clock("2026-11-12T04:00:00.000Z"),
            Story.provide(CurrentPortfolioActor, "owner"),
            Story.when(
                contentRef,
                new ImportContent({ snapshot, epoch: "copy-epoch", sequence: 4 }),
            ),
            Story.rejected(new PortfolioDenied()),
            Story.then(contentRef),
            Story.when(
                contentRef,
                new ReplaceContent({ revision: 0, content: DEFAULT_SITE_CONTENT }),
            ),
            Story.rejected(new ContentInactive()),
            Story.then(contentRef),
            Story.provide(CurrentPortfolioActor, "migration"),
            Story.when(
                contentRef,
                new ImportContent({ snapshot: pending, epoch: "copy-epoch", sequence: 3 }),
                { commandId: "copy-page-3" },
            ),
            Story.then(
                contentRef,
                new LegacyContentImported({
                    snapshot: pending,
                    epoch: "copy-epoch",
                    sequence: 3,
                }),
            ),
            Story.replied({ sequence: 3 }),
            Story.view(PublishedContent, contentRef, Story.none),
            Story.when(
                contentRef,
                new ImportContent({ snapshot, epoch: "copy-epoch", sequence: 4 }),
                { commandId: "copy-page-4" },
            ),
            Story.then(
                contentRef,
                new LegacyContentImported({ snapshot, epoch: "copy-epoch", sequence: 4 }),
            ),
            Story.replied({ sequence: 4 }),
            Story.state(contentRef, {
                ...snapshot,
                active: false,
                sourceEpoch: "copy-epoch",
                sourceSequence: 4,
            }),
            Story.view(PublishedContent, contentRef, { content: snapshot.content, revision: 17 }),
            Story.when(
                contentRef,
                new ImportContent({ snapshot, epoch: "copy-epoch", sequence: 4 }),
                { commandId: "copy-page-4" },
            ),
            Story.then(contentRef),
            Story.replied({ sequence: 4 }),
            Story.when(
                contentRef,
                new ImportContent({ snapshot, epoch: "copy-epoch", sequence: 4 }),
            ),
            Story.then(contentRef),
            Story.replied({ sequence: 4 }),
            Story.when(
                contentRef,
                new ImportContent({
                    snapshot: { ...snapshot, rejected: [] },
                    epoch: "copy-epoch",
                    sequence: 4,
                }),
            ),
            Story.rejected(
                new ContentImportConflict({
                    reason: "snapshot",
                    expectedSequence: 4,
                    actualSequence: 4,
                }),
            ),
            Story.then(contentRef),
            Story.when(
                contentRef,
                new ImportContent({ snapshot, epoch: "other-epoch", sequence: 5 }),
            ),
            Story.rejected(
                new ContentImportConflict({
                    reason: "epoch",
                    expectedSequence: 4,
                    actualSequence: 5,
                }),
            ),
            Story.then(contentRef),
            Story.when(
                contentRef,
                new ImportContent({ snapshot, epoch: "copy-epoch", sequence: 3 }),
            ),
            Story.rejected(
                new ContentImportConflict({
                    reason: "sequence",
                    expectedSequence: 4,
                    actualSequence: 3,
                }),
            ),
            Story.then(contentRef),
            Story.when(contentRef, new ActivateContent({ epoch: "copy-epoch", sequence: 3 })),
            Story.rejected(
                new ContentImportConflict({
                    reason: "sequence",
                    expectedSequence: 4,
                    actualSequence: 3,
                }),
            ),
            Story.then(contentRef),
            Story.provide(CurrentPortfolioActor, "publisher"),
            Story.when(contentRef, new ActivateContent({ epoch: "copy-epoch", sequence: 4 })),
            Story.rejected(new PortfolioDenied()),
            Story.then(contentRef),
            Story.state(contentRef, {
                ...snapshot,
                active: false,
                sourceEpoch: "copy-epoch",
                sourceSequence: 4,
            }),
            Story.emitted(PublishedContent, contentRef, [
                new PublicContentChanged({ content: snapshot.content, revision: 17 }),
            ]),
        ),
    );
    expect(projected).toEqual([]);
});

it("records a review identifier once only for the notes capability, without retaining the visitor payload", async () => {
    const documents = Layer.succeed(ContentDocumentStore, {
        write: () => Effect.die(new Error("Review queue must not publish content")),
    });
    const story = Story.make(Portfolio, {
        layer: PortfolioHandlers.pipe(Layer.provide(documents)),
    });
    const review = NoteReview.ref("00000000000000000000000000000201");
    await Effect.runPromise(
        story(
            Story.provide(CurrentPortfolioActor, "owner"),
            Story.when(review, new ConfirmNoteReviewQueued()),
            Story.rejected(new PortfolioDenied()),
            Story.then(review),
            Story.state(review, { queued: false }),
            Story.provide(CurrentPortfolioActor, "notes"),
            Story.when(review, new ConfirmNoteReviewQueued(), { commandId: "review-delivered" }),
            Story.then(review, new NoteReviewQueued()),
            Story.state(review, { queued: true }),
            Story.when(review, new ConfirmNoteReviewQueued(), { commandId: "review-delivered" }),
            Story.then(review),
            Story.when(review, new ConfirmNoteReviewQueued(), {
                commandId: "review-response-retry",
            }),
            Story.then(review),
            Story.state(review, { queued: true }),
        ),
    );
});

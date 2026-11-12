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
import {
    ActivateContent,
    ContentAuthorityActivated,
} from "../src/content/activate-content.command.ts";
import {
    LegacyDecisionsImported,
    RecordDecisionImport,
} from "../src/content/import-decisions.command.ts";
import { ReviewFinal } from "../src/content/review-final.rejection.ts";
import { ContentPublished } from "../src/content/confirm-publication.command.ts";
import {
    ClaimNoteApproval,
    NoteApprovalClaimed,
} from "../src/notes/claim-note-approval.command.ts";
import {
    ImportNoteDecision,
    LegacyNoteDecisionImported,
} from "../src/notes/import-note-decision.command.ts";
import { NoteApprovalPending } from "../src/notes/note-approval-pending.rejection.ts";
import { RecordNoteRejection } from "../src/notes/record-note-rejection.command.ts";
import {
    NoteApprovalSettled,
    SettleNoteApproval,
} from "../src/notes/settle-note-approval.command.ts";
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
                decisionCursor: null,
                decisionsImported: false,
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
                    snapshot: {
                        ...snapshot,
                        content: { ...snapshot.content, updatedAt: "2026-09-08T03:02:00.000Z" },
                    },
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
                decisionCursor: null,
                decisionsImported: false,
            }),
            Story.emitted(PublishedContent, contentRef, [
                new PublicContentChanged({ content: snapshot.content, revision: 17 }),
            ]),
        ),
    );
    expect(projected).toEqual([]);
});

const noReview = { queued: false, approval: "none", rejected: false, deleted: false } as const;

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
            Story.state(review, { ...noReview, queued: false }),
            Story.provide(CurrentPortfolioActor, "notes"),
            Story.when(review, new ConfirmNoteReviewQueued(), { commandId: "review-delivered" }),
            Story.then(review, new NoteReviewQueued()),
            Story.state(review, { ...noReview, queued: true }),
            Story.when(review, new ConfirmNoteReviewQueued(), { commandId: "review-delivered" }),
            Story.then(review),
            Story.when(review, new ConfirmNoteReviewQueued(), {
                commandId: "review-response-retry",
            }),
            Story.then(review),
            Story.state(review, { ...noReview, queued: true }),
        ),
    );
});

it("keeps each note decision final in its own review and activates only after every decision imports", async () => {
    const documents = Layer.succeed(ContentDocumentStore, { write: () => Effect.void });
    const story = Story.make(Portfolio, {
        layer: PortfolioHandlers.pipe(Layer.provide(documents)),
    });
    const published = "00000000000000000000000000000301";
    const rejected = "00000000000000000000000000000302";
    const approval = NoteReview.ref(published);
    const rejection = NoteReview.ref(rejected);
    await Effect.runPromise(
        story(
            Story.provide(CurrentPortfolioActor, "owner"),
            Story.when(approval, new ClaimNoteApproval()),
            Story.then(approval, new NoteApprovalClaimed()),
            Story.when(approval, new RecordNoteRejection()),
            Story.rejected(new NoteApprovalPending()),
            Story.then(approval),
            Story.when(approval, new SettleNoteApproval({ approved: true })),
            Story.then(approval, new NoteApprovalSettled({ approved: true })),
            Story.when(approval, new RecordNoteRejection()),
            Story.rejected(new ReviewFinal({ id: published, decision: "approved" })),
            Story.then(approval),
            Story.when(approval, new ImportNoteDecision({ decision: "rejected" })),
            Story.rejected(new PortfolioDenied()),
            Story.then(approval),
            Story.provide(CurrentPortfolioActor, "migration"),
            Story.when(rejection, new ImportNoteDecision({ decision: "rejected" })),
            Story.then(rejection, new LegacyNoteDecisionImported({ decision: "rejected" })),
            Story.when(rejection, new ImportNoteDecision({ decision: "rejected" })),
            Story.then(rejection),
            Story.provide(CurrentPortfolioActor, "owner"),
            Story.when(rejection, new ClaimNoteApproval()),
            Story.rejected(new ReviewFinal({ id: rejected, decision: "rejected" })),
            Story.then(rejection),
            Story.state(rejection, { ...noReview, rejected: true }),
            Story.provide(CurrentPortfolioActor, "migration"),
            Story.when(
                contentRef,
                new ImportContent({ snapshot, epoch: "copy-epoch", sequence: 0 }),
            ),
            Story.then(
                contentRef,
                new LegacyContentImported({ snapshot, epoch: "copy-epoch", sequence: 0 }),
            ),
            Story.replied({ sequence: 0 }),
            Story.when(contentRef, new ActivateContent({ epoch: "copy-epoch", sequence: 0 })),
            Story.rejected(
                new ContentImportConflict({
                    reason: "decisions",
                    expectedSequence: 0,
                    actualSequence: 0,
                }),
            ),
            Story.then(contentRef),
            Story.when(
                contentRef,
                new RecordDecisionImport({
                    epoch: "copy-epoch",
                    cursor: `rejected:${rejected}`,
                    complete: true,
                }),
            ),
            Story.then(
                contentRef,
                new LegacyDecisionsImported({
                    epoch: "copy-epoch",
                    cursor: `rejected:${rejected}`,
                    complete: true,
                }),
            ),
            Story.when(contentRef, new ActivateContent({ epoch: "copy-epoch", sequence: 0 })),
            Story.then(
                contentRef,
                new ContentAuthorityActivated({ epoch: "copy-epoch", sequence: 0 }),
                new ContentPublished({ content: snapshot.content, revision: 17 }),
            ),
        ),
    );
});

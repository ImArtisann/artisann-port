import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { CurrentPortfolioActor } from "@artisann-port/portfolio-domain/portfolio-actor.context";
import { SiteContentAggregate } from "@artisann-port/portfolio-domain/content/site-content.aggregate";
import { SITE_CONTENT_ID } from "@artisann-port/portfolio-domain/content/site-content.id";
import { ContentState } from "@artisann-port/portfolio-domain/content/content-state";
import { ImportContent } from "@artisann-port/portfolio-domain/content/import-content.command";
import { ActivateContent } from "@artisann-port/portfolio-domain/content/activate-content.command";
import { CmsBindings } from "./cms-service.ts";
import {
    ContentMigrationControl,
    ContentMigrationFailure,
    ContentMigrationPage,
    ContentMigrationRecord,
    ContentMigrationStatus,
    sourceSnapshotMatches,
} from "./content-migration-source.ts";

export const PortfolioMigrationStatus = Schema.Struct({
    source: ContentMigrationStatus,
    target: ContentState,
    converged: Schema.Boolean,
});
export type PortfolioMigrationStatus = typeof PortfolioMigrationStatus.Type;

export class PortfolioMigration extends Context.Service<
    PortfolioMigration,
    {
        readonly prepare: (
            epoch: string,
        ) => Effect.Effect<PortfolioMigrationStatus, ContentMigrationFailure>;
        readonly importPage: (
            take: number,
        ) => Effect.Effect<PortfolioMigrationStatus, ContentMigrationFailure>;
        readonly status: Effect.Effect<PortfolioMigrationStatus, ContentMigrationFailure>;
        readonly exportPage: (
            after: number,
            take: number,
        ) => Effect.Effect<ContentMigrationPage, ContentMigrationFailure>;
        readonly handoff: Effect.Effect<PortfolioMigrationStatus, ContentMigrationFailure>;
    }
>()("Portfolio/Migration") {}

function native<A, I>(schema: Schema.Codec<A, I>, run: () => Promise<I>) {
    return Effect.tryPromise({
        try: run,
        catch: () => new ContentMigrationFailure({ reason: "unavailable" }),
    }).pipe(
        Effect.flatMap(Schema.decodeEffect(schema)),
        Effect.mapError(() => new ContentMigrationFailure({ reason: "unavailable" })),
        Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () => Effect.fail(new ContentMigrationFailure({ reason: "unavailable" })),
        }),
    );
}

export const PortfolioMigrationLive = Layer.effect(
    PortfolioMigration,
    Effect.gen(function* () {
        const { writer } = yield* CmsBindings;
        const content = yield* SiteContentAggregate;
        const failure = () => new ContentMigrationFailure({ reason: "unavailable" });

        const status = Effect.gen(function* () {
            const source = yield* native(ContentMigrationStatus, () => writer.migrationStatus());
            const target = yield* content.state(SITE_CONTENT_ID);
            const converged =
                source.control !== null &&
                source.control.epoch === target.sourceEpoch &&
                source.control.sequence === target.sourceSequence &&
                sourceSnapshotMatches(source.snapshot, target);
            return { source, target, converged } satisfies PortfolioMigrationStatus;
        }).pipe(Effect.catchDefect(() => Effect.fail(failure())));

        const importRecord = Effect.fn("PortfolioMigration.importRecord")(function* (
            record: ContentMigrationRecord,
        ) {
            yield* content
                .send(
                    SITE_CONTENT_ID,
                    new ImportContent({
                        snapshot: record.snapshot,
                        epoch: record.epoch,
                        sequence: record.sequence,
                    }),
                    {
                        commandId: `legacy:${record.epoch}:${record.sequence}`,
                    },
                )
                .pipe(
                    Effect.provideService(CurrentPortfolioActor, "migration"),
                    Effect.mapError(() => new ContentMigrationFailure({ reason: "conflict" })),
                );
            const target = yield* content.state(SITE_CONTENT_ID);
            if (
                target.sourceEpoch !== record.epoch ||
                target.sourceSequence < record.sequence ||
                (target.sourceSequence === record.sequence &&
                    !sourceSnapshotMatches(record.snapshot, target))
            )
                return yield* new ContentMigrationFailure({ reason: "conflict" });
        });

        const prepare = Effect.fn("PortfolioMigration.prepare")(
            function* (epoch: string) {
                const baseline = yield* native(ContentMigrationRecord, () =>
                    writer.migrationPrepare(epoch),
                );
                const target = yield* content.state(SITE_CONTENT_ID);
                if (!target.active && target.sourceEpoch === null) yield* importRecord(baseline);
                if (target.sourceEpoch !== null && target.sourceEpoch !== epoch)
                    return yield* new ContentMigrationFailure({ reason: "conflict" });
                return yield* status;
            },
            Effect.catchDefect(() => Effect.fail(failure())),
        );

        const importPage = Effect.fn("PortfolioMigration.importPage")(
            function* (take: number) {
                if (!Number.isSafeInteger(take) || take < 1 || take > 100)
                    return yield* new ContentMigrationFailure({ reason: "invalid" });
                const current = yield* status;
                if (current.source.control === null)
                    return yield* new ContentMigrationFailure({ reason: "not-prepared" });
                if (current.target.active || current.source.control.mode !== "legacy")
                    return yield* new ContentMigrationFailure({ reason: "fenced" });
                if (current.target.sourceEpoch === null) {
                    const baseline = yield* native(ContentMigrationRecord, () =>
                        writer.migrationBaseline(),
                    );
                    yield* importRecord(baseline);
                }
                const target = yield* content.state(SITE_CONTENT_ID);
                const page = yield* native(ContentMigrationPage, () =>
                    writer.migrationEntries(target.sourceSequence, take),
                );
                for (const record of page.entries) yield* importRecord(record);
                return yield* status;
            },
            Effect.catchDefect(() => Effect.fail(failure())),
        );

        const exportPage = Effect.fn("PortfolioMigration.exportPage")(function* (
            after: number,
            take: number,
        ) {
            return yield* native(ContentMigrationPage, () => writer.migrationEntries(after, take));
        });

        const handoff = Effect.gen(function* () {
            const current = yield* status;
            const control = current.source.control;
            if (control === null)
                return yield* new ContentMigrationFailure({ reason: "not-prepared" });
            if (current.target.active) {
                if (
                    current.target.sourceEpoch !== control.epoch ||
                    current.target.sourceSequence !== control.sequence
                )
                    return yield* new ContentMigrationFailure({ reason: "conflict" });
                yield* native(ContentMigrationControl, () =>
                    writer.migrationComplete(control.epoch, control.sequence),
                );
                return yield* status;
            }
            if (!current.converged)
                return yield* new ContentMigrationFailure({ reason: "conflict" });
            const frozen = yield* native(ContentMigrationRecord, () =>
                writer.migrationFence(control.epoch, control.sequence),
            );
            const target = yield* content.state(SITE_CONTENT_ID);
            if (
                !sourceSnapshotMatches(frozen.snapshot, target) ||
                target.sourceEpoch !== frozen.epoch ||
                target.sourceSequence !== frozen.sequence
            )
                return yield* new ContentMigrationFailure({ reason: "conflict" });
            yield* content
                .send(
                    SITE_CONTENT_ID,
                    new ActivateContent({ epoch: frozen.epoch, sequence: frozen.sequence }),
                    {
                        commandId: `handoff:${frozen.epoch}:${frozen.sequence}`,
                    },
                )
                .pipe(
                    Effect.provideService(CurrentPortfolioActor, "migration"),
                    Effect.mapError(() => new ContentMigrationFailure({ reason: "conflict" })),
                );
            yield* native(ContentMigrationControl, () =>
                writer.migrationComplete(frozen.epoch, frozen.sequence),
            );
            return yield* status;
        }).pipe(
            Effect.catchDefect(() => Effect.fail(failure())),
            Effect.withSpan("PortfolioMigration.handoff"),
        );

        return PortfolioMigration.of({ prepare, importPage, status, exportPage, handoff });
    }),
);

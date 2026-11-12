import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
    ContentDecision,
    ContentSnapshot,
    Revision,
} from "@artisann-port/portfolio-domain/content/content-state";
import { decodeContentDocument } from "@artisann-port/portfolio-domain/content";
import type {
    ContentWriterStub,
    ContentWriterBinding,
    DurableObjectIdLike,
    DurableObjectStorageLike,
    DurableObjectTransactionLike,
} from "./content-writer.ts";

const CONTROL_KEY = "migration:control";
const BASELINE_KEY = "migration:baseline";
const ENTRY_PREFIX = "migration:entry:";
const MAX_PAGE_SIZE = 100;
/** Final decision markers, in storage key order: every `deleted:` key sorts first. */
const DECISION_PREFIXES = ["deleted:", "rejected:"] as const;

export const ContentMigrationControl = Schema.Struct({
    epoch: Schema.NonEmptyString,
    mode: Schema.Literals(["legacy", "fenced", "domain"]),
    sequence: Revision,
});
export type ContentMigrationControl = typeof ContentMigrationControl.Type;
/** A content snapshot plus the one decision its source mutation recorded, if any. */
export const ContentMigrationRecord = Schema.Struct({
    epoch: Schema.NonEmptyString,
    sequence: Revision,
    snapshot: ContentSnapshot,
    decision: Schema.NullOr(ContentDecision),
});
export type ContentMigrationRecord = typeof ContentMigrationRecord.Type;
export const ContentMigrationStatus = Schema.Struct({
    control: Schema.NullOr(ContentMigrationControl),
    snapshot: ContentSnapshot,
});
export type ContentMigrationStatus = typeof ContentMigrationStatus.Type;
export const ContentMigrationPage = Schema.Struct({
    entries: Schema.Array(ContentMigrationRecord),
    sequence: Revision,
});
export type ContentMigrationPage = typeof ContentMigrationPage.Type;
/** One bounded page of final decisions. `cursor` is the last marker key read. */
export const ContentDecisionPage = Schema.Struct({
    decisions: Schema.Array(ContentDecision),
    cursor: Schema.NullOr(Schema.NonEmptyString),
    complete: Schema.Boolean,
});
export type ContentDecisionPage = typeof ContentDecisionPage.Type;

export const ContentMigrationReason = Schema.Literals([
    "unavailable",
    "conflict",
    "not-prepared",
    "fenced",
    "invalid",
]);
export class ContentMigrationFailure extends Schema.TaggedError<ContentMigrationFailure>()(
    "ContentMigrationFailure",
    { reason: ContentMigrationReason },
) {}

/**
 * Durable Object RPC keeps only an error's message, so typed migration
 * failures cross the boundary as values; a rejection means the call itself failed.
 */
export type ContentMigrationResult<A> =
    | { readonly ok: true; readonly value: A }
    | { readonly ok: false; readonly reason: typeof ContentMigrationReason.Type };
export const contentMigrationResult = <A, I>(value: Schema.Codec<A, I>) =>
    Schema.Union([
        Schema.Struct({ ok: Schema.Literal(true), value }),
        Schema.Struct({ ok: Schema.Literal(false), reason: ContentMigrationReason }),
    ]);

export interface ContentMigrationSource extends ContentWriterStub {
    migrationPrepare(epoch: string): Promise<ContentMigrationResult<ContentMigrationRecord>>;
    migrationStatus(): Promise<ContentMigrationResult<ContentMigrationStatus>>;
    migrationBaseline(): Promise<ContentMigrationResult<ContentMigrationRecord>>;
    migrationEntries(
        after: number,
        take: number,
    ): Promise<ContentMigrationResult<ContentMigrationPage>>;
    migrationDecisions(
        after: string | null,
        take: number,
    ): Promise<ContentMigrationResult<ContentDecisionPage>>;
    migrationFence(
        epoch: string,
        sequence: number,
    ): Promise<ContentMigrationResult<ContentMigrationRecord>>;
    migrationComplete(
        epoch: string,
        sequence: number,
    ): Promise<ContentMigrationResult<ContentMigrationControl>>;
}

export interface ContentMigrationBinding extends ContentWriterBinding {
    get(id: DurableObjectIdLike): ContentMigrationSource;
}

function call<A>(evaluate: () => Promise<A>) {
    return Effect.tryPromise({
        try: evaluate,
        // A transaction rejects with its body's typed failure; keep that reason.
        catch: (cause) =>
            Schema.is(ContentMigrationFailure)(cause)
                ? cause
                : new ContentMigrationFailure({ reason: "unavailable" }),
    }).pipe(
        Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.fail(new ContentMigrationFailure({ reason: "unavailable" })),
        }),
    );
}

function decode<A, I>(schema: Schema.Codec<A, I>, value: I) {
    return Schema.decodeEffect(schema)(value).pipe(
        Effect.mapError(() => new ContentMigrationFailure({ reason: "unavailable" })),
    );
}

const readControl = (storage: DurableObjectTransactionLike) =>
    call(() => storage.get<ContentMigrationControl>(CONTROL_KEY)).pipe(
        Effect.flatMap((value) =>
            value === undefined ? Effect.succeed(null) : decode(ContentMigrationControl, value),
        ),
    );

const entryKey = (sequence: number) => `${ENTRY_PREFIX}${sequence.toString().padStart(16, "0")}`;

const decodeMarker = Schema.decodeUnknownEffect(ContentDecision);

const snapshot = Effect.fn("ContentMigration.snapshot")(function* (
    storage: DurableObjectTransactionLike,
) {
    const stored = yield* call(() => storage.get<Schema.Json>("state"));
    const state = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
            revision: Revision,
            publishedRevision: Revision,
            document: Schema.String,
            dirty: Schema.Boolean,
        }),
    )(stored).pipe(Effect.mapError(() => new ContentMigrationFailure({ reason: "unavailable" })));
    const content = yield* decodeContentDocument(state.document).pipe(
        Effect.mapError(() => new ContentMigrationFailure({ reason: "unavailable" })),
    );
    return yield* decode(ContentSnapshot, {
        content,
        revision: state.revision,
        publishedRevision: state.publishedRevision,
    });
});

export class ContentSourceJournal {
    constructor(private readonly storage: DurableObjectStorageLike) {}

    private transaction<A>(
        effect: (
            storage: DurableObjectTransactionLike,
        ) => Effect.Effect<A, ContentMigrationFailure>,
    ) {
        return call(() =>
            this.storage.transaction((storage) => Effect.runPromise(effect(storage))),
        );
    }

    get isLegacy() {
        return readControl(this.storage).pipe(
            Effect.map((control) => control === null || control.mode === "legacy"),
        );
    }

    /** `decision` is the final decision marker this mutation adds, if any. */
    write<A>(
        mutation: (
            storage: DurableObjectTransactionLike,
        ) => Effect.Effect<A, ContentMigrationFailure>,
        decision: ContentDecision | null = null,
    ) {
        return this.transaction((storage) =>
            Effect.gen(function* () {
                const control = yield* readControl(storage);
                if (control !== null && control.mode !== "legacy")
                    return yield* new ContentMigrationFailure({ reason: "fenced" });
                const result = yield* mutation(storage);
                if (control !== null) {
                    const sequence = control.sequence + 1;
                    const next = yield* snapshot(storage);
                    yield* call(() =>
                        storage.put(entryKey(sequence), {
                            epoch: control.epoch,
                            sequence,
                            snapshot: next,
                            decision,
                        } satisfies ContentMigrationRecord),
                    );
                    yield* call(() => storage.put(CONTROL_KEY, { ...control, sequence }));
                }
                return result;
            }),
        );
    }

    prepare(epoch: string) {
        return this.transaction((storage) =>
            Effect.gen(function* () {
                if (epoch.length === 0 || epoch.length > 128)
                    return yield* new ContentMigrationFailure({ reason: "invalid" });
                const existing = yield* readControl(storage);
                if (existing !== null) {
                    if (existing.epoch !== epoch)
                        return yield* new ContentMigrationFailure({ reason: "conflict" });
                    const baseline = yield* call(() =>
                        storage.get<ContentMigrationRecord>(BASELINE_KEY),
                    );
                    if (baseline === undefined)
                        return yield* new ContentMigrationFailure({ reason: "unavailable" });
                    return yield* decode(ContentMigrationRecord, baseline);
                }
                const baseline = {
                    epoch,
                    sequence: 0,
                    snapshot: yield* snapshot(storage),
                    decision: null,
                } satisfies ContentMigrationRecord;
                yield* call(() => storage.put(BASELINE_KEY, baseline));
                yield* call(() =>
                    storage.put(CONTROL_KEY, {
                        epoch,
                        sequence: 0,
                        mode: "legacy",
                    } satisfies ContentMigrationControl),
                );
                return baseline;
            }),
        );
    }

    readonly status = this.transaction((storage) =>
        Effect.gen(function* () {
            return {
                control: yield* readControl(storage),
                snapshot: yield* snapshot(storage),
            } satisfies ContentMigrationStatus;
        }),
    );

    readonly baseline = call(() => this.storage.get<ContentMigrationRecord>(BASELINE_KEY)).pipe(
        Effect.flatMap((record) =>
            record === undefined
                ? Effect.fail(new ContentMigrationFailure({ reason: "not-prepared" }))
                : decode(ContentMigrationRecord, record),
        ),
    );

    entries(after: number, take: number) {
        return this.transaction((storage) =>
            Effect.gen(function* () {
                if (
                    !Number.isSafeInteger(after) ||
                    after < 0 ||
                    !Number.isSafeInteger(take) ||
                    take < 1 ||
                    take > MAX_PAGE_SIZE
                )
                    return yield* new ContentMigrationFailure({ reason: "invalid" });
                const control = yield* readControl(storage);
                if (control === null)
                    return yield* new ContentMigrationFailure({ reason: "not-prepared" });
                const rows = yield* call(() =>
                    storage.list<ContentMigrationRecord>({
                        prefix: ENTRY_PREFIX,
                        startAfter: entryKey(after),
                        limit: take,
                    }),
                );
                const entries: ContentMigrationRecord[] = [];
                for (const [key, value] of rows) {
                    const record = yield* decode(ContentMigrationRecord, value);
                    if (
                        record.epoch !== control.epoch ||
                        key !== entryKey(record.sequence) ||
                        record.sequence !== after + entries.length + 1
                    )
                        return yield* new ContentMigrationFailure({ reason: "unavailable" });
                    entries.push(record);
                }
                return { entries, sequence: control.sequence } satisfies ContentMigrationPage;
            }),
        );
    }

    /**
     * Pages the live decision markers. Markers are final and never removed, and
     * capture journals each new one, so a scan started after `prepare` plus the
     * journal entries covers every decision the frozen source can hold.
     */
    decisions(after: string | null, take: number) {
        return this.transaction((storage) =>
            Effect.gen(function* () {
                if (
                    (after !== null &&
                        !DECISION_PREFIXES.some((prefix) => after.startsWith(prefix))) ||
                    !Number.isSafeInteger(take) ||
                    take < 1 ||
                    take > MAX_PAGE_SIZE
                )
                    return yield* new ContentMigrationFailure({ reason: "invalid" });
                if ((yield* readControl(storage)) === null)
                    return yield* new ContentMigrationFailure({ reason: "not-prepared" });
                const decisions: ContentDecision[] = [];
                let cursor = after;
                for (const prefix of DECISION_PREFIXES) {
                    if (cursor !== null && cursor > prefix && !cursor.startsWith(prefix)) continue;
                    const rows = yield* call(() =>
                        storage.list<Schema.Json>({
                            prefix,
                            startAfter: cursor?.startsWith(prefix) ? cursor : undefined,
                            limit: take - decisions.length,
                        }),
                    );
                    for (const [key, value] of rows) {
                        const marker = yield* decodeMarker(value).pipe(
                            Effect.mapError(
                                () => new ContentMigrationFailure({ reason: "unavailable" }),
                            ),
                        );
                        if (key !== `${prefix}${marker.id}` || `${marker.decision}:` !== prefix)
                            return yield* new ContentMigrationFailure({ reason: "unavailable" });
                        decisions.push(marker);
                        cursor = key;
                    }
                    if (decisions.length === take)
                        return { decisions, cursor, complete: false } satisfies ContentDecisionPage;
                }
                return { decisions, cursor, complete: true } satisfies ContentDecisionPage;
            }),
        );
    }

    fence(epoch: string, sequence: number) {
        return this.transaction((storage) =>
            Effect.gen(function* () {
                const control = yield* readControl(storage);
                if (control === null)
                    return yield* new ContentMigrationFailure({ reason: "not-prepared" });
                if (control.epoch !== epoch || control.sequence !== sequence)
                    return yield* new ContentMigrationFailure({ reason: "conflict" });
                const state = yield* snapshot(storage);
                if (state.publishedRevision !== state.revision)
                    return yield* new ContentMigrationFailure({ reason: "unavailable" });
                if (control.mode === "legacy")
                    yield* call(() => storage.put(CONTROL_KEY, { ...control, mode: "fenced" }));
                return {
                    epoch,
                    sequence,
                    snapshot: state,
                    decision: null,
                } satisfies ContentMigrationRecord;
            }),
        );
    }

    complete(epoch: string, sequence: number) {
        return this.transaction((storage) =>
            Effect.gen(function* () {
                const control = yield* readControl(storage);
                if (control === null)
                    return yield* new ContentMigrationFailure({ reason: "not-prepared" });
                if (
                    control.epoch !== epoch ||
                    control.sequence !== sequence ||
                    control.mode === "legacy"
                )
                    return yield* new ContentMigrationFailure({ reason: "conflict" });
                const completed: ContentMigrationControl = { ...control, mode: "domain" };
                yield* call(() => storage.put(CONTROL_KEY, completed));
                return completed;
            }),
        );
    }
}

export const sourceSnapshotMatches = Schema.toEquivalence(ContentSnapshot);

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ContentSnapshot, Revision } from "@artisann-port/portfolio-domain/content/content-state";
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

export const ContentMigrationControl = Schema.Struct({
    epoch: Schema.NonEmptyString,
    mode: Schema.Literals(["legacy", "fenced", "domain"]),
    sequence: Revision,
});
export type ContentMigrationControl = typeof ContentMigrationControl.Type;
export const ContentMigrationRecord = Schema.Struct({
    epoch: Schema.NonEmptyString,
    sequence: Revision,
    snapshot: ContentSnapshot,
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

export class ContentMigrationFailure extends Schema.TaggedError<ContentMigrationFailure>()(
    "ContentMigrationFailure",
    { reason: Schema.Literals(["unavailable", "conflict", "not-prepared", "fenced", "invalid"]) },
) {}

export interface ContentMigrationSource extends ContentWriterStub {
    migrationPrepare(epoch: string): Promise<ContentMigrationRecord>;
    migrationStatus(): Promise<ContentMigrationStatus>;
    migrationBaseline(): Promise<ContentMigrationRecord>;
    migrationEntries(after: number, take: number): Promise<ContentMigrationPage>;
    migrationFence(epoch: string, sequence: number): Promise<ContentMigrationRecord>;
    migrationComplete(epoch: string, sequence: number): Promise<ContentMigrationControl>;
}

export interface ContentMigrationBinding extends ContentWriterBinding {
    get(id: DurableObjectIdLike): ContentMigrationSource;
}

function call<A>(evaluate: () => Promise<A>) {
    return Effect.tryPromise({
        try: evaluate,
        catch: () => new ContentMigrationFailure({ reason: "unavailable" }),
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

const markerIds = Effect.fn("ContentMigration.markerIds")(function* (
    storage: DurableObjectTransactionLike,
    prefix: "rejected:" | "deleted:",
) {
    const ids: string[] = [];
    let after: string | undefined;
    while (true) {
        const rows = yield* call(() =>
            storage.list<Schema.Json>({
                prefix,
                limit: 1000,
                startAfter: after,
            }),
        );
        for (const [key, value] of rows) {
            const marker = yield* Schema.decodeUnknownEffect(
                Schema.Struct({
                    id: Schema.String,
                    decision: Schema.Literals(["rejected", "deleted"]),
                }),
            )(value).pipe(
                Effect.mapError(() => new ContentMigrationFailure({ reason: "unavailable" })),
            );
            if (key !== `${prefix}${marker.id}` || marker.decision !== prefix.slice(0, -1))
                return yield* new ContentMigrationFailure({ reason: "unavailable" });
            ids.push(marker.id);
            after = key;
        }
        if (rows.size < 1000) return ids;
    }
});

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
    const rejected = yield* markerIds(storage, "rejected:");
    const deleted = yield* markerIds(storage, "deleted:");
    return yield* decode(ContentSnapshot, {
        content,
        revision: state.revision,
        publishedRevision: state.publishedRevision,
        rejected,
        deleted,
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

    write<A>(
        mutation: (
            storage: DurableObjectTransactionLike,
        ) => Effect.Effect<A, ContentMigrationFailure>,
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
                return { epoch, sequence, snapshot: state } satisfies ContentMigrationRecord;
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

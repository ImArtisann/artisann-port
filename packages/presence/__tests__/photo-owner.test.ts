import { describe, expect, it } from "vite-plus/test";
import * as Domain from "@alchemy.run/domain";
import { PhotoOperations } from "@artisann-port/portfolio-domain/photo/photo.aggregate";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { PhotoDomainLive, PhotoDomainService } from "../src/photo-domain-service.ts";
import {
    PhotosBinding,
    PhotosConfig,
    PhotosLive,
    PhotosService,
    type PhotoStoredObject,
    type PhotosR2MutationBinding,
} from "../src/photos-service.ts";

class PhotoTestModel extends Domain.Model("PhotoOwnerTests", { aggregates: [PhotoOperations] }) {}

interface StoredPhoto extends PhotoStoredObject {
    readonly bytes: Uint8Array;
    readonly uploaded: Date;
}

class MemoryBucket implements PhotosR2MutationBinding {
    readonly objects = new Map<string, StoredPhoto>();
    puts = 0;
    deletes = 0;
    failPut: "before" | "after" | null = null;
    failDelete: "before" | "after" | null = null;
    beforePut: (() => Promise<void>) | undefined;
    afterPut: (() => Promise<void>) | undefined;

    async head(key: string) {
        return this.objects.get(key) ?? null;
    }
    async list(options: { prefix: string; cursor?: string; limit: number }) {
        return {
            objects: [...this.objects.entries()]
                .filter(([key]) => key.startsWith(options.prefix))
                .slice(0, options.limit)
                .map(([key, object]) => ({ key, uploaded: object.uploaded })),
            truncated: false as const,
        };
    }
    async put(
        key: string,
        bytes: Uint8Array,
        options: Parameters<PhotosR2MutationBinding["put"]>[2],
    ) {
        this.puts += 1;
        await this.beforePut?.();
        if (this.failPut === "before") throw new Error("private storage diagnostics");
        if (options.onlyIf !== undefined && this.objects.has(key)) return null;
        const object = {
            bytes: bytes.slice(),
            etag: `etag-${this.puts}`,
            customMetadata: options.customMetadata,
            uploaded: new Date("2026-09-10T12:00:00.000Z"),
        };
        this.objects.set(key, object);
        await this.afterPut?.();
        if (this.failPut === "after") throw new Error("private response lost");
        return object;
    }
    async delete(key: string) {
        this.deletes += 1;
        if (this.failDelete === "before") throw new Error("private storage diagnostics");
        this.objects.delete(key);
        if (this.failDelete === "after") throw new Error("private response lost");
    }
}

const KEY = "cats/12345678901234567.webp";
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const upload = {
    key: KEY,
    tag: "cats" as const,
    bytes: WEBP,
    operationId: "cats-upload:12345678901234567",
    mode: "create-only" as const,
    actor: "cats" as const,
};

function world(bucket: MemoryBucket) {
    const model = PhotoTestModel.layer(Layer.empty).pipe(Layer.provide(Domain.InMemory));
    const domain = PhotoDomainLive.pipe(Layer.provide(model));
    return PhotosLive.pipe(
        Layer.provideMerge(
            Layer.mergeAll(
                domain,
                Layer.succeed(PhotosBinding, bucket),
                Layer.succeed(PhotosConfig, { assetsHost: "assets.artisann.dev" }),
            ),
        ),
    );
}

it("recovers a lost upload response without overwriting, then distinguishes collisions", async () => {
    const bucket = new MemoryBucket();
    bucket.failPut = "after";
    await Effect.runPromise(
        Effect.gen(function* () {
            const photos = yield* PhotosService;
            const lost = yield* photos.upload(upload).pipe(Effect.flip);
            expect(lost).toMatchObject({ reason: "Uncertain", outcome: "unknown" });
            expect(bucket.objects.has(KEY)).toBe(true);
            bucket.failPut = null;
            const recovered = yield* photos.upload(upload);
            expect(recovered).toMatchObject({
                key: KEY,
                etag: "etag-1",
                url: `https://assets.artisann.dev/${KEY}`,
            });
            expect(bucket.puts).toBe(1);
            const collision = yield* photos
                .upload({ ...upload, operationId: "another-upload" })
                .pipe(Effect.flip);
            expect(collision).toMatchObject({ reason: "Collision", outcome: "not-applied" });
            expect(bucket.puts).toBe(1);
            const changedRetry = yield* photos
                .upload({ ...upload, bytes: new Uint8Array([...WEBP, 1]) })
                .pipe(Effect.flip);
            expect(changedRetry.reason).toBe("OperationConflict");
        }).pipe(Effect.provide(world(bucket))),
    );
});

/** The operator's recovery after asserting the original writer and its R2 calls stopped. */
const ownerResume = (photos: typeof PhotosService.Service, operationId: string) =>
    Effect.gen(function* () {
        const inspection = yield* photos.reconcile({
            key: KEY,
            operationId,
            actor: "owner",
            action: "inspect",
        });
        return yield* photos.reconcile({
            key: KEY,
            operationId,
            actor: "owner",
            action: "resume",
            expectedGeneration: inspection.generation,
            expectedEtag: inspection.storageEtag,
            confirmation: "original-writer-stopped",
        });
    });

it("re-executes a refused write only after the owner resumes it, and keeps the key reserved", async () => {
    const bucket = new MemoryBucket();
    bucket.failPut = "before";
    await Effect.runPromise(
        Effect.gen(function* () {
            const photos = yield* PhotosService;
            const outage = yield* photos.upload(upload).pipe(Effect.flip);
            expect(outage.reason).toBe("Uncertain");
            expect(bucket.objects.has(KEY)).toBe(false);
            const competing = yield* photos
                .upload({ ...upload, operationId: "competing-upload" })
                .pipe(Effect.flip);
            expect(competing.reason).toBe("OperationConflict");
            bucket.failPut = null;
            const unconfirmed = yield* photos.upload(upload).pipe(Effect.flip);
            expect(unconfirmed).toMatchObject({ reason: "Uncertain", outcome: "unknown" });
            expect(bucket.puts).toBe(1);
            expect(yield* ownerResume(photos, upload.operationId)).toMatchObject({
                status: "resumable",
            });
            yield* photos.upload(upload);
            expect(bucket.objects.has(KEY)).toBe(true);
            expect(bucket.puts).toBe(2);
        }).pipe(Effect.provide(world(bucket))),
    );
});

it("does not repeat a pending upload or let deletion race it", async () => {
    const bucket = new MemoryBucket();
    await Effect.runPromise(
        Effect.gen(function* () {
            const started = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            bucket.beforePut = () =>
                Effect.runPromise(
                    Effect.gen(function* () {
                        yield* Deferred.succeed(started, undefined);
                        yield* Deferred.await(release);
                    }),
                );
            const photos = yield* PhotosService;
            const writing = yield* photos.upload(upload).pipe(Effect.forkChild);
            yield* Deferred.await(started);
            const pending = yield* photos.upload(upload).pipe(Effect.flip);
            expect(pending.reason).toBe("Uncertain");
            const deletion = yield* photos
                .delete({ key: KEY, operationId: "early-delete", actor: "owner" })
                .pipe(Effect.flip);
            expect(deletion.reason).toBe("OperationConflict");
            expect(bucket.deletes).toBe(0);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(writing);
            expect(bucket.puts).toBe(1);
        }).pipe(Effect.scoped, Effect.provide(world(bucket))),
    );
});

it("recovers a lost delete response and cannot later delete a replacement", async () => {
    const bucket = new MemoryBucket();
    await Effect.runPromise(
        Effect.gen(function* () {
            const photos = yield* PhotosService;
            const original = yield* photos.upload(upload);
            const deletion = {
                key: KEY,
                operationId: "cats-rollback:12345678901234567",
                actor: "cats" as const,
                expectedEtag: original.etag,
            };
            bucket.failDelete = "after";
            const lost = yield* photos.delete(deletion).pipe(Effect.flip);
            expect(lost).toMatchObject({ reason: "Uncertain", outcome: "unknown" });
            expect(bucket.objects.has(KEY)).toBe(false);
            bucket.failDelete = null;
            yield* photos.delete(deletion);
            expect(bucket.deletes).toBe(1);
            const replacement = yield* photos.upload({
                ...upload,
                operationId: "replacement-upload",
            });
            yield* photos.delete(deletion);
            expect(bucket.objects.get(KEY)?.etag).toBe(replacement.etag);
            const late = yield* photos
                .delete({ ...deletion, operationId: "late-compensation" })
                .pipe(Effect.flip);
            expect(late.reason).toBe("OperationConflict");
            expect(bucket.deletes).toBe(1);
        }).pipe(Effect.provide(world(bucket))),
    );
});

it("retries a failed deletion after owner resume and still lists externally added managed photos", async () => {
    const bucket = new MemoryBucket();
    await Effect.runPromise(
        Effect.gen(function* () {
            const photos = yield* PhotosService;
            const stored = yield* photos.upload(upload);
            const deletion = {
                key: KEY,
                operationId: "delete-retry",
                actor: "owner" as const,
                expectedEtag: stored.etag,
            };
            bucket.failDelete = "before";
            const failed = yield* photos.delete(deletion).pipe(Effect.flip);
            expect(failed.reason).toBe("Uncertain");
            expect(bucket.objects.has(KEY)).toBe(true);
            bucket.failDelete = null;
            expect((yield* photos.delete(deletion).pipe(Effect.flip)).reason).toBe("Uncertain");
            expect(bucket.deletes).toBe(1);
            yield* ownerResume(photos, deletion.operationId);
            yield* photos.delete(deletion);
            expect(bucket.objects.has(KEY)).toBe(false);
            bucket.objects.set(KEY, {
                bytes: WEBP,
                etag: "external",
                uploaded: new Date("2026-09-11T00:00:00.000Z"),
            });
            const page = yield* photos.listPage("cats");
            expect(page.photos).toEqual([
                {
                    key: KEY,
                    url: `https://assets.artisann.dev/${KEY}`,
                    uploadedAt: "2026-09-11T00:00:00.000Z",
                },
            ]);
        }).pipe(Effect.provide(world(bucket))),
    );
});

it("lets an authenticated operator recover a crash before writing without expiring the fence", async () => {
    const bucket = new MemoryBucket();
    await Effect.runPromise(
        Effect.gen(function* () {
            const photos = yield* PhotosService;
            const domain = yield* PhotoDomainService;
            const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", WEBP));
            const hash = Array.from(new Uint8Array(digest), (byte) =>
                byte.toString(16).padStart(2, "0"),
            ).join("");
            const reservation = yield* domain.begin(upload.operationId, {
                _tag: "Upload",
                key: KEY,
                tag: "cats",
                actor: "cats",
                mode: "create-only",
                digest: hash,
                size: WEBP.byteLength,
            });
            expect((yield* photos.upload(upload).pipe(Effect.flip)).reason).toBe("Uncertain");
            const inspection = yield* photos.reconcile({
                key: KEY,
                operationId: upload.operationId,
                actor: "owner",
                action: "inspect",
            });
            expect(inspection).toMatchObject({
                status: "pending",
                evidence: "absent",
                outcome: "unknown",
            });
            const resume = {
                key: KEY,
                operationId: upload.operationId,
                actor: "owner" as const,
                action: "resume" as const,
                expectedGeneration: inspection.generation,
                expectedEtag: null,
                confirmation: "original-writer-stopped" as const,
            };
            expect(
                (yield* photos.reconcile({ ...resume, actor: "cats" }).pipe(Effect.flip)).reason,
            ).toBe("Unauthorized");
            expect(
                (yield* photos
                    .reconcile({ ...resume, expectedEtag: "stale-object" })
                    .pipe(Effect.flip)).reason,
            ).toBe("OperationConflict");
            const resumed = yield* photos.reconcile(resume);
            expect(resumed).toMatchObject({ status: "resumable", outcome: "unknown" });
            expect((yield* photos.reconcile(resume).pipe(Effect.flip)).reason).toBe(
                "OperationConflict",
            );
            expect(
                (yield* domain
                    .authorize(KEY, upload.operationId, reservation.operation.generation)
                    .pipe(Effect.flip)).reason,
            ).toBe("OperationConflict");
            yield* photos.upload(upload);
            expect(bucket.puts).toBe(1);

            const deletionId = "crashed-deletion";
            yield* domain.begin(deletionId, {
                _tag: "Delete",
                key: KEY,
                actor: "owner",
                expectedEtag: null,
            });
            const beforeAbort = yield* photos.reconcile({
                key: KEY,
                operationId: deletionId,
                actor: "owner",
                action: "inspect",
            });
            const aborted = yield* photos.reconcile({
                key: KEY,
                operationId: deletionId,
                actor: "owner",
                action: "abort",
                expectedGeneration: beforeAbort.generation,
                expectedEtag: beforeAbort.storageEtag,
                confirmation: "original-writer-stopped",
            });
            expect(aborted).toMatchObject({ status: "aborted", outcome: "unknown" });
            yield* photos.upload({
                ...upload,
                operationId: "after-abort",
                actor: "owner",
                mode: "replace",
            });
            expect(bucket.puts).toBe(2);
            expect(bucket.deletes).toBe(0);
        }).pipe(Effect.provide(world(bucket))),
    );
});

it("confirms R2 evidence after a writer crash without another upload", async () => {
    const bucket = new MemoryBucket();
    await Effect.runPromise(
        Effect.gen(function* () {
            const stored = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            bucket.afterPut = () =>
                Effect.runPromise(
                    Effect.gen(function* () {
                        yield* Deferred.succeed(stored, undefined);
                        yield* Deferred.await(release);
                    }),
                );
            const photos = yield* PhotosService;
            const interrupted = yield* photos.upload(upload).pipe(Effect.forkChild);
            yield* Deferred.await(stored);
            yield* Fiber.interrupt(interrupted);
            const inspection = yield* photos.reconcile({
                key: KEY,
                operationId: upload.operationId,
                actor: "owner",
                action: "inspect",
            });
            expect(inspection).toMatchObject({
                status: "pending",
                evidence: "upload-confirmed",
                storageEtag: "etag-1",
            });
            const discardConfirmed = yield* photos
                .reconcile({
                    key: KEY,
                    operationId: upload.operationId,
                    actor: "owner",
                    action: "abort",
                    expectedGeneration: inspection.generation,
                    expectedEtag: inspection.storageEtag,
                    confirmation: "original-writer-stopped",
                })
                .pipe(Effect.flip);
            expect(discardConfirmed.reason).toBe("OperationConflict");
            const recovered = yield* photos.reconcile({
                key: KEY,
                operationId: upload.operationId,
                actor: "owner",
                action: "recover-confirmed",
                expectedGeneration: inspection.generation,
                expectedEtag: inspection.storageEtag,
            });
            expect(recovered).toMatchObject({ status: "uploaded", outcome: "applied" });
            yield* Deferred.succeed(release, undefined);
            const retry = yield* photos.upload(upload);
            expect(retry.etag).toBe("etag-1");
            expect(bucket.puts).toBe(1);
        }).pipe(Effect.scoped, Effect.provide(world(bucket))),
    );
});

describe("writer validation", () => {
    it("refuses invalid WebP, mismatched tags and bytes above 32 MiB without storage writes", async () => {
        const bucket = new MemoryBucket();
        await Effect.runPromise(
            Effect.gen(function* () {
                const photos = yield* PhotosService;
                expect(
                    (yield* photos
                        .upload({ ...upload, bytes: new Uint8Array(12) })
                        .pipe(Effect.flip)).reason,
                ).toBe("InvalidImage");
                expect(
                    (yield* photos.upload({ ...upload, tag: "life" }).pipe(Effect.flip)).reason,
                ).toBe("InvalidKey");
                expect(
                    (yield* photos
                        .upload({ ...upload, bytes: new Uint8Array(32 * 1024 * 1024 + 1) })
                        .pipe(Effect.flip)).reason,
                ).toBe("TooLarge");
                expect(bucket.puts).toBe(0);
            }).pipe(Effect.provide(world(bucket))),
        );
    });
});

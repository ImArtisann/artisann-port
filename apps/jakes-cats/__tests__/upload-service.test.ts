/**
 * Upload rollback. An upload writes its WebP to R2 and then claims the key in
 * D1; when the claim fails, the object must not stay live under a key the site
 * never published, and the rollback must not be able to touch an object this
 * upload did not write.
 *
 * R2, Images, and D1 are doubles here — the bucket models R2's create-only
 * semantics, so a dropped precondition shows up as a successful overwrite
 * rather than an echo of the options the service passed.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Random from "effect/Random";
import type { ImagesBinding } from "@cloudflare/workers-types";
import type { PhotoTag, PhotosR2Page } from "@artisann-port/presence/photos";
import { MAX_UPLOAD_BYTES } from "../src/contracts.ts";
import type { PhotosR2MutationBinding } from "../src/env.ts";
import { PhotosBinding, PhotosConfig } from "../src/server/deck-service.ts";
import { HeartsError, HeartsService, type HeartsOperations } from "../src/server/hearts-service.ts";
import {
    UploadError,
    UploadImages,
    UploadLive,
    UploadService,
} from "../src/server/upload-service.ts";

const ASSETS_HOST = "assets.example.com";

/** A minimal WebP header: `RIFF` + size + `WEBP`, which is all the upload inspects. */
const WEBP_BYTES = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

/**
 * An in-memory bucket with R2's create-only semantics: `alreadyHolds` models a
 * key that is already taken, where a conditional put resolves `null` and an
 * unconditional one would overwrite what is there. `putScript` orders the
 * first writes when a test needs one collision or one outage rather than a
 * bucket-wide state: `"collide"` resolves `null` like a taken key, `"fail"`
 * rejects the way an R2 error does.
 */
class FakeBucket implements PhotosR2MutationBinding {
    readonly objects = new Map<string, Uint8Array>();
    readonly putKeys: Array<string> = [];
    readonly deleteKeys: Array<string> = [];
    readonly putScript: Array<"collide" | "fail"> = [];
    alreadyHolds = false;
    failDeletes = false;

    list(): Promise<PhotosR2Page> {
        return Promise.resolve({ objects: [], truncated: false });
    }

    put(
        key: string,
        value: Uint8Array,
        options: R2PutOptions & { readonly onlyIf: R2Conditional | Headers },
    ): Promise<R2Object | null>;
    put(key: string, value: Uint8Array, options?: R2PutOptions): Promise<R2Object>;
    async put(key: string, value: Uint8Array, options?: R2PutOptions): Promise<R2Object | null> {
        this.putKeys.push(key);
        const scripted = this.putScript.shift();
        if (scripted === "fail") throw new Error("R2 put failed.");
        const onlyIf = options?.onlyIf;
        const createOnly =
            onlyIf !== undefined && "etagDoesNotMatch" in onlyIf && onlyIf.etagDoesNotMatch === "*";
        if (scripted === "collide" || (this.alreadyHolds && createOnly)) return null;
        this.objects.set(key, Uint8Array.from(value));
        // SAFETY: `R2Object` is assignable to `{ key: string }`, so this narrows
        // to a shape the assertion cannot overstate; only `null` is ever read.
        return { key } as R2Object;
    }

    head(key: string): Promise<R2Object | null> {
        // SAFETY: as above — the key is the only member the upload path reads.
        return Promise.resolve(this.objects.has(key) ? ({ key } as R2Object) : null);
    }

    async delete(keys: string | Array<string>): Promise<void> {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const key of list) this.deleteKeys.push(key);
        if (this.failDeletes) throw new Error("R2 delete failed.");
        for (const key of list) this.objects.delete(key);
    }
}

/**
 * The transform handle the upload walks: `transform` through to the encoded
 * bytes. It stands in for the Images binding, whose stream declarations differ
 * between the Workers and DOM libs while the runtime value is the same.
 */
class StubTransformer {
    constructor(private readonly encoded: Uint8Array<ArrayBuffer>) {}

    transform(): StubTransformer {
        return this;
    }

    draw(): StubTransformer {
        return this;
    }

    output() {
        const encoded = this.encoded;
        return Promise.resolve({
            response: () => new Response(encoded),
            contentType: () => "image/webp",
            image: () =>
                new ReadableStream<Uint8Array>({
                    start: (controller) => {
                        controller.enqueue(encoded);
                        controller.close();
                    },
                }),
        });
    }
}

/** The Images double: whatever bytes arrive, it answers with WebP bytes. */
function imagesDouble(encoded: Uint8Array<ArrayBuffer>): ImagesBinding {
    const transformer = new StubTransformer(encoded);
    // SAFETY: the upload path reaches only `input(...).transform(...).output(...)`;
    // the Images members this double omits (`info`, `text`, `hosted`) never run,
    // and the Workers/DOM stream declarations bridge at runtime, not in the value.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    return { input: () => transformer } as unknown as ImagesBinding;
}

/** A D1 claim that fails on demand and records every key it accepted. */
class ScriptedHearts implements HeartsOperations {
    fails = false;
    readonly registered: Array<{
        readonly key: string;
        readonly tag: PhotoTag;
        readonly uploadedAt: string;
    }> = [];
    private readonly unimplemented = Effect.die("Not part of the upload path.");

    readonly countsFor: HeartsOperations["countsFor"] = () => this.unimplemented;
    readonly heartedBy: HeartsOperations["heartedBy"] = () => this.unimplemented;
    readonly heart: HeartsOperations["heart"] = () => this.unimplemented;
    readonly commentsFor: HeartsOperations["commentsFor"] = () => this.unimplemented;
    readonly addComment: HeartsOperations["addComment"] = () => this.unimplemented;
    readonly register: HeartsOperations["register"] = (key, tag, uploadedAt) => {
        if (this.fails) return Effect.fail(new HeartsError({ operation: "register" }));
        return Effect.sync(() => {
            this.registered.push({ key, tag, uploadedAt });
        });
    };
}

interface UploadWorld {
    readonly bucket: FakeBucket;
    readonly hearts: ScriptedHearts;
    readonly images: ImagesBinding;
    readonly logs: Array<ReadonlyArray<unknown>>;
}

function makeWorld(): UploadWorld {
    return {
        bucket: new FakeBucket(),
        hearts: new ScriptedHearts(),
        images: imagesDouble(WEBP_BYTES),
        logs: [],
    };
}

/** The production upload service over the doubles, with its logs captured. */
function runUpload<A, E>(
    world: UploadWorld,
    effect: Effect.Effect<A, E, UploadService>,
): Promise<A> {
    const logger = Logger.make<unknown, void>((options) => {
        const message = options.message;
        world.logs.push(Array.isArray(message) ? message : [message]);
    });
    const dependencies = Layer.mergeAll(
        Layer.succeed(UploadImages, world.images),
        Layer.succeed(PhotosBinding, world.bucket),
        Layer.succeed(PhotosConfig, { assetsHost: ASSETS_HOST }),
        Layer.succeed(HeartsService, world.hearts),
    );
    // One flat graph: the capture logger has to sit beside the upload service,
    // not under it, or it never sees what the upload itself logs.
    const runtime = Layer.merge(
        UploadLive.pipe(Layer.provide(dependencies)),
        Logger.layer([logger]),
    );
    return Effect.runPromise(effect.pipe(Effect.provide(runtime)));
}

/** The failure the upload surfaced, which is what an HTTP handler would map. */
function runUploadFailure(
    world: UploadWorld,
    effect: Effect.Effect<unknown, UploadError, UploadService>,
): Promise<UploadError> {
    return runUpload(
        world,
        Effect.match(effect, {
            onFailure: (error) => error,
            onSuccess: () => {
                throw new Error("Expected the upload to fail.");
            },
        }),
    );
}

const upload = (tag: PhotoTag, body: Uint8Array | ReadableStream<Uint8Array>) =>
    Effect.flatMap(UploadService, (service) => service.upload(tag, body));

/** A body that keeps producing chunks until the cap refuses it. */
function oversizedStream(chunkSize: number, chunks: number): ReadableStream<Uint8Array> {
    const chunk = new Uint8Array(chunkSize);
    let produced = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (produced >= chunks) {
                controller.close();
                return;
            }
            produced += 1;
            controller.enqueue(chunk);
        },
    });
}

describe("UploadService rollback", () => {
    it("deletes its object when the registration fails", async () => {
        const world = makeWorld();
        world.hearts.fails = true;

        const failure = await runUploadFailure(world, upload("cats", WEBP_BYTES));

        expect(failure.reason).toBe("Unavailable");
        expect(world.bucket.putKeys).toHaveLength(1);
        expect(world.bucket.deleteKeys).toEqual(world.bucket.putKeys);
        expect(world.bucket.objects.size).toBe(0);
        expect(world.hearts.registered).toEqual([]);
    });

    it("keeps its object when the registration succeeds", async () => {
        const world = makeWorld();

        const stored = await runUpload(world, upload("cats", WEBP_BYTES));

        expect(world.bucket.objects.has(stored.key)).toBe(true);
        expect(world.bucket.deleteKeys).toEqual([]);
        expect(world.hearts.registered.map((row) => row.key)).toEqual([stored.key]);
        expect(world.hearts.registered[0]?.tag).toBe("cats");
        expect(stored.likes).toBe(0);
    });

    it("leaves nothing behind for a retry after a failed registration", async () => {
        const world = makeWorld();
        world.hearts.fails = true;
        await runUploadFailure(world, upload("cats", WEBP_BYTES));

        world.hearts.fails = false;
        const stored = await runUpload(world, upload("cats", WEBP_BYTES));

        expect(world.bucket.putKeys).toHaveLength(2);
        expect(world.bucket.deleteKeys).toEqual([world.bucket.putKeys[0]]);
        expect(world.bucket.objects.size).toBe(1);
        expect(world.bucket.objects.has(stored.key)).toBe(true);
    });

    it("retries a colliding create-only write with a freshly minted id", async () => {
        const world = makeWorld();
        world.bucket.putScript.push("collide");

        // The seed fixes every id this upload mints, so the two attempts are
        // asserted distinct by construction rather than by hoping the live
        // clock and entropy happen to differ.
        const stored = await runUpload(
            world,
            upload("cats", WEBP_BYTES).pipe(Random.withSeed("jakes-cats-collision")),
        );

        expect(world.bucket.putKeys).toHaveLength(2);
        expect(world.bucket.putKeys[0]).not.toBe(world.bucket.putKeys[1]);
        expect(stored.key).toBe(world.bucket.putKeys[1]);
        expect(world.bucket.objects.has(stored.key)).toBe(true);
        expect(world.bucket.deleteKeys).toEqual([]);
        expect(world.hearts.registered.map((row) => row.key)).toEqual([stored.key]);
    });

    it("gives up after bounded collisions and never deletes the key it collided with", async () => {
        const world = makeWorld();
        const takenKey = "cats/000000000000000001.webp";
        world.bucket.objects.set(takenKey, new Uint8Array([0x01]));
        world.bucket.alreadyHolds = true;

        const failure = await runUploadFailure(world, upload("cats", WEBP_BYTES));

        expect(failure.reason).toBe("Unavailable");
        expect(world.bucket.putKeys).toHaveLength(3);
        expect(world.bucket.deleteKeys).toEqual([]);
        expect(world.bucket.objects.get(takenKey)).toEqual(new Uint8Array([0x01]));
        expect(world.hearts.registered).toEqual([]);
    });

    it("does not retry a create-only write that threw", async () => {
        const world = makeWorld();
        world.bucket.putScript.push("fail");

        const failure = await runUploadFailure(world, upload("cats", WEBP_BYTES));

        expect(failure.reason).toBe("Unavailable");
        expect(world.bucket.putKeys).toHaveLength(1);
        expect(world.bucket.deleteKeys).toEqual([]);
        expect(world.bucket.objects.size).toBe(0);
        expect(world.hearts.registered).toEqual([]);
    });

    it("refuses bytes past the size cap before storing anything", async () => {
        const world = makeWorld();

        const failure = await runUploadFailure(
            world,
            upload("cats", oversizedStream(4 * 1024 * 1024, 6)),
        );

        expect(failure.reason).toBe("TooLarge");
        expect(world.bucket.putKeys).toEqual([]);
        expect(world.bucket.objects.size).toBe(0);
    });

    it("still refuses when the raw bytes are one buffer past the cap", async () => {
        const world = makeWorld();

        const failure = await runUploadFailure(
            world,
            upload("cats", new Uint8Array(MAX_UPLOAD_BYTES + 1)),
        );

        expect(failure.reason).toBe("TooLarge");
        expect(world.bucket.putKeys).toEqual([]);
    });

    it("surfaces Unavailable and logs when the rollback itself fails", async () => {
        const world = makeWorld();
        world.hearts.fails = true;
        world.bucket.failDeletes = true;

        const failure = await runUploadFailure(world, upload("cats", WEBP_BYTES));

        expect(failure.reason).toBe("Unavailable");
        expect(world.bucket.deleteKeys).toEqual(world.bucket.putKeys);
        // The deletion failed, so the object is still there: that is the
        // documented orphan, and the log is the only trace of it.
        expect(world.bucket.objects.has(world.bucket.putKeys[0] ?? "")).toBe(true);
        expect(world.logs.flat()).toContain("Upload rollback failed");
        expect(world.logs.flat()).toContain(world.bucket.putKeys[0]);
    });
});

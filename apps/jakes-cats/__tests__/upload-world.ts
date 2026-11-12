import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PhotoOwnerClient, PhotoMutationError } from "@artisann-port/presence/photo-owner-client";
import { UploadImages, UploadLive } from "../src/server/upload-service.ts";
import { catsWorld } from "./cats-world.ts";

export const WEBP_BYTES = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
]);
export function uploadWorld() {
    const base = catsWorld();
    base.installCapture();
    const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
    const uploads: Array<string> = [];
    const deletes: Array<string> = [];
    const received: Array<Array<number>> = [];
    const script = {
        collideOnce: false,
        uncertainOnce: false,
        failDelete: false,
        invalidImage: false,
        transforms: 0,
        uploads,
        deletes,
        received,
    };
    const owner = Layer.succeed(PhotoOwnerClient, {
        upload: (input) =>
            Effect.suspend(() => {
                script.uploads.push(input.key);
                if (script.collideOnce) {
                    script.collideOnce = false;
                    objects.set(input.key, { bytes: new Uint8Array([9, 8, 7]), etag: "original" });
                    base.objects.set(input.key, new Date());
                }
                if (objects.has(input.key))
                    return Effect.fail(
                        new PhotoMutationError({ reason: "Collision", outcome: "not-applied" }),
                    );
                const etag = `etag-${input.key}`;
                objects.set(input.key, { bytes: Uint8Array.from(input.bytes), etag });
                base.objects.set(input.key, new Date());
                if (script.uncertainOnce) {
                    script.uncertainOnce = false;
                    return Effect.fail(
                        new PhotoMutationError({ reason: "Uncertain", outcome: "unknown" }),
                    );
                }
                return Effect.succeed({
                    key: input.key,
                    tag: input.tag,
                    operationId: input.operationId,
                    url: `https://assets.example.com/${input.key}`,
                    etag,
                });
            }),
        delete: (input) =>
            Effect.suspend(() => {
                script.deletes.push(input.key);
                if (script.failDelete)
                    return Effect.fail(
                        new PhotoMutationError({ reason: "Unavailable", outcome: "not-applied" }),
                    );
                if (objects.get(input.key)?.etag !== input.expectedEtag)
                    return Effect.fail(
                        new PhotoMutationError({
                            reason: "OperationConflict",
                            outcome: "not-applied",
                        }),
                    );
                objects.delete(input.key);
                base.objects.delete(input.key);
                return Effect.succeed({ key: input.key, operationId: input.operationId });
            }),
    });
    const images = Layer.succeed(UploadImages, {
        input: (stream) => ({
            transform: () => {
                script.transforms++;
                return {
                    output: async () => {
                        const reader = stream.getReader();
                        const input: Array<number> = [];
                        try {
                            while (true) {
                                const chunk = await reader.read();
                                if (chunk.done) break;
                                for (const byte of chunk.value) input.push(byte);
                            }
                        } finally {
                            reader.releaseLock();
                        }
                        received.push(input);
                        return {
                            response: () => ({
                                arrayBuffer: () =>
                                    Promise.resolve(
                                        Uint8Array.from(
                                            script.invalidImage ? [1, 2, 3] : WEBP_BYTES,
                                        ).buffer,
                                    ),
                            }),
                        };
                    },
                };
            },
        }),
    });
    const layer = UploadLive.pipe(Layer.provideMerge(Layer.mergeAll(base.layer, owner, images)));
    return { ...base, layer, objects, script };
}

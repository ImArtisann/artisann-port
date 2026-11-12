import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { collectPhotos, type Photo, type PhotoTag } from "@artisann-port/presence/photos";
import {
    BotPortfolioClient,
    BotStorageError,
    boundedApiOperation,
    type ApiStorageFailure,
} from "./portfolio-client.ts";

export interface BotPhotoClientService {
    readonly listPhotos: (tag: PhotoTag) => Effect.Effect<ReadonlyArray<Photo>, BotStorageError>;
    readonly putPhoto: (
        tag: PhotoTag,
        interactionId: string,
        bytes: Uint8Array,
    ) => Effect.Effect<string, BotStorageError>;
    readonly deletePhoto: (tag: PhotoTag, photoId: string) => Effect.Effect<void, BotStorageError>;
}

export class BotPhotoClient extends Context.Service<BotPhotoClient, BotPhotoClientService>()(
    "Discord.BotPhotoClient",
) {}

export const BotPhotoClientLive: Layer.Layer<BotPhotoClient, never, BotPortfolioClient> =
    Layer.effect(
        BotPhotoClient,
        Effect.gen(function* () {
            const clients = yield* BotPortfolioClient;
            const listPhotos = Effect.fn("BotPhotoClient.listPhotos")(function* (tag: PhotoTag) {
                return yield* boundedApiOperation(
                    "listPhotos",
                    collectPhotos<ApiStorageFailure, never>(tag, (cursor) =>
                        clients.photoPage(tag, cursor),
                    ),
                );
            });
            const putPhoto = Effect.fn("BotPhotoClient.putPhoto")(function* (
                tag: PhotoTag,
                interactionId: string,
                bytes: Uint8Array,
            ) {
                return yield* boundedApiOperation(
                    "putPhoto",
                    clients.uploadPhoto(tag, interactionId, bytes),
                );
            });
            const deletePhoto = Effect.fn("BotPhotoClient.deletePhoto")(function* (
                tag: PhotoTag,
                photoId: string,
            ) {
                const operationId = `discord:delete:${yield* Effect.sync(() => crypto.randomUUID())}`;
                yield* boundedApiOperation(
                    "deletePhoto",
                    clients.deletePhoto(tag, photoId, operationId),
                ).pipe(
                    // Unknown outcomes can keep the key reserved; reconciliation needs this ID.
                    Effect.mapError((error) =>
                        error.status === null
                            ? new BotStorageError({ ...error, operationId })
                            : error,
                    ),
                    Effect.tapError((error) =>
                        error.operationId === undefined
                            ? Effect.void
                            : Effect.logWarning("Photo deletion outcome unknown").pipe(
                                  Effect.annotateLogs({
                                      key: `${tag}/${photoId}.webp`,
                                      operationId,
                                  }),
                              ),
                    ),
                );
            });
            return BotPhotoClient.of({ listPhotos, putPhoto, deletePhoto });
        }),
    );

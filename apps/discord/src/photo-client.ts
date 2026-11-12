import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { collectPhotos, type Photo, type PhotoTag } from "@artisann-port/presence/photos";
import {
    BotPortfolioClient,
    boundedApiOperation,
    type BotStorageError,
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
                yield* boundedApiOperation("deletePhoto", clients.deletePhoto(tag, photoId));
            });
            return BotPhotoClient.of({ listPhotos, putPhoto, deletePhoto });
        }),
    );

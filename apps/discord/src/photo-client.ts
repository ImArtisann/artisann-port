import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ApiUnavailable } from "@artisann-port/presence/api-errors";
import {
    collectPhotos,
    type Photo,
    type PhotoPage,
    type PhotoTag,
} from "@artisann-port/presence/photos";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { BotRpcClients, boundedRpcOperation, type BotStorageError } from "./rpc-client.ts";

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

export const BotPhotoClientLive: Layer.Layer<BotPhotoClient, never, BotRpcClients> = Layer.effect(
    BotPhotoClient,
    Effect.gen(function* () {
        const clients = yield* BotRpcClients;
        const listPhotos = Effect.fn("BotPhotoClient.listPhotos")(function* (tag: PhotoTag) {
            return yield* boundedRpcOperation(
                "listPhotos",
                collectPhotos<ApiUnavailable | RpcClientError, never>(
                    tag,
                    (
                        cursor: string | undefined,
                    ): Effect.Effect<PhotoPage, ApiUnavailable | RpcClientError> => {
                        const payload = cursor === undefined ? { tag } : { tag, cursor };
                        return clients.public("photos.list", payload);
                    },
                ),
            );
        });
        const putPhoto = Effect.fn("BotPhotoClient.putPhoto")(function* (
            tag: PhotoTag,
            interactionId: string,
            bytes: Uint8Array,
        ) {
            return yield* boundedRpcOperation(
                "putPhoto",
                clients.writer("photos.upload", { tag, interactionId, bytes }),
            );
        });
        const deletePhoto = Effect.fn("BotPhotoClient.deletePhoto")(function* (
            tag: PhotoTag,
            photoId: string,
        ) {
            yield* boundedRpcOperation(
                "deletePhoto",
                clients.writer("photos.delete", { tag, photoId }),
            );
        });
        return BotPhotoClient.of({ listPhotos, putPhoto, deletePhoto });
    }),
);

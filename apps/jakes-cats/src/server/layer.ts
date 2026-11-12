import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { PhotoOwnerClientLive, PhotoOwnerConfig } from "@artisann-port/presence/photo-owner-client";
import type { CatsWorkerEnv } from "../env.ts";
import { DeckLive, PhotosBinding, PhotosConfig } from "./deck-service.ts";
import { HeartLive, RateLimitBinding } from "./heart-service.ts";
import { HeartsBinding, HeartsLive } from "./hearts-service.ts";
import { MigrationLive } from "./migration-service.ts";
import { ModerationLive } from "./moderation-service.ts";
import { UploadImages, UploadLive } from "./upload-service.ts";

export function makeServerLayer(env: CatsWorkerEnv) {
    const capabilities = Layer.mergeAll(
        Layer.succeed(HeartsBinding, env.LIKES),
        Layer.succeed(PhotosBinding, env.PHOTOS),
        Layer.succeed(UploadImages, env.IMAGES),
        Layer.succeed(RateLimitBinding, env.VISITOR_RATE_LIMIT),
        Layer.succeed(PhotosConfig, { assetsHost: env.ASSETS_HOST }),
        Layer.succeed(PhotoOwnerConfig, {
            origin: env.PORTFOLIO_ORIGIN,
            token: Redacted.make(env.CONTENT_WRITER_TOKEN),
        }),
        FetchHttpClient.layer,
    );
    const storage = Layer.mergeAll(HeartsLive, MigrationLive).pipe(
        Layer.provideMerge(capabilities),
    );
    const adapters = Layer.mergeAll(ModerationLive, PhotoOwnerClientLive).pipe(
        Layer.provideMerge(storage),
    );
    return Layer.mergeAll(DeckLive, HeartLive, UploadLive).pipe(Layer.provideMerge(adapters));
}

/**
 * Composition root for this site's server calls: one layer per process that
 * captures the live Worker bindings and hands the deck, heart, and upload
 * services their capabilities. Domain modules hold no storage setup.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { env, type CatsWorkerEnv } from "../env.ts";
import { DeckLive, DeckService, PhotosBinding, PhotosConfig } from "./deck-service.ts";
import { HeartLive, HeartService, RateLimitBinding } from "./heart-service.ts";
import { HeartsBinding, HeartsLive } from "./hearts-service.ts";
import { ModerationLive } from "./moderation-service.ts";
import { UploadImages, UploadLive, UploadService } from "./upload-service.ts";

/** Every service a server-side call may require. */
export type ServerServices = DeckService | HeartService | UploadService;

/** Acquisition captures native capabilities, never declares resources or starts I/O. */
export function makeServerLayer(workerEnv: CatsWorkerEnv): Layer.Layer<ServerServices> {
    const capabilities = Layer.mergeAll(
        Layer.succeed(HeartsBinding, workerEnv.LIKES),
        Layer.succeed(PhotosBinding, workerEnv.PHOTOS),
        Layer.succeed(UploadImages, workerEnv.IMAGES),
        Layer.succeed(RateLimitBinding, workerEnv.VISITOR_RATE_LIMIT),
        Layer.succeed(PhotosConfig, { assetsHost: workerEnv.ASSETS_HOST }),
    );

    // Hearts is built first so the deck, the heart action, and uploads can depend on it.
    const hearts = HeartsLive.pipe(Layer.provide(capabilities));
    // Moderation reaches profanity.dev through the Worker's global fetch.
    const moderation = ModerationLive.pipe(Layer.provide(FetchHttpClient.layer));

    return Layer.mergeAll(DeckLive, HeartLive, UploadLive).pipe(
        Layer.provide(Layer.mergeAll(capabilities, hearts, moderation)),
    );
}

/** Run one server effect against the live Worker bindings. */
export function runServer<A, E>(effect: Effect.Effect<A, E, ServerServices>): Promise<A> {
    return Effect.runPromise(effect.pipe(Effect.provide(makeServerLayer(env))));
}

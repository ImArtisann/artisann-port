/** Server-only native request and scheduled adapters; domain implementations own all I/O. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
    GITHUB_CRON,
    NOTES_RPC_PATH,
    PRESENCE_WEBSOCKET_PATH,
    PUBLIC_RPC_PATH,
    WRITER_RPC_PATH,
} from "./config.ts";
import { readContent } from "./content.ts";
import {
    CONTENT_WRITER_OBJECT_NAME,
    type ContentWriterBinding,
    type ContentWriterStub,
} from "./content-writer.ts";
import { CmsBindings, CmsContentLive } from "./cms-service.ts";
import { GithubBinding, GithubLive, refreshGithub } from "./github.ts";
import {
    NotesConfig,
    NotesLive,
    NotesRateLimit,
    type NotesRateLimitBinding,
    type NotesWorkerEnv,
} from "./notes-service.ts";
import {
    PhotosBinding,
    PhotosConfig,
    PhotosLive,
    type PhotosR2MutationBinding,
} from "./photos-service.ts";
import {
    PRESENCE_OBJECT_NAME,
    PresenceBinding,
    PresenceLive,
    type PresenceNamespace,
    type PresenceStub,
} from "./presence-service.ts";
import { projectPreviewResponse, type ProjectImageCache } from "./project-preview.ts";
import { handleRpcRequest } from "./rpc-server.ts";
import type { PresenceKvBinding } from "./store.ts";
import { WeatherLive } from "./weather-service.ts";

declare const caches: { readonly default: ProjectImageCache };

export interface WorkerDomainBindings {
    readonly snapshots: PresenceKvBinding;
    readonly photos: PhotosR2MutationBinding;
    readonly assetsHost: string;
    readonly contentWriter: ContentWriterStub;
    readonly presence: PresenceStub;
    readonly notesRateLimit: NotesRateLimitBinding;
    readonly websiteOrigin: string;
    readonly notesChannelId: string;
    readonly notesWebhookUrl: Redacted.Redacted<string>;
    readonly turnstileSecretKey: Redacted.Redacted<string>;
}

/** Acquisition captures native capabilities, never declares resources or starts I/O. */
export function makeWorkerLayer(env: WorkerDomainBindings) {
    const capabilities = Layer.mergeAll(
        Layer.succeed(CmsBindings, { snapshots: env.snapshots, writer: env.contentWriter }),
        Layer.succeed(PresenceBinding, env.presence),
        Layer.succeed(PhotosBinding, env.photos),
        Layer.succeed(PhotosConfig, { assetsHost: env.assetsHost }),
        Layer.succeed(GithubBinding, env.snapshots),
        Layer.succeed(NotesRateLimit, { binding: env.notesRateLimit }),
        Layer.succeed(NotesConfig, {
            websiteOrigin: env.websiteOrigin,
            discordNotesChannelId: env.notesChannelId,
            discordNotesWebhookUrl: env.notesWebhookUrl,
            turnstileSecretKey: env.turnstileSecretKey,
        }),
        FetchHttpClient.layer,
    );
    return Layer.mergeAll(
        CmsContentLive,
        PresenceLive,
        PhotosLive,
        GithubLive,
        NotesLive,
        WeatherLive,
    ).pipe(Layer.provide(capabilities));
}

export interface PresenceWorkerEnv extends NotesWorkerEnv {
    readonly PRESENCE: PresenceNamespace;
    readonly PRESENCE_KV: PresenceKvBinding;
    readonly PORT_GITHUB_TOKEN: string;
    readonly PHOTOS: PhotosR2MutationBinding;
    readonly ASSETS_HOST: string;
    readonly CONTENT_WRITER: ContentWriterBinding;
    readonly CONTENT_WRITER_TOKEN?: string;
}

export interface PresenceScheduledController {
    readonly cron: string;
    readonly scheduledTime: number;
}

export default {
    fetch(request: Request, env: PresenceWorkerEnv): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === PUBLIC_RPC_PATH || path === NOTES_RPC_PATH || path === WRITER_RPC_PATH) {
            const domains = makeWorkerLayer({
                snapshots: env.PRESENCE_KV,
                photos: env.PHOTOS,
                assetsHost: env.ASSETS_HOST,
                contentWriter: env.CONTENT_WRITER.get(
                    env.CONTENT_WRITER.idFromName(CONTENT_WRITER_OBJECT_NAME),
                ),
                presence: env.PRESENCE.get(env.PRESENCE.idFromName(PRESENCE_OBJECT_NAME)),
                notesRateLimit: env.NOTES_RATE_LIMIT,
                websiteOrigin: env.WEBSITE_ORIGIN,
                notesChannelId: env.DISCORD_NOTES_CHANNEL_ID,
                notesWebhookUrl: Redacted.make(env.DISCORD_NOTES_WEBHOOK_URL),
                turnstileSecretKey: Redacted.make(env.TURNSTILE_SECRET_KEY),
            });
            return handleRpcRequest(request, domains, {
                writerToken: Redacted.make(env.CONTENT_WRITER_TOKEN ?? ""),
                websiteOrigin: env.WEBSITE_ORIGIN,
            });
        }
        if (path === PRESENCE_WEBSOCKET_PATH) {
            if (request.method !== "GET")
                return Promise.resolve(new Response(null, { status: 405 }));
            if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
                return Promise.resolve(new Response(null, { status: 426 }));
            return env.PRESENCE.get(env.PRESENCE.idFromName(PRESENCE_OBJECT_NAME)).fetch(request);
        }
        if (path.startsWith("/projects/")) {
            return Effect.runPromise(
                readContent(env.PRESENCE_KV).pipe(
                    Effect.flatMap((content) =>
                        projectPreviewResponse(request, caches.default, content),
                    ),
                    Effect.tapError(() =>
                        Effect.logWarning("Project Open Graph preview unavailable"),
                    ),
                    Effect.orElseSucceed(
                        () =>
                            new Response(null, {
                                status: 502,
                                headers: { "cache-control": "no-store" },
                            }),
                    ),
                    Effect.provide(FetchHttpClient.layer),
                ),
            );
        }
        return Promise.resolve(
            new Response(null, { status: 404, headers: { "cache-control": "no-store" } }),
        );
    },
    scheduled(controller: PresenceScheduledController, env: PresenceWorkerEnv): Promise<void> {
        if (controller.cron !== GITHUB_CRON) return Promise.resolve();
        return Effect.runPromise(
            refreshGithub(env.PRESENCE_KV, Redacted.make(env.PORT_GITHUB_TOKEN)).pipe(
                Effect.provide(FetchHttpClient.layer),
            ),
        ).then(() => undefined);
    },
};

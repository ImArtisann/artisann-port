/**
 * The presence Worker: a public, read-only JSON endpoint plus the one-minute
 * cron that keeps the snapshot current.
 *
 * Snapshot routes only read KV. Project previews fill the edge image cache
 * on a miss; they never write to KV or R2.
 *
 * `scheduled` is the sole regular writer. Failed refreshes propagate to
 * Cloudflare without overwriting the last successful snapshot.
 *
 * The handlers are exported so they can be driven directly — with an in-memory
 * store and a stubbed fetch — without deploying anything.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { GITHUB_CRON, PRESENCE_CACHE_CONTROL } from "./config.ts";
import { readGithub, refreshGithub } from "./github.ts";
import { readPresence, refreshPresence } from "./presence.ts";
import { kvPresenceStore } from "./store.ts";
import type { PresenceKvBinding, PresenceStore } from "./store.ts";
import { projectPreviewResponse, type ProjectImageCache } from "./project-preview.ts";

declare const caches: { readonly default: ProjectImageCache };

/** Bindings this Worker is deployed with; see `alchemy.run.ts`. */
export interface PresenceWorkerEnv {
    readonly PRESENCE_KV: PresenceKvBinding;
    readonly PORT_GITHUB_TOKEN: string;
}

/** The part of Cloudflare's scheduled event this Worker is handed. */
export interface PresenceScheduledController {
    readonly cron: string;
    readonly scheduledTime: number;
}

/**
 * Public read: any origin, `GET`/`HEAD` only. There is no request body, no
 * query parameter and no write path, so the Worker cannot be used as a proxy
 * for anything but its own snapshot.
 */
const CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-max-age": "86400",
} as const;

/** Serve the snapshot for one request. Reads only. */
export const handlePresenceRequest = Effect.fn("Presence.handleRequest")(function* (
    request: Request,
    store: PresenceStore,
    namespace: PresenceKvBinding,
) {
    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, {
            status: 405,
            headers: { ...CORS_HEADERS, allow: "GET, HEAD, OPTIONS" },
        });
    }
    const path = new URL(request.url).pathname;
    if (path === "/github") {
        const calendar = yield* readGithub(namespace).pipe(
            Effect.tapError(() => Effect.logError("GitHub: cached calendar read failed")),
            Effect.option,
        );
        if (Option.isNone(calendar) || calendar.value === null) {
            return new Response(null, { status: 503, headers: CORS_HEADERS });
        }
        return new Response(request.method === "HEAD" ? null : JSON.stringify(calendar.value), {
            headers: {
                ...CORS_HEADERS,
                "content-type": "application/json; charset=utf-8",
                "cache-control": "public, max-age=60",
            },
        });
    }
    if (path !== "/") {
        return new Response(null, { status: 404, headers: CORS_HEADERS });
    }

    const snapshot = yield* readPresence(store).pipe(
        Effect.tapError((error) => Effect.logError("Presence: snapshot read failed", error)),
        Effect.option,
    );
    if (Option.isNone(snapshot)) {
        return new Response(null, { status: 503, headers: CORS_HEADERS });
    }
    const body = JSON.stringify(snapshot.value);
    return new Response(request.method === "HEAD" ? null : body, {
        status: 200,
        headers: {
            ...CORS_HEADERS,
            "content-type": "application/json; charset=utf-8",
            "cache-control": PRESENCE_CACHE_CONTROL,
        },
    });
});

/** Preserve the cache on failure and let Cloudflare record the failed run. */
export const handlePresenceSchedule = Effect.fn("Presence.handleSchedule")(function* (
    store: PresenceStore,
) {
    yield* refreshPresence(store);
});

export default {
    fetch(request: Request, env: PresenceWorkerEnv): Promise<Response> {
        if (new URL(request.url).pathname.startsWith("/projects/")) {
            return Effect.runPromise(
                projectPreviewResponse(request, caches.default).pipe(
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
        return Effect.runPromise(
            handlePresenceRequest(request, kvPresenceStore(env.PRESENCE_KV), env.PRESENCE_KV),
        );
    },
    scheduled(controller: PresenceScheduledController, env: PresenceWorkerEnv): Promise<void> {
        if (controller.cron === GITHUB_CRON) {
            return Effect.runPromise(
                refreshGithub(env.PRESENCE_KV, Redacted.make(env.PORT_GITHUB_TOKEN)).pipe(
                    Effect.map(() => undefined),
                    Effect.provide(FetchHttpClient.layer),
                ),
            );
        }
        return Effect.runPromise(
            handlePresenceSchedule(kvPresenceStore(env.PRESENCE_KV)).pipe(
                Effect.annotateLogs({ cron: controller.cron }),
                Effect.provide(FetchHttpClient.layer),
            ),
        );
    },
};

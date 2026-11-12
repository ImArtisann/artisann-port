import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { GITHUB_CRON, PRESENCE_WEBSOCKET_PATH } from "./config.ts";
import { refreshGithub } from "./github.ts";
import { PRESENCE_OBJECT_NAME, type PresenceNamespace } from "./presence-service.ts";
import type { PresenceKvBinding } from "./store.ts";

export interface PresenceWorkerEnv {
    readonly PRESENCE: PresenceNamespace;
    readonly PRESENCE_KV: PresenceKvBinding;
    readonly PORT_GITHUB_TOKEN: string;
    readonly PORTFOLIO_DOMAIN: { readonly fetch: (request: Request) => Promise<Response> };
}
export interface PresenceScheduledController {
    readonly cron: string;
    readonly scheduledTime: number;
}

export default {
    fetch(request: Request, env: PresenceWorkerEnv): Promise<Response> {
        if (new URL(request.url).pathname === PRESENCE_WEBSOCKET_PATH) {
            if (request.method !== "GET")
                return Promise.resolve(new Response(null, { status: 405 }));
            if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
                return Promise.resolve(new Response(null, { status: 426 }));
            return env.PRESENCE.get(env.PRESENCE.idFromName(PRESENCE_OBJECT_NAME)).fetch(request);
        }
        return env.PORTFOLIO_DOMAIN.fetch(request);
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

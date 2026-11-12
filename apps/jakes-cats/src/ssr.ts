import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Server from "foldkit/experimental/server";
import { Flags, init } from "./App.ts";
import { view } from "./view.ts";
import { loadPage, pageFailure } from "./page.ts";
import { SITE_OG_IMAGE_URL } from "./contracts.ts";

export interface CatsBinding {
    readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface CatsWorkerEnv {
    readonly CATS: CatsBinding;
}

export interface CatsRenderedApplication extends Server.RenderedApplication {
    readonly social?: { readonly image: string; readonly alt: string };
}

/** The generated Foldkit Worker calls this boundary before document assembly. */
export const handleCatsRequest = (
    request: Request,
    env: CatsWorkerEnv,
): Promise<Server.EntryResult> => {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        return env.CATS.fetch(request).then(Server.Responded);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
        return Promise.resolve(
            Server.Responded(
                new Response("Method Not Allowed", {
                    status: 405,
                    headers: { allow: "GET, HEAD" },
                }),
            ),
        );
    }
    const cookies: string[] = [];
    const transport = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request, _url, signal) =>
            HttpClientRequest.toWeb(request, { signal }).pipe(
                Effect.flatMap((native) => Effect.tryPromise(() => env.CATS.fetch(native))),
                Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
                Effect.mapError(
                    (cause) =>
                        new HttpClientError.HttpClientError({
                            reason: new HttpClientError.TransportError({ request, cause }),
                        }),
                ),
            ),
        ),
    );
    return Effect.runPromise(
        Effect.gen(function* () {
            const now = yield* Effect.clockWith((clock) =>
                Effect.succeed(clock.currentTimeMillisUnsafe()),
            );
            const flags = yield* loadPage(url.pathname, now, {
                origin: url.origin,
                cookie: request.headers.get("cookie") ?? "",
                onSetCookie: (cookie) => cookies.push(cookie),
            }).pipe(Effect.catch(() => Effect.succeed(pageFailure(url.pathname, now))));
            const application = yield* Server.renderToString({ Flags, init, view }, { flags });
            const photo = flags.detail?.photo;
            const rendered: CatsRenderedApplication = {
                ...application,
                social: {
                    image: photo?.url ?? SITE_OG_IMAGE_URL,
                    alt:
                        photo === undefined
                            ? "Pixel-art cats — Jake's Cats, created by artisann"
                            : "A cat",
                },
            };
            const headers = new Headers({ "cache-control": "private, no-store" });
            for (const cookie of cookies) headers.append("set-cookie", cookie);
            return Server.Rendered(rendered, {
                status: flags.kind === "NotFound" ? 404 : flags.phase === "Failed" ? 503 : 200,
                headers,
            });
        }).pipe(Effect.provide(transport)),
    );
};

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { loadPage } from "../src/page.ts";

const ID = "123456789012345678";
const photo = {
    key: `cats/${ID}.webp`,
    url: `https://assets.artisann.dev/cats/${ID}.webp`,
    likes: 2,
    hearted: false,
};

const load = (path: string, requested: Array<string>) =>
    Effect.runPromise(
        loadPage(path, 0, { origin: "https://jakes.cat" }).pipe(
            Effect.provide(
                Layer.succeed(
                    HttpClient.HttpClient,
                    HttpClient.make((request, url) =>
                        Effect.sync(() => {
                            requested.push(url.pathname);
                            const body =
                                url.pathname === "/api/top"
                                    ? { entries: [{ rank: 1, photo }] }
                                    : { photo, comments: [] };
                            return HttpClientResponse.fromWeb(request, Response.json(body));
                        }),
                    ),
                ),
            ),
        ),
    );

describe("Cats page routing", () => {
    it("loads the leaderboard and photo pages from trailing-slash URLs", async () => {
        const requested: Array<string> = [];
        const top = await load("/top/", requested);
        const detail = await load(`/photos/${ID}/`, requested);
        expect(top).toMatchObject({ kind: "Top", path: "/top", entries: [{ rank: 1, photo }] });
        expect(detail).toMatchObject({ kind: "Photo", detail: { photo, comments: [] } });
        expect(requested).toEqual(["/api/top", `/api/photo/${ID}`]);
    });
});

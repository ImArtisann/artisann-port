import * as Effect from "effect/Effect";
import { makeCatsHttp, type CatsHttpOptions } from "./api.ts";
import { emptyPage, type Page } from "./app-state.ts";

export const loadPage = Effect.fn("CatsPage.load")((
    path: string,
    now: number,
    options: CatsHttpOptions,
) => {
    const page = emptyPage(path, now);
    const api = makeCatsHttp(options);
    if (page.kind === "Home")
        return api.deck().pipe(Effect.map((data): Page => ({ ...page, photos: data.photos })));
    if (page.kind === "Top")
        return api.top().pipe(Effect.map((data): Page => ({ ...page, entries: data.entries })));
    if (page.kind === "Photo")
        return api.photo(path.slice("/photos/".length)).pipe(
            Effect.map((detail): Page => ({ ...page, detail })),
            Effect.catchTag("CatsApiFailure", (error) =>
                error.status === 404
                    ? Effect.succeed<Page>({ ...page, kind: "NotFound" })
                    : Effect.fail(error),
            ),
        );
    return Effect.succeed(page);
});

export const pageFailure = (path: string, now: number): Page => ({
    ...emptyPage(path, now),
    phase: "Failed",
});

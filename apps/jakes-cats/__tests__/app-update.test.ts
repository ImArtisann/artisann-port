import { describe, expect, it } from "vite-plus/test";
import { init, update } from "../src/App.ts";
import type { Message, Model, Page } from "../src/app-state.ts";
import type { DeckPhoto } from "../src/contracts.ts";

const photo: DeckPhoto = {
    key: "cats/123456789012345678.webp",
    url: "https://assets.artisann.dev/cats/123456789012345678.webp",
    likes: 1,
    hearted: false,
};

const home = (photos: ReadonlyArray<DeckPhoto>): Page => ({
    path: "/",
    kind: "Home",
    phase: "Ready",
    photos,
    entries: [],
    detail: null,
    now: 0,
});

const run = (messages: ReadonlyArray<Message>): Model =>
    messages.reduce((model, message) => update(model, message).model, init(home([photo])).model);

describe("Cats page state", () => {
    it("keeps a heart confirmed during a page load that returns the pre-heart photo", () => {
        const model = run([
            { _tag: "Heart" },
            { _tag: "LoadPage", path: "/", scroll: 0 },
            { _tag: "HeartSucceeded", key: photo.key, likes: 2 },
            { _tag: "PageLoaded", generation: 1, page: home([photo]) },
        ]);
        expect(model.page.photos).toEqual([{ ...photo, hearted: true, likes: 2 }]);
        expect(model.pendingHearts).toEqual({});
    });

    it("renders a previously failed image again after loading another page", () => {
        const model = run([
            { _tag: "ImageFailed", key: photo.key },
            { _tag: "LoadPage", path: "/", scroll: 0 },
            { _tag: "PageLoaded", generation: 1, page: home([photo]) },
        ]);
        expect(model.failedImages).toEqual([]);
    });
});

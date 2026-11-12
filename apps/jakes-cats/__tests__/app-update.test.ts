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

    it("keeps an uncertain heart pending and reads it back instead of undoing it", () => {
        const failed = update(run([{ _tag: "Heart" }]), {
            _tag: "HeartFailed",
            key: photo.key,
            message: "Request unavailable",
            uncertain: true,
            observedLikes: null,
        });
        expect(failed.commands?.map((command) => command.name)).toEqual(["ReconcileHeart"]);
        expect(failed.model.page.photos).toEqual([{ ...photo, hearted: true, likes: 2 }]);
        expect(failed.model.toast).toBeNull();
        // A count update alone cannot settle the uncertainty.
        const counted = update(failed.model, { _tag: "CountChanged", key: photo.key, likes: 2 });
        expect(Object.keys(counted.model.pendingHearts)).toEqual([photo.key]);
        const stored = update(counted.model, {
            _tag: "HeartReconciled",
            key: photo.key,
            hearted: true,
            likes: 2,
            message: "Request unavailable",
        }).model;
        expect(stored.page.photos).toEqual([{ ...photo, hearted: true, likes: 2 }]);
        expect(stored.pendingHearts).toEqual({});
        // Not stored: drop the optimistic heart but keep other visitors' hearts from the read-back.
        const missing = update(failed.model, {
            _tag: "HeartReconciled",
            key: photo.key,
            hearted: false,
            likes: 4,
            message: "Request unavailable",
        }).model;
        expect(missing.page.photos).toEqual([{ ...photo, likes: 4 }]);
        expect(missing.toast).toBe("Request unavailable");
        // A newer observed count than the read-back still wins.
        const newer = update(
            update(failed.model, { _tag: "CountChanged", key: photo.key, likes: 5 }).model,
            {
                _tag: "HeartReconciled",
                key: photo.key,
                hearted: false,
                likes: 4,
                message: "Request unavailable",
            },
        ).model;
        expect(newer.page.photos).toEqual([{ ...photo, likes: 5 }]);
    });

    it("never lowers a confirmed count when an older count arrives", () => {
        const model = run([
            { _tag: "Heart" },
            { _tag: "HeartSucceeded", key: photo.key, likes: 3 },
            { _tag: "CountChanged", key: photo.key, likes: 2 },
        ]);
        expect(model.page.photos).toEqual([{ ...photo, hearted: true, likes: 3 }]);
    });
});

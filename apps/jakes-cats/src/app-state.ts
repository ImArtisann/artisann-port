import * as Schema from "effect/Schema";
import { DeckPhoto, LeaderboardEntry, PhotoComment, PhotoDetail } from "./contracts.ts";

export const Page = Schema.Struct({
    path: Schema.String,
    kind: Schema.Literals(["Home", "Top", "Photo", "NotFound"]),
    phase: Schema.Literals(["Ready", "Loading", "Failed"]),
    photos: Schema.Array(DeckPhoto),
    entries: Schema.Array(LeaderboardEntry),
    detail: Schema.NullOr(PhotoDetail),
    now: Schema.Number,
});
export type Page = typeof Page.Type;
export const Flags = Page;
export type Flags = Page;

export const Model = Schema.Struct({
    page: Page,
    index: Schema.Number,
    generation: Schema.Number,
    scroll: Schema.Number,
    busy: Schema.Boolean,
    draft: Schema.String,
    sending: Schema.Boolean,
    toast: Schema.NullOr(Schema.String),
    announcement: Schema.String,
    failedImages: Schema.Array(Schema.String),
    pendingHearts: Schema.Record(
        Schema.String,
        Schema.Struct({
            before: DeckPhoto,
            latest: Schema.NullOr(Schema.Number),
            /** Confirmed while a page load was in flight; that load can predate the heart. */
            settled: Schema.Boolean,
        }),
    ),
});
export type Model = typeof Model.Type;

export const Swiped = Schema.TaggedStruct("Swiped", {
    direction: Schema.Literals(["left", "right"]),
    generation: Schema.Number,
    turn: Schema.Number,
});
export const RequestedSwipe = Schema.TaggedStruct("RequestedSwipe", {
    direction: Schema.Literals(["left", "right"]),
});
export const Message = Schema.Union([
    RequestedSwipe,
    Swiped,
    Schema.TaggedStruct("Heart", {}),
    Schema.TaggedStruct("HeartSucceeded", { key: Schema.String, likes: Schema.Number }),
    Schema.TaggedStruct("HeartFailed", { key: Schema.String, message: Schema.String }),
    Schema.TaggedStruct("CountChanged", { key: Schema.String, likes: Schema.Number }),
    Schema.TaggedStruct("DraftChanged", { body: Schema.String }),
    Schema.TaggedStruct("PostComment", {}),
    Schema.TaggedStruct("CommentSucceeded", {
        generation: Schema.Number,
        submitted: Schema.String,
        comment: PhotoComment,
    }),
    Schema.TaggedStruct("CommentFailed", { generation: Schema.Number, message: Schema.String }),
    Schema.TaggedStruct("Navigate", { href: Schema.String, external: Schema.Boolean }),
    Schema.TaggedStruct("LoadPage", { path: Schema.String, scroll: Schema.Number }),
    Schema.TaggedStruct("PageLoaded", { generation: Schema.Number, page: Page }),
    Schema.TaggedStruct("Retry", {}),
    Schema.TaggedStruct("ImageFailed", { key: Schema.String }),
    Schema.TaggedStruct("DismissToast", {}),
    Schema.TaggedStruct("Tick", { now: Schema.Number }),
    Schema.TaggedStruct("Noop", {}),
]);
export type Message = typeof Message.Type;

export const emptyPage = (rawPath: string, now: number): Page => {
    // Like the retired router, a non-root trailing slash does not change the route.
    const path = rawPath.replace(/(?<=.)\/+$/u, "");
    return {
        path,
        kind:
            path === "/"
                ? "Home"
                : path === "/top"
                  ? "Top"
                  : /^\/photos\/[0-9]{17,20}$/u.test(path)
                    ? "Photo"
                    : "NotFound",
        phase: "Ready",
        photos: [],
        entries: [],
        detail: null,
        now,
    };
};

export const currentPhoto = (model: Model) =>
    model.page.kind === "Home"
        ? model.page.photos[model.index % model.page.photos.length]
        : model.page.detail?.photo;

import { CatsApi } from "@artisann-port/cats-domain/cats.api";
import * as DomainFoldkit from "@alchemy.run/domain/Foldkit";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/http/HttpClient";
import { Navigation, Subscription, Url, type Command, type Update } from "foldkit";
import { catsHttp } from "./api.ts";
import {
    currentPhoto,
    emptyPage,
    type Flags,
    type Model,
    type Message,
    type Page,
} from "./app-state.ts";
import { MAX_COMMENTS_PER_PHOTO, photoIdFromKey, type DeckPhoto } from "./contracts.ts";
import { exitCard } from "./components/deck-motion.ts";
import { failureMessage } from "./components/toast-message.ts";
import { loadPage, pageFailure } from "./page.ts";
import { restoreScroll, rememberScroll, readScroll, trackScroll } from "./scroll.ts";
import { syncSocialMetadata } from "./metadata.ts";
export { Flags, Model } from "./app-state.ts";
export { view } from "./view.ts";

type CatsResources = Effect.Services<typeof CatsApi.Client>;
type AppUpdate = Update.Return<Model, Message, HttpClient.HttpClient>;

export const init = (flags: Flags): AppUpdate => ({
    model: {
        page: flags,
        index: 0,
        generation: 0,
        scroll: 0,
        busy: false,
        draft: "",
        sending: false,
        toast: null,
        announcement: "",
        failedImages: [],
        pendingHearts: {},
    },
    commands: [
        { name: "RestoreInitialScroll", effect: Effect.suspend(() => restoreScroll(readScroll())) },
    ],
});

const mapPhotos = (page: Page, f: (photo: DeckPhoto) => DeckPhoto): Page => ({
    ...page,
    photos: page.photos.map(f),
    entries: page.entries.map((entry) => ({ ...entry, photo: f(entry.photo) })),
    detail: page.detail === null ? null : { ...page.detail, photo: f(page.detail.photo) },
});

const heart = (model: Model, photo: DeckPhoto): AppUpdate => {
    if (photo.hearted || model.pendingHearts[photo.key] !== undefined) return { model };
    return {
        model: {
            ...model,
            page: mapPhotos(model.page, (entry) =>
                entry.key === photo.key
                    ? { ...entry, hearted: true, likes: entry.likes + 1 }
                    : entry,
            ),
            pendingHearts: {
                ...model.pendingHearts,
                [photo.key]: { before: photo, latest: null, settled: false },
            },
        },
        commands: [
            {
                name: "HeartPhoto",
                effect: catsHttp.heart({ key: photo.key }).pipe(
                    Effect.match({
                        onSuccess: (result): Message => ({
                            _tag: "HeartSucceeded",
                            key: result.key,
                            likes: result.likes,
                        }),
                        onFailure: (error): Message => ({
                            _tag: "HeartFailed",
                            key: photo.key,
                            message: failureMessage(error),
                            uncertain: error.status === 0 || error.status >= 500,
                            observedLikes: null,
                        }),
                    }),
                ),
            },
        ],
    };
};

/** Read the visitor's stored heart back; a failed read leaves nothing proven. */
const reconcileHeart = (
    key: string,
    message: string,
): Command.Command<Message, never, HttpClient.HttpClient> => {
    const id = photoIdFromKey(key);
    const unresolved: Message = {
        _tag: "HeartFailed",
        key,
        message,
        uncertain: false,
        observedLikes: null,
    };
    return {
        name: "ReconcileHeart",
        effect:
            id === null
                ? Effect.succeed(unresolved)
                : catsHttp.photo(id).pipe(
                      Effect.match({
                          onSuccess: ({ photo }): Message => ({
                              _tag: "HeartReconciled",
                              key,
                              hearted: photo.hearted,
                              likes: photo.likes,
                              message,
                          }),
                          onFailure: () => unresolved,
                      }),
                  ),
    };
};

const fetchPage = (
    path: string,
    generation: number,
): Command.Command<Message, never, HttpClient.HttpClient> => ({
    name: "LoadPage",
    effect: Effect.gen(function* () {
        const now = yield* Effect.clockWith((clock) =>
            Effect.succeed(clock.currentTimeMillisUnsafe()),
        );
        const page = yield* loadPage(path, now, { origin: "" }).pipe(
            Effect.catch(() => Effect.succeed(pageFailure(path, now))),
        );
        return { _tag: "PageLoaded", generation, page } satisfies Message;
    }),
});

export const update = (model: Model, message: Message): AppUpdate => {
    switch (message._tag) {
        case "RequestedSwipe": {
            const photo = currentPhoto(model);
            if (model.page.kind !== "Home" || model.busy || photo === undefined) return { model };
            return {
                model: { ...model, busy: true },
                commands: [
                    {
                        name: "ExitCard",
                        effect: exitCard(message.direction, model.generation, model.index),
                    },
                ],
            };
        }
        case "Swiped": {
            if (
                !model.busy ||
                model.page.kind !== "Home" ||
                message.generation !== model.generation ||
                message.turn !== model.index
            )
                return { model };
            const photo = currentPhoto(model);
            if (photo === undefined) return { model: { ...model, busy: false } };
            const result = message.direction === "right" ? heart(model, photo) : { model };
            return {
                ...result,
                model: { ...result.model, busy: false, index: model.index + 1 },
            };
        }
        case "Heart": {
            const photo = currentPhoto(model);
            return photo === undefined ? { model } : heart(model, photo);
        }
        case "HeartSucceeded": {
            const pending = model.pendingHearts[message.key];
            if (pending === undefined || pending.settled) return { model };
            const pendingHearts = { ...model.pendingHearts };
            const likes = Math.max(message.likes, pending.latest ?? 0);
            if (model.page.phase === "Loading")
                pendingHearts[message.key] = { ...pending, latest: likes, settled: true };
            else delete pendingHearts[message.key];
            return {
                model: {
                    ...model,
                    pendingHearts,
                    announcement: `Hearted. ${likes} ${likes === 1 ? "heart" : "hearts"} so far.`,
                    page: mapPhotos(model.page, (photo) =>
                        photo.key === message.key ? { ...photo, likes, hearted: true } : photo,
                    ),
                },
            };
        }
        case "HeartFailed": {
            const pending = model.pendingHearts[message.key];
            if (pending === undefined) return { model };
            // The heart may already be stored: keep it pending until the read-back decides.
            if (message.uncertain)
                return { model, commands: [reconcileHeart(message.key, message.message)] };
            const pendingHearts = { ...model.pendingHearts };
            delete pendingHearts[message.key];
            return {
                model: {
                    ...model,
                    pendingHearts,
                    toast: message.message,
                    page: mapPhotos(model.page, (photo) =>
                        photo.key === message.key
                            ? {
                                  ...photo,
                                  // Hearts are append-only: keep the newest count observed.
                                  likes: Math.max(
                                      pending.latest ?? pending.before.likes,
                                      message.observedLikes ?? 0,
                                  ),
                                  hearted: false,
                              }
                            : photo,
                    ),
                },
            };
        }
        case "HeartReconciled":
            return message.hearted
                ? update(model, { _tag: "HeartSucceeded", key: message.key, likes: message.likes })
                : update(model, {
                      _tag: "HeartFailed",
                      key: message.key,
                      message: message.message,
                      uncertain: false,
                      observedLikes: message.likes,
                  });
        case "CountChanged": {
            const pending = model.pendingHearts[message.key];
            return {
                model: {
                    ...model,
                    pendingHearts:
                        pending === undefined
                            ? model.pendingHearts
                            : {
                                  ...model.pendingHearts,
                                  [message.key]: { ...pending, latest: message.likes },
                              },
                    // Hearts are append-only, so a late count can never lower the displayed one.
                    page: mapPhotos(model.page, (photo) =>
                        photo.key === message.key
                            ? { ...photo, likes: Math.max(photo.likes, message.likes) }
                            : photo,
                    ),
                },
            };
        }
        case "DraftChanged":
            return { model: { ...model, draft: message.body } };
        case "PostComment": {
            const photo = model.page.detail?.photo;
            if (photo === undefined || model.sending || model.draft.trim().length === 0)
                return { model };
            const submitted = model.draft;
            return {
                model: { ...model, sending: true },
                commands: [
                    {
                        name: "PostComment",
                        effect: catsHttp.comment({ key: photo.key, body: submitted.trim() }).pipe(
                            Effect.match({
                                onSuccess: ({ comment }): Message => ({
                                    _tag: "CommentSucceeded",
                                    generation: model.generation,
                                    submitted,
                                    comment,
                                }),
                                onFailure: (error): Message => ({
                                    _tag: "CommentFailed",
                                    generation: model.generation,
                                    message: failureMessage(error),
                                }),
                            }),
                        ),
                    },
                ],
            };
        }
        case "CommentSucceeded": {
            if (message.generation !== model.generation || model.page.detail === null)
                return { model };
            return {
                model: {
                    ...model,
                    sending: false,
                    draft: model.draft === message.submitted ? "" : model.draft,
                    page: {
                        ...model.page,
                        detail: {
                            ...model.page.detail,
                            comments: [
                                message.comment,
                                ...model.page.detail.comments.filter(
                                    (comment) => comment.id !== message.comment.id,
                                ),
                            ].slice(0, MAX_COMMENTS_PER_PHOTO),
                        },
                    },
                },
            };
        }
        case "CommentFailed":
            return message.generation !== model.generation
                ? { model }
                : { model: { ...model, sending: false, toast: message.message } };
        case "Retry":
            return update(model, { _tag: "LoadPage", path: model.page.path, scroll: model.scroll });
        case "Navigate":
            return {
                model,
                commands: [
                    {
                        name: "Navigate",
                        effect: (message.external
                            ? Navigation.load(message.href)
                            : rememberScroll.pipe(Effect.andThen(Navigation.pushUrl(message.href)))
                        ).pipe(Effect.as<Message>({ _tag: "Noop" })),
                    },
                ],
            };
        case "LoadPage": {
            const generation = model.generation + 1;
            return {
                model: {
                    ...model,
                    generation,
                    scroll: message.scroll,
                    page: { ...emptyPage(message.path, model.page.now), phase: "Loading" },
                    index: 0,
                    busy: false,
                    draft: "",
                    sending: false,
                    toast: null,
                    failedImages: [],
                },
                commands: [fetchPage(message.path, generation)],
            };
        }
        case "PageLoaded": {
            if (message.generation !== model.generation) return { model };
            const page = mapPhotos(message.page, (photo) => {
                const pending = model.pendingHearts[photo.key];
                return pending === undefined
                    ? photo
                    : {
                          ...photo,
                          hearted: true,
                          likes: Math.max(
                              photo.likes,
                              pending.before.likes + 1,
                              pending.settled ? (pending.latest ?? 0) : 0,
                          ),
                      };
            });
            const pendingHearts = Object.fromEntries(
                Object.entries(model.pendingHearts).filter(([, pending]) => !pending.settled),
            );
            return {
                model: { ...model, page, pendingHearts },
                commands: [
                    { name: "RestoreScroll", effect: restoreScroll(model.scroll) },
                    { name: "SyncSocialMetadata", effect: syncSocialMetadata(page) },
                ],
            };
        }
        case "ImageFailed":
            return { model: { ...model, failedImages: [...model.failedImages, message.key] } };
        case "DismissToast":
            return { model: { ...model, toast: null } };
        case "Tick":
            return { model: { ...model, page: { ...model.page, now: message.now } } };
        case "Noop":
            return { model };
    }
};

const Counts = DomainFoldkit.make(CatsApi);
export const subscriptions = Subscription.make<Model, Message, CatsResources>()((entry) => ({
    counts: entry(
        { key: Schema.String, enabled: Schema.Boolean },
        {
            modelToDependencies: (model) => ({
                key: currentPhoto(model)?.key ?? "",
                enabled: model.page.phase === "Ready" && currentPhoto(model) !== undefined,
            }),
            dependenciesToStream: ({ key, enabled }) =>
                !enabled
                    ? Stream.empty
                    : Counts.PhotoCounts.watch<Model, Message>({
                          key: () => key,
                          toMessage: ({ state }): Message =>
                              Option.isSome(state)
                                  ? { _tag: "CountChanged", key, likes: state.value.likes }
                                  : { _tag: "Noop" },
                          onFailure: (): Message => ({ _tag: "Noop" }),
                          onDefect: (): Message => ({ _tag: "Noop" }),
                      }).dependenciesToStream({ key, isEnabled: true }),
        },
    ),
    keyboard: entry(
        { enabled: Schema.Boolean },
        {
            modelToDependencies: (model) => ({
                enabled: model.page.kind === "Home" && model.page.phase === "Ready",
            }),
            dependenciesToStream: ({ enabled }) =>
                enabled
                    ? Stream.callback<Message>((queue) =>
                          Effect.acquireRelease(
                              Effect.sync(() => {
                                  const handler = (event: KeyboardEvent) => {
                                      if (event.altKey || event.ctrlKey || event.metaKey) return;
                                      if (
                                          event.target instanceof Element &&
                                          event.target.closest(
                                              "button,a,input,textarea,select,[contenteditable]",
                                          )
                                      )
                                          return;
                                      const direction =
                                          event.key === "ArrowLeft"
                                              ? "left"
                                              : event.key === "ArrowRight" || event.key === "Enter"
                                                ? "right"
                                                : null;
                                      if (direction === null) return;
                                      event.preventDefault();
                                      Queue.offerUnsafe(queue, {
                                          _tag: "RequestedSwipe",
                                          direction,
                                      });
                                  };
                                  document.addEventListener("keydown", handler);
                                  return handler;
                              }),
                              (handler) =>
                                  Effect.sync(() =>
                                      document.removeEventListener("keydown", handler),
                                  ),
                          ),
                      )
                    : Stream.empty,
        },
    ),
    toast: entry(
        { message: Schema.NullOr(Schema.String) },
        {
            modelToDependencies: (model) => ({ message: model.toast }),
            dependenciesToStream: ({ message }) =>
                message === null
                    ? Stream.empty
                    : Stream.fromEffect(
                          Effect.sleep("3200 millis").pipe(
                              Effect.as<Message>({ _tag: "DismissToast" }),
                          ),
                      ),
        },
    ),
    scroll: entry(
        { enabled: Schema.Boolean },
        {
            modelToDependencies: (model) => ({ enabled: model.page.phase !== "Loading" }),
            dependenciesToStream: ({ enabled }) => (enabled ? trackScroll : Stream.empty),
        },
    ),
    clock: Subscription.persistentEntry(
        Stream.tick("1 minute").pipe(
            Stream.mapEffect(() =>
                Effect.clockWith((clock) =>
                    Effect.succeed<Message>({ _tag: "Tick", now: clock.currentTimeMillisUnsafe() }),
                ),
            ),
        ),
    ),
}));

export const routing = {
    onUrlRequest: (request: Navigation.UrlRequest): Message => {
        return request._tag === "External"
            ? { _tag: "Navigate", href: request.href, external: true }
            : { _tag: "Navigate", href: Url.toString(request.url), external: false };
    },
    onUrlChange: (url: Url.Url): Message => ({
        _tag: "LoadPage",
        path: url.pathname,
        scroll: readScroll(),
    }),
};

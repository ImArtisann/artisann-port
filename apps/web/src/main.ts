import * as DomainFoldkit from "@alchemy.run/domain/Foldkit";
import { PortfolioApi } from "@artisann-port/portfolio-domain/portfolio.api";
import { SiteContent } from "@artisann-port/portfolio-domain/content";
import { Weather } from "@artisann-port/presence/api";
import { GithubSnapshot } from "@artisann-port/presence/github-schema";
import { Photo, PhotoTag } from "@artisann-port/presence/photos";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Mount, Subscription, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import * as Gallery from "./components/gallery.ts";
import * as Notes from "./components/notes.ts";
import { PortfolioHttp } from "./lib/api-client.ts";
import { projectImageSource } from "./lib/project-image.ts";
import { INITIAL_PRESENCE, PresenceState, presenceStream } from "./lib/presence-client.ts";

export const Flags = Schema.Struct({
    content: SiteContent,
    siteKey: Schema.String,
    composerEnabled: Schema.Boolean,
    year: Schema.Number,
});
export type Flags = typeof Flags.Type;
export const Model = Schema.Struct({
    content: SiteContent,
    revision: Schema.Number,
    watchEnabled: Schema.Boolean,
    theme: Schema.Literals(["dark", "light"]),
    year: Schema.Number,
    appId: Schema.NullOr(Schema.String),
    openSourceId: Schema.NullOr(Schema.String),
    appDirection: Schema.Number,
    openSourceDirection: Schema.Number,
    loadedImages: Schema.Array(Schema.String),
    failedImages: Schema.Array(Schema.String),
    presence: PresenceState,
    github: Schema.NullOr(GithubSnapshot),
    githubFailed: Schema.Boolean,
    weather: Schema.NullOr(Weather),
    weatherFailed: Schema.Boolean,
    weatherSettled: Schema.Boolean,
    notes: Notes.Model,
    gallery: Gallery.Model,
});
export type Model = typeof Model.Type;
export const Message = defineMessageUnion({
    ReceivedContent: { content: SiteContent },
    ReceivedPublished: { content: SiteContent, revision: Schema.Number },
    FailedContent: {},
    FailedWatch: {},
    ResumeWatch: {},
    ReceivedPhotos: { tag: PhotoTag, photos: Schema.Array(Photo) },
    FailedPhotos: { tag: PhotoTag },
    ReceivedGithub: { snapshot: GithubSnapshot },
    FailedGithub: {},
    ReceivedWeather: { reading: Weather },
    FailedWeather: {},
    ReceivedPresence: { presence: PresenceState },
    ToggleTheme: {},
    AppliedTheme: { theme: Schema.Literals(["dark", "light"]) },
    StepProject: { kind: Schema.Literals(["apps", "openSource"]), delta: Schema.Number },
    SettledImage: { src: Schema.String, failed: Schema.Boolean },
    NotesMessage: { message: Notes.Message },
    GalleryMessage: { message: Gallery.Message },
});
export type Message = typeof Message.Type;

const AdoptTheme = Command.define("AdoptTheme", {
    messages: [Message.AppliedTheme],
    execute: Effect.sync(() =>
        Message.AppliedTheme({
            theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
        }),
    ),
});
const ApplyTheme = Command.define("ApplyTheme", {
    args: { theme: Schema.Literals(["dark", "light"]) },
    messages: [Message.AppliedTheme],
    execute: ({ theme }) =>
        Effect.sync(() => {
            document.documentElement.classList.toggle("dark", theme === "dark");
            document
                .querySelector('meta[name="theme-color"]')
                ?.setAttribute("content", theme === "dark" ? "#111214" : "#F5F6F7");
            try {
                localStorage.setItem("theme", theme);
            } catch {
                /* The applied theme still works without persistence. */
            }
            return Message.AppliedTheme({ theme });
        }),
});
const ReconnectWatch = Command.define("ReconnectContentWatch", {
    messages: [Message.ResumeWatch],
    execute: Effect.sleep("5 seconds").pipe(Effect.as(Message.ResumeWatch())),
});

export const AdoptImage = Mount.define("AdoptLoadedImage", {
    args: { src: Schema.String },
    messages: [Message.SettledImage],
    execute: ({ element, src }) =>
        Effect.callback((resume) => {
            if (!(element instanceof HTMLImageElement)) {
                resume(Effect.succeed(Message.SettledImage({ src, failed: true })));
                return;
            }
            const complete = () =>
                resume(
                    Effect.succeed(
                        Message.SettledImage({
                            src,
                            failed: element.naturalWidth === 0,
                        }),
                    ),
                );
            if (element.complete) {
                complete();
                return;
            }
            element.addEventListener("load", complete, { once: true });
            element.addEventListener("error", complete, { once: true });
            return Effect.sync(() => {
                element.removeEventListener("load", complete);
                element.removeEventListener("error", complete);
            });
        }),
});

export const init = (flags: Flags): Update.Return<Model, Message, PortfolioHttp> => {
    const notes = Notes.init({
        content: flags.content,
        siteKey: flags.siteKey,
        enabled: flags.composerEnabled,
    });
    const gallery = Gallery.init();
    return {
        model: {
            content: flags.content,
            revision: -1,
            watchEnabled: true,
            theme: "dark",
            year: flags.year,
            appId: null,
            openSourceId: null,
            appDirection: 1,
            openSourceDirection: 1,
            loadedImages: [],
            failedImages: [],
            presence: INITIAL_PRESENCE,
            github: null,
            githubFailed: false,
            weather: null,
            weatherFailed: false,
            weatherSettled: false,
            notes: notes.model,
            gallery: gallery.model,
        },
        commands: [
            AdoptTheme(),
            ...Command.mapMessages(notes.commands, (message) => Message.NotesMessage({ message })),
            ...Command.mapMessages(gallery.commands, (message) =>
                Message.GalleryMessage({ message }),
            ),
        ],
    };
};

/** Both content transports carry the authority's monotonic `updatedAt`. */
const isOlderContent = (model: Model, content: SiteContent): boolean =>
    model.content.updatedAt !== null &&
    (content.updatedAt === null || content.updatedAt < model.content.updatedAt);

const applyContent = (
    model: Model,
    content: SiteContent,
): Update.Return<Model, Message, PortfolioHttp> => {
    const notes = Notes.update(model.notes, Notes.Message.ReceivedContent({ content }));
    return {
        model: { ...model, content, notes: notes.model },
        commands: Command.mapMessages(notes.commands, (message) =>
            Message.NotesMessage({ message }),
        ),
    };
};

export const update = (
    model: Model,
    message: Message,
): Update.Return<Model, Message, PortfolioHttp> =>
    Message.match(message, {
        ReceivedContent: ({ content }) =>
            isOlderContent(model, content) ? { model } : applyContent(model, content),
        // Before handoff, HTTP reads the live source while the watch can lag on an import.
        ReceivedPublished: ({ content, revision }) =>
            revision < model.revision || isOlderContent(model, content)
                ? { model }
                : applyContent({ ...model, revision }, content),
        FailedContent: () => ({ model }),
        FailedWatch: () => ({
            model: { ...model, watchEnabled: false },
            commands: [ReconnectWatch()],
        }),
        ResumeWatch: () => ({ model: { ...model, watchEnabled: true } }),
        ReceivedPhotos: ({ tag, photos }) => {
            const gallery = Gallery.update(
                model.gallery,
                Gallery.Message.ReceivedPhotos({ tag, photos }),
            );
            return {
                model: { ...model, gallery: gallery.model },
                commands: Command.mapMessages(gallery.commands, (message) =>
                    Message.GalleryMessage({ message }),
                ),
            };
        },
        FailedPhotos: ({ tag }) => {
            const gallery = Gallery.update(model.gallery, Gallery.Message.FailedPhotos({ tag }));
            return {
                model: { ...model, gallery: gallery.model },
                commands: Command.mapMessages(gallery.commands, (message) =>
                    Message.GalleryMessage({ message }),
                ),
            };
        },
        ReceivedGithub: ({ snapshot }) => ({
            model: { ...model, github: snapshot, githubFailed: false },
        }),
        FailedGithub: () => ({ model: { ...model, githubFailed: true } }),
        ReceivedWeather: ({ reading }) => ({
            model: { ...model, weather: reading, weatherFailed: false, weatherSettled: true },
        }),
        FailedWeather: () => ({ model: { ...model, weatherFailed: true, weatherSettled: true } }),
        ReceivedPresence: ({ presence }) => ({ model: { ...model, presence } }),
        ToggleTheme: () => ({
            model,
            commands: [ApplyTheme({ theme: model.theme === "dark" ? "light" : "dark" })],
        }),
        AppliedTheme: ({ theme }) => ({ model: { ...model, theme } }),
        StepProject: ({ kind, delta }) => {
            const entries = model.content[kind];
            const selectedId = kind === "apps" ? model.appId : model.openSourceId;
            const index = Math.max(
                0,
                entries.findIndex((entry) => entry.id === selectedId),
            );
            const next = entries[(index + delta + entries.length) % entries.length];
            if (next === undefined) return { model };
            // Like the retired keyed preview, revisiting a project retries its failed image.
            const src = projectImageSource(next);
            const retried = {
                ...model,
                failedImages: model.failedImages.filter((failed) => failed !== src),
            };
            return {
                model:
                    kind === "apps"
                        ? { ...retried, appId: next.id, appDirection: delta }
                        : { ...retried, openSourceId: next.id, openSourceDirection: delta },
            };
        },
        SettledImage: ({ src, failed }) => ({
            model: {
                ...model,
                loadedImages:
                    failed || model.loadedImages.includes(src)
                        ? model.loadedImages
                        : [...model.loadedImages, src],
                failedImages:
                    !failed || model.failedImages.includes(src)
                        ? model.failedImages
                        : [...model.failedImages, src],
            },
        }),
        NotesMessage: ({ message }) => {
            const notes = Notes.update(model.notes, message);
            return {
                model: { ...model, notes: notes.model },
                commands: Command.mapMessages(notes.commands, (message) =>
                    Message.NotesMessage({ message }),
                ),
            };
        },
        GalleryMessage: ({ message }) => {
            const gallery = Gallery.update(model.gallery, message);
            return {
                model: { ...model, gallery: gallery.model },
                commands: Command.mapMessages(gallery.commands, (message) =>
                    Message.GalleryMessage({ message }),
                ),
            };
        },
    });

const domain = DomainFoldkit.make(PortfolioApi);
type Resources = PortfolioHttp | typeof PortfolioApi.Client.Identifier;
const sources = Subscription.make<Model, Message, Resources>()(() => ({
    published: domain.PublishedContent.watch<Model, Message>({
        key: () => "site-content",
        isEnabled: (model: Model) => model.watchEnabled,
        toMessage: ({ state }) =>
            Option.match(state, {
                onNone: () => Message.FailedContent(),
                onSome: ({ content, revision }) => Message.ReceivedPublished({ content, revision }),
            }),
        onFailure: () => Message.FailedWatch(),
        onDefect: () => Message.FailedWatch(),
    }),
    content: Subscription.persistentEntry(
        Stream.fromEffect(
            PortfolioHttp.use((http) => http.content).pipe(
                Effect.match({
                    onSuccess: (content) => Message.ReceivedContent({ content }),
                    onFailure: () => Message.FailedContent(),
                }),
            ),
        ).pipe(Stream.repeat(Schedule.spaced("60 seconds"))),
    ),
    life: Subscription.persistentEntry(
        Stream.fromEffect(
            PortfolioHttp.use((http) => http.photos("life")).pipe(
                Effect.match({
                    onSuccess: (photos) => Message.ReceivedPhotos({ tag: "life", photos }),
                    onFailure: () => Message.FailedPhotos({ tag: "life" }),
                }),
            ),
        ).pipe(Stream.repeat(Schedule.spaced("60 seconds"))),
    ),
    cats: Subscription.persistentEntry(
        Stream.fromEffect(
            PortfolioHttp.use((http) => http.photos("cats")).pipe(
                Effect.match({
                    onSuccess: (photos) => Message.ReceivedPhotos({ tag: "cats", photos }),
                    onFailure: () => Message.FailedPhotos({ tag: "cats" }),
                }),
            ),
        ).pipe(Stream.repeat(Schedule.spaced("60 seconds"))),
    ),
    github: Subscription.persistentEntry(
        Stream.fromEffect(
            PortfolioHttp.use((http) => http.github).pipe(
                Effect.match({
                    onSuccess: (snapshot) => Message.ReceivedGithub({ snapshot }),
                    onFailure: () => Message.FailedGithub(),
                }),
            ),
        ).pipe(Stream.repeat(Schedule.spaced("15 minutes"))),
    ),
    weather: Subscription.persistentEntry(
        Stream.fromEffect(
            PortfolioHttp.use((http) => http.weather).pipe(
                Effect.match({
                    onSuccess: (reading) => Message.ReceivedWeather({ reading }),
                    onFailure: () => Message.FailedWeather(),
                }),
            ),
        ).pipe(Stream.repeat(Schedule.spaced("15 minutes"))),
    ),
    presence: Subscription.persistentEntry(
        Stream.suspend(() => {
            const endpoint = new URL("/presence", location.origin);
            endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
            return presenceStream(endpoint.href).pipe(
                Stream.map((presence) => Message.ReceivedPresence({ presence })),
            );
        }),
    ),
}));
export const subscriptions = Subscription.aggregate(
    sources,
    Subscription.lift(Gallery.subscriptions)<Model, Message>({
        read: (model) => Option.some(model.gallery),
        toParentMessage: (message) => Message.GalleryMessage({ message }),
    }),
);

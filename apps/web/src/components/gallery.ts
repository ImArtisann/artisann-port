import { Photo, PhotoTag } from "@artisann-port/presence/photos";
import { ImageNotFound01Icon, ImagesIcon } from "@hugeicons-pro/core-solid-rounded";
import { Effect, Option, Queue, Random, Schema, Stream } from "effect";
import { Command, Subscription, type Update } from "foldkit";
import type { Attribute, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { defineView } from "foldkit/submodel";

const Placement = Schema.Literals(["life-desktop", "life-mobile", "cats"]);
type Placement = typeof Placement.Type;
const placements: readonly Placement[] = ["life-desktop", "life-mobile", "cats"];
const Direction = Schema.Literals([-1, 1]);
type Direction = typeof Direction.Type;
const Gesture = Schema.Struct({
    pointerId: Schema.Number,
    startX: Schema.Number,
    startY: Schema.Number,
    lastX: Schema.Number,
    originX: Schema.Number,
    lastAt: Schema.Number,
    velocity: Schema.Number,
    horizontal: Schema.Boolean,
});
const Deck = Schema.Struct({
    photos: Schema.Array(Photo),
    selectedKey: Schema.NullOr(Schema.String),
    failedKeys: Schema.Array(Schema.String),
    unavailable: Schema.Boolean,
    visible: Schema.Boolean,
    shuffling: Schema.Boolean,
    shuffleGeneration: Schema.Number,
    phase: Schema.Literals(["idle", "dragging", "snapping", "exiting"]),
    gesture: Schema.NullOr(Gesture),
    x: Schema.Number,
    velocity: Schema.Number,
    peek: Direction,
    exitDelta: Direction,
    pauseNonce: Schema.Number,
    pausedUntil: Schema.Number,
});
type Deck = typeof Deck.Type;

export const Model = Schema.Struct({
    "life-desktop": Deck,
    "life-mobile": Deck,
    cats: Deck,
    documentVisible: Schema.Boolean,
    reducedMotion: Schema.Boolean,
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
    ReceivedPhotos: { tag: PhotoTag, photos: Schema.Array(Photo) },
    FailedPhotos: { tag: PhotoTag },
    ShuffledPhotos: {
        placement: Placement,
        generation: Schema.Number,
        photos: Schema.Array(Photo),
    },
    ChangedEnvironment: { documentVisible: Schema.Boolean, reducedMotion: Schema.Boolean },
    ChangedVisibility: { placement: Placement, visible: Schema.Boolean },
    StartedPointer: {
        placement: Placement,
        pointerId: Schema.Number,
        x: Schema.Number,
        y: Schema.Number,
        at: Schema.Number,
    },
    MovedPointer: {
        placement: Placement,
        pointerId: Schema.Number,
        x: Schema.Number,
        y: Schema.Number,
        at: Schema.Number,
    },
    ReleasedPointer: {
        placement: Placement,
        pointerId: Schema.Number,
        x: Schema.Number,
        at: Schema.Number,
    },
    CanceledPointer: { placement: Placement, pointerId: Schema.Number },
    PressedArrow: { placement: Placement, delta: Direction, at: Schema.Number },
    AutoAdvanced: { placement: Placement, at: Schema.Number },
    AnimationFrame: { deltaTime: Schema.Number },
    FailedImage: { placement: Placement, key: Schema.String },
});
export type Message = typeof Message.Type;

const ShufflePhotos = Command.define("Gallery.ShufflePhotos", {
    args: { placement: Placement, generation: Schema.Number, photos: Schema.Array(Photo) },
    messages: [Message.ShuffledPhotos],
    execute: ({ placement, generation, photos }) =>
        Random.shuffle(photos).pipe(
            Effect.map((shuffled) =>
                Message.ShuffledPhotos({ placement, generation, photos: shuffled }),
            ),
        ),
});

const emptyDeck = (): Deck => ({
    photos: [],
    selectedKey: null,
    failedKeys: [],
    unavailable: false,
    visible: false,
    shuffling: false,
    shuffleGeneration: 0,
    phase: "idle",
    gesture: null,
    x: 0,
    velocity: 0,
    peek: 1,
    exitDelta: 1,
    pauseNonce: 0,
    pausedUntil: 0,
});

export const init = (): Update.Return<Model, Message> => ({
    model: {
        "life-desktop": emptyDeck(),
        "life-mobile": emptyDeck(),
        cats: emptyDeck(),
        documentVisible: false,
        reducedMotion: true,
    },
});

const rootId = (placement: Placement) => `portfolio-gallery-${placement}`;
const replaceDeck = (model: Model, placement: Placement, deck: Deck): Model =>
    model[placement] === deck ? model : { ...model, [placement]: deck };
const positionOf = (deck: Deck): number =>
    Math.max(
        0,
        deck.photos.findIndex((photo) => photo.key === deck.selectedKey),
    );
const centered = (deck: Deck): Deck => ({
    ...deck,
    phase: "idle",
    gesture: null,
    x: 0,
    velocity: 0,
    peek: 1,
});
const advance = (deck: Deck, delta: Direction): Deck => ({
    ...centered(deck),
    selectedKey:
        deck.photos[(positionOf(deck) + delta + deck.photos.length) % deck.photos.length]?.key ??
        null,
});

const reconcile = (deck: Deck, photos: readonly Photo[]): Deck => {
    const nextByKey = new Map(photos.map((photo) => [photo.key, photo]));
    const previousKeys = new Set(deck.photos.map((photo) => photo.key));
    const ordering = deck.photos.flatMap((photo) => {
        const current = nextByKey.get(photo.key);
        return current === undefined ? [] : [current];
    });
    for (const photo of photos) {
        if (!previousKeys.has(photo.key)) ordering.push(photo);
    }
    let selectedKey = deck.selectedKey;
    if (selectedKey === null || !nextByKey.has(selectedKey)) {
        const previousPosition = deck.photos.findIndex((photo) => photo.key === selectedKey);
        selectedKey = null;
        for (
            let index = previousPosition + 1;
            previousPosition >= 0 && index < deck.photos.length;
            index += 1
        ) {
            const successor = deck.photos[index];
            if (successor !== undefined && nextByKey.has(successor.key)) {
                selectedKey = successor.key;
                break;
            }
        }
        selectedKey ??= ordering[0]?.key ?? null;
    }
    const next: Deck = {
        ...deck,
        photos: ordering,
        selectedKey,
        failedKeys: deck.failedKeys.filter((key) => nextByKey.has(key)),
        unavailable: false,
    };
    return selectedKey !== deck.selectedKey || ordering.length < 2 ? centered(next) : next;
};

const beginExit = (
    deck: Deck,
    delta: Direction,
    reducedMotion: boolean,
    userAt: number | null,
): Deck => {
    if (deck.photos.length < 2 || deck.shuffling || deck.phase === "exiting") return deck;
    const next = {
        ...deck,
        gesture: null,
        peek: delta,
        exitDelta: delta,
        pauseNonce: deck.pauseNonce + (userAt === null ? 0 : 1),
        pausedUntil: userAt === null ? deck.pausedUntil : userAt + 2_000,
    };
    return reducedMotion ? advance(next, delta) : { ...next, phase: "exiting" };
};

const springFrame = (deck: Deck, deltaTime: number): Deck => {
    if (deck.phase !== "snapping" && deck.phase !== "exiting") return deck;
    const exiting = deck.phase === "exiting";
    const target = exiting ? -deck.exitDelta * 400 : 0;
    const stiffness = exiting ? 400 : 600;
    const damping = exiting ? 40 : 30;
    const elapsed = Math.min(32, Math.max(0, deltaTime)) / 1_000;
    const steps = Math.max(1, Math.ceil(elapsed * 120));
    const step = elapsed / steps;
    let x = deck.x;
    let velocity = deck.velocity;
    for (let index = 0; index < steps; index += 1) {
        velocity += (-stiffness * (x - target) - damping * velocity) * step;
        x += velocity * step;
    }
    if (Math.abs(x - target) < 0.5 && Math.abs(velocity) < 5) {
        return exiting ? advance(deck, deck.exitDelta) : centered(deck);
    }
    return { ...deck, x, velocity };
};

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
    Message.match<Update.Return<Model, Message>>(message, {
        ReceivedPhotos: ({ tag, photos }) => {
            let next = model;
            const commands: Command.Command<Message>[] = [];
            for (const placement of tag === "cats"
                ? (["cats"] as const)
                : (["life-desktop", "life-mobile"] as const)) {
                const previous = next[placement];
                let deck = reconcile(previous, photos);
                if (photos.length > 0 && (previous.photos.length === 0 || previous.shuffling)) {
                    const generation = previous.shuffleGeneration + 1;
                    deck = { ...deck, shuffling: true, shuffleGeneration: generation };
                    commands.push(ShufflePhotos({ placement, generation, photos }));
                } else if (photos.length === 0) {
                    deck = {
                        ...deck,
                        shuffling: false,
                        shuffleGeneration: previous.shuffleGeneration + 1,
                    };
                }
                next = replaceDeck(next, placement, deck);
            }
            return { model: next, commands };
        },
        FailedPhotos: ({ tag }) => {
            let next = model;
            for (const placement of tag === "cats"
                ? (["cats"] as const)
                : (["life-desktop", "life-mobile"] as const)) {
                next = replaceDeck(next, placement, { ...next[placement], unavailable: true });
            }
            return { model: next };
        },
        ShuffledPhotos: ({ placement, generation, photos }) => {
            const deck = model[placement];
            if (!deck.shuffling || generation !== deck.shuffleGeneration) return { model };
            return {
                model: replaceDeck(model, placement, {
                    ...centered(deck),
                    photos,
                    selectedKey: photos[0]?.key ?? null,
                    shuffling: false,
                }),
            };
        },
        ChangedEnvironment: ({ documentVisible, reducedMotion }) => {
            let next: Model = { ...model, documentVisible, reducedMotion };
            for (const placement of placements) {
                const deck = next[placement];
                if (reducedMotion && deck.phase === "exiting") {
                    next = replaceDeck(next, placement, advance(deck, deck.exitDelta));
                } else if (reducedMotion && deck.phase === "snapping") {
                    next = replaceDeck(next, placement, centered(deck));
                } else if (!documentVisible && deck.gesture !== null) {
                    next = replaceDeck(next, placement, centered(deck));
                } else if (reducedMotion && deck.x !== 0) {
                    next = replaceDeck(next, placement, { ...deck, x: 0, velocity: 0 });
                }
            }
            return { model: next };
        },
        ChangedVisibility: ({ placement, visible }) => {
            const deck = model[placement];
            if (deck.visible === visible) return { model };
            const next = { ...deck, visible };
            return {
                model: replaceDeck(
                    model,
                    placement,
                    !visible && deck.phase !== "idle" ? centered(next) : next,
                ),
            };
        },
        StartedPointer: ({ placement, pointerId, x, y, at }) => {
            const deck = model[placement];
            if (
                deck.photos.length < 2 ||
                deck.shuffling ||
                deck.phase === "exiting" ||
                deck.gesture !== null
            )
                return { model };
            return {
                model: replaceDeck(model, placement, {
                    ...deck,
                    phase: "dragging",
                    velocity: 0,
                    gesture: {
                        pointerId,
                        startX: x,
                        startY: y,
                        lastX: x,
                        originX: deck.x,
                        lastAt: at,
                        velocity: 0,
                        horizontal: false,
                    },
                }),
            };
        },
        MovedPointer: ({ placement, pointerId, x, y, at }) => {
            const deck = model[placement];
            const gesture = deck.gesture;
            if (gesture === null || gesture.pointerId !== pointerId) return { model };
            const offset = x - gesture.startX;
            const vertical = Math.abs(y - gesture.startY);
            if (!gesture.horizontal && vertical > 6 && vertical > Math.abs(offset)) {
                return { model: replaceDeck(model, placement, centered(deck)) };
            }
            const horizontal =
                gesture.horizontal || (Math.abs(offset) > 6 && Math.abs(offset) > vertical);
            const velocity =
                at > gesture.lastAt
                    ? ((x - gesture.lastX) * 1_000) / (at - gesture.lastAt)
                    : gesture.velocity;
            return {
                model: replaceDeck(model, placement, {
                    ...deck,
                    x: horizontal && !model.reducedMotion ? gesture.originX + offset * 0.7 : 0,
                    velocity: horizontal && !model.reducedMotion ? velocity * 0.7 : 0,
                    peek: horizontal && offset > 0 ? -1 : 1,
                    gesture: { ...gesture, lastX: x, lastAt: at, velocity, horizontal },
                }),
            };
        },
        ReleasedPointer: ({ placement, pointerId, x, at }) => {
            const deck = model[placement];
            const gesture = deck.gesture;
            if (gesture === null || gesture.pointerId !== pointerId) return { model };
            const offset = x - gesture.startX;
            const sinceMove = at - gesture.lastAt;
            const velocity =
                sinceMove > 100
                    ? 0
                    : x !== gesture.lastX && sinceMove > 0
                      ? ((x - gesture.lastX) * 1_000) / sinceMove
                      : gesture.velocity;
            const committed =
                gesture.horizontal && (Math.abs(offset) > 80 || Math.abs(velocity) > 400);
            const next: Deck = { ...deck, gesture: null };
            if (committed) {
                const direction = Math.abs(offset) > 80 ? offset : velocity;
                return {
                    model: replaceDeck(
                        model,
                        placement,
                        beginExit(next, direction > 0 ? -1 : 1, model.reducedMotion, at),
                    ),
                };
            }
            return {
                model: replaceDeck(
                    model,
                    placement,
                    model.reducedMotion ? centered(next) : { ...next, phase: "snapping", peek: 1 },
                ),
            };
        },
        CanceledPointer: ({ placement, pointerId }) => {
            const deck = model[placement];
            if (deck.gesture?.pointerId !== pointerId) return { model };
            const next: Deck = { ...deck, gesture: null, phase: "snapping", peek: 1 };
            return {
                model: replaceDeck(model, placement, model.reducedMotion ? centered(next) : next),
            };
        },
        PressedArrow: ({ placement, delta, at }) => {
            const deck = model[placement];
            if (deck.gesture !== null) return { model };
            return {
                model: replaceDeck(
                    model,
                    placement,
                    beginExit(deck, delta, model.reducedMotion, at),
                ),
            };
        },
        AutoAdvanced: ({ placement, at }) => {
            const deck = model[placement];
            if (
                !deck.visible ||
                !model.documentVisible ||
                model.reducedMotion ||
                deck.phase !== "idle" ||
                at < deck.pausedUntil
            )
                return { model };
            return { model: replaceDeck(model, placement, beginExit(deck, 1, false, null)) };
        },
        AnimationFrame: ({ deltaTime }) => {
            if (!model.documentVisible) return { model };
            let next = model;
            for (const placement of placements)
                next = replaceDeck(next, placement, springFrame(next[placement], deltaTime));
            return { model: next };
        },
        FailedImage: ({ placement, key }) => {
            const deck = model[placement];
            if (deck.failedKeys.includes(key) || !deck.photos.some((photo) => photo.key === key))
                return { model };
            return {
                model: replaceDeck(model, placement, {
                    ...deck,
                    failedKeys: [...deck.failedKeys, key],
                }),
            };
        },
    });

const environmentStream = Stream.callback<Message>((queue) =>
    Effect.acquireRelease(
        Effect.sync(() => {
            const media = window.matchMedia("(prefers-reduced-motion: reduce)");
            const roots = new Map<Placement, HTMLElement>();
            const visibility = new Map<Placement, boolean>();
            const emitVisibility = (placement: Placement, visible: boolean) => {
                if (visibility.get(placement) === visible) return;
                visibility.set(placement, visible);
                Queue.offerUnsafe(queue, Message.ChangedVisibility({ placement, visible }));
            };
            const measure = (placement: Placement, element: HTMLElement) => {
                const rect = element.getBoundingClientRect();
                const area = rect.width * rect.height;
                const width = Math.max(
                    0,
                    Math.min(rect.right, window.innerWidth) - Math.max(0, rect.left),
                );
                const height = Math.max(
                    0,
                    Math.min(rect.bottom, window.innerHeight) - Math.max(0, rect.top),
                );
                emitVisibility(
                    placement,
                    area > 0 &&
                        element.getClientRects().length > 0 &&
                        (width * height) / area >= 0.1,
                );
            };
            const observer = new IntersectionObserver(
                (entries) => {
                    for (const entry of entries) {
                        for (const [placement, element] of roots) {
                            if (entry.target === element)
                                emitVisibility(
                                    placement,
                                    entry.isIntersecting && entry.intersectionRatio >= 0.1,
                                );
                        }
                    }
                },
                { threshold: [0, 0.1] },
            );
            const bindRoots = () => {
                for (const placement of placements) {
                    const previous = roots.get(placement);
                    const element = document.getElementById(rootId(placement));
                    if (element === previous) continue;
                    if (previous !== undefined) observer.unobserve(previous);
                    if (element === null) {
                        roots.delete(placement);
                        emitVisibility(placement, false);
                    } else {
                        roots.set(placement, element);
                        measure(placement, element);
                        observer.observe(element);
                    }
                }
            };
            const measureRoots = () => {
                for (const [placement, element] of roots) measure(placement, element);
            };
            const environment = () =>
                Queue.offerUnsafe(
                    queue,
                    Message.ChangedEnvironment({
                        documentVisible: !document.hidden,
                        reducedMotion: media.matches,
                    }),
                );
            const mutation = new MutationObserver(bindRoots);
            mutation.observe(document.documentElement, { childList: true, subtree: true });
            document.addEventListener("visibilitychange", environment);
            media.addEventListener("change", environment);
            window.addEventListener("resize", measureRoots, { passive: true });
            bindRoots();
            environment();
            return () => {
                mutation.disconnect();
                observer.disconnect();
                document.removeEventListener("visibilitychange", environment);
                media.removeEventListener("change", environment);
                window.removeEventListener("resize", measureRoots);
            };
        }),
        (dispose) => Effect.sync(dispose),
    ),
);

const pointerStream = (placement: Placement, pointerId: number) =>
    Stream.callback<Message>((queue) =>
        Effect.acquireRelease(
            Effect.sync(() => {
                const element = document
                    .getElementById(rootId(placement))
                    ?.querySelector<HTMLElement>("[data-gallery-top]");
                const move = (event: PointerEvent) => {
                    if (event.pointerId !== pointerId) return;
                    Queue.offerUnsafe(
                        queue,
                        Message.MovedPointer({
                            placement,
                            pointerId,
                            x: event.clientX,
                            y: event.clientY,
                            at: event.timeStamp,
                        }),
                    );
                };
                const release = (event: PointerEvent) => {
                    if (event.pointerId !== pointerId) return;
                    Queue.offerUnsafe(
                        queue,
                        Message.ReleasedPointer({
                            placement,
                            pointerId,
                            x: event.clientX,
                            at: event.timeStamp,
                        }),
                    );
                };
                const cancel = (event: PointerEvent) => {
                    if (event.pointerId === pointerId)
                        Queue.offerUnsafe(queue, Message.CanceledPointer({ placement, pointerId }));
                };
                const blur = () =>
                    Queue.offerUnsafe(queue, Message.CanceledPointer({ placement, pointerId }));
                window.addEventListener("pointermove", move, { passive: true });
                window.addEventListener("pointerup", release);
                window.addEventListener("pointercancel", cancel);
                element?.addEventListener("lostpointercapture", cancel);
                window.addEventListener("blur", blur);
                return () => {
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", release);
                    window.removeEventListener("pointercancel", cancel);
                    element?.removeEventListener("lostpointercapture", cancel);
                    window.removeEventListener("blur", blur);
                    if (element?.hasPointerCapture(pointerId))
                        element.releasePointerCapture(pointerId);
                };
            }),
            (dispose) => Effect.sync(dispose),
        ),
    );

const autoStream = (placement: Placement) =>
    Stream.callback<Message>((queue) =>
        Effect.acquireRelease(
            Effect.sync(() => {
                let timer = 0;
                const tick = () => {
                    Queue.offerUnsafe(
                        queue,
                        Message.AutoAdvanced({ placement, at: performance.now() }),
                    );
                    timer = window.setTimeout(tick, 2_500);
                };
                timer = window.setTimeout(tick, 2_500);
                return () => window.clearTimeout(timer);
            }),
            (dispose) => Effect.sync(dispose),
        ),
    );

export const subscriptions = Subscription.make<Model, Message>()((entry) => {
    const rotation = (placement: Placement) =>
        entry(
            { active: Schema.Boolean, pauseNonce: Schema.Number },
            {
                modelToDependencies: (model) => ({
                    active:
                        model.documentVisible &&
                        !model.reducedMotion &&
                        model[placement].visible &&
                        model[placement].photos.length > 1 &&
                        !model[placement].shuffling,
                    pauseNonce: model[placement].pauseNonce,
                }),
                dependenciesToStream: ({ active }) =>
                    active ? autoStream(placement) : Stream.empty,
            },
        );
    const pointer = (placement: Placement) =>
        entry(
            { pointerId: Schema.NullOr(Schema.Number) },
            {
                modelToDependencies: (model) => ({
                    pointerId: model[placement].gesture?.pointerId ?? null,
                }),
                dependenciesToStream: ({ pointerId }) =>
                    pointerId === null ? Stream.empty : pointerStream(placement, pointerId),
            },
        );
    return {
        galleryEnvironment: entry(
            {},
            { modelToDependencies: () => ({}), dependenciesToStream: () => environmentStream },
        ),
        galleryAnimation: Subscription.animationFrameEntry<Model, Message>({
            isActive: (model) =>
                model.documentVisible &&
                !model.reducedMotion &&
                placements.some(
                    (placement) =>
                        model[placement].phase === "snapping" ||
                        model[placement].phase === "exiting",
                ),
            toMessage: (deltaTime) => Message.AnimationFrame({ deltaTime }),
        }),
        galleryDesktopRotation: rotation("life-desktop"),
        galleryMobileRotation: rotation("life-mobile"),
        galleryCatsRotation: rotation("cats"),
        galleryDesktopPointer: pointer("life-desktop"),
        galleryMobilePointer: pointer("life-mobile"),
        galleryCatsPointer: pointer("cats"),
    };
});

export interface ViewInputs {
    readonly placement: Placement;
}

const icon = (h: HtmlBuilder<Message>, image: typeof ImagesIcon, size: number) =>
    h.svg(
        [
            h.ViewBox("0 0 24 24"),
            h.Width(String(size)),
            h.Height(String(size)),
            h.Fill("none"),
            h.AriaHidden(true),
        ],
        image.map(([, attributes]) =>
            h.path(
                Object.entries(attributes).map(([key, value]) =>
                    key === "key"
                        ? h.Key(String(value))
                        : h.Attribute(
                              key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`),
                              String(value),
                          ),
                ),
            ),
        ),
    );

const deckView = (model: Model, placement: Placement, h: HtmlBuilder<Message>) => {
    const deck = model[placement];
    const position = positionOf(deck);
    const canSwipe = deck.photos.length > 1;
    const photoNoun = placement === "cats" ? "Cat photo" : "Life photo";
    return h.div(
        [h.Class("relative size-full min-h-0 rounded-xl")],
        Array.from({ length: Math.min(2, deck.photos.length) }, (_, offset) => {
            const top = offset === 0;
            const index =
                (position + (top ? 0 : deck.peek) + deck.photos.length) % deck.photos.length;
            const photo = deck.photos[index];
            if (photo === undefined) return null;
            const attributes: Attribute<Message>[] = [
                h.Key(photo.key),
                h.AriaHidden(!top),
                h.Class(
                    `absolute inset-0 flex items-center justify-center overflow-hidden rounded-xl bg-muted${top && canSwipe ? " cursor-grab touch-pan-y active:cursor-grabbing" : ""}${!top ? " pointer-events-none" : ""}`,
                ),
                h.Style({
                    zIndex: String(3 - offset),
                    transform: `translateX(${top ? deck.x : 0}px) rotate(${top && !model.reducedMotion ? Math.max(-15, Math.min(15, (deck.x * 15) / 200)) : 0}deg)`,
                    willChange: top && canSwipe ? "transform" : "auto",
                }),
            ];
            if (top) {
                attributes.push(h.DataAttribute("gallery-top", ""));
                if (canSwipe)
                    attributes.push(
                        h.OnPointerDown(
                            (
                                _pointerType,
                                button,
                                _screenX,
                                _screenY,
                                at,
                                x,
                                y,
                                pointerId,
                                target,
                            ) => {
                                if (
                                    button !== 0 ||
                                    deck.shuffling ||
                                    deck.phase === "exiting" ||
                                    deck.gesture !== null
                                )
                                    return Option.none();
                                const element =
                                    target instanceof Element
                                        ? target.closest<HTMLElement>("[data-gallery-top]")
                                        : null;
                                element?.setPointerCapture(pointerId);
                                return Option.some(
                                    Message.StartedPointer({ placement, pointerId, x, y, at }),
                                );
                            },
                        ),
                    );
            }
            return h.div(attributes, [
                deck.failedKeys.includes(photo.key)
                    ? h.div(
                          [h.Class("flex flex-col items-center gap-2")],
                          [
                              icon(h, ImageNotFound01Icon, 28),
                              h.p(
                                  [h.Class("text-image-caption text-muted-foreground")],
                                  ["Photo unavailable"],
                              ),
                          ],
                      )
                    : h.img([
                          h.Src(photo.url),
                          h.Alt(top ? `${photoNoun} ${index + 1} of ${deck.photos.length}` : ""),
                          h.Loading("lazy"),
                          h.Decoding("async"),
                          h.Draggable(false),
                          h.OnError(Message.FailedImage({ placement, key: photo.key })),
                          h.Class("size-full rounded-xl object-cover select-none"),
                      ]),
            ]);
        }),
    );
};

const keyboardAttributes = (
    placement: Placement,
    h: HtmlBuilder<Message>,
): Attribute<Message>[] => [
    h.Tabindex(0),
    h.AriaKeyshortcuts("ArrowLeft ArrowRight"),
    h.OnKeyDownSelfPreventDefault((key) => {
        switch (key) {
            case "ArrowLeft":
                return Option.some(
                    Message.PressedArrow({ placement, delta: -1, at: performance.now() }),
                );
            case "ArrowRight":
                return Option.some(
                    Message.PressedArrow({ placement, delta: 1, at: performance.now() }),
                );
            default:
                return Option.none();
        }
    }),
];
const emptyClass =
    "flex w-full min-w-0 flex-col items-center justify-center rounded-xl bg-muted p-6 text-center text-caption text-muted-foreground";
const emptyMediaClass =
    "flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0 bg-transparent";
const descriptionClass =
    "text-caption text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary";
const frameClass =
    "relative flex min-w-0 items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-muted/40";

export const view = defineView<Model, Message, ViewInputs>((model, { placement }, h) => {
    const deck = model[placement];
    const cats = placement === "cats";
    const desktop = placement === "life-desktop";
    const count = deck.photos.length;
    const position = positionOf(deck);
    const current = deck.photos[position];
    const alt = `${cats ? "Cat" : "Life"} photo ${position + 1} of ${count}`;
    const status = `${current === undefined ? "" : `${alt}. `}${deck.unavailable ? "Photo updates are temporarily unavailable." : ""}`;
    const media = (size: number) =>
        h.div(
            [
                h.DataAttribute("slot", "empty-icon"),
                h.DataAttribute("variant", "default"),
                h.Class(emptyMediaClass),
            ],
            [icon(h, ImagesIcon, size)],
        );
    const description = h.div(
        [
            h.DataAttribute("slot", "empty-description"),
            h.Class(`${descriptionClass}${desktop ? " text-aside" : ""}`),
        ],
        [
            deck.unavailable
                ? `${cats ? "Cat" : "Life"} photos are temporarily unavailable.`
                : cats
                  ? "Cat photos go here"
                  : "A few moments from my life",
        ],
    );
    const liveStatus = h.p(
        [
            h.Role("status"),
            h.AriaLive("polite"),
            h.Class(
                cats
                    ? "sr-only"
                    : `text-image-caption text-muted-foreground${deck.unavailable ? "" : " sr-only"}`,
            ),
        ],
        [status],
    );
    if (cats) {
        const content =
            count === 0
                ? h.div(
                      [
                          h.DataAttribute("slot", "empty"),
                          h.Class(`${emptyClass} aspect-4/5 min-h-0 flex-1 gap-3`),
                          ...(deck.unavailable ? [h.Role("status")] : []),
                      ],
                      [media(32), description],
                  )
                : h.div(
                      [
                          h.Role("group"),
                          h.AriaLabel("Cat photo carousel, swipe to browse"),
                          h.Class(`${frameClass} aspect-4/5 w-full shrink-0`),
                          ...keyboardAttributes(placement, h),
                      ],
                      [deckView(model, placement, h)],
                  );
        return h.div(
            [
                h.Id(rootId(placement)),
                h.DataAttribute("slot", "card-content"),
                h.Class("px-(--card-spacing) relative flex min-h-0 flex-1 flex-col"),
            ],
            [content, liveStatus],
        );
    }
    const markers = [
        h.Id(rootId(placement)),
        h.DataAttribute("design-node", desktop ? "B2q4fP" : "P9RRLh"),
        ...(!desktop ? [h.DataAttribute("portfolio-section", "personal-photos")] : []),
    ];
    const sidebarSize = desktop
        ? "h-85 max-h-110 flex-none gap-2 max-lg:hidden"
        : "aspect-4/5 max-h-110 flex-none gap-2 lg:hidden";
    if (count === 0)
        return h.div(
            [
                ...markers,
                h.DataAttribute("slot", "empty"),
                h.Class(`${emptyClass} ${sidebarSize}`),
                ...(deck.unavailable ? [h.Role("status")] : []),
            ],
            [
                h.div(
                    [
                        h.DataAttribute("slot", "empty-header"),
                        h.Class("flex max-w-sm flex-col items-center gap-2"),
                    ],
                    [media(26), description],
                ),
            ],
        );
    return h.div(
        [
            ...markers,
            h.Role("group"),
            h.AriaLabel("Life photo carousel, swipe to browse"),
            h.Class(`flex min-w-0 flex-none flex-col ${desktop ? "max-lg:hidden" : "lg:hidden"}`),
            ...keyboardAttributes(placement, h),
        ],
        [
            h.div(
                [h.Class(`${frameClass} ${sidebarSize} w-full p-2.5`)],
                [deckView(model, placement, h)],
            ),
            liveStatus,
        ],
    );
});

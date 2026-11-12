import type { Html } from "foldkit";
import * as Match from "effect/Match";
import { currentPhoto, type Message, type Model } from "./app-state.ts";
import {
    MAX_COMMENT_LENGTH,
    SITE_MARK_URL,
    SITE_URL,
    photoPagePath,
    type DeckPhoto,
} from "./contracts.ts";
import { DeckGestures } from "./components/deck-motion.ts";
import { relativeTime } from "./components/relative-time.ts";

type Builder = Html.HtmlBuilder<Message>;
const MAIN = "mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 px-4 py-6";
const FOCUS =
    "focus-visible:ring-ink rounded-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden";
const ACTION =
    "bg-heart focus-visible:ring-ink focus-visible:ring-offset-cream self-start rounded-full px-5 py-2.5 text-sm font-semibold text-white focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden";

function heartButton(h: Builder, photo: DeckPhoto, swipe: boolean) {
    return h.span(
        [h.Class("relative inline-flex")],
        [
            h.button(
                [
                    h.Type("button"),
                    h.Disabled(photo.hearted),
                    h.AriaLabel(photo.hearted ? "Hearted" : "Heart this cat"),
                    h.OnClick(
                        swipe ? { _tag: "RequestedSwipe", direction: "right" } : { _tag: "Heart" },
                    ),
                    h.Class(
                        "cat-action bg-heart focus-visible:ring-ink focus-visible:ring-offset-cream flex size-14 items-center justify-center rounded-full text-white shadow-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-60",
                    ),
                ],
                [
                    h.svg(
                        [
                            h.ViewBox("0 0 24 24"),
                            h.Fill(photo.hearted ? "currentColor" : "none"),
                            h.Stroke("currentColor"),
                            h.StrokeWidth("2.2"),
                            h.StrokeLinecap("round"),
                            h.StrokeLinejoin("round"),
                            h.AriaHidden(true),
                            h.Class("size-6"),
                        ],
                        [
                            h.path([
                                h.D(
                                    "M12 20.5S3.5 15 3.5 9.6A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8.5 2.6c0 5.4-8.5 10.9-8.5 10.9Z",
                                ),
                            ]),
                        ],
                    ),
                ],
            ),
            photo.hearted
                ? h.span(
                      [
                          h.Class(
                              "text-pass absolute top-full left-1/2 mt-1 -translate-x-1/2 text-xs whitespace-nowrap",
                          ),
                      ],
                      ["Hearted"],
                  )
                : null,
        ],
    );
}

function heartCount(h: Builder, likes: number) {
    return h.span(
        [
            h.Class(
                "inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/50 px-3 py-1 text-sm font-semibold text-white backdrop-blur-sm",
            ),
        ],
        [
            h.span([h.AriaHidden(true), h.Class("text-heart")], ["♥"]),
            h.keyed("span")(likes, [h.Class("heart-number tabular-nums")], [String(likes)]),
            h.span([h.Class("sr-only")], [likes === 1 ? "heart" : "hearts"]),
        ],
    );
}

function cardFace(h: Builder, model: Model, photo: DeckPhoto, eager: boolean) {
    return model.failedImages.includes(photo.key)
        ? h.div(
              [h.Class("bg-card text-pass flex size-full items-center justify-center")],
              [h.p([h.Class("text-sm")], ["Photo unavailable"])],
          )
        : h.img([
              h.Src(photo.url),
              h.Alt("A cat"),
              h.Loading(eager ? "eager" : "lazy"),
              h.Decoding("async"),
              h.Draggable(false),
              h.OnError({ _tag: "ImageFailed", key: photo.key }),
              h.Class("size-full object-cover select-none"),
          ]);
}

function deck(h: Builder, model: Model, photo: DeckPhoto) {
    const next =
        model.page.photos.length < 2
            ? undefined
            : model.page.photos[(model.index + 1) % model.page.photos.length];
    const path = photoPagePath(photo.key);
    return h.div(
        [
            h.Role("group"),
            h.AriaLabel("Cat photo deck"),
            h.Class("relative aspect-4/5 max-h-full w-full max-w-md"),
        ],
        [
            next === undefined
                ? null
                : h.keyed("div")(
                      `next-${next.key}-${model.index}`,
                      [
                          h.DataAttribute("deck-next", ""),
                          h.AriaHidden(true),
                          h.Class(
                              "border-line bg-card absolute inset-0 scale-95 overflow-hidden rounded-3xl border",
                          ),
                      ],
                      [cardFace(h, model, next, false)],
                  ),
            h.keyed("div")(
                `current-${photo.key}-${model.index}`,
                [
                    h.DataAttribute("deck-current", ""),
                    h.OnMount(DeckGestures()),
                    h.Class(
                        "border-line bg-card absolute inset-0 cursor-grab touch-pan-y overflow-hidden rounded-3xl border shadow-xl active:cursor-grabbing",
                    ),
                    h.Style({ "will-change": "transform" }),
                ],
                [
                    cardFace(h, model, photo, true),
                    h.div([
                        h.Class(
                            "pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-linear-to-t from-black/60 to-transparent",
                        ),
                    ]),
                    h.div(
                        [h.Class("pointer-events-none absolute bottom-3 left-3")],
                        [heartCount(h, photo.likes)],
                    ),
                    path === null
                        ? null
                        : h.a(
                              [
                                  h.Href(path),
                                  h.Class(
                                      "bg-card/90 text-ink focus-visible:ring-heart absolute right-3 bottom-3 rounded-full px-3 py-1 text-sm font-semibold focus-visible:ring-2 focus-visible:outline-hidden",
                                  ),
                              ],
                              ["Comments"],
                          ),
                    h.span(
                        [
                            h.DataAttribute("stamp", "like"),
                            h.AriaHidden(true),
                            h.Style({ opacity: "0", transform: "rotate(12deg)" }),
                            h.Class(
                                "border-heart text-heart pointer-events-none absolute top-5 left-4 rounded-lg border-4 px-3 py-1 text-4xl font-black tracking-widest uppercase",
                            ),
                        ],
                        ["LIKE"],
                    ),
                    h.span(
                        [
                            h.DataAttribute("stamp", "skip"),
                            h.AriaHidden(true),
                            h.Style({ opacity: "0", transform: "rotate(-12deg)" }),
                            h.Class(
                                "border-pass text-pass pointer-events-none absolute top-5 right-4 rounded-lg border-4 px-3 py-1 text-4xl font-black tracking-widest uppercase",
                            ),
                        ],
                        ["SKIP"],
                    ),
                ],
            ),
        ],
    );
}

function panel(h: Builder, title: string, body: string, retry: boolean) {
    return h.div(
        [
            h.Class(
                "border-line bg-card flex w-full max-w-md flex-col items-center gap-3 rounded-3xl border px-6 py-10 text-center",
            ),
        ],
        [
            h.h2([h.Class("font-display text-ink text-xl font-bold")], [title]),
            h.p([h.Class("text-pass text-sm")], [body]),
            retry
                ? h.button(
                      [
                          h.Type("button"),
                          h.OnClick({ _tag: "Retry" }),
                          h.Class(`${ACTION} self-center`),
                      ],
                      ["Try again"],
                  )
                : null,
        ],
    );
}

function home(h: Builder, model: Model) {
    const photo = currentPhoto(model);
    return h.main(
        [h.Class(`${MAIN} min-h-0`)],
        [
            h.section(
                [h.AriaLabel("Cat photo deck"), h.Class("flex items-start justify-center pt-2")],
                [
                    model.page.phase === "Loading"
                        ? h.div([
                              h.AriaHidden(true),
                              h.Class(
                                  "border-line bg-card animate-pulse motion-reduce:animate-none relative aspect-4/5 max-h-full w-full max-w-md rounded-3xl border",
                              ),
                          ])
                        : model.page.phase === "Failed"
                          ? panel(h, "Cats are napping", "Try again in a moment.", true)
                          : photo === undefined
                            ? panel(h, "No cats yet.", "Jake is on it. Check back soon.", false)
                            : deck(h, model, photo),
                ],
            ),
            h.div(
                [h.Class("flex h-16 shrink-0 items-center justify-center")],
                [
                    photo === undefined
                        ? null
                        : h.div(
                              [h.Class("flex items-center justify-center gap-6")],
                              [
                                  h.button(
                                      [
                                          h.Type("button"),
                                          h.AriaLabel("Skip this cat"),
                                          h.OnClick({ _tag: "RequestedSwipe", direction: "left" }),
                                          h.Class(
                                              "cat-action border-line bg-card text-pass hover:border-pass focus-visible:ring-ink focus-visible:ring-offset-cream flex size-14 items-center justify-center rounded-full border shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden",
                                          ),
                                      ],
                                      [
                                          h.svg(
                                              [
                                                  h.ViewBox("0 0 24 24"),
                                                  h.Fill("none"),
                                                  h.Stroke("currentColor"),
                                                  h.StrokeWidth("2.4"),
                                                  h.StrokeLinecap("round"),
                                                  h.StrokeLinejoin("round"),
                                                  h.AriaHidden(true),
                                                  h.Class("size-6"),
                                              ],
                                              [
                                                  h.path([h.D("M5 6l6 6-6 6")]),
                                                  h.path([h.D("M13 6l6 6-6 6")]),
                                              ],
                                          ),
                                      ],
                                  ),
                                  heartButton(h, photo, true),
                              ],
                          ),
                ],
            ),
            h.p(
                [h.Class("sr-only"), h.AriaLive("polite"), h.AriaAtomic(true)],
                [model.announcement],
            ),
        ],
    );
}

function top(h: Builder, model: Model) {
    return h.main(
        [h.Class("mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 px-4 py-6")],
        [
            h.h1(
                [h.Class("font-display text-ink text-2xl font-bold tracking-tight")],
                ["Top cats"],
            ),
            model.page.phase === "Loading"
                ? h.p([h.Class("text-pass text-sm")], ["Counting hearts…"])
                : model.page.phase === "Failed"
                  ? h.div(
                        [h.Class("flex flex-col gap-4")],
                        [
                            h.p(
                                [h.Class("text-pass text-sm")],
                                ["The leaderboard is napping. Try again in a moment."],
                            ),
                            h.button(
                                [h.Type("button"), h.OnClick({ _tag: "Retry" }), h.Class(ACTION)],
                                ["Try again"],
                            ),
                        ],
                    )
                  : model.page.entries.length === 0
                    ? h.p(
                          [h.Class("text-pass text-sm")],
                          [
                              "No hearts yet — ",
                              h.a(
                                  [h.Href("/"), h.Class("text-ink underline underline-offset-4")],
                                  ["go swipe"],
                              ),
                              ".",
                          ],
                      )
                    : h.ol(
                          [h.Class("flex flex-col gap-2")],
                          model.page.entries.map((entry) => {
                              const path = photoPagePath(entry.photo.key);
                              return path === null
                                  ? null
                                  : h.keyed("li")(
                                        entry.photo.key,
                                        [],
                                        [
                                            h.a(
                                                [
                                                    h.Href(path),
                                                    h.Class(
                                                        "border-line bg-card hover:border-pass focus-visible:ring-ink flex items-center gap-3 rounded-2xl border p-3 transition-colors focus-visible:ring-2 focus-visible:outline-hidden",
                                                    ),
                                                ],
                                                [
                                                    h.span(
                                                        [
                                                            h.Class(
                                                                "text-pass w-6 shrink-0 text-right text-sm font-semibold tabular-nums",
                                                            ),
                                                        ],
                                                        [String(entry.rank)],
                                                    ),
                                                    h.img([
                                                        h.Src(entry.photo.url),
                                                        h.Alt("A cat"),
                                                        h.Width("96"),
                                                        h.Height("96"),
                                                        h.Loading("lazy"),
                                                        h.Decoding("async"),
                                                        h.Class(
                                                            "size-24 shrink-0 rounded-xl object-cover",
                                                        ),
                                                    ]),
                                                    h.span(
                                                        [
                                                            h.Class(
                                                                "text-ink text-sm font-semibold tabular-nums",
                                                            ),
                                                        ],
                                                        [`♥ ${entry.photo.likes}`],
                                                    ),
                                                ],
                                            ),
                                        ],
                                    );
                          }),
                      ),
        ],
    );
}

function photoPage(h: Builder, model: Model) {
    const detail = model.page.detail;
    if (model.page.phase === "Loading")
        return h.main(
            [h.Class(`${MAIN} py-16 text-center`)],
            [h.p([h.Class("text-pass text-sm")], ["Fetching a cat…"])],
        );
    if (model.page.phase === "Failed")
        return h.main(
            [h.Class(MAIN)],
            [panel(h, "Cats are napping", "Try again in a moment.", true)],
        );
    if (detail === null) return notFound(h);
    const photo = detail.photo;
    return h.main(
        [h.Class(MAIN)],
        [
            h.a(
                [
                    h.Href("/"),
                    h.Class(`text-pass hover:text-ink self-start text-sm font-medium ${FOCUS}`),
                ],
                ["← Back to the deck"],
            ),
            model.failedImages.includes(photo.key)
                ? h.div(
                      [
                          h.Class(
                              "bg-card text-pass flex aspect-4/5 w-full max-w-md items-center justify-center self-center rounded-2xl",
                          ),
                      ],
                      ["Photo unavailable"],
                  )
                : h.img([
                      h.Src(photo.url),
                      h.Alt("A cat"),
                      h.Decoding("async"),
                      h.OnError({ _tag: "ImageFailed", key: photo.key }),
                      h.Class(
                          "bg-card border-line w-full max-w-md self-center rounded-2xl border object-cover",
                      ),
                  ]),
            h.div(
                [h.Class("flex items-center justify-between gap-4")],
                [heartCount(h, photo.likes), heartButton(h, photo, false)],
            ),
            h.p(
                [h.Class("sr-only"), h.AriaLive("polite"), h.AriaAtomic(true)],
                [model.announcement],
            ),
            h.section(
                [h.AriaLabel("Comments"), h.Class("flex flex-col gap-4")],
                [
                    h.h2([h.Class("font-display text-ink text-xl font-bold")], ["Comments"]),
                    h.form(
                        [h.OnSubmit({ _tag: "PostComment" }), h.Class("flex flex-col gap-2")],
                        [
                            h.label([h.For("comment-body"), h.Class("sr-only")], ["Add a comment"]),
                            h.textarea([
                                h.Id("comment-body"),
                                h.Value(model.draft),
                                h.OnInput((body) => ({ _tag: "DraftChanged", body })),
                                h.Maxlength(MAX_COMMENT_LENGTH),
                                h.Rows(3),
                                h.Placeholder("Say something nice about this cat"),
                                h.Class(
                                    "border-line bg-card text-ink placeholder:text-pass focus-visible:ring-ink resize-none rounded-2xl border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-hidden",
                                ),
                            ]),
                            h.div(
                                [h.Class("flex items-center justify-between gap-3")],
                                [
                                    h.span(
                                        [h.Class("text-pass text-xs tabular-nums")],
                                        [`${model.draft.length} / ${MAX_COMMENT_LENGTH}`],
                                    ),
                                    h.button(
                                        [
                                            h.Type("submit"),
                                            h.Disabled(
                                                model.sending || model.draft.trim().length === 0,
                                            ),
                                            h.Class(
                                                "bg-heart focus-visible:ring-ink focus-visible:ring-offset-cream rounded-full px-4 py-2 text-sm font-semibold text-white focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-60",
                                            ),
                                        ],
                                        [model.sending ? "Posting…" : "Post comment"],
                                    ),
                                ],
                            ),
                        ],
                    ),
                    detail.comments.length === 0
                        ? h.p([h.Class("text-pass text-sm")], ["No comments yet."])
                        : h.ul(
                              [h.AriaLabel("Comments"), h.Class("flex flex-col gap-3")],
                              detail.comments.map((comment) =>
                                  h.keyed("li")(
                                      comment.id,
                                      [h.Class("border-line bg-card rounded-2xl border px-3 py-2")],
                                      [
                                          h.p(
                                              [
                                                  h.Class(
                                                      "text-pass flex items-center gap-2 text-xs",
                                                  ),
                                              ],
                                              [
                                                  h.span(
                                                      [h.Class("text-ink font-semibold")],
                                                      [comment.mine ? "You" : "Anonymous"],
                                                  ),
                                                  h.time(
                                                      [h.Datetime(comment.createdAt)],
                                                      [
                                                          relativeTime(
                                                              comment.createdAt,
                                                              model.page.now,
                                                          ),
                                                      ],
                                                  ),
                                              ],
                                          ),
                                          h.p(
                                              [
                                                  h.Class(
                                                      "text-ink mt-1 text-sm wrap-break-word whitespace-pre-wrap",
                                                  ),
                                              ],
                                              [comment.body],
                                          ),
                                      ],
                                  ),
                              ),
                          ),
                ],
            ),
        ],
    );
}

function notFound(h: Builder) {
    return h.main(
        [
            h.Class(
                "mx-auto flex w-full max-w-lg flex-1 flex-col items-center gap-3 px-4 py-16 text-center",
            ),
        ],
        [
            h.h1([h.Class("font-display text-ink text-2xl font-bold")], ["That cat wandered off."]),
            h.a(
                [h.Href("/"), h.Class(`text-ink text-sm underline underline-offset-4 ${FOCUS}`)],
                ["Back to the deck"],
            ),
        ],
    );
}

export function view(model: Model, h: Builder): Html.Document {
    const kind = model.page.kind;
    const title =
        kind === "Top"
            ? "Top cats · Jake's Cats"
            : kind === "Photo" || model.page.path.startsWith("/photos/")
              ? "A cat · Jake's Cats"
              : "Jake's Cats";
    const photoPath =
        model.page.detail === null ? null : photoPagePath(model.page.detail.photo.key);
    return {
        title,
        lang: "en",
        ogUrl: photoPath === null ? SITE_URL : `${SITE_URL}${photoPath}`,
        body: h.div(
            [h.Id("cats-app"), h.Class("bg-cream text-ink flex min-h-dvh flex-col antialiased")],
            [
                h.header(
                    [
                        h.Class(
                            "mx-auto flex w-full max-w-lg shrink-0 items-center justify-between px-4 pt-4",
                        ),
                    ],
                    [
                        h.a(
                            [
                                h.Href("/"),
                                h.AriaLabel("Jake's Cats — home"),
                                h.Class(`flex items-center ${FOCUS}`),
                            ],
                            [
                                h.img([
                                    h.Src(SITE_MARK_URL),
                                    h.Alt(""),
                                    h.Class("size-7 rounded-md"),
                                    h.Style({ "image-rendering": "pixelated" }),
                                ]),
                            ],
                        ),
                        h.nav(
                            [
                                h.AriaLabel("Site"),
                                h.Class("flex items-center gap-4 text-sm font-medium"),
                            ],
                            [
                                h.a(
                                    [
                                        h.Href("/"),
                                        h.Class(
                                            `${FOCUS} ${kind === "Home" ? "text-ink underline underline-offset-4" : "text-pass hover:text-ink"}`,
                                        ),
                                        ...(kind === "Home" ? [h.AriaCurrent("page")] : []),
                                    ],
                                    ["Deck"],
                                ),
                                h.a(
                                    [
                                        h.Href("/top"),
                                        h.Class(
                                            `${FOCUS} ${kind === "Top" ? "text-ink underline underline-offset-4" : "text-pass hover:text-ink"}`,
                                        ),
                                        ...(kind === "Top" ? [h.AriaCurrent("page")] : []),
                                    ],
                                    ["Top cats"],
                                ),
                            ],
                        ),
                    ],
                ),
                Match.value(kind).pipe(
                    Match.when("Home", () => home(h, model)),
                    Match.when("Top", () => top(h, model)),
                    Match.when("Photo", () => photoPage(h, model)),
                    Match.orElse(() => notFound(h)),
                ),
                model.toast === null
                    ? null
                    : h.div(
                          [
                              h.Class(
                                  "pointer-events-none fixed inset-x-0 bottom-[max(1.5rem,env(safe-area-inset-bottom))] z-50 flex justify-center px-4",
                              ),
                          ],
                          [
                              h.p(
                                  [
                                      h.Role("status"),
                                      h.AriaLive("polite"),
                                      h.Class(
                                          "cat-toast bg-ink text-cream rounded-full px-4 py-2 text-sm font-medium shadow-lg",
                                      ),
                                  ],
                                  [model.toast],
                              ),
                          ],
                      ),
                h.footer(
                    [h.Class("border-line mt-auto border-t")],
                    [
                        h.p(
                            [
                                h.Class(
                                    "text-pass mx-auto w-full max-w-lg px-4 py-6 text-center text-xs",
                                ),
                            ],
                            [
                                "A corner of ",
                                h.a(
                                    [
                                        h.Href("https://www.artisann.dev"),
                                        h.Target("_blank"),
                                        h.Rel("noreferrer"),
                                        h.Class(
                                            `text-ink hover:text-heart-ink underline underline-offset-4 transition-colors ${FOCUS}`,
                                        ),
                                    ],
                                    ["artisann.dev"],
                                ),
                            ],
                        ),
                    ],
                ),
            ],
        ),
    };
}

import {
    Album01Icon,
    ArrowUpRight01Icon,
    ChevronLeftIcon,
    ChevronRightIcon,
    ImageNotFound01Icon,
    MusicNote02Icon,
    SunCloud02Icon,
} from "@hugeicons-pro/core-solid-rounded";
import type { Html, HtmlBuilder } from "foldkit/html";
import { projectImageSource } from "../lib/project-image.ts";
import { AdoptImage, Message, type Model } from "../main.ts";
import { card, CARD_CONTENT, CARD_HEADER, icon, ICON_BUTTON } from "./ui.ts";

export function projectCarousel(
    model: Model,
    h: HtmlBuilder<Message>,
    kind: "apps" | "openSource",
): Html {
    const projects = model.content[kind];
    const selectedId = kind === "apps" ? model.appId : model.openSourceId;
    const index = Math.max(
        0,
        projects.findIndex((project) => project.id === selectedId),
    );
    const project = projects[index];
    if (project === undefined)
        return h.div(
            [h.Class(CARD_CONTENT)],
            [
                h.p(
                    [h.Class("text-caption text-muted-foreground")],
                    [kind === "apps" ? "Nothing deployed yet." : "Nothing here yet."],
                ),
            ],
        );
    const url = new URL(project.url);
    const src = projectImageSource(project);
    const failed = src === null || model.failedImages.includes(src);
    const loading = src !== null && !model.loadedImages.includes(src);
    const placeholder = h.div(
        [
            h.Class(
                "absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl text-muted-foreground",
            ),
            h.Role("status"),
        ],
        [
            icon(h, failed ? ImageNotFound01Icon : Album01Icon, 28),
            h.p(
                [h.Class("text-image-caption text-muted-foreground")],
                [
                    failed
                        ? `Preview unavailable · Visit ${project.name}`
                        : kind === "apps"
                          ? "Website OG image"
                          : "GitHub OG image",
                ],
            ),
        ],
    );
    const path = url.pathname.replace(/^\/+|\/+$/gu, "");
    const label =
        url.hostname === "github.com" && path.length > 0
            ? path
            : url.hostname.replace(/^www\./u, "");
    const direction = kind === "apps" ? model.appDirection : model.openSourceDirection;
    return h.div(
        [h.Class(`${CARD_CONTENT} flex min-h-0 flex-col gap-3 lg:flex-1`)],
        [
            h.div(
                [h.Class("relative min-w-0 overflow-hidden")],
                [
                    h.keyed("a")(
                        `${kind}-${project.id}-preview`,
                        [
                            h.Href(project.url),
                            h.AriaLabel(`Visit ${project.name}`),
                            h.Class(
                                "portfolio-slide relative block aspect-[1200/630] w-full overflow-hidden rounded-xl bg-muted",
                            ),
                            h.Style({ "--slide-from": `${direction * 20}px` }),
                        ],
                        [
                            src === null || failed
                                ? placeholder
                                : h.img([
                                      h.Src(src),
                                      h.Alt(`${project.name} Open Graph preview`),
                                      h.Width("1200"),
                                      h.Height("630"),
                                      h.Loading("lazy"),
                                      h.Decoding("async"),
                                      h.Class(
                                          `size-full object-cover transition-opacity duration-200 ease-out ${loading ? "opacity-0" : ""}`,
                                      ),
                                      h.OnMount(AdoptImage({ src })),
                                      h.OnLoad(Message.SettledImage({ src, failed: false })),
                                      h.OnError(Message.SettledImage({ src, failed: true })),
                                  ]),
                            !failed && loading ? placeholder : null,
                        ],
                    ),
                ],
            ),
            h.div(
                [
                    h.Class("flex h-11 items-center justify-between gap-3 lg:h-9"),
                    h.Role("group"),
                    h.AriaLabel(
                        kind === "apps" ? "Deployed apps carousel" : "Open source carousel",
                    ),
                ],
                [
                    h.span(
                        [h.Class("flex items-center gap-1.5"), h.AriaHidden(true)],
                        projects.map((_, position) =>
                            h.span([
                                h.Class(
                                    `h-1.25 rounded-full transition-[width] duration-200 ease-out ${position === index ? "w-4.5 bg-foreground" : "w-1.25 bg-muted-foreground/40"}`,
                                ),
                            ]),
                        ),
                    ),
                    h.span(
                        [h.Class("flex items-center gap-3")],
                        [-1, 1].map((delta) =>
                            h.button(
                                [
                                    h.Type("button"),
                                    h.Class(ICON_BUTTON),
                                    h.Disabled(projects.length < 2),
                                    h.AriaLabel(delta < 0 ? "Previous project" : "Next project"),
                                    h.OnClick(Message.StepProject({ kind, delta })),
                                ],
                                [icon(h, delta < 0 ? ChevronLeftIcon : ChevronRightIcon)],
                            ),
                        ),
                    ),
                ],
            ),
            h.div(
                [h.Class("relative min-w-0 overflow-hidden"), h.AriaLive("polite")],
                [
                    h.keyed("div")(
                        `${kind}-${project.id}-description`,
                        [
                            h.Class("portfolio-slide flex min-w-0 flex-col gap-2"),
                            h.Style({ "--slide-from": `${direction * 20}px` }),
                        ],
                        [
                            h.div(
                                [h.Class("flex flex-col gap-1")],
                                [
                                    h.h3([h.Class("text-project font-semibold")], [project.name]),
                                    h.p(
                                        [h.Class("text-label text-muted-foreground")],
                                        [project.description],
                                    ),
                                ],
                            ),
                            h.a(
                                [
                                    h.Href(project.url),
                                    h.Class(
                                        "flex h-11 items-center text-caption font-medium text-primary lg:h-auto",
                                    ),
                                ],
                                [label, icon(h, ArrowUpRight01Icon, 12, "ml-1")],
                            ),
                        ],
                    ),
                ],
            ),
        ],
    );
}

export function musicWidget(model: Model, h: HtmlBuilder<Message>): Html {
    const { snapshot, failed, settled } = model.presence;
    const song = snapshot?.song ?? null;
    const retained =
        song !== null && (failed || snapshot?.stale || snapshot?.playback === "last-played");
    const artwork = song?.artworkUrl ?? null;
    const heading =
        song === null
            ? "Listening"
            : retained
              ? "Last played"
              : snapshot?.playback === "paused"
                ? "Paused"
                : "Listening";
    let title =
        song?.title ??
        (!settled ? "Checking playback" : failed ? "Playback unavailable" : "Between songs");
    if (song !== null) {
        const segments = [
            ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(title),
        ];
        if (segments.length > 40)
            title = `${segments
                .slice(0, 40)
                .map((part) => part.segment)
                .join("")
                .trimEnd()}…`;
    }
    return card(
        h,
        [h.Role("region"), h.Attribute("aria-labelledby", "music-heading")],
        [
            h.div(
                [
                    h.Class(
                        `${CARD_CONTENT} flex flex-col items-start gap-3 @xs/music:flex-row @xs/music:items-center @xs/music:gap-4`,
                    ),
                ],
                [
                    artwork !== null && !model.failedImages.includes(artwork)
                        ? h.img([
                              h.Src(artwork),
                              h.Alt(`Album art for ${song?.title} by ${song?.artist}`),
                              h.Width("72"),
                              h.Height("72"),
                              h.Loading("lazy"),
                              h.Decoding("async"),
                              h.Draggable(false),
                              h.OnError(Message.SettledImage({ src: artwork, failed: true })),
                              h.Class(
                                  `size-18 flex-none rounded-xl bg-muted object-cover ${retained ? "opacity-70" : ""}`,
                              ),
                          ])
                        : h.div(
                              [
                                  h.Class(
                                      `flex size-18 flex-none items-center justify-center rounded-xl border border-dashed border-border text-muted-foreground ${retained ? "opacity-70" : ""}`,
                                  ),
                              ],
                              [icon(h, MusicNote02Icon, 28)],
                          ),
                    h.div(
                        [h.Class("flex w-full min-w-0 flex-1 flex-col gap-0")],
                        [
                            h.h2(
                                [
                                    h.Id("music-heading"),
                                    h.Class("text-caption text-muted-foreground"),
                                ],
                                [heading],
                            ),
                            h.div(
                                [h.Class("flex flex-col gap-0.5")],
                                [
                                    h.p(
                                        [
                                            h.Class(
                                                "text-[1.125rem]/[1.4625rem] font-semibold break-words",
                                            ),
                                            h.Title(song?.title ?? title),
                                        ],
                                        [title],
                                    ),
                                    song === null
                                        ? null
                                        : h.p(
                                              [
                                                  h.Class(
                                                      "text-caption break-words text-muted-foreground",
                                                  ),
                                              ],
                                              [song.artist],
                                          ),
                                ],
                            ),
                            h.a(
                                [
                                    h.Href(song?.url ?? "https://music.youtube.com/"),
                                    h.AriaLabel(
                                        song === null
                                            ? "Open YouTube Music"
                                            : `Open ${song.title} in YouTube Music`,
                                    ),
                                    h.Class(
                                        "flex h-11 items-center gap-2 text-caption font-medium text-primary",
                                    ),
                                ],
                                ["YouTube Music", icon(h, ArrowUpRight01Icon, 16)],
                            ),
                        ],
                    ),
                ],
            ),
        ],
        "@container/music min-h-[135px] justify-center py-3 [--card-spacing:--spacing(5)]",
    );
}

export function statusWidget(model: Model, h: HtmlBuilder<Message>): Html {
    const { snapshot, failed, settled } = model.presence;
    const available = snapshot !== null && !failed && !snapshot.stale && snapshot.status !== null;
    const labels = { online: "Online", idle: "Idle", dnd: "Do not disturb", offline: "Offline" };
    const label =
        available && snapshot.status !== null
            ? labels[snapshot.status]
            : !settled
              ? "Connecting"
              : "Status unavailable";
    const dot = !available
        ? "bg-muted-foreground/40"
        : snapshot.status === "online"
          ? "bg-foreground"
          : snapshot.status === "dnd"
            ? "bg-destructive"
            : "bg-muted-foreground";
    return card(
        h,
        [h.Role("region"), h.Attribute("aria-labelledby", "status-heading")],
        [
            h.div(
                [h.Class(`${CARD_HEADER} gap-0`)],
                [
                    h.h2(
                        [h.Id("status-heading"), h.Class("text-caption text-muted-foreground")],
                        ["Status"],
                    ),
                ],
            ),
            h.div(
                [h.Class(`${CARD_CONTENT} flex flex-1 flex-col justify-center gap-3`)],
                [
                    h.p(
                        [
                            h.Class("flex items-center gap-2.5 text-subheading font-semibold"),
                            h.AriaLive("polite"),
                        ],
                        [
                            h.span([
                                h.Class(`size-2 shrink-0 rounded-full ${dot}`),
                                h.AriaHidden(true),
                            ]),
                            label,
                        ],
                    ),
                ],
            ),
        ],
        "h-full gap-3 [--card-spacing:--spacing(5)]",
    );
}

export function weatherWidget(model: Model, h: HtmlBuilder<Message>): Html {
    const reading = model.weather;
    const status =
        reading === null
            ? model.weatherSettled
                ? "Weather unavailable"
                : "Waiting for weather"
            : model.weatherFailed
              ? "Last reading, refresh failed"
              : null;
    return card(
        h,
        [h.Role("region"), h.Attribute("aria-labelledby", "weather-heading")],
        [
            h.div(
                [h.Class(`${CARD_HEADER} grid-cols-[1fr_auto] gap-0`)],
                [
                    h.h2(
                        [h.Id("weather-heading"), h.Class("text-caption text-muted-foreground")],
                        ["Weather in Dallas"],
                    ),
                    h.div([h.Class("text-muted-foreground")], [icon(h, SunCloud02Icon, 20)]),
                ],
            ),
            h.div(
                [h.Class(`${CARD_CONTENT} flex items-center gap-3`)],
                [
                    h.p(
                        [
                            h.Class("shrink-0 text-display font-semibold whitespace-nowrap"),
                            h.AriaLive("polite"),
                        ],
                        [
                            reading === null
                                ? "—°"
                                : `${Math.round(reading.temperature)}${reading.unit}`,
                        ],
                    ),
                    status === null
                        ? null
                        : h.p([h.Class("min-w-0 text-caption text-muted-foreground")], [status]),
                ],
            ),
        ],
        "h-full gap-3 [--card-spacing:--spacing(5)]",
    );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LEVEL_COLORS = {
    NONE: "bg-muted",
    FIRST_QUARTILE: "bg-foreground/20",
    SECOND_QUARTILE: "bg-foreground/40",
    THIRD_QUARTILE: "bg-foreground/65",
    FOURTH_QUARTILE: "bg-foreground",
};
const CELL = "h-2.25 rounded-[2px] lg:h-3.5 lg:rounded-full";

export function githubWidget(model: Model, h: HtmlBuilder<Message>): Html {
    const snapshot = model.github;
    const weeks = snapshot?.calendar.weeks ?? [];
    const july =
        snapshot === null
            ? -1
            : weeks.findIndex((week) => week.firstDay >= `${snapshot.year}-07-01`);
    const halves = july === -1 ? [weeks, []] : [weeks.slice(0, july), weeks.slice(july)];
    const today = snapshot?.updatedAt.slice(0, 10) ?? "";
    const monthRow = (months: readonly string[], className = "") =>
        h.div(
            [h.Class(`flex justify-between text-caption text-muted-foreground ${className}`)],
            months.map((month) => h.span([], [month])),
        );
    const total = snapshot?.calendar.totalContributions.toLocaleString("en-US");
    return card(
        h,
        [h.Role("region"), h.AriaLabel("GitHub activity")],
        [
            h.div(
                [
                    h.Class(
                        `${CARD_CONTENT} flex items-center justify-between gap-4 text-caption text-muted-foreground`,
                    ),
                ],
                [
                    h.a(
                        [
                            h.Href("https://github.com/ImArtisann"),
                            h.Class("flex h-11 min-w-0 items-center lg:h-auto"),
                        ],
                        ["ImArtisann on GitHub"],
                    ),
                    h.span(
                        [h.Class("shrink-0 tabular-nums")],
                        [String(snapshot?.year ?? model.year)],
                    ),
                ],
            ),
            h.div(
                [h.Class(`${CARD_CONTENT} hidden lg:block`), h.AriaHidden(true)],
                [monthRow(MONTHS)],
            ),
            h.div(
                [
                    h.Class(
                        `${CARD_CONTENT} flex flex-col gap-4 lg:flex-row lg:gap-1 lg:pr-[calc(var(--card-spacing)+2px)]`,
                    ),
                    h.AriaHidden(true),
                ],
                halves.flatMap((half, index) => [
                    monthRow(MONTHS.slice(index * 6, index * 6 + 6), "lg:hidden"),
                    h.div(
                        [
                            h.Class("flex min-w-0 gap-0.75 lg:flex-[var(--weeks)_1_0%] lg:gap-1"),
                            h.Style({
                                "--weeks": String(
                                    snapshot === null ? (index === 0 ? 27 : 26) : half.length,
                                ),
                            }),
                        ],
                        snapshot === null
                            ? Array.from({ length: index === 0 ? 27 : 26 }, () =>
                                  h.div(
                                      [h.Class("flex min-w-0 flex-1 flex-col gap-0.75")],
                                      Array.from({ length: 7 }, () =>
                                          h.span([h.Class(`${CELL} bg-muted`)]),
                                      ),
                                  ),
                              )
                            : half.map((week) =>
                                  h.div(
                                      [h.Class("flex min-w-0 flex-1 flex-col gap-0.75")],
                                      Array.from({ length: 7 }, (_, weekday) => {
                                          const day = week.contributionDays.find(
                                              (candidate) => candidate.weekday === weekday,
                                          );
                                          if (day === undefined) return h.span([h.Class(CELL)]);
                                          const future = day.date > today;
                                          const date = new Intl.DateTimeFormat("en-US", {
                                              month: "short",
                                              day: "numeric",
                                              year: "numeric",
                                              timeZone: "UTC",
                                          }).format(new Date(`${day.date}T12:00:00Z`));
                                          return h.span([
                                              h.Class(
                                                  `${CELL} ${future ? "bg-muted/40" : LEVEL_COLORS[day.contributionLevel]}`,
                                              ),
                                              h.Title(
                                                  future
                                                      ? `${date}: upcoming`
                                                      : `${date}: ${day.contributionCount} contributions`,
                                              ),
                                          ]);
                                      }),
                                  ),
                              ),
                    ),
                ]),
            ),
            h.div(
                [h.Class(CARD_CONTENT)],
                [
                    h.p(
                        [h.Class("text-caption text-muted-foreground"), h.Role("status")],
                        [
                            snapshot === null
                                ? model.githubFailed
                                    ? "GitHub activity is temporarily unavailable."
                                    : "Awaiting GitHub data"
                                : `${total} contributions in ${snapshot.year}${model.githubFailed || snapshot.stale ? " · Last saved activity" : ""}`,
                        ],
                    ),
                    snapshot === null
                        ? null
                        : h.p(
                              [h.Class("sr-only")],
                              [
                                  `${total} GitHub contributions in ${snapshot.year}. Each square is one day, shaded from less to more contributions. Daily details are available on the linked GitHub profile.`,
                              ],
                          ),
                ],
            ),
        ],
        "gap-4",
    );
}

import { requireAssetPath } from "@artisann-port/assets/urls";
import {
    ArrowUpRight01Icon,
    BirthdayCakeIcon,
    BlueskyIcon,
    CatIcon,
    DiscordIcon,
    Dumbbell01Icon,
    GithubIcon,
    HeadphonesIcon,
    InstagramIcon,
    Link01Icon,
    Mail01Icon,
    Moon02Icon,
    NewTwitterIcon,
    Sun03Icon,
    TwitchIcon,
    YoutubeIcon,
} from "@hugeicons-pro/core-solid-rounded";
import type { Document, HtmlBuilder } from "foldkit/html";
import * as Gallery from "./components/gallery.ts";
import * as Notes from "./components/notes.ts";
import { assetImage, card, CARD_CONTENT, CARD_HEADER, icon } from "./components/ui.ts";
import {
    githubWidget,
    musicWidget,
    projectCarousel,
    statusWidget,
    weatherWidget,
} from "./components/widgets.ts";
import { Message, type Model } from "./main.ts";

const DOMAINS = [
    "editor.so",
    "fym.me",
    "jtw.lol",
    "kyros.gg",
    "leftover.app",
    "purio.me",
    "rate.cat",
    "twisted.to",
    "workflo.so",
];
const FACT_ICONS = {
    birthday: BirthdayCakeIcon,
    cats: CatIcon,
    music: HeadphonesIcon,
    fitness: Dumbbell01Icon,
};
const SOCIAL_ICONS = {
    github: GithubIcon,
    x: NewTwitterIcon,
    bluesky: BlueskyIcon,
    youtube: YoutubeIcon,
    twitch: TwitchIcon,
    instagram: InstagramIcon,
    discord: DiscordIcon,
    mail: Mail01Icon,
    link: Link01Icon,
};
const NAV_LINK = "flex h-11 items-center px-1.5 text-sm leading-[1.5] lg:h-auto lg:px-0";
const PROFILE = requireAssetPath("portfolio/profile-picture.jpg");
const PIXEL_CATS = requireAssetPath("portfolio/cats.webp");

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
    const content = model.content;
    const themeLabel = model.theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
    const gallery = (placement: "life-desktop" | "life-mobile" | "cats") =>
        h.submodel({
            slotId: placement,
            model: model.gallery,
            view: Gallery.view,
            viewInputs: { placement },
            toParentMessage: (message) => Message.GalleryMessage({ message }),
        });
    const notes = (placement: "desktop" | "mobile") =>
        h.submodel({
            slotId: `notes-${placement}`,
            model: model.notes,
            view: Notes.view,
            viewInputs: { placement },
            toParentMessage: (message) => Message.NotesMessage({ message }),
        });
    return {
        title: "Artisann | Developer & Automation Architect",
        lang: "en",
        canonical: "https://www.artisann.dev/",
        body: h.div(
            [
                h.DataAttribute("portfolio-page", ""),
                h.DataAttribute("design-node", "SGDDb"),
                h.Class(
                    "mx-auto flex w-full max-w-360 flex-col gap-6 px-5 pt-6 pb-7 lg:gap-7 lg:px-16 lg:pt-9",
                ),
            ],
            [
                h.a(
                    [
                        h.Href("#main-content"),
                        h.Class(
                            "fixed -top-20 left-5 z-20 rounded-xl bg-primary p-3 text-label text-primary-foreground focus:top-4",
                        ),
                    ],
                    ["Skip to content"],
                ),
                h.header(
                    [
                        h.DataAttribute("portfolio-section", "site-navigation"),
                        h.DataAttribute("design-node", "OYWzR"),
                        h.Class("flex h-12 items-center justify-between"),
                    ],
                    [
                        h.a(
                            [
                                h.Href("/"),
                                h.AriaLabel("Artisann home"),
                                h.Class(
                                    "flex h-11 items-center text-wordmark font-normal tracking-[-0.02em] lg:h-auto",
                                ),
                            ],
                            ["artisann."],
                        ),
                        h.nav(
                            [
                                h.AriaLabel("Main navigation"),
                                h.Class("flex items-center gap-1 lg:gap-8"),
                            ],
                            [
                                h.a(
                                    [
                                        h.Href("/"),
                                        h.Attribute("aria-current", "page"),
                                        h.Class(`${NAV_LINK} text-primary`),
                                    ],
                                    ["Home"],
                                ),
                                h.a(
                                    [
                                        h.Href("https://jakes.cat"),
                                        h.Class(`${NAV_LINK} text-muted-foreground`),
                                    ],
                                    ["cats"],
                                ),
                                h.a(
                                    [
                                        h.Href("mailto:hello@artisann.dev"),
                                        h.Class(`${NAV_LINK} font-medium text-primary`),
                                    ],
                                    ["Say hello"],
                                ),
                                h.button(
                                    [
                                        h.Type("button"),
                                        h.Class(
                                            "inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 lg:size-4.5",
                                        ),
                                        h.AriaLabel(themeLabel),
                                        h.Title(themeLabel),
                                        h.OnClick(Message.ToggleTheme()),
                                    ],
                                    [icon(h, model.theme === "dark" ? Moon02Icon : Sun03Icon)],
                                ),
                            ],
                        ),
                    ],
                ),
                h.main(
                    [
                        h.Id("main-content"),
                        h.DataAttribute("portfolio-section", "page-grid"),
                        h.DataAttribute("design-node", "rN8gr"),
                        h.Class(
                            "flex min-w-0 flex-col gap-6 lg:grid lg:grid-cols-[304px_minmax(0,352fr)_minmax(240px,208fr)_minmax(0,400fr)] lg:gap-4",
                        ),
                    ],
                    [
                        h.aside(
                            [
                                h.AriaLabel("About Artisann"),
                                h.DataAttribute("portfolio-section", "sidebar"),
                                h.DataAttribute("design-node", "uUTF6"),
                                h.Class(
                                    "flex min-w-0 flex-col gap-6 lg:col-start-1 lg:row-span-4 lg:row-start-1 lg:gap-8 lg:pt-2 lg:pr-8",
                                ),
                            ],
                            [
                                h.div(
                                    [
                                        h.DataAttribute("design-node", "HBGRh"),
                                        h.Class(
                                            "size-19 shrink-0 overflow-hidden rounded-xl bg-muted",
                                        ),
                                    ],
                                    [
                                        assetImage(
                                            h,
                                            PROFILE,
                                            "Artisann's profile picture",
                                            76,
                                            "size-full object-cover",
                                            true,
                                        ),
                                    ],
                                ),
                                h.div(
                                    [
                                        h.DataAttribute("design-node", "FIClU"),
                                        h.Class("flex flex-col gap-3"),
                                    ],
                                    [
                                        h.h1(
                                            [
                                                h.Class(
                                                    "text-display font-semibold tracking-[-0.02em]",
                                                ),
                                            ],
                                            ["Hey, I’m Artisann."],
                                        ),
                                        h.p(
                                            [h.Class("text-base text-muted-foreground")],
                                            ["A developer & automation architect in Dallas."],
                                        ),
                                    ],
                                ),
                                h.section(
                                    [
                                        h.Attribute("aria-labelledby", "about-heading"),
                                        h.DataAttribute("design-node", "i5zhN"),
                                        h.Class("flex flex-col gap-2"),
                                    ],
                                    [
                                        h.h2(
                                            [
                                                h.Id("about-heading"),
                                                h.Class("text-heading font-semibold"),
                                            ],
                                            ["A little about me"],
                                        ),
                                        h.ul(
                                            [
                                                h.Class(
                                                    "flex flex-col gap-2 text-label text-muted-foreground",
                                                ),
                                            ],
                                            content.facts.map(({ id, icon: factIcon, label }) =>
                                                h.keyed("li")(
                                                    id,
                                                    [h.Class("flex items-center gap-2.5")],
                                                    [
                                                        icon(h, FACT_ICONS[factIcon], 17),
                                                        h.span([], [label]),
                                                    ],
                                                ),
                                            ),
                                        ),
                                        h.div(
                                            [h.Class("flex flex-col gap-1.5 pt-2 pl-7")],
                                            [
                                                h.h3(
                                                    [h.Class("text-aside text-muted-foreground")],
                                                    ["Personal records"],
                                                ),
                                                h.dl(
                                                    [h.Class("flex flex-col gap-1.5")],
                                                    [
                                                        ["Bench", content.records.bench],
                                                        ["Squat", content.records.squat],
                                                        ["Deadlift", content.records.deadlift],
                                                    ].map(([label, value]) =>
                                                        h.div(
                                                            [h.Class("flex justify-between gap-3")],
                                                            [
                                                                h.dt(
                                                                    [
                                                                        h.Class(
                                                                            "text-aside text-muted-foreground",
                                                                        ),
                                                                    ],
                                                                    [String(label)],
                                                                ),
                                                                h.dd(
                                                                    [
                                                                        h.Class(
                                                                            "text-label font-semibold tabular-nums",
                                                                        ),
                                                                    ],
                                                                    [String(value)],
                                                                ),
                                                            ],
                                                        ),
                                                    ),
                                                ),
                                            ],
                                        ),
                                    ],
                                ),
                                h.section(
                                    [
                                        h.Attribute("aria-labelledby", "domains-heading"),
                                        h.DataAttribute("portfolio-section", "domains"),
                                        h.Class("flex flex-col gap-2"),
                                    ],
                                    [
                                        h.h2(
                                            [
                                                h.Id("domains-heading"),
                                                h.Class("text-heading font-semibold"),
                                            ],
                                            ["Domain list"],
                                        ),
                                        h.ul(
                                            [h.Class("grid grid-cols-2 gap-x-4")],
                                            DOMAINS.map((domain) =>
                                                h.li(
                                                    [],
                                                    [
                                                        h.a(
                                                            [
                                                                h.Href(`https://${domain}`),
                                                                h.Class(
                                                                    "flex min-h-11 items-center gap-1 text-label font-medium text-primary",
                                                                ),
                                                            ],
                                                            [
                                                                domain,
                                                                icon(
                                                                    h,
                                                                    ArrowUpRight01Icon,
                                                                    12,
                                                                    "text-muted-foreground",
                                                                ),
                                                            ],
                                                        ),
                                                    ],
                                                ),
                                            ),
                                        ),
                                    ],
                                ),
                                gallery("life-desktop"),
                            ],
                        ),
                        card(
                            h,
                            [
                                h.Id("work"),
                                h.DataAttribute("portfolio-section", "deployed-apps"),
                                h.DataAttribute("design-node", "LWPRy"),
                            ],
                            [projectCarousel(model, h, "apps")],
                            "gap-3 lg:col-span-2 lg:col-start-2 lg:row-start-1",
                        ),
                        h.div(
                            [
                                h.DataAttribute("portfolio-section", "listening-notes"),
                                h.DataAttribute("design-node", "Y5A1J"),
                                h.Class(
                                    "flex min-w-0 flex-col gap-6 lg:col-start-2 lg:row-start-3 lg:gap-4",
                                ),
                            ],
                            [
                                musicWidget(model, h),
                                h.div(
                                    [
                                        h.DataAttribute("portfolio-section", "socials"),
                                        h.DataAttribute("design-node", "I7lMtH"),
                                    ],
                                    [
                                        content.socials.length === 0
                                            ? h.p(
                                                  [h.Class("text-caption text-muted-foreground")],
                                                  ["Nowhere else yet."],
                                              )
                                            : h.ul(
                                                  [
                                                      h.AriaLabel("Elsewhere"),
                                                      h.Class("flex flex-wrap items-center gap-3"),
                                                  ],
                                                  content.socials.map(
                                                      ({ id, icon: socialIcon, label, url }) =>
                                                          h.keyed("li")(
                                                              id,
                                                              [],
                                                              [
                                                                  h.a(
                                                                      [
                                                                          h.Href(url),
                                                                          h.AriaLabel(label),
                                                                          h.Title(label),
                                                                          h.Class(
                                                                              "flex size-11 items-center justify-center text-primary lg:size-9",
                                                                          ),
                                                                      ],
                                                                      [
                                                                          icon(
                                                                              h,
                                                                              SOCIAL_ICONS[
                                                                                  socialIcon
                                                                              ],
                                                                              18,
                                                                          ),
                                                                      ],
                                                                  ),
                                                              ],
                                                          ),
                                                  ),
                                              ),
                                    ],
                                ),
                            ],
                        ),
                        card(
                            h,
                            [
                                h.DataAttribute("portfolio-section", "open-source"),
                                h.DataAttribute("design-node", "lTwEH"),
                            ],
                            [projectCarousel(model, h, "openSource")],
                            "min-h-0 overflow-hidden lg:col-span-2 lg:col-start-2 lg:row-start-2 lg:h-full lg:min-h-64",
                        ),
                        card(
                            h,
                            [
                                h.DataAttribute("portfolio-section", "cat-gallery"),
                                h.DataAttribute("design-node", "S3g7P"),
                            ],
                            [gallery("cats")],
                            "[--card-spacing:--spacing(3)] lg:col-start-4 lg:row-start-1",
                        ),
                        h.div(
                            [
                                h.DataAttribute("portfolio-section", "git-history"),
                                h.DataAttribute("design-node", "nYszh"),
                                h.Class(
                                    "grid min-w-0 lg:col-span-3 lg:col-start-2 lg:row-start-5 lg:min-h-68",
                                ),
                            ],
                            [githubWidget(model, h)],
                        ),
                        gallery("life-mobile"),
                        card(
                            h,
                            [
                                h.DataAttribute("portfolio-section", "uses"),
                                h.DataAttribute("design-node", "s6ZG2G"),
                            ],
                            [
                                h.div(
                                    [
                                        h.Class(
                                            `${CARD_CONTENT} grid grid-cols-2 gap-x-5 gap-y-4 lg:grid-cols-3 lg:gap-x-8`,
                                        ),
                                    ],
                                    [
                                        {
                                            heading: "Software",
                                            items: content.uses.software,
                                            className: "",
                                        },
                                        {
                                            heading: "Hardware",
                                            items: content.uses.hardware,
                                            className:
                                                "col-span-2 row-start-2 lg:col-span-1 lg:col-start-2 lg:row-start-1",
                                        },
                                        {
                                            heading: "Languages",
                                            items: content.uses.languages,
                                            className: "col-start-2 lg:col-start-3 lg:row-start-1",
                                        },
                                    ].map(({ heading, items, className }) =>
                                        h.section(
                                            [h.Class(`flex min-w-0 flex-col gap-1.5 ${className}`)],
                                            [
                                                h.h3(
                                                    [h.Class("text-subheading font-semibold")],
                                                    [heading],
                                                ),
                                                h.ul(
                                                    [h.Class("flex flex-col gap-1 text-base")],
                                                    items.length === 0
                                                        ? [
                                                              h.li(
                                                                  [
                                                                      h.Class(
                                                                          "text-muted-foreground",
                                                                      ),
                                                                  ],
                                                                  ["—"],
                                                              ),
                                                          ]
                                                        : items.map((item) =>
                                                              h.li([], [item.label]),
                                                          ),
                                                ),
                                            ],
                                        ),
                                    ),
                                ),
                            ],
                            "lg:col-span-3 lg:col-start-2 lg:row-start-4",
                        ),
                        h.div(
                            [
                                h.DataAttribute("portfolio-section", "experience-socials"),
                                h.DataAttribute("design-node", "usrua"),
                                h.Class(
                                    "grid min-w-0 gap-6 lg:col-span-2 lg:col-start-3 lg:row-start-3 lg:gap-4",
                                ),
                            ],
                            [
                                card(
                                    h,
                                    [
                                        h.DataAttribute("size", "sm"),
                                        h.DataAttribute("portfolio-section", "work-experience"),
                                        h.DataAttribute("design-node", "tXZgT"),
                                    ],
                                    [
                                        h.div(
                                            [h.Class(CARD_HEADER)],
                                            [
                                                h.h2(
                                                    [
                                                        h.Id("experience-heading"),
                                                        h.Class(
                                                            "text-title font-semibold tracking-[-0.02em]",
                                                        ),
                                                    ],
                                                    ["Work experience"],
                                                ),
                                            ],
                                        ),
                                        h.div(
                                            [h.Class(CARD_CONTENT)],
                                            [
                                                h.ul(
                                                    [h.Class("flex flex-col gap-3")],
                                                    content.experience.map(
                                                        ({ id, company, years, title }) =>
                                                            h.keyed("li")(
                                                                id,
                                                                [h.Class("flex flex-col gap-0.5")],
                                                                [
                                                                    h.div(
                                                                        [
                                                                            h.Class(
                                                                                "flex items-center justify-between gap-3",
                                                                            ),
                                                                        ],
                                                                        [
                                                                            h.h3(
                                                                                [
                                                                                    h.Class(
                                                                                        "min-w-0 text-label leading-[1.375rem] font-semibold lg:leading-5",
                                                                                    ),
                                                                                ],
                                                                                [company],
                                                                            ),
                                                                            h.p(
                                                                                [
                                                                                    h.Class(
                                                                                        "shrink-0 text-caption text-right text-muted-foreground",
                                                                                    ),
                                                                                ],
                                                                                [years],
                                                                            ),
                                                                        ],
                                                                    ),
                                                                    h.p(
                                                                        [
                                                                            h.Class(
                                                                                "text-caption text-muted-foreground",
                                                                            ),
                                                                        ],
                                                                        [title],
                                                                    ),
                                                                ],
                                                            ),
                                                    ),
                                                ),
                                            ],
                                        ),
                                    ],
                                    "gap-3 [--card-spacing:--spacing(4)]",
                                ),
                            ],
                        ),
                        h.div(
                            [
                                h.DataAttribute("portfolio-section", "status-weather"),
                                h.DataAttribute("design-node", "oaer3"),
                                h.Class(
                                    "grid min-w-0 gap-6 lg:col-start-4 lg:row-start-2 lg:min-h-64 lg:grid-rows-[auto_auto_1fr] lg:gap-4",
                                ),
                            ],
                            [
                                statusWidget(model, h),
                                weatherWidget(model, h),
                                h.div(
                                    [h.Class("h-full min-h-52.25 max-lg:hidden")],
                                    [notes("desktop")],
                                ),
                            ],
                        ),
                        h.div([h.Class("min-w-0 lg:hidden")], [notes("mobile")]),
                        h.div(
                            [
                                h.DataAttribute("portfolio-section", "bottom-contact"),
                                h.Class(
                                    "flex flex-col gap-5 pt-6 lg:col-start-1 lg:row-start-5 lg:gap-8 lg:self-end lg:pt-0 lg:pr-8",
                                ),
                            ],
                            [
                                assetImage(
                                    h,
                                    PIXEL_CATS,
                                    "Two pixel-art cats sitting together",
                                    124,
                                    "h-26.5 w-31 object-contain",
                                ),
                                h.section(
                                    [
                                        h.Attribute("aria-labelledby", "contact-heading"),
                                        h.DataAttribute("design-node", "d6Lg3"),
                                        h.Class("flex flex-col gap-3"),
                                    ],
                                    [
                                        h.h2(
                                            [
                                                h.Id("contact-heading"),
                                                h.Class("text-heading font-semibold"),
                                            ],
                                            ["Good things start with a hello."],
                                        ),
                                        h.a(
                                            [
                                                h.Href("mailto:hello@artisann.dev"),
                                                h.Class(
                                                    "flex h-11 items-center text-label font-medium text-primary lg:h-auto",
                                                ),
                                            ],
                                            ["hello@artisann.dev"],
                                        ),
                                        h.p(
                                            [h.Class("text-aside text-muted-foreground")],
                                            [
                                                "Have a project, a question, or a cat photo? My inbox is open.",
                                            ],
                                        ),
                                    ],
                                ),
                            ],
                        ),
                    ],
                ),
                h.footer(
                    [
                        h.DataAttribute("portfolio-section", "footer"),
                        h.DataAttribute("design-node", "Ea0Rh"),
                        h.Class(
                            "flex flex-col gap-2 pt-2.5 text-aside text-muted-foreground lg:flex-row lg:justify-between lg:gap-4",
                        ),
                    ],
                    [
                        h.p([], ["A small corner of the internet, made mine."]),
                        h.p([], ["Artisann · Dallas, TX"]),
                    ],
                ),
            ],
        ),
    };
};

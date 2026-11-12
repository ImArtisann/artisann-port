import { DEFAULT_ASSETS_HOST } from "@artisann-port/assets/config";
import type { AssetPath } from "@artisann-port/assets/manifest";
import {
    assetBreakpoints,
    assetDimensions,
    assetHost,
    assetSrc,
    assetUrl,
} from "@artisann-port/assets/urls";
import type { ArrowUpRight01Icon } from "@hugeicons-pro/core-solid-rounded";
import { createCn } from "cn/config";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

const cn = createCn({
    extend: {
        classGroups: {
            "font-size": [
                {
                    text: [
                        "aside",
                        "caption",
                        "image-caption",
                        "label",
                        "heading",
                        "subheading",
                        "wordmark",
                        "title",
                        "project",
                        "display",
                    ],
                },
            ],
        },
    },
});

const CARD =
    "group/card flex min-w-0 flex-col gap-(--card-spacing) rounded-xl py-(--card-spacing) text-sm [--card-spacing:--spacing(6)] bg-card text-card-foreground inset-ring inset-ring-border";
export const CARD_CONTENT = "px-(--card-spacing)";
export const CARD_HEADER =
    "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing)";
export const ICON_BUTTON =
    "group/button inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[transform,translate,opacity,color,background-color,border-color,box-shadow] outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 lg:size-9";

export function icon<M>(
    h: HtmlBuilder<M>,
    glyph: typeof ArrowUpRight01Icon,
    size = 18,
    className = "",
): Html {
    return h.svg(
        [
            h.Xmlns("http://www.w3.org/2000/svg"),
            h.ViewBox("0 0 24 24"),
            h.Width(String(size)),
            h.Height(String(size)),
            h.Fill("none"),
            h.AriaHidden(true),
            h.Class(`shrink-0 ${className}`),
        ],
        glyph.map(([tag, properties]) => {
            const attributes = Object.entries(properties).map(([key, value]) =>
                h.Attribute(
                    key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`),
                    String(value),
                ),
            );
            switch (tag) {
                case "path":
                    return h.path(attributes);
                case "circle":
                    return h.circle(attributes);
                case "ellipse":
                    return h.ellipse(attributes);
                case "rect":
                    return h.rect(attributes);
                case "line":
                    return h.line(attributes);
                case "polygon":
                    return h.polygon(attributes);
                case "polyline":
                    return h.polyline(attributes);
                default:
                    return h.g(attributes);
            }
        }),
    );
}

export function card<M>(
    h: HtmlBuilder<M>,
    attributes: readonly Attribute<M>[],
    children: readonly (Html | string)[],
    className = "",
): Html {
    return h.div(
        [h.DataAttribute("slot", "card"), h.Class(cn(CARD, className)), ...attributes],
        children,
    );
}

export function assetImage<M>(
    h: HtmlBuilder<M>,
    asset: AssetPath,
    alt: string,
    width: number,
    className: string,
    eager = false,
): Html {
    const dimensions = assetDimensions(asset);
    const host = assetHost(import.meta.env.PUBLIC_ASSETS_HOST ?? "") || DEFAULT_ASSETS_HOST;
    const original = assetUrl(asset, `https://${host}`);
    const transform = import.meta.env.PUBLIC_ASSETS_TRANSFORM === "true";
    const transformed = (size: number) =>
        `https://${host}/cdn-cgi/image/width=${size},format=auto,fit=scale-down,metadata=none,quality=82${assetSrc(asset)}`;
    const responsive = transform
        ? [
              h.Srcset(
                  assetBreakpoints(asset)
                      .map((size) => `${transformed(size)} ${size}w`)
                      .join(", "),
              ),
              h.Sizes(`${width}px`),
          ]
        : [];
    return h.img([
        h.Src(transform ? transformed(width) : original),
        h.Alt(alt),
        h.Width(String(width)),
        h.Height(String(Math.round((width * dimensions.height) / dimensions.width))),
        h.Loading(eager ? "eager" : "lazy"),
        h.Decoding("async"),
        h.Class(className),
        ...responsive,
    ]);
}

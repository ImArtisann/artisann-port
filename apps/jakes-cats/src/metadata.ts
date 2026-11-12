import * as Effect from "effect/Effect";
import type { Message, Page } from "./app-state.ts";
import { SITE_OG_IMAGE_URL } from "./contracts.ts";

export const syncSocialMetadata = (page: Page): Effect.Effect<Message> =>
    Effect.sync(() => {
        const photo = page.detail?.photo;
        const image = photo?.url ?? SITE_OG_IMAGE_URL;
        const alt =
            photo === undefined ? "Pixel-art cats — Jake's Cats, created by artisann" : "A cat";
        const entries: ReadonlyArray<readonly [string, string, string]> = [
            ["property", "og:image", image],
            ["property", "og:image:alt", alt],
            ["name", "twitter:image", image],
            ["name", "twitter:image:alt", alt],
        ];
        for (const [attribute, key, value] of entries) {
            const element = document.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
            if (element !== null) element.content = value;
        }
        return { _tag: "Noop" };
    });

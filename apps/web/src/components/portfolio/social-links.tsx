import { HugeiconsIcon } from "@hugeicons/react";
import {
    BlueskyIcon,
    DiscordIcon,
    GithubIcon,
    InstagramIcon,
    Link01Icon,
    Mail01Icon,
    NewTwitterIcon,
    TwitchIcon,
    YoutubeIcon,
} from "@hugeicons-pro/core-solid-rounded";
import type { SiteContent, SocialIcon } from "@artisann-port/presence/content";
import { SharedAtomRegistry } from "@/lib/atom-registry";
import { useSiteContent } from "@/lib/content-client";

/** Hugeicons glyphs for every icon literal the content document may carry. */
const ICONS = {
    github: GithubIcon,
    x: NewTwitterIcon,
    bluesky: BlueskyIcon,
    youtube: YoutubeIcon,
    twitch: TwitchIcon,
    instagram: InstagramIcon,
    discord: DiscordIcon,
    mail: Mail01Icon,
    link: Link01Icon,
} satisfies Record<SocialIcon, typeof GithubIcon>;

/** Compact icon-only strip keyed by the content document's icon literal. */
function SocialLinksContent({ initial }: { initial: SiteContent }) {
    const content = useSiteContent(initial);

    if (content.socials.length === 0) {
        return <p className="text-caption text-muted-foreground">Nowhere else yet.</p>;
    }

    return (
        <ul aria-label="Elsewhere" className="flex flex-wrap items-center gap-3">
            {content.socials.map(({ id, icon, label, url }) => {
                const Icon = ICONS[icon];
                return (
                    <li key={id}>
                        <a
                            href={url}
                            aria-label={label}
                            title={label}
                            className="flex size-11 items-center justify-center text-primary lg:size-9"
                        >
                            <HugeiconsIcon
                                icon={Icon}
                                size={18}
                                className="shrink-0"
                                aria-hidden="true"
                            />
                        </a>
                    </li>
                );
            })}
        </ul>
    );
}

export function SocialLinks(props: { initial: SiteContent }) {
    return (
        <SharedAtomRegistry>
            <SocialLinksContent {...props} />
        </SharedAtomRegistry>
    );
}

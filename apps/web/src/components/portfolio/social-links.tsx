/** @jsxImportSource react */
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
import { CardContent } from "@artisann-port/ui/components/card";
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

/** The "Elsewhere" card body: icon rows keyed by the content document's icon literal. */
function SocialLinksContent({ initial }: { initial: SiteContent }) {
    const content = useSiteContent(initial);

    if (content.socials.length === 0) {
        return (
            <CardContent>
                <p className="text-caption text-muted-foreground">Nowhere else yet.</p>
            </CardContent>
        );
    }

    return (
        <CardContent>
            <ul className="flex min-h-11 flex-wrap items-center gap-3 lg:min-h-10">
                {content.socials.map(({ id, icon, label, url }) => {
                    const Icon = ICONS[icon];
                    return (
                        <li
                            key={id}
                            className="h-11 min-w-0 basis-[calc((100%_-_1.5rem)/3)] grow lg:h-10"
                        >
                            <a
                                href={url}
                                className="flex h-full items-center gap-2 text-label leading-[1.375rem] font-medium text-primary lg:leading-5"
                            >
                                <HugeiconsIcon
                                    icon={Icon}
                                    size={16}
                                    className="shrink-0"
                                    aria-hidden="true"
                                />
                                <span className="truncate">{label}</span>
                            </a>
                        </li>
                    );
                })}
            </ul>
        </CardContent>
    );
}

export function SocialLinks(props: { initial: SiteContent }) {
    return (
        <SharedAtomRegistry>
            <SocialLinksContent {...props} />
        </SharedAtomRegistry>
    );
}

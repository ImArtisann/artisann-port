import {
    BirthdayCakeIcon,
    CatIcon,
    Dumbbell01Icon,
    HeadphonesIcon,
} from "@hugeicons-pro/core-solid-rounded";
import { HugeiconsIcon } from "@hugeicons/react";
import type { FactIcon, SiteContent } from "@artisann-port/presence/content";
import { SharedAtomRegistry } from "@/lib/atom-registry";
import { useSiteContent } from "@/lib/content-client";

const ICONS = {
    birthday: BirthdayCakeIcon,
    cats: CatIcon,
    music: HeadphonesIcon,
    fitness: Dumbbell01Icon,
} satisfies Record<FactIcon, typeof BirthdayCakeIcon>;

function PersonalFactsContent({ initial }: { initial: SiteContent }) {
    const content = useSiteContent(initial);

    return (
        <ul className="flex flex-col gap-2 text-label text-muted-foreground">
            {content.facts.map(({ id, icon, label }) => (
                <li key={id} className="flex items-center gap-2.5">
                    <HugeiconsIcon
                        icon={ICONS[icon]}
                        size={17}
                        className="shrink-0"
                        aria-hidden="true"
                    />
                    <span>{label}</span>
                </li>
            ))}
        </ul>
    );
}

export function PersonalFacts(props: { initial: SiteContent }) {
    return (
        <SharedAtomRegistry>
            <PersonalFactsContent {...props} />
        </SharedAtomRegistry>
    );
}

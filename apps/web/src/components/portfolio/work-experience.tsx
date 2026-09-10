/** @jsxImportSource react */
import type { SiteContent } from "@artisann-port/presence/content";
import { CardContent } from "@artisann-port/ui/components/card";
import { SharedAtomRegistry } from "@/lib/atom-registry";
import { useSiteContent } from "@/lib/content-client";

function WorkExperienceContent({ initial }: { initial: SiteContent }) {
    const content = useSiteContent(initial);

    return (
        <CardContent>
            <ul className="flex flex-col gap-3">
                {content.experience.map(({ id, company, years, title }) => (
                    <li key={id} className="flex flex-col gap-0.5">
                        <div className="flex items-center justify-between gap-3">
                            <h3 className="min-w-0 text-label leading-[1.375rem] font-semibold lg:leading-5">
                                {company}
                            </h3>
                            <p className="shrink-0 text-caption text-right text-muted-foreground">
                                {years}
                            </p>
                        </div>
                        <p className="text-caption text-muted-foreground">{title}</p>
                    </li>
                ))}
            </ul>
        </CardContent>
    );
}

export function WorkExperience(props: { initial: SiteContent }) {
    return (
        <SharedAtomRegistry>
            <WorkExperienceContent {...props} />
        </SharedAtomRegistry>
    );
}

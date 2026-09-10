/** @jsxImportSource react */
import type { SiteContent } from "@artisann-port/presence/content";
import { CardContent } from "@artisann-port/ui/components/card";
import { SharedAtomRegistry } from "@/lib/atom-registry";
import { useSiteContent } from "@/lib/content-client";

const usesColumn = "flex min-w-0 flex-col gap-1.5";
const usesHeading = "text-subheading font-semibold";
const usesList = "flex flex-col gap-1 text-base";

function UsesGroup({
    heading,
    items,
    className,
}: {
    heading: string;
    items: SiteContent["uses"]["software"];
    className: string;
}) {
    return (
        <section className={className}>
            <h3 className={usesHeading}>{heading}</h3>
            {items.length === 0 ? (
                <ul className={usesList}>
                    <li className="text-muted-foreground">—</li>
                </ul>
            ) : (
                <ul className={usesList}>
                    {items.map((item, index) =>
                        item.note === null ? (
                            <li key={index}>{item.label}</li>
                        ) : (
                            <li key={index} className="flex flex-col gap-0.5">
                                <span>{item.label}</span>
                                <span className="text-caption text-muted-foreground">
                                    {item.note}
                                </span>
                            </li>
                        ),
                    )}
                </ul>
            )}
        </section>
    );
}

/** The "What I use" card body: the three-column software / hardware / languages grid. */
function UsesContent({ initial }: { initial: SiteContent }) {
    const content = useSiteContent(initial);

    return (
        <CardContent className="grid grid-cols-2 gap-x-5 gap-y-4 lg:grid-cols-3 lg:gap-x-8">
            <UsesGroup heading="Software" items={content.uses.software} className={usesColumn} />
            <UsesGroup
                heading="Hardware"
                items={content.uses.hardware}
                className={`${usesColumn} col-span-2 row-start-2 lg:col-span-1 lg:col-start-2 lg:row-start-1`}
            />
            <UsesGroup
                heading="Languages"
                items={content.uses.languages.map((item) =>
                    (item.label === "JS / TS" || item.label === "JS/TS") &&
                    item.note === "Effect highly pilled"
                        ? { ...item, note: null }
                        : item,
                )}
                className={`${usesColumn} col-start-2 lg:col-start-3 lg:row-start-1`}
            />
        </CardContent>
    );
}

export function Uses(props: { initial: SiteContent }) {
    return (
        <SharedAtomRegistry>
            <UsesContent {...props} />
        </SharedAtomRegistry>
    );
}

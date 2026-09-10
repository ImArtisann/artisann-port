import type { SiteContent } from "@artisann-port/presence/content";
import { SharedAtomRegistry } from "@/lib/atom-registry";
import { useSiteContent } from "@/lib/content-client";

/** The sidebar "Personal records" list; the surrounding section stays server-rendered. */
function PersonalRecordsContent({ initial }: { initial: SiteContent }) {
    const content = useSiteContent(initial);
    const records = content.records;

    return (
        <dl className="flex flex-col gap-1.5">
            {(
                [
                    ["Bench", records.bench],
                    ["Squat", records.squat],
                    ["Deadlift", records.deadlift],
                ] as const
            ).map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3">
                    <dt className="text-aside text-muted-foreground">{label}</dt>
                    <dd className="text-label font-semibold tabular-nums">{value}</dd>
                </div>
            ))}
        </dl>
    );
}

export function PersonalRecords(props: { initial: SiteContent }) {
    return (
        <SharedAtomRegistry>
            <PersonalRecordsContent {...props} />
        </SharedAtomRegistry>
    );
}

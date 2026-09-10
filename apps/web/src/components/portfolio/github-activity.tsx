import type { GithubSnapshot } from "@artisann-port/presence/github-schema";
import { Card, CardContent } from "@artisann-port/ui/components/card";
import { cn } from "@artisann-port/ui/lib/utils";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as DateTime from "effect/DateTime";
import { useAtomValue } from "@effect/atom-react";
import type { CSSProperties } from "react";
import { SharedAtomRegistry } from "@/lib/atom-registry";
import { portfolioApiEndpoints, githubAtom } from "@/lib/rpc-client";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FIRST_HALF_MONTHS = MONTHS.slice(0, 6);
const SECOND_HALF_MONTHS = MONTHS.slice(6);

const LEVEL_COLORS = {
    NONE: "bg-muted",
    FIRST_QUARTILE: "bg-foreground/20",
    SECOND_QUARTILE: "bg-foreground/40",
    THIRD_QUARTILE: "bg-foreground/65",
    FOURTH_QUARTILE: "bg-foreground",
};

/** A contribution year is one column per week, split into two rows on narrow viewports. */
const CELL = "h-2.25 rounded-[2px] lg:h-3.5 lg:rounded-full";
const COLUMN = "flex min-w-0 flex-1 flex-col gap-0.75";
/**
 * Each half grows with its own week count, so the two rows share one cell width when they sit
 * side by side on wide viewports regardless of how the year splits.
 */
const HALF = "flex min-w-0 gap-0.75 lg:flex-[var(--weeks)_1_0%] lg:gap-1";

/**
 * Week counts of a full Sunday-aligned contribution year, used only while no snapshot exists yet:
 * the empty grid is a placeholder, never a stand-in for real days.
 */
const PLACEHOLDER_FIRST_HALF = 27;
const PLACEHOLDER_SECOND_HALF = 26;

type CalendarWeeks = GithubSnapshot["calendar"]["weeks"];

const dateLabel = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
});

/**
 * Splits the year at the first week that begins in July of the reported year, so the two
 * narrow-viewport rows carry every real day exactly once and neither invents or drops a cell.
 * The year is part of the comparison because the first column often starts in the previous
 * December, which a month-only test would push into the second half.
 */
const splitAtJuly = (
    weeks: CalendarWeeks,
    year: number,
): readonly [CalendarWeeks, CalendarWeeks] => {
    const july = weeks.findIndex((week) => week.firstDay >= `${year}-07-01`);
    return july === -1 ? [weeks, []] : [weeks.slice(0, july), weeks.slice(july)];
};

const halfWidth = (weeks: number): CSSProperties & { "--weeks": number } => ({ "--weeks": weeks });

function MonthRow({ months, className }: { months: readonly string[]; className?: string }) {
    return (
        <div className={cn("flex justify-between text-caption text-muted-foreground", className)}>
            {months.map((month) => (
                <span key={month}>{month}</span>
            ))}
        </div>
    );
}

function WeekColumns({ weeks, updatedAt }: { weeks: CalendarWeeks; updatedAt: string }) {
    const today = updatedAt.slice(0, 10);
    return (
        <div className={HALF} style={halfWidth(weeks.length)}>
            {weeks.map((week) => (
                <div key={week.firstDay} className={COLUMN}>
                    {Array.from({ length: 7 }, (_, weekday) => {
                        const day = week.contributionDays.find(
                            (candidate) => candidate.weekday === weekday,
                        );
                        // Partial first and last weeks have no day here; the gap keeps the grid aligned.
                        if (!day) return <span key={weekday} className={CELL} />;
                        const future = day.date > today;
                        const label = DateTime.formatIntl(
                            DateTime.makeUnsafe(`${day.date}T12:00:00Z`),
                            dateLabel,
                        );
                        return (
                            <span
                                key={day.date}
                                title={
                                    future
                                        ? `${label}: upcoming`
                                        : `${label}: ${day.contributionCount} contributions`
                                }
                                className={cn(
                                    CELL,
                                    future ? "bg-muted/40" : LEVEL_COLORS[day.contributionLevel],
                                )}
                            />
                        );
                    })}
                </div>
            ))}
        </div>
    );
}

function PlaceholderColumns({ weeks }: { weeks: number }) {
    return (
        <div className={HALF} style={halfWidth(weeks)}>
            {Array.from({ length: weeks }, (_, week) => (
                <div key={week} className={COLUMN}>
                    {Array.from({ length: 7 }, (_, weekday) => (
                        <span key={weekday} className={cn(CELL, "bg-muted")} />
                    ))}
                </div>
            ))}
        </div>
    );
}

function GithubActivityContent() {
    const result = useAtomValue(githubAtom(portfolioApiEndpoints.rpcUrl));
    const snapshot = AsyncResult.getOrElse(result, () => null);
    const failed = AsyncResult.isFailure(result);

    const stale = failed || snapshot?.stale === true;
    const calendar =
        snapshot === null
            ? null
            : {
                  halves: splitAtJuly(snapshot.calendar.weeks, snapshot.year),
                  updatedAt: snapshot.updatedAt,
              };
    const total =
        snapshot === null ? null : snapshot.calendar.totalContributions.toLocaleString("en-US");

    return (
        <Card role="region" aria-label="GitHub activity" className="gap-4">
            <CardContent className="flex items-center justify-between gap-4 text-caption text-muted-foreground">
                <a
                    href="https://github.com/ImArtisann"
                    className="flex h-11 min-w-0 items-center lg:h-auto"
                >
                    ImArtisann on GitHub
                </a>
                <span className="shrink-0 tabular-nums">
                    {snapshot?.year ?? DateTime.getPartUtc(DateTime.nowUnsafe(), "year")}
                </span>
            </CardContent>
            <CardContent className="hidden lg:block" aria-hidden="true">
                <MonthRow months={MONTHS} />
            </CardContent>
            <CardContent
                className="flex flex-col gap-4 lg:flex-row lg:gap-1 lg:pr-[calc(var(--card-spacing)+2px)]"
                aria-hidden="true"
            >
                <MonthRow months={FIRST_HALF_MONTHS} className="lg:hidden" />
                {calendar === null ? (
                    <PlaceholderColumns weeks={PLACEHOLDER_FIRST_HALF} />
                ) : (
                    <WeekColumns weeks={calendar.halves[0]} updatedAt={calendar.updatedAt} />
                )}
                <MonthRow months={SECOND_HALF_MONTHS} className="lg:hidden" />
                {calendar === null ? (
                    <PlaceholderColumns weeks={PLACEHOLDER_SECOND_HALF} />
                ) : (
                    <WeekColumns weeks={calendar.halves[1]} updatedAt={calendar.updatedAt} />
                )}
            </CardContent>
            <CardContent>
                <p className="text-caption text-muted-foreground" role="status">
                    {snapshot === null
                        ? failed
                            ? "GitHub activity is temporarily unavailable."
                            : "Awaiting GitHub data"
                        : `${total} contributions in ${snapshot.year}${stale ? " · Last saved activity" : ""}`}
                </p>
                {snapshot !== null && (
                    <p className="sr-only">
                        {`${total} GitHub contributions in ${snapshot.year}. Each square is one day, shaded from less to more contributions. Daily details are available on the linked GitHub profile.`}
                    </p>
                )}
            </CardContent>
        </Card>
    );
}

export function GithubActivity() {
    return (
        <SharedAtomRegistry>
            <GithubActivityContent />
        </SharedAtomRegistry>
    );
}

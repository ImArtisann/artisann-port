import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const MINUTE_S = 60;
const HOUR_S = 60 * MINUTE_S;
const DAY_S = 24 * HOUR_S;
const WEEK_S = 7 * DAY_S;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "3m ago" style timestamp for a comment's ISO `createdAt`. Pure: pass `now`
 * (ms epoch) in tests. Falls back to a short date past a week, and to the raw
 * string when it cannot be parsed.
 */
export function relativeTime(iso: string, now: number): string {
    const parsed = DateTime.make(iso);
    if (Option.isNone(parsed)) return iso;
    const then = DateTime.toEpochMillis(parsed.value);
    const seconds = Math.max(0, Math.floor((now - then) / 1000));
    if (seconds < MINUTE_S) return "just now";
    if (seconds < HOUR_S) return `${Math.floor(seconds / MINUTE_S)}m ago`;
    if (seconds < DAY_S) return `${Math.floor(seconds / HOUR_S)}h ago`;
    if (seconds < WEEK_S) return `${Math.floor(seconds / DAY_S)}d ago`;
    const parts = DateTime.toPartsUtc(parsed.value);
    return `${MONTHS[parts.month - 1]} ${parts.day}, ${parts.year}`;
}

/** @jsxImportSource react */
import type {
    PresencePlayback,
    PresenceSnapshot,
    PresenceStatus as PresenceStatusValue,
} from "@artisann-port/presence/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@artisann-port/ui/components/card";
import { Empty, EmptyMedia } from "@artisann-port/ui/components/empty";
import { cn } from "@artisann-port/ui/lib/utils";
import { ArrowUpRight01Icon, MusicNote02Icon } from "@hugeicons-pro/core-solid-rounded";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { usePresence } from "@/lib/presence-client";

interface StatusCopy {
    readonly label: string;
    readonly description: string;
    readonly dot: string;
    /**
     * A live reading already names a real presence state, so the design hides its description and
     * leaves it to assistive tech. Degraded copy stays visible: a missing feed must never read as
     * availability.
     */
    readonly live: boolean;
}

const STATUS_COPY = {
    online: {
        label: "Online",
        description: "Around and building",
        dot: "bg-foreground",
        live: true,
    },
    idle: {
        label: "Idle",
        description: "Stepped away for a moment",
        dot: "bg-muted-foreground",
        live: true,
    },
    dnd: {
        label: "Do not disturb",
        description: "Heads down, focused",
        dot: "bg-destructive",
        live: true,
    },
    offline: {
        label: "Offline",
        description: "Away from the keyboard",
        dot: "bg-muted-foreground",
        live: true,
    },
} satisfies Record<Exclude<PresenceStatusValue, null>, StatusCopy>;

const CONNECTING_COPY: StatusCopy = {
    label: "Connecting",
    description: "Checking my presence",
    dot: "bg-muted-foreground/40",
    live: false,
};

const UNREACHABLE_COPY: StatusCopy = {
    label: "Status unavailable",
    description: "Can’t reach my presence feed right now",
    dot: "bg-muted-foreground/40",
    live: false,
};

const STALE_COPY: StatusCopy = {
    label: "Status unavailable",
    description: "Waiting on a fresh presence reading",
    dot: "bg-muted-foreground/40",
    live: false,
};

const PLAYBACK_HEADING = {
    playing: "Listening",
    paused: "Paused",
    "last-played": "Last played",
    none: "Listening",
} satisfies Record<PresencePlayback, string>;

/** Only a fresh snapshot from a successful request may claim a live status. */
const statusCopy = (
    snapshot: PresenceSnapshot | null,
    settled: boolean,
    failed: boolean,
): StatusCopy => {
    if (failed) return UNREACHABLE_COPY;
    if (snapshot === null) return settled ? UNREACHABLE_COPY : CONNECTING_COPY;
    if (snapshot.status === null || snapshot.stale) return STALE_COPY;
    return STATUS_COPY[snapshot.status] ?? STALE_COPY;
};

/** Never present a stale or unreachable snapshot as live playback. */
const musicHeading = (snapshot: PresenceSnapshot | null, failed: boolean) => {
    if (snapshot === null || snapshot.song === null) return "Listening";
    if (failed || snapshot.stale) return "Last played";
    return PLAYBACK_HEADING[snapshot.playback] ?? "Listening";
};

const emptyTitle = (settled: boolean, failed: boolean) => {
    if (!settled) return "Checking playback";
    if (failed) return "Playback unavailable";
    return "Between songs";
};

const SONG_TITLE_LIMIT = 40;
const songTitleSegments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const displaySongTitle = (title: string) => {
    if (title.length <= SONG_TITLE_LIMIT) return title;
    let count = 0;
    for (const { index } of songTitleSegments.segment(title)) {
        if (count === SONG_TITLE_LIMIT) return `${title.slice(0, index).trimEnd()}…`;
        count++;
    }
    return title;
};

export interface PresenceStatusProps {
    /** Overrides the shared presence endpoint; every island on one endpoint shares a single poll. */
    readonly endpoint?: string;
}

export function PresenceStatus({ endpoint }: PresenceStatusProps) {
    const { snapshot, settled, failed } = usePresence(endpoint);
    const copy = statusCopy(snapshot, settled, failed);

    return (
        <Card
            role="region"
            aria-labelledby="status-heading"
            className="h-full gap-3 [--card-spacing:--spacing(5)]"
        >
            <CardHeader className="gap-0">
                <CardTitle tone="label">
                    <h2 id="status-heading" className="text-caption">
                        Status
                    </h2>
                </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
                <p
                    className="flex items-center gap-2.5 text-subheading font-semibold"
                    aria-live="polite"
                >
                    <span
                        className={cn("size-2 shrink-0 rounded-full", copy.dot)}
                        aria-hidden="true"
                    />
                    {copy.label}
                </p>
                <p className={cn("text-caption text-muted-foreground", copy.live && "sr-only")}>
                    {copy.description}
                </p>
            </CardContent>
        </Card>
    );
}

export interface MusicStatusProps {
    /** Overrides the shared presence endpoint; every island on one endpoint shares a single poll. */
    readonly endpoint?: string;
}

export function MusicStatus({ endpoint }: MusicStatusProps) {
    const { snapshot, settled, failed } = usePresence(endpoint);
    const [brokenArtwork, setBrokenArtwork] = useState<string | null>(null);

    const song = snapshot === null ? null : snapshot.song;
    const artwork =
        song !== null && song.artworkUrl !== null && song.artworkUrl !== brokenArtwork
            ? { src: song.artworkUrl, alt: `Album art for ${song.title} by ${song.artist}` }
            : null;

    return (
        <Card
            role="region"
            aria-labelledby="music-heading"
            className="@container/music [--card-spacing:--spacing(5)]"
        >
            <CardContent className="flex flex-col items-start gap-3 @xs/music:flex-row @xs/music:items-center @xs/music:gap-4">
                {artwork === null ? (
                    <Empty className="size-18 flex-none rounded-xl p-0">
                        <EmptyMedia>
                            <HugeiconsIcon icon={MusicNote02Icon} size={28} aria-hidden="true" />
                        </EmptyMedia>
                    </Empty>
                ) : (
                    <img
                        src={artwork.src}
                        alt={artwork.alt}
                        width={72}
                        height={72}
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                        onError={() => setBrokenArtwork(artwork.src)}
                        className="size-18 flex-none rounded-xl bg-muted object-cover"
                    />
                )}
                <div className="flex w-full min-w-0 flex-1 flex-col gap-1">
                    <h2 id="music-heading" className="text-caption text-muted-foreground">
                        {musicHeading(snapshot, failed)}
                    </h2>
                    <div className="flex flex-col gap-1.75">
                        <p
                            className="text-[1.125rem]/[1.4625rem] font-semibold break-words"
                            title={song?.title}
                        >
                            {song === null
                                ? emptyTitle(settled, failed)
                                : displaySongTitle(song.title)}
                        </p>
                        {/* No song means no artist to name: the action below already says the source. */}
                        {song !== null && (
                            <p className="text-caption break-words text-muted-foreground">
                                {song.artist}
                            </p>
                        )}
                    </div>
                    <a
                        href={song === null ? "https://music.youtube.com/" : song.url}
                        aria-label={
                            song === null
                                ? "Open YouTube Music"
                                : `Open ${song.title} in YouTube Music`
                        }
                        className="flex h-11 items-center gap-2 text-caption font-medium text-primary"
                    >
                        YouTube Music
                        <HugeiconsIcon
                            icon={ArrowUpRight01Icon}
                            size={16}
                            className="shrink-0"
                            aria-hidden="true"
                        />
                    </a>
                </div>
            </CardContent>
        </Card>
    );
}

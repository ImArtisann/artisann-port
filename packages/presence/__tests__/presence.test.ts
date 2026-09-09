import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { decodeDiscordPresence, findSongCandidate, presenceStatus } from "../src/activity.ts";
import type { DiscordPresence } from "../src/activity.ts";
import { mergePresence, withFreshness } from "../src/presence.ts";
import type { PresenceSnapshot } from "../src/schema.ts";

const observedAt = new Date("2026-09-08T03:00:00.000Z");
const previous: PresenceSnapshot = {
    status: "online",
    song: {
        title: "Previous song",
        artist: "Previous artist",
        url: "https://music.youtube.com/watch?v=previous",
        artworkUrl: null,
    },
    playback: "playing",
    updatedAt: observedAt.toISOString(),
    stale: false,
};

describe("Gateway presence decode", () => {
    it("decodes the original Gateway object and preserves details_url", async () => {
        const presence = await Effect.runPromise(
            decodeDiscordPresence({
                status: "online",
                activities: [
                    {
                        name: "YouTube Music",
                        type: 2,
                        details: "Song",
                        state: "Artist",
                        details_url: "https://music.youtube.com/watch?v=x",
                    },
                ],
            }),
        );
        expect(presence.activities[0]?.details_url).toBe("https://music.youtube.com/watch?v=x");
    });

    it("rejects a missing or unrecognized status at the boundary", async () => {
        expect(
            Result.isFailure(
                await Effect.runPromise(Effect.result(decodeDiscordPresence({ activities: [] }))),
            ),
        ).toBe(true);
        expect(
            Result.isFailure(
                await Effect.runPromise(
                    Effect.result(decodeDiscordPresence({ status: "invisible", activities: [] })),
                ),
            ),
        ).toBe(true);
    });

    it("rejects a presence without an activities array", async () => {
        expect(
            Result.isFailure(
                await Effect.runPromise(Effect.result(decodeDiscordPresence({ status: "online" }))),
            ),
        ).toBe(true);
    });

    it("narrows only recognized statuses", () => {
        const presence: DiscordPresence = { status: "idle", activities: [] };
        expect(presenceStatus(presence)).toBe("idle");
    });
});

describe("last-song cache", () => {
    it("retains the previous song when Discord goes offline without music", () => {
        const snapshot = mergePresence(
            previous,
            { status: "offline", activities: [{ name: "Custom Status", type: 4, state: "Away" }] },
            observedAt,
        );

        expect(snapshot.status).toBe("offline");
        expect(snapshot.song).toEqual(previous.song);
        expect(snapshot.playback).toBe("last-played");
    });

    it("finds paused YouTube Music after unrelated activities and replaces the cached song", () => {
        const snapshot = mergePresence(
            previous,
            {
                status: "dnd",
                activities: [
                    { name: "A game", type: 0 },
                    {
                        name: "YouTube Music",
                        type: 2,
                        details: "New song",
                        state: "New artist",
                        details_url: "https://music.youtube.com/watch?v=new",
                        assets: {
                            small_text: "Paused",
                            large_image:
                                "mp:external/hash/%3Fquality%3Dhigh/https/i.ytimg.com/vi/new/default.jpg",
                        },
                    },
                ],
            },
            observedAt,
        );

        expect(snapshot.status).toBe("dnd");
        expect(snapshot.playback).toBe("paused");
        expect(snapshot.song).toEqual({
            title: "New song",
            artist: "New artist",
            url: "https://music.youtube.com/watch?v=new",
            artworkUrl:
                "https://media.discordapp.net/external/hash/%3Fquality%3Dhigh/https/i.ytimg.com/vi/new/default.jpg",
        });
    });

    it("does not replace a cached song with an incomplete or unsafe activity", () => {
        const snapshot = mergePresence(
            previous,
            {
                status: "online",
                activities: [
                    { name: "YouTube Music", type: 2, details: "Missing link", state: "Artist" },
                    {
                        name: "YouTube Music",
                        type: 2,
                        details: "Unsafe link",
                        state: "Artist",
                        details_url: "javascript:alert(1)",
                    },
                ],
            },
            observedAt,
        );

        expect(snapshot.song).toEqual(previous.song);
        expect(snapshot.playback).toBe("last-played");
    });

    it("keeps the first genuine song when a later activity is not a song", () => {
        const snapshot = mergePresence(
            previous,
            {
                status: "online",
                activities: [
                    {
                        name: "YouTube Music",
                        type: 2,
                        details: "First",
                        state: "Artist",
                        details_url: "https://music.youtube.com/watch?v=first",
                    },
                    { name: "Spotify", type: 2, details: "Later", state: "Other" },
                ],
            },
            observedAt,
        );

        expect(snapshot.song?.title).toBe("First");
        expect(snapshot.playback).toBe("playing");
    });

    it("produces none only when no song was ever stored", () => {
        const snapshot = mergePresence(null, { status: "offline", activities: [] }, observedAt);

        expect(snapshot.playback).toBe("none");
        expect(snapshot.song).toBeNull();
    });

    it("finds the song candidate across all activities", () => {
        const candidate = findSongCandidate({
            status: "online",
            activities: [
                { name: "Custom Status", type: 4 },
                {
                    name: "YouTube Music",
                    type: 2,
                    details: "Now",
                    state: "Who",
                    details_url: "https://music.youtube.com/watch?v=now",
                },
            ],
        });

        expect(candidate?.song.title).toBe("Now");
        expect(candidate?.playback).toBe("playing");
    });
});

describe("freshness window", () => {
    it("stops claiming live presence when stale without losing the song", () => {
        const snapshot = withFreshness(previous, new Date("2026-09-08T03:02:31.000Z"));

        expect(snapshot.status).toBeNull();
        expect(snapshot.stale).toBe(true);
        expect(snapshot.song).toEqual(previous.song);
        expect(snapshot.playback).toBe("last-played");
    });

    it("keeps the snapshot fresh inside the 150-second window", () => {
        const snapshot = withFreshness(previous, new Date("2026-09-08T03:02:30.000Z"));

        expect(snapshot.stale).toBe(false);
        expect(snapshot.status).toBe("online");
    });

    it("treats a corrupt timestamp as stale", () => {
        const snapshot = withFreshness(
            { ...previous, updatedAt: "not a timestamp" },
            new Date("2026-09-08T03:00:01.000Z"),
        );

        expect(snapshot.stale).toBe(true);
        expect(snapshot.song).toEqual(previous.song);
    });
});

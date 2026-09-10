import { describe, expect, it } from "vite-plus/test";
import { mergePresence, withFreshness } from "./presence.ts";
import type { PresenceSnapshot } from "./schema.ts";

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

describe("last-song cache", () => {
    it("retains the previous song when Discord goes offline without music", () => {
        const snapshot = mergePresence(
            previous,
            {
                discord_status: "offline",
                activities: [{ name: "Custom Status", type: 4, state: "Away" }],
            },
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
                discord_status: "dnd",
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
                discord_status: "online",
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

    it("stops claiming live presence when stale without losing the song", () => {
        const snapshot = withFreshness(previous, new Date("2026-09-08T03:02:31.000Z"));

        expect(snapshot.status).toBeNull();
        expect(snapshot.stale).toBe(true);
        expect(snapshot.song).toEqual(previous.song);
        expect(snapshot.playback).toBe("last-played");
    });
});

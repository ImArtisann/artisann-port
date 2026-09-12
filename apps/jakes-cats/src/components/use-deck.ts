import { useCallback, useState } from "react";
import type { DeckPhoto } from "../contracts.ts";
import { likePhoto } from "../server-fns.ts";
import type { SwipeDirection } from "./deck-config.ts";
import { failureMessage } from "./toast-message.ts";

/** What the deck screen needs to render and commit cards. */
export type DeckController = {
    current: DeckPhoto | undefined;
    next: DeckPhoto | undefined;
    toast: string | null;
    /** Polite-announcer text for the latest heart outcome. */
    announcement: string;
    /** Commits one card: `right` hearts it, both advance the deck (looping). */
    resolve: (direction: SwipeDirection) => void;
    dismissToast: () => void;
};

/**
 * Deck state for one visit: the queue, the current position, and the heart
 * round-trip. Whether a photo is hearted comes from the server (`DeckPhoto.hearted`,
 * per visitor cookie) — there is no device-local storage. Hearts are optimistic:
 * the count ticks up and the photo flips to hearted immediately, reconciles with
 * the authoritative `LikeResult`, and reverts with a toast when refused.
 *
 * The deck loops: advancing past the last card returns to the first.
 */
export function useDeck(initial: readonly DeckPhoto[]): DeckController {
    const [photos, setPhotos] = useState<readonly DeckPhoto[]>(initial);
    const [index, setIndex] = useState(0);
    const [toast, setToast] = useState<string | null>(null);
    const [announcement, setAnnouncement] = useState("");

    const heart = useCallback((key: string) => {
        setPhotos((previous) =>
            previous.map((photo) =>
                photo.key === key ? { ...photo, likes: photo.likes + 1, hearted: true } : photo,
            ),
        );
        void likePhoto({ data: { key } })
            .then((result) => {
                setPhotos((previous) =>
                    previous.map((photo) =>
                        photo.key === result.key
                            ? { ...photo, likes: result.likes, hearted: true }
                            : photo,
                    ),
                );
                setAnnouncement(
                    `Hearted. ${result.likes} ${result.likes === 1 ? "heart" : "hearts"} so far.`,
                );
            })
            .catch((error: Error) => {
                const message = failureMessage(error);
                setPhotos((previous) =>
                    previous.map((photo) =>
                        photo.key === key
                            ? { ...photo, likes: Math.max(0, photo.likes - 1), hearted: false }
                            : photo,
                    ),
                );
                setToast(message);
                setAnnouncement(message);
            });
    }, []);

    const resolve = useCallback(
        (direction: SwipeDirection) => {
            const photo = photos[index];
            if (photo === undefined) return;
            // Already hearted (server-confirmed, or an optimistic heart in flight)
            // never sends a second like — the UI cannot double-heart.
            if (direction === "right" && !photo.hearted) heart(photo.key);
            setIndex((previous) => (previous + 1) % photos.length);
        },
        [heart, index, photos],
    );

    const dismissToast = useCallback(() => {
        setToast(null);
    }, []);

    const length = photos.length;

    return {
        current: photos[index],
        next: length < 2 ? undefined : photos[(index + 1) % length],
        toast,
        announcement,
        resolve,
        dismissToast,
    };
}

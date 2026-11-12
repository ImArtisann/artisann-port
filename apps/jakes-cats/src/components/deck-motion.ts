import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Mount } from "foldkit";
import { animate, type AnimationPlaybackControlsWithThen } from "motion";
import { RequestedSwipe, type Message } from "../app-state.ts";
import {
    commitDirection,
    DRAG_ELASTIC,
    DRAG_ROTATE_DEG,
    DRAG_ROTATE_RANGE_PX,
    EXIT_SPRING,
    exitTranslation,
    SNAP_BACK_SPRING,
    SWIPE_OFFSET_PX,
    type SwipeDirection,
} from "./deck-config.ts";

export const DeckGestures = Mount.defineStream("DeckGestures", {
    messages: [RequestedSwipe],
    execute: ({ element }) =>
        Stream.callback<typeof RequestedSwipe.Type>((queue) =>
            Effect.gen(function* () {
                if (!(element instanceof HTMLElement)) return;
                const card = element;
                const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
                const like = card.querySelector<HTMLElement>("[data-stamp='like']");
                const skip = card.querySelector<HTMLElement>("[data-stamp='skip']");
                let pointer: number | null = null;
                let startX = 0;
                let startY = 0;
                let lastX = 0;
                let lastTime = 0;
                let velocity = 0;
                let horizontal = false;
                let snap: AnimationPlaybackControlsWithThen | undefined;
                const paint = (x: number) => {
                    const rotation = preference.matches
                        ? 0
                        : Math.max(
                              -DRAG_ROTATE_DEG,
                              Math.min(
                                  DRAG_ROTATE_DEG,
                                  (x / DRAG_ROTATE_RANGE_PX) * DRAG_ROTATE_DEG,
                              ),
                          );
                    card.style.transform = `translateX(${x}px) rotate(${rotation}deg)`;
                    if (like !== null)
                        like.style.opacity = String(Math.min(1, Math.max(0, x / SWIPE_OFFSET_PX)));
                    if (skip !== null)
                        skip.style.opacity = String(Math.min(1, Math.max(0, -x / SWIPE_OFFSET_PX)));
                };
                const down = (event: PointerEvent) => {
                    if (card.dataset.exiting === "true" || event.button !== 0 || pointer !== null)
                        return;
                    if (
                        event.target instanceof Element &&
                        event.target.closest("a,button,input,textarea,select,[contenteditable]")
                    )
                        return;
                    snap?.stop();
                    pointer = event.pointerId;
                    startX = lastX = event.clientX;
                    startY = event.clientY;
                    lastTime = event.timeStamp;
                    velocity = 0;
                    horizontal = false;
                    card.setPointerCapture(event.pointerId);
                };
                const move = (event: PointerEvent) => {
                    if (pointer !== event.pointerId || card.dataset.exiting === "true") return;
                    const dx = event.clientX - startX;
                    const dy = event.clientY - startY;
                    if (!horizontal && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) {
                        pointer = null;
                        paint(0);
                        return;
                    }
                    horizontal ||= Math.abs(dx) > 5;
                    if (!horizontal) return;
                    const elapsed = event.timeStamp - lastTime;
                    if (elapsed > 0) velocity = ((event.clientX - lastX) / elapsed) * 1000;
                    lastX = event.clientX;
                    lastTime = event.timeStamp;
                    paint(preference.matches ? 0 : dx * DRAG_ELASTIC);
                };
                const release = (event: PointerEvent) => {
                    if (pointer !== event.pointerId) return;
                    pointer = null;
                    if (card.dataset.exiting === "true") return;
                    const direction =
                        event.type !== "pointerup" || !horizontal
                            ? null
                            : commitDirection(
                                  event.clientX - startX,
                                  event.timeStamp - lastTime > 100 ? 0 : velocity,
                              );
                    if (direction !== null) {
                        card.dataset.exiting = "true";
                        Queue.offerUnsafe(queue, { _tag: "RequestedSwipe", direction });
                    } else if (preference.matches) paint(0);
                    else {
                        const origin = (lastX - startX) * DRAG_ELASTIC;
                        snap = animate(origin, 0, { ...SNAP_BACK_SPRING, onUpdate: paint });
                    }
                };
                const stopSnap = () => snap?.stop();
                yield* Effect.acquireRelease(
                    Effect.sync(() => {
                        card.addEventListener("pointerdown", down);
                        card.addEventListener("pointermove", move);
                        card.addEventListener("pointerup", release);
                        card.addEventListener("pointercancel", release);
                        card.addEventListener("lostpointercapture", release);
                        card.addEventListener("cats:exit", stopSnap);
                    }),
                    () =>
                        Effect.sync(() => {
                            snap?.stop();
                            card.removeEventListener("pointerdown", down);
                            card.removeEventListener("pointermove", move);
                            card.removeEventListener("pointerup", release);
                            card.removeEventListener("pointercancel", release);
                            card.removeEventListener("lostpointercapture", release);
                            card.removeEventListener("cats:exit", stopSnap);
                        }),
                );
            }),
        ),
});

export const exitCard = (
    direction: SwipeDirection,
    generation: number,
    turn: number,
): Effect.Effect<Message> =>
    Effect.callback<Message>((resume) => {
        const card = document.querySelector<HTMLElement>("[data-deck-current]");
        const behind = document.querySelector<HTMLElement>("[data-deck-next]");
        const complete = () =>
            resume(Effect.succeed({ _tag: "Swiped", direction, generation, turn }));
        if (card === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            complete();
            return;
        }
        card.dataset.exiting = "true";
        card.dispatchEvent(new Event("cats:exit"));
        // The rect includes the live drag; rotation keeps the center, so only translation moves it.
        const rect = card.getBoundingClientRect();
        const transform = getComputedStyle(card).transform;
        const dragged = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
        const x = exitTranslation(
            direction,
            rect.left + rect.width / 2 - dragged,
            card.offsetWidth,
            card.offsetHeight,
            document.documentElement.clientWidth,
        );
        const rotation = direction === "right" ? DRAG_ROTATE_DEG : -DRAG_ROTATE_DEG;
        const stamp = card.querySelector<HTMLElement>(
            `[data-stamp='${direction === "right" ? "like" : "skip"}']`,
        );
        if (stamp !== null) stamp.style.opacity = "1";
        const exit = animate(
            card,
            { transform: `translateX(${x}px) rotate(${rotation}deg)` },
            EXIT_SPRING,
        );
        const promotion =
            behind === null ? undefined : animate(behind, { transform: "scale(1)" }, EXIT_SPRING);
        void exit.then(complete);
        return Effect.sync(() => {
            exit.stop();
            promotion?.stop();
        });
    });

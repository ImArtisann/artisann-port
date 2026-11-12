/** Drag distance (px) or velocity (px/s) that commits a swipe instead of snapping back. */
export const SWIPE_OFFSET_PX = 80;
export const SWIPE_VELOCITY_PX_S = 400;

/** A velocity-only flick must still travel this far (px); a fast twitch is not a swipe. */
export const SWIPE_FLICK_MIN_PX = 30;

/** Clearance (px) past the viewport edge where a committed swipe ends. */
export const EXIT_MARGIN_PX = 24;

/** Spring driving the exit animation. */
export const EXIT_SPRING = { type: "spring", stiffness: 400, damping: 40 } as const;

/** Spring returning a canceled drag to center. */
export const SNAP_BACK_SPRING = { type: "spring", stiffness: 600, damping: 30 } as const;

/** Drag resistance while pulling a card. */
export const DRAG_ELASTIC = 0.7;

/** Drag distance (px) mapped to the full rotation range. */
export const DRAG_ROTATE_RANGE_PX = 200;

/** Rotation (deg) applied at the edge of the drag range. */
export const DRAG_ROTATE_DEG = 15;

/** Rotation (deg) of the LIKE / SKIP stamps on the card. */
export const STAMP_ROTATE_DEG = 12;

/** Which way a card leaves the deck: right hearts, left skips. */
export type SwipeDirection = "left" | "right";

/**
 * Direction a drag commits to, or `null` when it should snap back. Distance wins
 * over velocity when both clear their threshold; velocity alone needs a real flick.
 */
export const commitDirection = (offset: number, velocity: number): SwipeDirection | null => {
    const byDistance = Math.abs(offset) > SWIPE_OFFSET_PX;
    const byVelocity =
        Math.abs(offset) >= SWIPE_FLICK_MIN_PX && Math.abs(velocity) > SWIPE_VELOCITY_PX_S;
    if (!byDistance && !byVelocity) return null;
    return (byDistance ? offset : velocity) > 0 ? "right" : "left";
};

/**
 * Horizontal translation that leaves the rotated card entirely beyond the
 * viewport edge. `centerX` is the card's untranslated center; rotation about
 * that center widens its horizontal half-extent to (w·cos θ + h·sin θ) / 2.
 */
export const exitTranslation = (
    direction: SwipeDirection,
    centerX: number,
    width: number,
    height: number,
    viewportWidth: number,
): number => {
    const angle = (DRAG_ROTATE_DEG * Math.PI) / 180;
    const halfExtent = (width * Math.cos(angle) + height * Math.sin(angle)) / 2 + EXIT_MARGIN_PX;
    return direction === "right" ? viewportWidth - centerX + halfExtent : -(centerX + halfExtent);
};

/** Drag distance (px) or velocity (px/s) that commits a swipe instead of snapping back. */
export const SWIPE_OFFSET_PX = 80;
export const SWIPE_VELOCITY_PX_S = 400;

/** How far the top card travels off screen on a committed swipe. */
export const EXIT_DISTANCE_PX = 400;

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
 * over velocity when both clear their threshold.
 */
export const commitDirection = (offset: number, velocity: number): SwipeDirection | null => {
    const byDistance = Math.abs(offset) > SWIPE_OFFSET_PX;
    const byVelocity = Math.abs(velocity) > SWIPE_VELOCITY_PX_S;
    if (!byDistance && !byVelocity) return null;
    return (byDistance ? offset : velocity) > 0 ? "right" : "left";
};

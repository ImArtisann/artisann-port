/** Delay between automatic photo changes while a gallery is on screen. */
export const AUTO_ADVANCE_MS = 2_500;

/** Minimum delay before the automatic rotation resumes after the user swipes a photo. */
export const USER_PAUSE_MS = 2_000;

/** Drag distance (px) or velocity (px/s) that commits a swipe instead of snapping back. */
export const SWIPE_OFFSET_PX = 80;
export const SWIPE_VELOCITY_PX_S = 400;

/** How far the top card travels off screen on a committed swipe or auto-advance. */
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

# Jake's Cats — design brief

A mobile-first site at https://jakes.cat: a photo deck you can swipe, heart,
rank, and comment on. The visitor swipes through the portfolio's `cats/` photos,
hearts the ones they like, climbs a leaderboard of the most-hearted cats, and
can open any cat to read and leave comments. Identity is anonymous and
server-side — one visitor cookie, no accounts, no forms of login.

## Concept & tone

Playful and warm, like a friend's camera roll. The deck is the personality, so
the chrome stays quiet: a pixel-cat mark, a two-link nav, a card, two buttons,
and a link-only footer. Copy is light and cat-flavoured but never explains the
joke. No auto-advance, no Tinder-style "NOPE" theatrics — skipping is neutral,
the stamps read `SKIP` and `LIKE`, and the deck loops so the visitor is never
told they are done.

## Palette

Tailwind v4 `@theme` tokens, defined in `src/styles.css`. Light values first,
`prefers-color-scheme: dark` overrides second.

| Token               | Light     | Dark      | Use                                  |
| ------------------- | --------- | --------- | ------------------------------------ |
| `--color-cream`     | `#faf3ea` | `#171310` | Page background                      |
| `--color-ink`       | `#1c1512` | `#f5ece2` | Text, icon strokes                   |
| `--color-heart`     | `#d63a5c` | `#d63a5c` | Heart button, LIKE stamp, heart chip |
| `--color-heart-ink` | `#b3274d` | `#ff9aa8` | Small accent text on page surfaces   |
| `--color-pass`      | `#6f655c` | `#9a8d82` | Skip button, SKIP stamp, captions    |
| `--color-card`      | `#fffdf9` | `#241d18` | Card surface, fallback tile          |
| `--color-line`      | `#eadfd2` | `#3a2f27` | Hairline borders, chip outline       |

`--font-display` is the system-ui stack (`ui-rounded` first for headings). No
background images, no grid patterns — flat cream, one card. White button text on
`--color-heart` meets 4.5:1 in both themes; `--color-heart-ink` keeps small
accent text readable on light and dark page surfaces.

Classes used by the implementation map 1:1: `bg-cream`, `text-ink`, `bg-heart`,
`text-pass`, `bg-card`, `border-line`, `font-display`, plus tokens read through
Tailwind (`ring-heart`, `ring-offset-cream`).

## Typography

- Home link: the pixel-cat mark alone (below), no wordmark — the link carries
  `aria-label="Jake's Cats — home"`. Nav links sit beside it at
  `text-sm font-medium`.
- Page titles ("Top cats", "Comments"): `text-2xl` / `text-xl font-bold`,
  `font-display`.
- Heart chip and stamps: chip `text-sm font-semibold`; stamps
  `text-4xl font-black uppercase tracking-widest`.
- Body/caption (empty, error, toast, comments, counter): `text-base` / `text-sm`
  / `text-xs`.

## Layout

Full-viewport column (`min-h-dvh`, `overscroll-behavior: none` on `body` so
drags never bounce the page). The root body is a flex column; the shared header
is `shrink-0` and each route fills the rest. Safe-area insets via
`env(safe-area-inset-*)` padding on the body.

- Header (shared, every route): `max-w-lg`, pixel-cat mark left, nav right.
  Active link is `text-ink underline underline-offset-4`; inactive is
  `text-pass`.
- Deck page: the card (`aspect-4/5`, `max-w-md`, about 28rem) and action row
  (`h-16`) form a top-aligned group, both centered horizontally. The column uses
  `gap-6 px-4 py-6`, matching the comments section. Spare viewport space stays
  below the controls, not between the card and its buttons.
- Footer (shared, every route): `mt-auto border-t border-line` strip so it pins
  to the bottom of the `min-h-dvh` column; centered copy at `px-4 py-6`
  `text-xs text-pass`.
- Leaderboard / photo page: single `max-w-lg` column, `gap-4`–`gap-6`, scrolling
  with the page (no inner scroll region).

## Site chrome

- Pixel-cat mark: `SITE_MARK_URL` derives the content-addressed URL for
  `portfolio/cats.webp` from the assets manifest and configured default origin
  (`size-7 rounded-md`) with `image-rendering: pixelated`, alone inside the home
  link. It is decorative (`alt=""`) because the link's `aria-label` carries the
  name — no icon-font, no inline SVG, no local copy.
- Favicon: the same content-addressed URL, declared once in the root route
  `links` as `rel="icon" type="image/webp"`. The old inline SVG heart is gone.
- Footer copy: `A corner of artisann.dev` — the link opens the portfolio
  (`https://www.artisann.dev`) in a new tab with
  `target="_blank" rel="noreferrer"`.

## Social sharing

- Default artwork: `opengraph/jakes-cats.png` in the assets package, a 1200×630
  PNG on cream. The original pixel cats sit left of the large pink "Jake's Cats"
  title, with "created by artisann" below in smaller muted text. The cats use
  nearest-neighbor scaling; there are no decorative frames.
- `SITE_OG_IMAGE_URL` resolves its content-addressed public URL from the
  manifest. The homepage and leaderboard use it for Open Graph and Twitter, with
  `summary_large_image` cards.
- Individual photo pages override both image URLs and alt text with the selected
  photo, rather than inheriting the default artwork.

## Card anatomy

- Photo fills the frame: `object-cover`, `rounded-3xl`, `bg-card` surface,
  `border-line` hairline.
- Bottom gradient scrim (`from-black/60 to-transparent`) for chip legibility.
- Heart-count chip bottom-left: `♥ 12`, `bg-black/50 text-white backdrop-blur`,
  `rounded-full px-3 py-1`; the number pops when it changes.
- Comments link bottom-right: plain text ("Comments"), `bg-card/90` pill with a
  `ring-heart` focus ring, no icon; a capture-phase pointer stop keeps a tap on
  it from starting a drag.
- LIKE / SKIP stamps: bordered uppercase labels top-left/top-right, rotated
  ±12°, opacity driven by drag x (fade in over the first 80px of drag).
- Broken image: `bg-card` tile with the plain text "Photo unavailable".

## Motion

Constants live in `src/components/deck-config.ts` (mirrors the portfolio deck).

- Drag: x only, `DRAG_ELASTIC = 0.7`, rotation `DRAG_ROTATE_DEG = 15` mapped
  over `DRAG_ROTATE_RANGE_PX = 200`.
- Commit threshold: `SWIPE_OFFSET_PX = 80` **or** `SWIPE_VELOCITY_PX_S = 400`;
  `commitDirection(offset, velocity)` owns the decision (distance wins over
  velocity) and returns `null` to snap back.
- Exit: `EXIT_SPRING` stiffness 400 / damping 40, travels
  `EXIT_DISTANCE_PX = 400`.
- An exiting swipe owns the motion value: a later drag release cannot replace it
  with snapback. Cancellation completes that exit once so controls do not remain
  locked.
- Snap back (canceled drag): `SNAP_BACK_SPRING` stiffness 600 / damping 30.
- Stamps: LIKE / SKIP tilted `STAMP_ROTATE_DEG = 12`, opacity from 0 to 1 across
  the first `SWIPE_OFFSET_PX` of drag in their direction.
- Behind card: `scale-95`, promotes to full size as the top card exits; it is
  the next cat in the loop, so the stack never runs out.
- Buttons: `scale(0.92)` while pressed, heart and skip alike. No burst, no ring.
- `prefers-reduced-motion`: no rotation, no elastic, exits are instant (no
  spring), no number pop, no press scale.

## States

- Loading: skeleton card (`bg-card` pulse) in the stack frame.
- Empty collection: plain text panel "No cats yet.", body "Jake is on it. Check
  back soon." — no icons.
- Loader error: "Cats are napping" panel, body "Try again in a moment.", with a
  "Try again" button that invalidates the route and reruns its loader.
- Cached revisits wait for refreshed loader data before mounting. Optimistic
  heart/comment state is not initialized from stale cached snapshots.
- End of deck: **there is no end.** Advancing past the last card wraps to the
  first; the loop is the state.
- Heart rejected (rate limit or server): toast "Slow down, tiger." for rate
  limits, otherwise an approved server message or the generic fallback. The
  optimistic +1 reverts; only the toast announces the failure.
- Already hearted (server-side, per visitor cookie): the heart button is filled
  and disabled with a "Hearted" caption under it — a second heart is impossible
  from the UI.

## Leaderboard (`/top`)

- One `max-w-lg` column titled "Top cats", meta title "Top cats · Jake's Cats".
- `getLeaderboard()` returns the most-hearted photos, ranked 1-based, hearts
  descending then newest key first. Deleted photos are excluded before the
  20-entry limit.
- One row per cat, the whole row a link to that cat's page: rank number (`w-6`,
  right-aligned, `tabular-nums`), 96px square thumbnail
  (`size-24 rounded-xl object-cover`), then `♥ n` as text.
- Empty state: "No hearts yet — go swipe." with "go swipe" linking to `/`.
- Loader error: fixed local copy and a "Try again" action that invalidates the
  route and reruns the leaderboard loader.

## Photo page (`/photos/$id`)

- Loader is `getPhoto({ data: { id } })`; an unknown or unmanaged id throws
  TanStack `notFound()`, rendering "That cat wandered off." with a link home.
  Meta title "A cat · Jake's Cats", `og:image` and `twitter:image` set to the
  photo URL, and `og:url` set to that photo's canonical
  `https://jakes.cat/photos/<id>` URL.
- Anatomy, top to bottom: "Back to the deck" link; the photo at
  `max-w-md rounded-2xl`; a row with the heart-count chip and shared heart
  button (same optimistic, idempotent, disabled-when-hearted semantics as the
  deck); then the comments section.
- Comments list, newest first: author line (`You` when the visitor wrote it,
  otherwise `Anonymous`) with a relative timestamp ("just now", "3m ago", "2d
  ago", then a short date), and the body with
  `wrap-break-word whitespace-pre-wrap`. Cap `MAX_COMMENTS_PER_PHOTO` (100).
- Comment form: `textarea` capped at `MAX_COMMENT_LENGTH` (280) with a live
  `n / 280` counter, placeholder "Say something nice about this cat"; the submit
  button reads "Post comment" ("Posting…" while in flight) and is disabled while
  the trimmed body is empty or a submit is in flight. Success prepends the
  returned comment and clears only the submitted draft. Edits made during the
  request are preserved; rejection toasts the message and retains the draft.
- Relative time is a pure helper (`components/relative-time.ts`) using Effect
  DateTime.

## Accessibility

- Buttons have `aria-label`s ("Skip this cat", "Heart this cat", "Hearted").
- The deck is a `role="group"` with `aria-label="Cat photo deck"`; the comments
  list is `aria-label="Comments"`; the comment textarea has a real `sr-only`
  label.
- An `aria-live="polite"` announcer reports heart-count changes; toasts use
  `role="status"`.
- Keyboard: `←` skip, `→` or `Enter` heart — same exit animation as a drag.
- `focus-visible` rings on every interactive element (`ring-heart` /
  `ring-ink`), including nav links, leaderboard rows, and the footer link.
  `focus-visible:outline-hidden` preserves an outline in forced-colors mode,
  where the custom ring may not render.

## Copy voice

Short, warm, a little smug. Examples: empty "No cats yet. Jake is on it."; rate
limit "Slow down, tiger."; error "Cats are napping — try again."; unknown cat
"That cat wandered off."; leaderboard empty "No hearts yet — go swipe."

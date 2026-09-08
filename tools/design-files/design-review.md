# Portfolio canvas review

Artifact: `landing.pen`, layers **Artisann · Desktop** (`EBtCW`) and **Artisann
· Mobile** (`O7pKdN`).

Applied skills: better-layout, better-colors, better-typography. This review
covers the editable Pencil design, not the implemented website. Pencil node IDs
identify locations because the encrypted document has no source line numbers.

## Grouping and alignment

| Severity | Location                          | Before                                                                                   | After                                                                                                              | Why                                                         |
| -------- | --------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| MEDIUM   | Desktop / About me `bypsb`        | Flexible spacer separated photos from contact by hundreds of pixels.                     | Content-sized sidebar; 32px between groups, 8–12px within groups; pixel cats directly precede contact.             | Related personal content reads as one sequence.             |
| MEDIUM   | Both / Deployed apps, Open source | Uniform gaps between unrelated elements and fixed mobile heights left large empty areas. | Project title and description grouped at 8px; separate projects at 24px; mobile cards grow with content.           | Space distinguishes groups and accommodates wrapping.       |
| MEDIUM   | Both / What I use                 | Effect note sat at the same spacing as unrelated languages.                              | JS/TS and its Effect note form a 2px group; list items use 8px; categories use 32px.                               | The note belongs clearly to JS/TS.                          |
| LOW      | Both / Bento cards                | Mixed 20px, 22px, and 24px insets.                                                       | Desktop main cards use 24px; mobile main cards use 20px. Compact status/weather cards retain their smaller insets. | Shared text edges improve scanning.                         |
| MEDIUM   | Both / Git history                | Tiny month labels, distorted cells, and an unnecessarily narrow title column.            | 13px labels, more proportional cells, content-sized container, fixed metadata allocation and flexible title.       | The calendar and heading remain legible at narrower widths. |
| MEDIUM   | Both / Social and external links  | Text controls resembled static content; social rows had little vertical space.           | Explicit link styling, consistent action zones, 44px social rows.                                                  | Actions can be distinguished from descriptions.             |

## Semantic color roles

| Severity | Location                                         | Before                                                             | After                                                                                                             | Why                                               |
| -------- | ------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| MEDIUM   | Both / Static icons, Blocky title, pagination    | Primary and ring tokens also represented unrelated static content. | Static title uses foreground, decorative icons use muted-foreground, pagination uses foreground/muted-foreground. | Tokens are assigned by role.                      |
| LOW      | Both / Photo and music placeholders, Git history | Secondary surface token was used for empty-state content.          | Empty-state fills use the stylesheet's muted token.                                                               | Same existing color, more accurate semantic role. |

The existing `packages/ui/src/styles/globals.css` dark palette is preserved.
Pencil uses the nearest supported 8-bit sRGB encoding of its achromatic OKLCH
values; no new accent palette was introduced. Both root and dark CSS definitions
were inspected. A light canvas was not requested or created.

All 157 visible text nodes were measured against their nearest painted ancestor.
There are seven unique rendered solid-color text pairs; none is unmeasured.

| Foreground                 | Actual background    | WCAG 2 contrast |
| -------------------------- | -------------------- | --------------- |
| Foreground `#FAFAFA`       | Background `#0A0A0A` | 18.97:1         |
| Primary `#E5E5E5`          | Background `#0A0A0A` | 15.72:1         |
| Muted foreground `#A1A1A1` | Background `#0A0A0A` | 7.66:1          |
| Muted foreground `#A1A1A1` | Muted `#262626`      | 5.86:1          |
| Muted foreground `#A1A1A1` | Card `#171717`       | 6.94:1          |
| Foreground `#FAFAFA`       | Card `#171717`       | 17.18:1         |
| Primary `#E5E5E5`          | Card `#171717`       | 14.23:1         |

Every text pair exceeds 4.5:1. Decorative borders and empty heatmap cells are
not claimed to meet text or interactive-control contrast requirements. No text
is placed over photographs.

## Typography and hierarchy

| Severity | Location                       | Before                                                          | After                                                                             | Why                                                         |
| -------- | ------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| MEDIUM   | Both / All text                | Manrope with many individual sizes, including 10–12px captions. | Geist, matching the stylesheet family; six named steps: 13, 14, 16, 18, 24, 32px. | A coherent system with readable captions.                   |
| MEDIUM   | Both / Project headings        | 27px Blocky name exceeded its 20px parent section heading.      | 24px section title, 18px project name.                                            | Heading sizes descend with hierarchy.                       |
| MEDIUM   | Both / Heading and body rhythm | Inconsistent/default line heights.                              | Display 1.1, section titles 1.2, subheads 1.3, body 1.5, captions 1.4.            | Short headings stay compact; wrapped copy remains readable. |
| LOW      | Both / Personal records        | Values had varying auto-sized boxes.                            | Right-aligned values in equal 44px boxes.                                         | Records share a stable trailing edge.                       |

All visible text uses Geist, no caption falls below 13px, and body-sized text
uses weight 400 or above. Long-form text is absent; short card descriptions use
constrained wrapping widths. Full copy remains visible, with no ellipsis or
clipped text required.

## Verification

- Inspected canonical 1440px desktop and 390px mobile canvas layouts, including
  section screenshots and current resolved bounds.
- Stress-tested the actual frames at 1280px desktop and 320px mobile, then
  restored the canonical widths. No visible overflow beyond 0.5px rounding
  tolerance remained at either pair of widths.
- Verified grouping, wrapping, heading hierarchy, all rendered text color pairs,
  and tokenized color usage. Disabled legacy layers were excluded from
  visible-layout checks.
- Refreshed `previews/EBtCW.png` and `previews/O7pKdN.png` from the final
  document.
- **Not verified:** live browser behavior, 200% browser zoom, RTL and
  mixed-direction text, pseudo-localization, responsive CSS breakpoints,
  font-file loading/fallbacks, browser font smoothing, text selection, OpenType
  tabular-number support, and hover/focus interactions. These are implementation
  checks that the static Pencil schema cannot prove.
- **Not verified:** a light-theme canvas, APCA scoring, or live
  weather/music/GitHub integration. The current empty states remain explicit.

**Approve — inspected desktop and mobile Pencil layouts.** No HIGH findings
remain within this canvas scope; this is not approval of uninspected browser
implementation behavior.

## Follow-up: mobile What I use

| Severity | Location                                   | Before                                                                          | After                                                                                                                                                    | Why                                                                                                                                  |
| -------- | ------------------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| MEDIUM   | `landing.pen` / Mobile / `C9A46Q`, `TpxIs` | Three stacked category lists created a 630px card with unused horizontal space. | Software and Languages share two flexible columns; Hardware retains the full width beneath them. Card height is 419px at the saved 390px artboard width. | Related software content scans together, long hardware names remain readable, and the card uses about one-third less vertical space. |

Spacing remains 8px within lists and 24px between category groups and columns.
All text and the existing type/color tokens are preserved. Verified screenshots
and resolved bounds at 390px and 320px artboard widths: no clipping; the Effect
note wraps naturally at the narrower width. Restored the 390px artboard and
refreshed its preview. Desktop was unchanged.

**Not verified:** browser zoom, RTL, pseudo-localization, and responsive CSS;
this change is to the static Pencil canvas.

**Approve — mobile What I use canvas layout.**

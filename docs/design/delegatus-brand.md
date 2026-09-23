# Delegatus brand: emblem, placement and palette

Status: shipped with the brand pull request. This note records which emblem
files exist, where each one appears in the Viewer, which tokens the palette
changed and why, and what was deliberately left alone.

## 1. The emblem files

All emblem art is plain SVG under `public/brand/`, served as-is by every
install shape (the image copies `public/`). Each file has a `viewBox`, no
embedded raster, no editor metadata, and a single `<title>Delegatus</title>`.

| file | what it is | used by |
| --- | --- | --- |
| `delegatus-mark.svg` | flat mark on a 64 grid: red body, cream belly, swept hair, bold glasses | favicon (`src/app/icon.svg` is a copy), rail header, onboarding header, Viewer-authored cards |
| `delegatus-mark-16.svg` | the mark redrawn on a 16 px grid with whole-pixel frames | kept for tools that want a crisp 16 px bitmap; the browser tab uses the full mark |
| `delegatus-badge.svg` | head-and-shoulders character in a slate ring, hair breaking the frame | empty board, onboarding tour |
| `delegatus-lockup.svg` | mark and outlined "Delegatus" wordmark, dark ink, for light backgrounds | README |
| `delegatus-lockup-on-dark.svg` | the same with cream ink, for dark backgrounds | README (dark scheme) |
| `delegatus-touch-icon.svg` | the mark on a full-bleed slate square | source of the iOS home-screen icon |
| `delegatus-social-card.svg` | 1280×640 badge and wordmark on slate | source for the repository's social preview |

The wordmark is outlined from Adwaita Sans (SIL Open Font License), so no font
has to be installed to render it. The emblem is an original character: a
round red bird with glasses and swept grey hair, with no beak and no heavy
brows.

## 2. Placement

| # | place | what shows | code |
| --- | --- | --- | --- |
| 1 | browser tab | the mark as the icon, title `Delegatus` (with the waiting-queue count in front) | `src/app/icon.svg`, `src/app/layout.tsx`, `src/components/Viewer.tsx` |
| 2 | iOS home screen | 180×180 PNG drawn at build time from `delegatus-touch-icon.svg` | `src/app/apple-icon.tsx` |
| 3 | rail header, desktop and phone drawer | 20 px mark plus the product name, replacing "Agent logs" | `src/components/ProjectRail.tsx` |
| 4 | empty project board, desktop and phone | 88 px badge above the empty-state lines | `src/components/ProjectDashboard.tsx` |
| 5 | onboarding | 24 px mark beside the dialog title (desktop), 64 px badge above the tour step's heading (both) | `src/components/onboarding/OnboardingDialog.tsx` |
| 6 | Viewer-authored cards in the feed | the mark as the avatar of an internal relay message and of the orchestrator mandate card | `src/components/feed/FeedItem.tsx`, `src/components/feed/cards/MandateCard.tsx` |
| 7 | README | the lockup, switching to the cream version under a dark scheme | `README.md` |

The emblem is always decoration beside text that already names the product, so
`src/components/brand/BrandMark.tsx` renders it as an `<img>` with an empty
`alt`. Loading it as an image also keeps each SVG's clip-path ids to itself.
The product name lives in one constant, `PRODUCT_NAME` in `src/lib/brand.ts`;
it is a brand and is not translated (Ukrainian keeps the Latin spelling).

## 3. Palette

Light surfaces move to the emblem's warm paper, dark ones lean towards its
slate, and a new brand pair fills the primary actions. Values live in
`src/styles/tokens.css` (the light table in `@theme static` and both dark
override blocks, which stay identical).

| token | light before → after | dark before → after |
| --- | --- | --- |
| `--surface-canvas` | `#f3f3f6` → `#f4f1ec` | `#101014` → `#111218` |
| `--surface-card` | `#ffffff` → `#fffdfa` | `#17171c` → `#191b23` |
| `--surface-sunken` | `#f7f7fa` → `#f8f5f0` | `#121216` → `#14151b` |
| `--surface-raised` | `#ffffff` → `#fffdfa` | `#1d1d24` → `#20232c` |
| `--surface-board` | `#f3f3f6` → `#f4f1ec` | `#0d0d11` → `#0d0e13` |
| `--surface-well` | `#f0f0f4` → `#f2efe9` | `#131318` → `#15161d` |
| `--surface-quiet` | `#fafafb` → `#faf8f4` | `#141419` → `#16181e` |
| `--border-default` | `#e6e6ea` → `#e5dfd5` | `#26262e` → `#292c36` |
| `--border-strong` | `#c9c9d1` → `#cbc3b7` | `#3a3a44` → `#3c404c` |
| `--color-user` | `#e9e9ef` → `#ede7de` | `#2a2a33` → `#262a36` |
| `--color-brand` (new) | `#262a36` | `#fbebdd` |
| `--color-on-brand` (new) | `#fbebdd` | `#262a36` |

Tailwind emits `bg-brand`, `text-on-brand` and `border-brand` from the new
tokens. Every filled primary action that painted `bg-accent … text-white` now
paints `bg-brand text-on-brand` (41 controls, plus `.kb .btn.primary` on the
kanban board). Four accent fills that are states, not actions, keep the
accent: the scheme selection check, the selected flow round-limit stop and the
custom round-limit value beside it, and the swipe row's accent tone.

Contrast, with the formula `tokens.contrast.test.ts` uses:

- The pinned roles keep their 4.5:1 floor on all seven surfaces. The tightest
  light value is `text-muted` on the well at 4.51:1 (4.55 before); the well
  was lightened from a first `#eeeae3` candidate for exactly this reason.
  Dark minimums: muted 4.67, success 7.00, warning 7.70.
- `on-brand` on `brand` is 12.3:1 in both schemes, and the brand fill stands
  more than 14:1 off the card. A new test pins both, and that the two dark
  blocks agree.
- The depth ladder stays ordered in both schemes.
- Light-scheme contrasts of the other roles move by at most 0.15 (primary text,
  14.92 → 14.77); dark ones drop by 0.3 to 0.9 and every one stays above 5:1.

## 4. Rasters and the privacy gate

The publication gate reads any committed file that is not text, and fails a
PNG without reproducible generator provenance and a binary `.ico` outright
(`inspection_error`). So the pull request commits only SVG:

- `src/app/favicon.ico` is removed. `src/app/icon.svg` is the tab icon, which
  Next.js links with `sizes="any"`.
- The iOS icon is `src/app/apple-icon.tsx`, a Next.js icon route that draws
  the PNG from the committed SVG during the build (prerendered as static).
- The social preview PNG is not committed; the repository's social preview is
  uploaded in the GitHub settings from a render of
  `public/brand/delegatus-social-card.svg`.

## 5. What stays unchanged

- `--color-accent` and `--color-accent-soft`: links, focus rings and the
  running/reviewing/assigned/provisioning states keep their violet, so a brand
  button never reads as a state, and a warm accent can never be mistaken for
  `--color-warning` or the crown gold.
- `--color-danger` and every other state role. The emblem's red stays inside
  the emblem files and is not a UI token, so the danger red remains the only
  red in the chrome.
- The text roles `--color-primary`, `--color-secondary` and `--color-muted`,
  and the engine tints.
- Composer send buttons: their white icon is shared with the recording state
  and the draft pane's model tint in `ComposerBar`, so they keep the accent.
- Product-name text beyond the tab title and the rail (onboarding title,
  README heading, i18n strings, the orchestrator prompt). That is slice 2 of
  the rename plan.

## 6. Not done here

- No web app manifest: installing as a standalone app is a behaviour change of
  its own.
- The push notification (`public/question-push-sw.js`) shows no icon, as
  before.
- The repository's social preview has to be uploaded by hand.

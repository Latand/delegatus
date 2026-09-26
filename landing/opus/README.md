# Landing prototype A (from the Opus concept)

A static page for delegatus.org, built from
[`docs/landing/concept-opus.md`](../../docs/landing/concept-opus.md). Plain
HTML, CSS and three classic scripts; nothing runs on a server.

## Open it

- From a file: open `landing/opus/index.html` in a browser.
- Served from the repository root: `bunx serve .` and open `/landing/opus/`.
- Self-contained, the way a static host gets it: `bun landing/opus/build.mjs`,
  then `bunx serve landing/opus/dist`. The build copies the captures and the
  emblem the page references into `dist/` (ignored by git) and rewrites their
  paths.

`?lang=uk` or `?lang=en` picks the language; the switch in the header
remembers the choice.

## Files

| file | what it holds |
| --- | --- |
| `index.html` | the four sections, the footer band and the install-box template |
| `styles.css` | layout, the product's dark tokens, the crop system for the captures |
| `copy.js` | every visible string in English and Ukrainian, and the two install prompts |
| `mascot.js` | the mascot's three poses, drawn on the emblem's 64 grid |
| `main.js` | language, install boxes, the legacy giggle, the handoff and the pass edge |
| `build.mjs` | the optional `dist/` assembly |

## How the pictures work

Every picture is a real README capture (`docs/media/readme/*.svg`, synthetic
demo data), read in place. A `.crop` shows one region of a capture; layers
inside it are positioned in the capture's own pixels, so they stay aligned at
every width. The hero's handoff animation uses those layers: covers that
hide the operator's message, the answer and the "2 working" label, a composer
overlay that types the line, and three report entries cut out of the same
capture that drop into the log. With `prefers-reduced-motion` the page shows
the final frame and nothing moves.

## Decisions where the concept was open

- **No self-hosted fonts.** The publication gate refuses committed binaries,
  and WOFF2 is one, so Unbounded, Geologica and Martian Mono load from
  Google Fonts. Self-hosting needs the capture-media route the concept
  describes for rasters.
- **SVG captures instead of AVIF/WebP.** The raster case for
  `scripts/capture-readme-media.ts` is not written yet; the page reads the
  committed SVGs directly.
- **The search palette is drawn in HTML** over the conversation, using the
  product's `GlobalSearch` markup, tokens and strings, because the README set
  has no capture of it yet. The three hits are synthetic, from the demo's own
  projects.
- **The hero crop drops the capture's sidebar**, so the chat and the Reports
  log read at a useful size beside the headline. The board chips of step 3
  sit below the capture's edge, so the "2 working" label in the header shows
  that step instead.
- **Headline size is capped at 4.3vw** on desktop: Unbounded is wide, and at
  the concept's 6vw "everything." overflows the text column.
- **One mascot per viewport.** When the hero's legacy box opens, the hero's
  bird steps out while the giggling one peeks over the box, and it comes back
  once the giggler has ducked ("I'll be in the browser").
- **On a phone**, section 3 uses the phone conversation capture, and section 4
  shows only the Telegram exchange, because the hero already shows the phone
  board.
- **Live numbers.** The GitHub star count and the npm version are fetched in
  the browser; if a request fails, the star count stays hidden and the version
  keeps its last known value.

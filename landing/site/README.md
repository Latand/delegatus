# The Delegatus landing (delegatus.org)

Source for the published landing, reviewed against `main`.
The hero is a demo that plays by itself: the board drawn in the product's own
look over invented data, with a pointer that creates the orchestrator, sends
it a request and watches the board fill (`boardDemo.js`). Every picture of the
product below it is the product: Delegatus's own interface, bundled for the
browser and running over invented data, in an iframe the visitor can click
through.

## Build and open

```
bun landing/site/build.ts          # → landing/site/dist/, a static site
bunx serve landing/site/dist       # any static host serves it the same way
```

The demo is an ES module that answers the interface's requests inside the
page, so the site has to be served over HTTP; a `file://` page cannot load it.
`?lang=uk` or `?lang=en` picks the language; the switch in the header
remembers the choice, and so does the switch inside the demo.

Renders for review (never committed):

```
flock /var/tmp/llv-heavy-gate.lock bun landing/site/capture.ts
```

It takes 1440×900 and 390×844 in English and Ukrainian: the full page, the
first screen, each section (the FAQ with its first answer open), the hero's
demo held at each of its six steps, every tab of every frame, and the legacy
install. `report.json` beside the PNGs lists page errors, requests
the demo left unanswered, and sideways overflow. `--scheme=light` renders with
the browser asking for a light colour scheme; the page and the demo pin dark,
so the PNGs should match the default run.

```
LANDING_RENDER_DIR="$HOME/Projects/delegatus-wt/handoff/<task>/demo" \
LANDING_BEFORE_DIR=/path/to/an/earlier/dist \
  flock /var/tmp/llv-heavy-gate.lock bun landing/site/capture.ts --check-demo
```

measures the hero's demo. At 1440×900 and 390×844 under a 4× CPU throttle it
traces one full loop playing in view and reads, from Chrome's frame reporter,
the frames presented and dropped, and every main-thread task over 50 ms. It
loads the page cold five times (cache off, same throttle, alternating with the
build in `LANDING_BEFORE_DIR` when it is set) and reports the median LCP, the
layout shift, and the bytes and requests that arrive without scrolling. It
checks that the demo plays only in view, stops on its pause button, in a
hidden tab and off screen, starts on an empty board and leaves nothing flying
on the finished one, and stands still under reduced motion with every caption
shown. Unthrottled, it writes a PNG every half second of one loop in both
languages and a screen recording of the loop at each width. It fails on a long
task during the loop, on more than 1% dropped frames, or on any of the holds.
`--no-frames` skips the PNGs and the recordings. Everything goes to
`LANDING_RENDER_DIR`, outside the tree.

```
CHROME_BIN=/usr/bin/google-chrome-stable bun landing/site/capture.ts --check-prompt
```

expands the Claude Code and Codex install prompts in the hero and the footer,
in both languages and widths, and fails unless the whole prompt can be read to
its last line, with nothing clipped by the prompt's box or a container around it.

```
CHROME_BIN=/usr/bin/google-chrome-stable bun landing/site/capture.ts --check-fullscreen
```

puts each of the four frames full screen through its control, in both
languages at 1440×900 and 390×844, once with the browser's Fullscreen API and
once as the overlay iPhone Safari gets (no element fullscreen there). It fails
unless the iframe runs unscaled at the width of the screen and at the height of
the frame's area, the control clears the product's own controls, the frame is
not reloaded, Esc (overlay) and the control (API) leave, and the page's scroll
position comes back. PNGs go to `/tmp/landing-fullscreen-renders/`.

## Files

| file | what it holds |
| --- | --- |
| `index.html` | the four sections, the footer band and the install-box template |
| `styles.css` | the page: type, the product's dark tokens, the frames around the demo |
| `copy.js` | every visible string of the page and of the hero's demo in English and Ukrainian, and the two install prompts |
| `boardDemo.js` | the hero's demo: the drawn board, its one timeline, and when it plays |
| `mascot.js` | the mascot's three poses (unchanged from A) |
| `main.js` | language, install boxes, the phone's send-the-link action, the legacy giggle, the release line, and the controller of the live frames |
| `demo/demo.tsx` | the demo: the real `Viewer`, the answers to its requests, the scripted steps, the views |
| `demo/world.ts` | the invented harbor-api world at each step, in both languages |
| `demo/taskIcons.json` | the lucide drawings of the demo's task icons, written by the build |
| `build.ts` | bundles the demo, compiles the product stylesheet, assembles `dist/` |
| `capture.ts` | the render driver |

## Worker configuration and publication

`landing/wrangler.jsonc` is the source of the `delegatus-landing` Worker
configuration. It retains the compatibility date, the two custom domains,
`workers_dev: false` and static 404 handling of the existing deployment.
Assets now come directly from `landing/site/dist/`. Only `/api/*` runs the
script first; every other path remains a static asset. `ASSETS` is the asset
fallback and `SITE_EVENTS` binds the Analytics Engine dataset `site_events`.
The account id and tokens belong in the deployer's protected environment
(`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`), never in this config.

From the repository root:

```sh
flock /var/tmp/llv-heavy-gate.lock bun landing/site/build.ts
bunx wrangler deploy --config landing/wrangler.jsonc --dry-run
```

After merge, the authorized deployer publishes with
`bunx wrangler deploy --config landing/wrangler.jsonc` using the same protected
environment. There is no need to copy the build into a separate deploy
directory. The build and dry-run do not publish anything. Account eligibility
for Analytics Engine is checked on publication; a binding refusal must be
brought to the operator before continuing.

## Site event contract

The page uses `navigator.sendBeacon` to POST JSON to `/api/event` on these
actions. Copy events count button clicks, including attempts where clipboard
access fails. A demo start counts once per page load, when the hero's demo
first plays on screen (most of it in view, the tab visible, motion allowed);
loading an iframe, scrolling past the demo again or pausing it do not count.
Opening any frame full screen counts once, including the Safari overlay.

| `event` | Required fields besides `event` |
| --- | --- |
| `copy_prompt` | `lang`: `en` or `uk`; `agent`: `claude` or `codex` |
| `copy_legacy` | `lang`: `en` or `uk` |
| `demo_start` | `lang`: `en` or `uk` |
| `fullscreen_open` | `lang`: `en` or `uk` |

Every extra field, unknown event, invalid value, malformed JSON or body over
1024 bytes receives 400 and writes nothing. Valid events receive 204 and write
exactly one point. The Worker adds only `request.cf.country` (a two-letter
code, or an empty string when unavailable). It stores no cookie, id or IP.

For the metrics reader, ordered fields in `site_events` are `blob1 = event`,
`blob2 = agent` (empty for the other events), `blob3 = lang`, `blob4 = country`,
`double1 = 1`, `index1 = event`. Use `SUM(_sample_interval * double1)` for
counts so Analytics Engine sampling is represented. The footer discloses the
existing Cloudflare Web Analytics beacon and these four actions in EN/UK.

Focused checks:

```sh
bun test landing/worker.test.ts
LANDING_RENDER_DIR="$HOME/Pictures/delegatus-review/site-metrics" \
  flock /var/tmp/llv-heavy-gate.lock bun landing/site/capture.ts --check-events
LANDING_RENDER_DIR="$HOME/Pictures/delegatus-review/site-metrics" \
  flock /var/tmp/llv-heavy-gate.lock bun landing/site/capture.ts
```

`--check-events` exercises the real page and handler at both widths and in
both languages with a local recording binding; it writes no Cloudflare data.
It checks both install boxes and agents, legacy copies, the demo's start (on
load where the first screen already shows most of it, otherwise when it is
scrolled to), full-screen open/close, no events on load or unrelated controls,
and unavailable analytics.

### Analytics Engine permissions

Runtime [`writeDataPoint`](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)
uses the Worker binding directly, with no API token. Uploading a Worker with
an `analytics_engine` binding requires Account → Workers Scripts → Edit
(API name [`Workers Scripts Write`](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/)),
already used by the landing's deploy token. Reading the
[SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
requires Account → Account Analytics → Read and belongs to the metrics reader.

Observation on 2026-09-30: deploy token verification, zone and Worker settings
returned HTTP 200; the deployed Worker had no bindings. SQL
`SELECT 'permission_probe' AS message` and `SHOW TABLES` both returned HTTP 403
`Authorization error`. Account information did not establish Analytics Engine
eligibility; the permission catalog returned 403 (9109). The operator accepted
proceeding with S3/S4 and checking account eligibility on publication after
merge. SQL read access is handled separately for the metrics script.

To create its separate read-only token in the Cloudflare dashboard:

1. Open **My Profile → API Tokens → Create Token → Create Custom Token**.
2. Name it for the metrics reader. Add **Account → Account Analytics → Read**.
3. Under **Account Resources**, select **Include → Specific account**, choosing
   the account that owns the landing Worker. Set any desired IP restrictions
   and expiry.
4. Choose **Continue to summary → Create Token**. Save the token once in the
   protected local secret source used by the metrics reader; never paste it
   into the repository, logs or a pull request.
5. Using that source, repeat `SELECT 'permission_probe' AS message` and
   `SHOW TABLES` through the SQL API. A dataset table appears after its first
   data point. After publication, a copy click should appear in the metrics
   script within minutes. If Cloudflare requests Analytics Engine activation,
   the operator enables it for the account before the deployer retries.

## How the hero's demo works

`boardDemo.js` builds the board once, in the product's dark tokens: the top
bar, the orchestrator's place, Inbox, In progress and Done, three cards and the
pointer. It lays the stage out at 1280×720 (on a phone, 360×606: the chat over
three narrow columns, a fingertip for the pointer) and scales it to the
column, so positions are read once, in the stage's own pixels.

The flow is one timeline of 24 s. Every element that moves gets one Web
Animation of that length, on `transform` and `opacity` only, repeating forever,
so the compositor plays the whole loop and it has no seam: each track ends on
its first frame, what moved fades out with the board and comes back unseen.
The pointer creates the orchestrator, focuses the composer, the request types
itself and is sent; the orchestrator answers with three tasks, each flies to
Inbox and lands as a card; two move to In progress, the orchestrator's wires
draw to them (the board's own idiom: a line down the gutter into a port on the
card, a pulse when it acts), Build, Review and Verify pass on the first card,
the PR merges and the card moves to Done, then the finished board holds.
Under the stage, six chips light and fill with the step that plays and one
line says what is happening; screen readers get the six steps as a list.

It plays only with most of it on screen and the tab visible, and stops on its
pause button. Under reduced motion it is built at the finished board, never
plays, and the rail writes out all six steps. It is built after the first
paint, inside a box that already has the stage's proportions. Elements a
layout hides get no animation: an animation on an undrawn element ticks on the
main thread every frame. `window.DLG.demo` lets the capture driver hold the
loop at a moment (`seek`) and let it go (`release`).

## How the live frames work

`demo/demo.tsx` renders `@/components/Viewer`, the same component the product
serves, and replaces `fetch` and `EventSource` so every request is answered
from `demo/world.ts`: files, tasks, pipelines, transcripts, the orchestrator's
seat and report log, accounts and limits, message search. The build stubs
`"use server"` modules the way Next does for a client bundle, compiles
`src/app/globals.css` through Tailwind and pins it to the dark palette.

The world is a function of the step and the language. The frames on the page
open at its last step (`step=5`); the scripted steps before it (a request
typed into the orchestrator's composer, a task and its pipeline, Build, Review,
a decision) remain in `demo.tsx` and are reachable with `?step=0`. Each step
moves the world forward and tells the board through the runtime stream, the
way a running Delegatus does.

The page talks to each frame by message: which step to jump to, which view to
show. A view is reached by pressing the product's own controls (fold the
orchestrator, dock it at the side, open a pipeline, open a conversation, the
accounts trigger, `/` for search), found by their labels in the product's own
dictionaries, so both languages work. Frames navigate in place. Language changes reload visible frames;
frames farther down refresh when the reader approaches them.

## Decisions where the brief was open

- **Frames, not captures.** The product in an iframe keeps its own layout,
  styles and language, and it is clickable; the page scales a frame only when
  the column is narrower than the width the product needs.
- **The hero is drawn, the rest is the product.** The operator asked for a
  hero that plays one flow by itself, with a visible pointer and no
  interaction, smooth under a slow CPU (prototype review, 2026-10-09). The
  real Viewer re-renders the whole board for every step and its bundle is
  4.3 MB; the drawn board animates on the compositor only and weighs 27 KB.
  The frames below keep the clickable product.
- **On a phone** every frame runs the product's phone interface at 390 px,
  and the hero's demo its own phone layout. The hero leads with sending the
  page to a computer (the share sheet, or a copied link), since Delegatus runs
  there; the prompt is the second choice.
- **One message, one row.** The composer keeps its own copy of a sent message
  until the transcript moves 2 s past the delivery, so the demo dates the
  request at the exact moment of the send and the answer at least 2.5 s
  later. Each frame also clears what another frame left in the shared
  storage (sent messages, opened conversations) before it draws. The 2.5 s
  timestamp offset is a delivery-order constraint, independent of playback
  speed; the first response starts after 650 ms.
- **Panels fill the frame.** A pipeline's stages and a conversation opened
  full take the whole frame, and the accounts panel takes the board's place
  beside the rail, so nothing half-covered shows at their edges.
- **The hero is readable at its size.** The drawn stage is 1280 px wide, so
  at 1440 it shows at scale 1.0 (the frame it replaced showed at 0.70).
- **A frame is also a still picture.** Transcripts fade in at their top edge,
  so a pane scrolled to its tail never starts on half a line; a conversation
  opened full wears the plain reader border instead of the builder's amber
  ring; and a docked accounts list drops the popover's height cap.
- **A lived-in board.** harbor-api carries a week of work (three cards in
  Inbox, five in Assigned, two in Blocked, four in Done), so no frame is
  mostly empty canvas.
- **Activity** is the product's Overview: the cards someone is working on
  right now, across every project.
- **Telegram** has no drawn cards: the product has no Telegram surface to show
  with invented data, so it stays one line of copy.
- **Fonts** still load from Google Fonts, as in A: the publication gate
  refuses committed binaries.
- **Size.** The live frames' bundle is about 4.3 MB minified; it loads when
  the first frame below the hero comes near, so the first screen no longer
  fetches it.
- **Answers and freshness.** Six questions the misreadings raise sit before
  the footer, closed. The footer's version line reads npm's release times and
  adds how long ago the latest release came out and how many came out in the
  last 30 days, with the changelog beside it. The star count left the header.

- **Full screen.** Each frame has a control at the top-right corner of its
  window: in the bar of the run frame, above the corner of the other two, so
  the product's own header controls stay clear. The run frame goes full screen
  as a whole window with its tabs, the other two with a 52 px strip that holds
  the way out. The frame
  then runs at the real size of its area, unscaled, so the product's own
  layout applies. Full screen never changes an iframe's `src`. The demo's own
  synthetic Esc (it closes panels between views) does not leave the overlay;
  only a visitor's Esc does.

## Performance and scroll regression

Build first, then run the existing capture driver with Chrome's 4× CPU
throttle at 1440×900 and 390×844. Each run uses one browser and one page at a
time. Keep Chrome traces, JSON measurements and screenshots outside Git:

```sh
flock /var/tmp/llv-heavy-gate.lock bun landing/site/build.ts
LANDING_RENDER_DIR="$HOME/Pictures/delegatus-review/landing-perf" \
  flock /var/tmp/llv-heavy-gate.lock bun landing/site/capture.ts --perf=after
```

`--perf=before` records the same cases without enforcing the corrected scroll
behavior. Set `LANDING_URL=https://delegatus.org/` to measure the published
site. No capture command deploys the site. `--only=en-1440` or `--only=en-390`
limits the run to one viewport. `--load-only` repeats just the cold-load case;
`LANDING_DIST_DIR` selects a separately built baseline with the same driver.
`--early-tab-only` holds the frames' script until a tab is selected, then
verifies that selection survives startup.
Run the full scenario to exercise startup again after tabs and
language switches have populated browser history and storage. The full run
also checks early Search in both languages, rapid tab choices after each
language switch, and empty search responses: a missing result must offer a
retry without acknowledging readiness, and retry must recover three results
in the same iframe. Acknowledgements are checked against the rendered DOM.
`--search-failure-only` isolates the empty-response and retry check.

To check phone swipes, run `CHROME_BIN=/usr/bin/google-chrome-stable bun landing/site/capture.ts --check-swipe=after` after building. It drives 390×844 touch gestures at DPR 3 over the hero's demo, the conversation frame's composer, each demo frame, the install prompt and plain text in both languages. For the page-scroll measurement it places nested scroll areas at the edge in the swipe direction; a long composer draft separately verifies that the inner area still scrolls before that edge. The check writes `swipe-after.json` to `LANDING_RENDER_DIR` and requires page travel of at least 80% of the plain-text control in either direction. It also checks that a quick flick coasts after release. Use `--check-swipe=before` to record an unchanged or published baseline without asserting it.

The driver records load, tabs and repeated
EN/UK switches after visiting the lower sections. Chrome traces record script
evaluation, layout, paint and long tasks; JSON records click-to-state and
click-to-visible-content times separately. Timings include automation sampling
and vary with host load; compare runs on the same machine and throttle.

The first scripted reply waits 650 ms. Later steps retain 5.2/5.2/4.6 seconds
for reading the reports, with a visible playback progress line. Selecting a
step interrupts playback immediately. Transcript changes stream to the Viewer
as soon as the demo changes its world. Tabs keep that Viewer running, and
view readiness follows the actual controls and rendering instead of fixed
500/900 ms waits. Focus in a demo frame uses `preventScroll`, so opening a
conversation or search after translation cannot move the outer landing.

Phone navigation waits for its destination to render before the next queued
view opens. Project navigation uses the Viewer's own navigation command,
which clears pending conversation intent; an initial conversation can no
longer finish opening over a later Search selection. Readiness timeouts show
a localized retry control. Reloaded frames also wait for acknowledgement;
elapsed time alone never marks a frame ready.

`--check-swipe-feedback` covers the other half: a finger that moves steadily and then rests over the run and phone frames. The page has to follow it 1:1, hold still while it rests, and never reverse. It runs twice, once with Chromium's stable touch coordinates and once with `Touch.screenY` carrying the landing's scroll, the semantics seen in an iPhone Safari recording where the page alternated over a demo. The second run fails on a frame that reads the finger as a difference between two readings taken in a frame that moved in between, which is what made the landing jump back and forth. Playwright's WebKit can only tap, so this check models the iPhone coordinates in Chromium.

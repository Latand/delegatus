# Landing on a phone: the demo frames take no swipe

## The requirement

Operator, 2026-10-12 ~05:20, in the orchestrator chat (Ukrainian, verbatim):

> також на лендінгу на моб заборони свайпи на демо екранах, бо скаче і не дає
> лендос прокрутити вниз - скаче все вгору. вся сторінка.

In English: on the landing, on mobile, forbid swipes on the demo screens,
because the page jumps, won't let the landing scroll down, and the whole page
jumps up.

Pinned acceptance, in short: at 390×844 and 375×667 with touch, a vertical
swipe that starts on any demo screen scrolls the page; the demo never captures
the gesture, the page never jumps back and the scroll position never resets
while the demo animates. Demo swipes are off on mobile; screens change by taps
or by autoplay. Fix the jump at its source. Desktop is unchanged. Before/after
evidence from a mobile-emulated browser. Landing tests and the project's checks
pass. Report how a landing change reaches production; do not deploy.

## The surfaces

The landing has four demo screens. The hero (`index.html:68-91`,
`boardDemo.js`) is a drawn animation: `.demo-stage` has `pointer-events: none`
and the hero registers no touch listener, so the page scrolls natively over it.
The other three are iframes running the real Viewer over invented data
(`demo/demo.tsx`), mounted by `main.js` when 10% of them is in view:

| frame | markup | phone layout |
| --- | --- | --- |
| run («It runs the work») | `index.html:109-113`, `.live-run` | 390×700 scaled, `phone=1` |
| open («Every conversation, open») | `index.html:132-136`, `.live-open` | 390×700 scaled, `phone=1` |
| phone («It finds you») | `index.html:152-156`, `.live-phone`, `data-fixed` | 390×740, phone layout at every width |

Each section changes its frame's screen with the landing's own tab buttons,
outside the iframe (`index.html:104-107`, `121-130`, `158-162`;
`main.js:483-513`). Those are taps and stay as they are.

## How touch is handled today

A vertical swipe on a phone frame never reaches the browser's own scrolling.
Since #2304 and #2321 the page is scrolled by script, from finger coordinates
read inside the frame:

- `landing/site/demo/demo.tsx:73-119`. In a `phone=1` frame, capture-phase
  `touchstart`/`touchmove`/`touchend` listeners on the frame's document decide
  the axis after 8 px. A vertical move first goes to any nested scroll area
  that can still scroll (`canScroll`, lines 83-91, 109). After that the
  listener calls `preventDefault()` and posts `dlg:vertical-pan` with the
  finger's `clientY` in the frame (line 112), then `dlg:vertical-end`.
- `landing/site/main.js:340-365` turns the frame reading into viewport
  coordinates (`fingerInViewport`, from the frame's `getBoundingClientRect()`
  when the message arrives) and, at `main.js:521-547`, calls
  `window.scrollBy(0, …)` per message, clamped to ±100 px. On release it starts
  a script coast (`coastPan`, `main.js:352-365`, up to 1.8 px/ms, decaying with
  τ 180 ms). `main.js:350-351` cancels the coast on a new touch or wheel.

So on a phone the page's scroll position is written by script, from a finger
position measured in a frame that moves under the finger with every write.

## The cause

Two defects come from that one mechanism.

**1. The demo captures the gesture (reproduced).** A swipe over a frame first
scrolls the Viewer's own feed or list inside the frame, and the page moves only
the remainder. In headless Chromium 1243, `isMobile` + `hasTouch`, DPR 3, a
260 px vertical swipe from the open frame's centre, current `main`:

| viewport | surface | finger | page moved |
| --- | --- | --- | --- |
| 390×844 | open frame, finger down (page should go up) | 260 | −100 … −110 |
| 375×667 | open frame, finger down | 260 | −120 … −130 |
| 390×844 | open frame, diagonal (−120, −160) | 160 | +21 (plain text: +148) |
| 375×667 | open frame, diagonal | 160 | +43 (plain text: +148) |
| 390×844 | open frame, finger +200 then −300 | 200 / 300 | −50 / +120 |

The frames show it: in
`before-390x844-live-open-1-after-swipe-up.png` the swipe scrolled the chat
inside the demo back to the visitor's first message while the landing hardly
moved. `capture.ts --check-swipe=after` passes over this only because it first
sets every nested scroll area to its edge in the swipe direction
(`capture.ts:211-222`). On a horizontal or diagonal swipe the Viewer's own
gestures run too (the phone board's `snap-x` columns, swipe rows).

**2. The jump (device-specific, mechanism located, not reproduced in
emulation).** Chromium emulation does not reproduce a backwards jump: page
traces stayed monotonic at 1×, 4× and 6× CPU throttle, finger steps of 1-10 px,
and with the landing handling each `dlg:vertical-pan` 0, 12 or 24 ms late
(375×667, 24 ms: one 9 px reversal). CDP delivers each touch and its message
before the next, and Chromium updates `clientY` in a moved frame consistently,
so the coordinate conversion holds there. The operator's phone is an iPhone
(`landing/site/README.md:367` cites the iPhone Safari recording behind #2321),
and Playwright's WebKit can only tap, so the device semantics cannot be driven
here.

What the probe did establish: every scroll writer on the landing and in the
three frames was instrumented (`Element.scrollIntoView` in all frames,
`window.scrollTo`/`scrollBy` on the landing), and across a full walk down the
page at both viewports (frames loading on the way, the hero animating) **no
product code wrote a scroll position**. The only writers a swipe over a demo
frame reaches are `main.js:533` (`scrollBy` per forwarded move) and
`main.js:359` (the script coast). Those writes take their sign and size from
`clientY` read inside a frame that the previous write just moved, and from the
order in which the frame's touch events and the landing's message handler run.
Both depend on the device. #2321 already replaced `screenY` with `clientY`
for the same symptom («Stop the landing jumping back and forth under a swipe
over a phone demo»), and the operator still sees it. When those readings
disagree, consecutive writes cancel or reverse ("скаче"), and a release with
reversed samples throws the coast up to about 1.8 px/ms × 180 ms ≈ 320 px the
wrong way ("скаче все вгору"). `frameSession.ts:39-45` already stops the
Viewer's own `focus()` calls from scrolling the landing; nothing else in the
frames moves it.

Fixing the coordinate arithmetic a third time would keep the page's scroll
position under script control and still device-dependent. Its source is the
forwarding itself, and the operator's instruction removes the reason for it:
the demo frames take no swipe on a phone, so the browser scrolls the page
natively.

## The change

### 1. A phone frame takes no touch: `landing/site/main.js`

After `phoneQuery` (`main.js:324`) add:

```js
  // A touch screen scrolls the page over a phone frame; the frame takes taps
  // only in full screen.
  const touchQuery = matchMedia("(hover: none) and (pointer: coarse)");
```

In `layout()` (`main.js:381-416`), first line inside `if (live.iframe) {`
(`main.js:404`):

```js
      live.iframe.style.pointerEvents = phone && touchQuery.matches && !full ? "none" : "";
```

`phone` and `full` are already computed in `layout()` (lines 382, 387). Beside
`phoneQuery.addEventListener("change", relayout)` (`main.js:700`) add
`touchQuery.addEventListener("change", relayout);`.

Why this condition:

- `phone`: the frame runs the phone layout. On a phone that is every frame; on
  a touch tablet only the fixed handset.
- `touchQuery`: the device's primary pointer is a finger. A desktop window
  narrower than 640 px with a mouse keeps its frames interactive, exactly as
  today. Chromium's mobile emulation sets this media (verified: a 844×390
  touch viewport matched `phoneQuery` through its touch clause).
- `!full`: full screen is the one mode where the visitor uses the demo itself.
  `layout()` already runs on `enterFullscreen` (`main.js:638`) and, for every
  frame, on `finishLeave` (`main.js:672`), and it runs after both
  `mount` (`main.js:432`) and `reload` (`main.js:445`) create an iframe, so
  every new iframe gets the value.

The inline `""` leaves the stylesheet in charge, so
`.live iframe[data-incoming] { pointer-events: none }` (`styles.css:109`)
still holds for a frame that is still loading. With `pointer-events: none`
the touch lands on `.live-frame` (`styles.css:100`), a plain `div`, and the
browser scrolls the page with its own momentum and rubber band.

No change in `styles.css` or `index.html`. A CSS rule would have to
reimplement `phone` (the fixed handset), the full-screen state on two
different roots (`live.root` is the `.stage-wrap` for the run frame and the
`.live` itself for the other two) and the `data-incoming` precedence; the one
line in `layout()` reads all three from where they are already decided.

### 2. Delete the forwarding: `demo.tsx` and `main.js`

With no touch reaching a phone frame outside full screen, and the landing
ignoring pans in full screen (`main.js:520`), the forwarding has no caller
left. Delete it:

- `landing/site/demo/demo.tsx:73-119`, the comment and the whole
  `if (PHONE && window.parent !== window) { … }` block. Keep `post()`
  (`demo.tsx:69-71`); `announce`, `dlg:lang` and the view acknowledgements use
  it.
- `landing/site/main.js:335-365`: `panAnimation`, `stopPanMomentum`, the
  comment and `pan`, `fingerInViewport`, the two `window` listeners
  (`touchstart`, `wheel`) and `coastPan`.
- `landing/site/main.js:519-547`: the `pans` constant and the
  `dlg:vertical-start`, `dlg:vertical-pan` and `dlg:vertical-end` branches of
  the message handler. The rest of the handler stays.

Deleting this also takes the frame's capture-phase non-passive `touchmove`
listener off every phone frame, which is what lets the browser start a scroll
without waiting on the frame's script.

### 3. The driver: `landing/site/capture.ts`

Extend the existing `--check-swipe` case; do not add a driver.

- `checkSwipe` (`capture.ts:190-360`): drive both 390×844 and 375×667
  (`isMobile`, `hasTouch`, DPR 3) in both languages. Stop setting nested scroll
  areas to their edge (`capture.ts:211-222`): that setup hid the capture. For
  `after`, each demo surface (hero, run, open, phone, open composer) must
  move the page within 4 px of the plain-text control, in the same direction,
  for vertical (both directions) and diagonal swipes, with no backwards step
  in a per-`requestAnimationFrame` `scrollY` trace, and every nested scroll
  area in the frame must keep its `scrollTop` (the demo took nothing). Record
  the per-surface table for `before` as today.
- Replace the in-frame interactions of the `after` branch
  (`capture.ts:257-345`): typing into the composer, the run-frame flick
  coast, the two coast interruptions, the long draft and the click on
  `[data-phone-kanban-tab]` inside the phone frame all need a touch that now
  never reaches the frame. In their place:
  - each frame's iframe has computed `pointer-events: none` at both phone
    viewports and `auto` at 1440×900 (desktop, no touch);
  - a tap on a landing tab under each frame (run «A decision», open
    «Search», phone «Decision») still switches the frame's view
    (`data-busy` clears, the frame acknowledges with `dlg:viewed`);
  - after the run frame's full-screen control, its iframe is `auto` and a tap
    inside it reaches the Viewer; after leaving, it is `none` again.
- Delete `--check-swipe-feedback` (`capture.ts:700-788`, and its dispatch at
  `capture.ts:785-788`). It models the frame's coordinate reading, which no
  longer exists.

### 4. `landing/site/README.md`

- Line 344: describe the new `--check-swipe` assertions above.
- Line 367: delete the `--check-swipe-feedback` paragraph.
- Under "How the frames work" or beside the full-screen section: on a touch
  phone the frames are pictures the page scrolls over; the landing's tabs
  change their screen and the full-screen control opens the demo for use.

## States to check at 390×844 and 375×667 (touch, DPR 3, EN and UK)

Measured on a scratch build of `main` with change 1 applied (the
`phoneQuery`-only form; the final condition gives the same values on a
phone):

| state | before (`main`) | after |
| --- | --- | --- |
| walk the page with 40% swipes from mid-screen, top to bottom | monotonic in Chromium | monotonic; each step equals the plain-text step |
| vertical swipe 250 px on hero / run / open / phone, down and up | open up −100 / −110, others ±250 | ±235 on every surface, equal to plain text (15 px is the browser's touch slop) |
| diagonal swipe (−120, −160) | open +21 / +43, others +160 | +148 on every surface, equal to plain text |
| open frame chat after a swipe | scrolled inside the demo | unchanged at its tail |
| finger +200 then −300 over each frame | open −50 / +120 (390), −70 / +180 (375) | −185 / +285 on every frame |
| 260 px finger-down swipe in 2 px steps | open −104 / −128 (1× CPU) | −245 on every frame at 4× CPU, no reversal |
| landing tab under the phone frame, «Рішення» | switches | switches (`#pipeline=p-retries`) |
| iframe `pointer-events` | `auto` | `none`; `auto` in full screen; `none` after leaving |
| phone sideways 844×390, touch | `auto` | `none` |
| frames loading during the walk, hero animating | no scroll write from product code | same |

The lane re-measures these with `--check-swipe=before` on `main` and
`--check-swipe=after` on its head and records each table.

## What must not change on desktop

- 1440×900 with a mouse: every iframe stays `pointer-events: auto`; clicks,
  wheel scrolling inside the frames, the tabs, full screen and the language
  switch behave as on `main`. Measured on the scratch build: `auto` on all
  three frames, in and out of full screen.
- A desktop window narrower than 640 px with a mouse (600×900): frames stay
  `auto` and keep their phone layout (`phoneQuery` is unchanged).
- The handset frame on desktop keeps `data-fixed`, its phone layout and mouse
  interaction.
- The hero's demo, its timeline, pause button and `demo_start` event are
  untouched.
- `frameSession.ts:39-45` (`focus` with `preventScroll`) stays: it is what
  keeps a frame's `focus()` from moving the landing on load and language
  reload.
- A touch tablet (1024×1366) keeps its interactive desktop-layout run and open
  frames; only its handset frame stops taking touch, the same treatment as a
  phone.

## Checks

- `landing/site/copy.test.ts` and `landing/worker.test.ts`: 110 pass, 0 fail
  on a scratch export of `main` through `scripts/gate-slot.sh`, with isolated
  `HOME`, `TMPDIR` and `LLV_STATE_DIR`.
- The hooks (`.githooks`): pre-commit privacy and eslint; pre-push types (for
  `demo.tsx` and `capture.ts`), changed-file lint and touched tests.
- `bun landing/site/build.ts`, then `capture.ts --check-swipe=before` (on
  `main`'s build) and `--check-swipe=after`, plus `--check-fullscreen`, which
  must still pass at 390×844 (the full-screen frame takes touch).
- A real iPhone: the jump was seen on one and cannot be driven here. After
  publication the operator scrolls the landing over each frame once.

## Evidence

Before and after frames and one recording per viewport, from a scratch build
of `main` and the same build with change 1, under
`$HOME/Pictures/delegatus-review/landing-mobile-swipe/`: for each of the run,
open and phone frames, `{before,after}-{390x844,375x667}-live-<frame>-0-start`,
`-1-after-swipe-up` and `-2-after-swipe-down`, the phone tab frame
`-phone-tab-decision`, and `{before,after}-{390x844,375x667}.webm`. The lane
produces its own evidence from its head through `capture.ts`.

## How a landing change reaches production

The landing is the `delegatus-landing` Cloudflare Worker, configured by
`landing/wrangler.jsonc`, serving `landing/site/dist/`
(`landing/site/README.md`, "Worker configuration and publication"). No GitHub
workflow builds or deploys it: the only workflow naming the landing,
`.github/workflows/macos-newcomer.yml`, runs `landing/site/copy.test.ts`. The
Viewer's deploy (`scripts/rebuild.sh`, the Docker image) does not touch it.
After the pull request merges, the authorized deployer runs, from the
repository root:

```sh
flock /var/tmp/llv-heavy-gate.lock bun landing/site/build.ts
bunx wrangler deploy --config landing/wrangler.jsonc
```

with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in a protected
environment. `--dry-run` checks it without publishing. On 2026-10-12 the
published `index.html`, `main.js` and `styles.css` were byte-identical to a
build of `main` at `a8e005428`, so the live site runs the forwarding described
above. The lane does not deploy.

## Options considered

1. **No touch for a phone frame outside full screen; delete the forwarding**
   (chosen). One line decides it; the browser scrolls natively; about 80 lines
   leave. Cost: on a touch phone a tap inside a frame does nothing; the
   landing's tabs and the full-screen control remain.
2. **Fix the coordinate arithmetic again.** #2321 did that once and the
   operator still sees the jump. It keeps the page's scroll under script and
   keeps the capture of defect 1. Rejected.
3. **Keep taps, drop swipes: a shield over the frame that forwards taps into
   it.** It needs hit-testing into the scaled frame, synthetic clicks, and
   focus rules for the composer on iOS. The requirement asks for no swipes and
   names taps only as a way to change screens, which the landing's tabs
   already are. Deferred.

## Deferred — not currently justified

- Tap-through on a phone frame (option 3). Revisit only if the operator wants
  the phone demo usable without full screen.
- A visible hint on phone that the full-screen control opens the demo for use.
- The touch tablet's desktop-layout run and open frames, which still scroll
  their own lists under a finger. Nobody reported it, and the requirement
  names mobile.

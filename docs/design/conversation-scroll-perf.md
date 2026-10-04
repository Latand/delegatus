# Scrolling a large, fully expanded conversation on the board

Status: diagnosis with trace evidence, and the plan the builder implements.

## Originating requirement

The operator, 2026-10-01, by voice, relayed in the pinned task (paraphrased
in English; the original Russian stays in the task):

> When I scroll through a large conversation, the scrolling becomes very
> sluggish. I open the conversation on the board, expand it fully with the
> «показати раніше» button, and then scroll, and it lags badly, really badly.
> I would fix this. Check it on prod.

The screenshot showed the desktop board, a conversation opened inside a task
card in the Assigned column, the feed with command groups and tool rows, the
«показати раніше» button on top and the composer below.

What must be true (from the pinned specification): the cause is named from a
real Chrome trace of exactly that scenario; after the fix the expanded feed
scrolls smoothly against a numeric target met in a before/after run of the
same harness on the same transcript; nothing listed under "Must not regress"
regresses; and no cap hides history from the operator.

## The answer in one paragraph

Two pieces of work run on every scroll frame, and both grow with what is on
the board. **First and largest:** the feed's "which answer is on screen"
measure for the speak button (`src/components/LogFeed.tsx:713-749`) walks
every text node of every prose row in the expanded feed and asks each for its
`Range.getClientRects()`, once per animation frame while the feed scrolls:
about 32 000 rect queries per second, 56% of the main thread, in the
operator's scenario. Its cost is linear in the size of the expanded history.
**Second:** the board's root frame is sized in container-query units
(`height: max(440px, 100cqh)` against `.kb-page { container-type: size }`,
`src/components/kanban/kanbanBoard.css:701-702`). On a busy board its style
is re-resolved on every scroll frame, which invalidates the layout of the
whole board (24 000 DOM nodes on the Delegatus board): about 11 ms of forced
layout per scroll event. Removing the first cause alone takes the operator's
scenario from 37–47% of frames showing the scroll to 95–99%. Removing both
takes it to 98–100% on that board and from 62–66% to 92–96% on the busier one.
The fix bounds the measure to the rows on screen, sizes the board frame
without container units, and stops the speak buttons re-rendering on every
change of the visible answer. No windowing is needed, and no history is
hidden.

## How it was measured

**Surfaces.**
- The prod Viewer on `127.0.0.1:8898`, read-only.
- A local production build (`next build --webpack`) of `origin/main` at
  `130021a8d`, the same commit this pipeline started from. It ran in an
  isolated home and state directory with the install ping off. It sat behind
  a proxy that sends page and chunk requests to the local `next start` and
  `GET /api/*` to the prod Viewer, so both runs read the same transcript.
  The proxy refuses every other `/api` method.

**Read-only.** Every page the harness drives wraps `fetch`, XHR and
`sendBeacon` and refuses any non-GET. Across all runs it refused the writes
the board itself attempts: `POST /api/view/presence`, `PATCH /api/board` and
`POST /api/tmux/targets`. Readers are opened in a throwaway browser profile.
`GET /api/team` answers 401 to an unsigned browser, and the "sign in to
continue" panel this raises is hidden by an injected style so its backdrop
blur does not sit over the measured page.

**Scenario A, the operator's case.**
- A Claude conversation on a task card in the Assigned column of a second
  project's board: a 39 MB transcript of 2 533 lines.
- Opened by clicking its tile on the card, so the reader sits inside the
  card, then expanded by wheeling up and clicking «показати раніше» until the
  button is gone (49 clicks).
- Expanded, the feed holds 451 rows (110 prose rows, 136 tool rows, 83 command
  groups, 53 thinking rows). That is 8 346 DOM nodes in the feed and 13 430 on
  the page.

**Scenario B, a busier board.**
- A Codex build-stage conversation on an Assigned card of the Delegatus
  project board: a 5.4 MB transcript, 210 rows (24 prose rows) once expanded.
- The board around it has 24 160 DOM nodes and the orchestrator seat open.

The pipeline stage summary names both conversations and cards, so the
builder runs on the same transcripts. They are not named here because this
repository is public.

**Size.** The specification says "thousands of feed items". No conversation on
a currently visible card expands further than 451 rows: the larger
transcripts on prod belong to seats or to done cards, which do not show their
tiles. The two scenarios bracket the growth instead: the speech measure costs
455 ms per 5 s with 24 prose rows and 2 830 ms with 110, so it is linear in
the expanded history and a feed of thousands of rows is several times worse
than what is measured here.

**Gesture.** The viewport is 1600×1000 at DPR 1, the operator's desktop. The
feed is set to its top and brought on screen. Then
`Input.synthesizeScrollGesture` scrolls it down 10 000 px in 5 s at
2 000 px/s with mouse-wheel input, and a Chrome trace is recorded for those
5 s alone.

**Metrics.**
- *Full frames.* Chrome's `PipelineReporter` reports every frame with
  `frame_reporter.state`. The feed scrolls on the main thread (see below), so
  only a frame `PRESENTED_ALL` shows the new scroll offset; a frame
  `PRESENTED_PARTIAL` repeats the old one. "Full frames" is the share of frame
  sequences presented in full. The "full-frame interval" is the time between
  them: 16.7 ms is smooth, 33 ms is half rate.
- *Long tasks.* Main-thread `RunTask`s over 50 ms.
- *Main busy.* The share of the window the main thread was running a task.
- *Phases.* Main-thread self time per event, grouped into scripting, style,
  layout (with forced layout counted apart and attributed to the script that
  forced it), paint, composite and other.
- *React commits.* Counted through `__REACT_DEVTOOLS_GLOBAL_HOOK__`, which
  React also calls in production builds. For each commit, how many components
  rendered.
- *Observer callbacks and rect reads.* Counted by wrapping the constructors
  and prototypes in the page.

**Ablations.** Ablations are applied inside the page only, and each removes
one suspect:
- `speech` makes the measure's `SHOW_TEXT` tree walker return nothing.
- `rects` stubs `Range.getClientRects`.
- `composite` puts `will-change: scroll-position` on the feed scroller.
- `cv` turns `content-visibility` off on feed rows.
- `frameh` gives the board frame a `vh` height in place of `cqh`.
- A `--disable-lcd-text` Chrome run rules out the LCD-text compositing rule.

## Evidence

### Scenario A: prod, before, and each suspect removed

| run | main busy | long tasks (max ms) | full frames | full-frame interval p50 / p95 / max ms | React commits |
|---|---|---|---|---|---|
| prod, as is (3 runs) | 100% ×3 | 13 (78), 30 (93), 18 (86) | 41%, 36%, 37% | 33–50 / 50–67 / 67–133 | 54–76 |
| local build of origin/main, as is (3 runs) | 99–100% | 4, 1, 2 (≤ 86) | 46%, 47%, 46% | 33 / 50 / 67–100 | 52–53 |
| − speech measure (prod ×2, local ×1) | 75–78% | 1, 1, 0 | 95%, 97%, 99% | 16.7 / 16.7 / 33–83 | 25–32 |
| − speech measure − board-frame `cqh` (prod ×2) | 64–66% | 0, 1 | 100%, 98% | 16.7 / 16.7 / 33–83 | 30–31 |
| − `getClientRects` only (prod ×2) | 91–95% | 1, 0 | 88%, 85% | 16.7 / 33 / 33–100 | 46–70 |
| + `will-change` on the feed only (prod ×2) | 82–83% | 6, 9 | 37%, 37% | 50 / 67 / 83–100 | 67–156 |
| `--disable-lcd-text` (prod ×1) | 82% | 10 | 35% | 50 / 67 / 83 | 55 |
| − speech − `content-visibility` (prod ×2) | 76–80% | 1, 0 | 93%, 94% | 16.7 / 33 / 33–50 | 30–31 |

Where the main thread goes in the 5 s scroll, prod as is (one representative
run, self time):
- scripting ≈ 1 940 ms
- style ≈ 160 ms
- layout ≈ 50 ms, plus ≈ 720 ms forced by script
- paint ≈ 470 ms
- composite ≈ 55 ms
- other ≈ 2 280 ms (most of it the Blink lifecycle around the forced
  layouts: `Document::recalcStyle`, `UpdateStyleAndLayout`)

Per function, the speech measure's `requestAnimationFrame` callback alone is
2 830 ms of the 5 065 ms window (56%), and it forced 11 289 style recalcs in
that window. The counting run read `Range.getClientRects` 162 820 times and
`getBoundingClientRect` 7 449 times in 5 s, for 140 scroll events.

React during the 5 s scroll:
- 52 commits.
- 30 of them render more than 100 components (333 each). These follow every
  change of the "visible answer": all 110 row speak buttons re-render,
  because each subscribes to the whole speech snapshot
  (`src/components/feed/SpeakButton.tsx:106`).
- 8 commits re-render all 519 feed row wrappers, where `FeedItem`'s `memo`
  bails out.

Observers during the scroll:
- `ResizeObserver` callbacks ≈ 55 per 5 s.
- No `IntersectionObserver` or `MutationObserver` callbacks.
- Chrome's own `IntersectionObserverController::computeIntersections`
  (content-visibility relevance) ≈ 130–240 ms per 5 s.

DOM: 13 430 nodes on the page, 8 346 in the feed. The feed's rows are
`content-visibility: auto` (`.feed-cv`).

### Scenario B: prod, the busier board

| run | main busy | long tasks | forced layout ms / 5 s | full frames | full-frame interval p50 / p95 ms |
|---|---|---|---|---|---|
| as is (3 runs) | 100% | 2–3 | 2 200–2 350 | 62–66% | 17–33 / 33–50 |
| − speech measure (×2) | 98–99% | 1–3 | 2 130–2 220 | 68%, 73% | 16.7 / 33 |
| − board-frame `cqh` (×1) | 84% | 1 | 549 | 96% | 16.7 / 16.7 |
| − speech − board-frame `cqh` (×2) | 96%, 100% | 0, 7 | 660, 227 | 92%, 26%* | 16.7 / 33; 33 / 400* |
| − `content-visibility` (×1) | 100% | 0 | 2 729 | 48% | 33 / 50 |

\* In that run a board data update landed mid-scroll and React's scheduler
ran about 3.1 s of render work in seven 130–460 ms tasks. That is the open
#2218 ("each catalog update rebuilds the whole dashboard model in one
render"). The scroll does not cause it, and it appears in one run of six on
this board.

The invalidation trace names the trigger. In a 5 s scroll, Chrome records 434
layout invalidations with reason `Style changed` on
`div.board-frame.with-rail`, the board's root frame, about one per frame.
Each one relayouts the board down from that frame: 28–36 dirty objects out of
7 500, yet 11 ms per layout, all of it forced synchronously by the first
script that reads geometry in the frame. That is the reader-host scroll
tracker (`src/components/kanban/KanbanReaders.tsx:85-93`, 1 920 ms of the
window in the first trace). With the frame's height given in `vh`, those
invalidations disappear, forced layout drops from ≈ 2 200 ms to ≈ 550 ms, and
full frames rise from ≈ 64% to 96%. Turning `content-visibility` off leaves
289 of them and helps nothing. Scenario A's board shows the same invalidation
(298 in 5 s); there it is the smaller cost.

### What is not the cause

- **Scrolling on the main thread.** Every frame in every run reports
  `SCROLL_MAIN_THREAD`. Promoting the feed scroller
  (`will-change: scroll-position`, the fix #2219 applied to the board's own
  scrollers) and running Chrome with `--disable-lcd-text` both left the
  scroll on the main thread and the frame numbers unchanged (37% and 35%).
  The compositor still handles the gesture (`InputHandler::ScrollUpdate`
  every frame); the offset waits on the main thread. Once the main thread is
  free, the frames are on time (95–100%), so this is not what the operator
  feels.
- **content-visibility.** It neither helps nor hurts once the speech measure
  is gone (93–94% with it off, 95–97% with it on).
- **DOM size of the feed.** 8 346 nodes with `content-visibility: auto` paint
  in ≈ 470 ms per 5 s. That is the same with or without the fixes and well
  inside the budget.
- **Observer storms.** None (see above).

## Causes, ranked by share of frame time

1. **The speech visible-answer measure**
   (`src/components/LogFeed.tsx:713-749`).
   - On every scroll of the feed, every capture-phase scroll anywhere in the
     document (`window.addEventListener("scroll", schedule, true)`, so a
     column or another reader scrolling triggers every open reader too),
     every resize and every DOM mutation in the feed, it schedules `measure`.
   - `measure` takes every `[data-tts-answer-index]` row in the whole
     expanded feed, walks every text node of each with a `TreeWalker`, calls
     `closest()` on each, and sums `Range.getClientRects()` clipped to the
     viewport.
   - Rows off screen contribute zero area, and `visibleSpeakableAnswer`
     (`src/components/feed/speakableAnswer.ts:49-62`) skips fragments with no
     area. So all that work on off-screen rows changes nothing.
   - On rows that `content-visibility` has skipped, each geometry read
     forces a style and layout update of that subtree.
   - Share: 56% of the main thread in scenario A, rising with every expanded
     prose row.
2. **The board frame sized in container-query units**
   (`src/components/kanban/kanbanBoard.css:701-702`).
   - `.kb-page` is a size container and also the page scroller;
     `.board-frame` is `height: max(440px, 100cqh)`. On every scroll frame
     the frame's style is re-resolved and the whole board relayouts.
   - Someone pays about 11 ms per frame for that layout. Today the
     reader-host scroll tracker pays it, reading `scrollHeight` in its scroll
     listener.
   - Share: ≈ 45% of the window on the busier board (2.2 s of 5 s),
     ≈ 15% in scenario A.
3. **Speak-button fan-out** (`src/components/feed/SpeakButton.tsx:106`).
   - Every row's speak button subscribes to the whole conversation speech
     snapshot. Each change of the visible answer, about 6 per second while
     scrolling, re-renders all of them: 333 components a commit in scenario
     A, growing with prose rows.
   - Share: a few percent today (the React scheduler's work in scenario A is
     ≈ 230–330 ms per 5 s). It grows with history.
4. **Linear per-scroll-event scans.** `viewportAnchor`
   (`src/components/LogFeed.tsx:179-184`) runs on every scroll event
   (`LogFeed.tsx:1552-1556`) to remember the reading position. It
   `querySelectorAll`s every row and reads `getBoundingClientRect` from the
   first row down until it passes the viewport top. That is 7 449 rect reads
   in 5 s at 451 rows, and it grows linearly with how deep the reader is in a
   longer history. Cheap with layout clean, but O(history) per event.

## The fix

Four changes. F1 and F2 meet the target on their own (measured above); F3
and F4 keep it met as the history grows, which the requirement's "thousands"
asks for. None of them changes what the operator sees.

### F1. Measure only the rows on screen (LogFeed.tsx:713-749)

Keep `measure`'s arithmetic and `visibleSpeakableAnswer` exactly as they are,
and feed `measure` only the rows that intersect the screen:

- In the effect, create one `IntersectionObserver` with `root: null` (the
  viewport). Intersection with the viewport already applies every clipping
  ancestor, the feed scroller and the board column included, which is the
  same clip `measure` computes by hand. Observe each
  `[data-tts-answer-index]` row and keep a `Set` of the intersecting ones.
  The callback updates the set and calls `schedule()`.
- The existing `MutationObserver` observes rows added under the viewport and
  drops removed ones from the set. Scan the added nodes only, never the
  whole feed again.
- `measure` iterates the set, a handful of rows, in place of
  `viewport.querySelectorAll("[data-tts-answer-index]")`.
- Keep the triggers (feed scroll, window resize, `ResizeObserver`, the
  `window` capture scroll): with a bounded `measure` they cost microseconds,
  and keeping them keeps today's behaviour when an ancestor scrolls.
- The effect is keyed on `feed.items` today, so every tail update tears it
  down and rebuilds it. Read `feed.items` and `answerFor` through refs and
  key the effect on `speechScope` alone, or the rebuild re-observes every row
  on every poll.

Acceptance:
- In the harness's `--count` run, `Range.getClientRects` reads during the
  5 s scroll fall from ≈ 143 000–163 000 to under 5 000.
- The speech `requestAnimationFrame` callback is under 100 ms per 5 s
  (from ≈ 2 800).
- The header speak button still reads the most visible answer, as
  `SpeakButton.dom.test.tsx` and `speakableAnswer.test.ts` pin today.
- A test drives a feed with many prose rows of which only a few intersect and
  asserts that `measure` touched only those rows.

### F2. Size the board frame without container units (kanbanBoard.css:701-702)

`.board-frame` must fill the page below the seat and never shrink under
440 px. Give it that height without `cqh`. For example, `height: max(440px,
100%)` resolves against `.kb-page`, whose height is definite as a flexed item
of a definite column. Then `.kb-page` no longer needs `container-type: size`.
`inline-size` keeps every width query that resolves against it working (the
unnamed `@container (max-width: 480px)` at `kanbanBoard.css:1481` resolves to
the nearer `.reader.conv` and `.pane`, which are inline-size containers
already).

Acceptance:
- With `--invalidation`, the scroll window holds no `LayoutInvalidationTracking`
  on `.board-frame` (from ≈ 300–434).
- Scenario B's forced layout falls under 700 ms per 5 s (from ≈ 2 200).
- Board geometry is unchanged: run `scripts/capture-board-geometry.ts` on
  base and branch. The seat above the board, the board's 440 px floor at a
  short window, the open-agents rail and the folded-column strips keep their
  rectangles.

If a percentage height cannot reproduce the geometry, set the frame's height
from the page's height once per resize. The requirement is only that nothing
re-resolves the board root's style on a scroll frame.

### F3. Row speak buttons re-render only for their own answer (SpeakButton.tsx:106)

A row button reads the speech snapshot in three places when it renders:
- whether it is the active one (`activeId === answerId`, or
  `activeText === text`), line 120;
- the `phase` when it is;
- the `error`, lines 442 and 450.

Its reads of `snapshot.target` (lines 197, 338) run inside click and playback
handlers and can read `speech.getSnapshot()` at that moment. Give row buttons
a `useSyncExternalStore` selector that returns a primitive built from those
three, so a change of the visible answer does not re-render them. The header
button keeps the full snapshot, because it shows the target.

Acceptance: in the `--count` run, commits rendering more than 100 components
during the scroll fall from 30 to at most 5. Playback, stop, highlighting and
error notices behave as `SpeakButton.dom.test.tsx` pins.

### F4. Find the reading anchor by bisection (LogFeed.tsx:179-184)

Rows are in document order and their tops increase down the feed, so
`viewportAnchor` can binary-search `feedRows(scroller)` for the first row
whose bottom passes the viewport top. That costs O(log n) rect reads per
scroll event in place of O(rows above the viewport). The same linear pattern
in `src/components/scheme/NativeConversationPane.tsx:58` can share the
helper.

Acceptance: element rect reads during the `--count` scroll stay under 1 000
at 451 rows (from 7 449). `LogFeed.prependAnchor.dom.test.tsx` and the
remount scroll-memory tests pass unchanged.

## Target

Measured with the harness below: scenario A, three runs on the local build of
the base and three on the branch, the same transcript through the same proxy.
The PR body carries both tables.

| metric (5 s scripted scroll, scenario A) | before (local origin/main) | target |
|---|---|---|
| full frames | 46–47% | ≥ 95% in each run |
| full-frame interval p95 | 50 ms | ≤ 17 ms |
| long tasks > 50 ms | 1–4 | 0, or 1 attributed to a board data update (#2218) |
| main busy | 99–100% | ≤ 75% |
| speech rAF callback | ≈ 2 750 ms | ≤ 100 ms |
| `Range.getClientRects` reads (`--count`) | ≈ 143 000 | ≤ 5 000 |
| commits rendering > 100 components (`--count`) | 30 | ≤ 5 |

On scenario B, also: no layout invalidation of `.board-frame` during the
scroll, forced layout ≤ 700 ms per 5 s, and full frames ≥ 90% in at least two
of three runs. A run where React's scheduler ran a board update during the
scroll is reported and repeated, not counted (#2218).

## Harness

`scripts/profile-conversation-scroll.ts` sits beside
`scripts/profile-kanban-board.ts` and `scripts/profile-reopen.ts`. It needs
`playwright-core` (a dependency already) and a local Chrome:

```sh
# one local production build per side, each under its own isolated home, state and port
# (env as in scripts/profileBrowser.ts seededEnvironment; DELEGATUS_TELEMETRY=0)
bun --bun node_modules/.bin/next build --webpack
LLV_STATE_OWNER=viewer LLV_STATE_DIR=<isolated> HOME=<isolated> DELEGATUS_TELEMETRY=0 \
  bun --bun node_modules/.bin/next start -H 127.0.0.1 -p <port>

# pages from that build, data from the prod Viewer, writes refused
bun scripts/profile-conversation-scroll.ts proxy --app http://127.0.0.1:<port> --data http://127.0.0.1:8898

# three traced runs, then one counting and one invalidation run
CHROME_BIN=/usr/bin/google-chrome-stable bun scripts/profile-conversation-scroll.ts run \
  --url http://127.0.0.1:<proxy port> --project <project key> --card task:<task id> --tile 0 \
  --conversation <conversation id> --out <dir> --runs 3
… run … --runs 1 --count
… run … --runs 1 --invalidation
```

Each run prints one JSON line with the shape of the expanded feed, the
in-page counters and the trace analysis (`fullFrameShare`,
`fullFrameIntervalMs`, `longTasks`, `mainBusyShare`, `phasesMs`, `layoutMs`
with the script that forced each layout, `topJsMs`, `layoutInvalidations`).
`analyze <trace.json>` re-reads a kept trace. `--ablate speech,frameh,cv,composite`
reproduces the diagnosis above. Measure on a quiet machine: one harness at a
time, no build running beside it.

Four things cost a run each to learn:
- **Wheel up before clicking.** A click without a real wheel leaves the follow
  magnet on, and the tail cap then trims what each «показати раніше» loads.
- **Re-measure the feed's box before the gesture.** The wheel during expansion
  chains into the column when the feed reaches its top and moves the card.
- **A reader seeded into localStorage for a conversation the card does not
  show** lands outside any card and never loads its tail. Open the reader
  through its tile.
- **zsh does not word-split** an unquoted `$CMD`. Drive repeated runs from an
  `sh` script.

## Must not regress

The surfaces the specification names, and how the builder shows each one:

- **Live tail and «jump to latest».** The glue on new items, the release on an
  upward wheel, the return at the bottom. F1–F4 touch none of these paths;
  run `LogFeed.liveToolRows`, `LogFeed.startingWindow`, `LogFeed.mobileChrome`
  and `LogFeed.suggestedReplies` `.dom.test.tsx`.
- **«показати раніше».** It loads and keeps the scroll anchor:
  `LogFeed.prependAnchor.dom.test.tsx` (F4 changes the function it relies
  on), plus a harness run, which expands through every click.
- **Search and anchors into the feed, and the scroll memory across remounts.**
  `viewportAnchor` and `rowForAnchor` keep their contract:
  `src/components/feed/scrollMemory.test.ts` and the prepend test.
- **The speak button.** The header still reads the most visible answer, rows
  still show their own playback state, the karaoke highlight still finds its
  roots: `SpeakButton.dom.test.tsx`, `speakableAnswer.test.ts`, and the new F1
  test.
- **Board geometry (F2).** `scripts/capture-board-geometry.ts` before and
  after: the seat over the board, the board at its 440 px floor in a short
  window, the open-agents rail, folded columns, a reader in a card at its
  in-card height, and the Stages sheet. `conversationHeights.test.ts` and
  `boardScrollers.test.ts` pass. #2219's `will-change` on `.kb-page` stays.
- **Phone, 390 px.** The phone runs the same `LogFeed` in its focused pane,
  so F1, F3 and F4 apply there; F2 is desktop board CSS. Run
  `src/components/mobile/issue1671Evidence.browser.test.tsx`
  (`LLV_SWIPE_BROWSER_TEST=1`) and look at the focused conversation at
  390×844 yourself.
- **The conversation outside the board** (full window, `compact = false`).
  The same `LogFeed` effect, without `.feed-cv`. Open one in the full view on
  the local build and scroll it.
- **Light and dark.** Nothing here touches colour; one harness run with the
  dark theme set, plus the geometry capture in both themes.
- **No hidden history.** No change to `COMPACT_STEP`, `TAIL_CAP`,
  `FOCUS_CAP` or what «показати раніше» loads. The harness prints `rows` and
  `clicks`; both stay as before (451 and 49 in scenario A).

Per `AGENTS.md`, run each touched test file by path, never a directory
sweep, and `tsc` under the heavy-gate lock. The PR's required checks are
`privacy-publication` and `privacy-tracker-audit`.

## Deferred: not currently justified

- **Windowing or virtualizing the feed.** With F1 and F2 the expanded feed
  presents 98–100% of frames; the remaining main-thread time is paint and
  React work that does not scale per frame with history. Virtualization would
  rework the prepend anchor, scroll memory, search anchors, the image gallery
  and speech roots for no measured gain. Reconsider only if a future harness
  run on a feed of several thousand rows misses the target after F1–F4.
- **Compositor scrolling for the feed.** `will-change: scroll-position` on
  `[data-log-feed-scroller]` made no difference (37% before and after), and
  neither did `--disable-lcd-text`. Why the feed stays on the main thread is
  still open. It stops mattering once the main thread is free, so it is not
  part of this fix.
- **Rewriting the reader-host scroll tracker**
  (`KanbanReaders.tsx:85-93`). It pays for the layout that F2 removes; with F2
  in place its reads land on a clean layout.
- **Changing `content-visibility` on feed rows.** Measured neutral.
- **The board-wide render on catalog updates.** #2218, already open. It
  showed up in one run of six on the busy board as 130–460 ms tasks, and it
  stalls any gesture, scrolling included.
- **Memoizing feed row wrappers.** `FeedItem` is already `memo`; only 8
  commits in 5 s re-rendered the row wrappers.

## Notes

- **Phone not profiled.** This investigation did not profile the phone
  surface. The phone feed runs the same measure, so the builder's phone check
  should include a scroll through an expanded feed.
- **Heavy-gate lock.** The local build ran without
  `/var/tmp/llv-heavy-gate.lock`, because the lock was held by a process in
  another PID namespace (#2386). At the time there were 13 GB free and no
  other `tsc` or `next build` running.
- **Install ping.** The local build of `origin/main` includes the default-on
  install ping (#2382). Run the before/after servers with
  `DELEGATUS_TELEMETRY=0` so a profiling instance never reports itself.

# Long conversation scroll evidence

The same browser case measured the original implementation, a CSS-only control,
then the complete fix. Maximum displacement of the message being read:

| Viewport | Feed | Before | CSS-only control | After |
| --- | --- | ---: | ---: | ---: |
| 390 px | compact | 14757.875 px | 506.25 px | 0.25 px |
| 390 px | full | 731.75 px | 731.75 px | 0.25 px |
| 1440 px | compact | 9028 px | 0.5 px | 0.5 px |
| 1440 px | full | 0.5 px | 0.5 px | 0.5 px |

The baseline source is commit `4baabbec88d86b5a9a69d178e2be9881d12fa7fe`.
Its `src/components/LogFeed.tsx:1609,1638` applied `.feed-cv` to compact rows;
`src/app/globals.css:285-287` supplied `content-visibility: auto` and a 44 px
intrinsic estimate. On phone prepend, scroll height collapsed to 7956 px,
then grew to 44154 px as rows were measured. The original same-frame prepend
snapshot (`LogFeed.tsx:202-228`) could not preserve an offset across those
later height changes. Disabling only that CSS reduced the compact phone's
maximum displacement to 506.25 px and desktop's to 0.5 px.

Two additional mechanisms affected released phone readers. The original
`LogFeed.tsx:495-512` scheduled smooth rest alignment after 160 ms, including
from the resize observer at `:785-794`. In the full phone baseline, prepend
first restored within 0.25 px, then the timer moved the anchor 52 px. Late
image growth added 200 px and late code/markdown layout added 480 px. Native
`overflow-anchor: auto` could choose the prepended predecessor, whose lower
edge entered the viewport's padding, instead of the message the reader had
chosen. Keeping that predecessor's top fixed allowed its growth to push the
reader's message down. The height-estimate control reproduces those late-layout
shifts; live-bottom updates and viewport resize add no independent shift.

The fix keeps actual row layout within the existing bounded render window
(`LogFeed.tsx:1612`), removes released-reader rest snapping (`:490`), and makes
prepend and resize share a stable message anchor (`:189,227,766,1503`). The
scroller disables native anchoring (`:1427`); the existing ResizeObserver
restores the same anchor's offset before paint. Compensation uses the canvas
scale for compact panes. Bottom-follow still uses its existing glue and
alignment. All four final bottom gaps after a new message are 0 px.

The driver is the existing
`src/components/mobile/issue1671Evidence.browser.test.tsx`, case
`long conversation scroll: history and late layout preserve the reader`.
Its existing fixture now has a synthetic history scene: 120 loaded records,
60 records prepended after real upward wheel and CDP touch steps while the
request is pending, long paragraphs and highlighted code, a sticky header,
late image/code/markdown growth above the reader, a bottom append, and an
844-to-780 px viewport resize. Both compact and full feeds run at phone and
desktop widths. Only fixture transport and content are used.

`before.json`, `cv-disabled.json`, and `after.json` contain every sampled frame's
scrollTop, anchor position, content height, scroller top/height, visual viewport
height, event phase and overflow-anchor setting. rAF runs before ResizeObserver:
when a resize occurs, the trace retains `preResizeAnchorY` and
`preResizeScrollTop`, then records the position after the product's earlier
observer has restored the anchor in that rendering opportunity. This preserves
the raw layout displacement and distinguishes it from a position that survives
to paint. The final tolerance of 3 px is asserted for every stationary phase;
intentional wheel/touch movement is retained in the trace and excluded from
the stationary displacement metric.

`summary.json` gives per-event numbers and SHA-256 digests of 24 local rendered
frames at `.artifacts/scroll-history/`. Phone and desktop before/after frames
were visually inspected. Raw PNGs stay local as required by the repository.
Chromium emulates touch and viewport resize; physical mobile browser chrome
and WebKit were not exercised.

Changed source files: `src/components/LogFeed.tsx`, `src/app/globals.css`,
`src/components/feed/SpeakMenu.tsx` (obsolete containment comment),
`src/components/mobile/issue1671Evidence.fixture.tsx`, and the existing phone
driver. The driver also updates the earlier edge-alignment case so only
followed content must align to the task strip: a released reader retains their
chosen partial line. Its measurements are refreshed in
`evidence/issue-1978/phone.json`. Evidence files in this directory are new.
The composer context, linked sync and review-defaults lanes were untouched.

Every check used fresh isolation, with this prefix repeated for each command:

```sh
sandbox=$(mktemp -d /tmp/llv-scroll-check-XXXXXX)
export LLV_STATE_DIR="$sandbox/state" XDG_CONFIG_HOME="$sandbox/config" TMPDIR="$sandbox"
```

Final verification commands and counts:

| Command | Result |
| --- | --- |
| `LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN="$CHROME_BIN" bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t 'long conversation scroll\|#1978'` | 2 pass, 32 filtered, 12 assertions; includes copy controls and bottom-follow |
| `bun test src/components/LogFeed.prependAnchor.dom.test.tsx` | 10 pass, 4 optional transport/browser cases skipped, 37 assertions |
| `bun test src/components/LogFeed.mobileChrome.dom.test.tsx` | 6 pass, 33 assertions |
| `bun test src/components/LogFeed.outboxTailOrder.dom.test.tsx` | 10 pass, 25 assertions |
| `bun test src/components/feed/SpeakMenu.placement.test.ts` | 6 pass, 10 assertions |
| `bunx tsc --noEmit` | exit 0 |
| `bun run privacy:check` | PASS, including required known-value fingerprints and commit checking |
| `git diff --check` | exit 0 |

The DOM suites run in separate processes; combining them contaminates their
shared browser globals and test dependency seam. Final relevant checks have
34 passes, 4 optional skips and no failures. No broad suite touched live state.

Unfiltered scoped lint used
`bun run lint src/components/LogFeed.tsx src/components/feed/SpeakMenu.tsx src/components/mobile/issue1671Evidence.browser.test.tsx src/components/mobile/issue1671Evidence.fixture.tsx`.
It reports the same four pre-existing `react-hooks/refs` errors and nine warnings
as the baseline LogFeed; the other touched TypeScript files have zero errors or
warnings. Comparing baseline and final JSON reports found no new diagnostic.
The same command with `--rule 'react-hooks/refs: off'` exits 0 with the nine
existing warnings. Repository lint configuration was unchanged.

An additional starting-window sanity check,
`bun test src/components/LogFeed.startingWindow.dom.test.tsx`, has 4 passes and
1 failure: issue 1398 expects one internal prompt but finds two. It reproduces
unchanged on the original source. This unrelated baseline defect was also
reported in an earlier project transcript; it is outside this scroll fix.

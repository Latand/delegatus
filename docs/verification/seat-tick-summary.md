# Seat tick state before panel details

Open the orchestrator card. Its tick row reads the saved cadence and health
without opening the settings panel. Opening the panel starts its detailed
read; until that answer arrives, the panel says that it is reading and offers
no editable defaults. A failed panel read keeps the closed control's saved
state available.

The request split is in `src/app/api/monitor/seat-tick/settings/route.ts` and
`src/lib/monitor/seatTickSettingsAnswer.ts`. Both GET and PUT accept
`view=summary`. The default request retains the complete panel answer. The
compact answer contains schedule, persisted health, scoped journal summaries,
and the autonomy/Turbo marks. It omits monitor text, episode histories,
curation computation, maintenance runs, release status, and account catalogs.
PUT still uses the existing same-origin and actor checks, validation, write,
and stored read-back. A compact write invalidates cached panel details.

The desktop chip and mobile row request the summary. The desktop panel's read
is enabled only while open; the phone sheet mounts its detailed reader when
opened. Project and view identify separate cache entries, bounded to 64 entries
per tab with oldest-entry eviction. A detailed receipt can update the closed
control; a summary cannot populate the editable form. A refused closed-control
write keeps its reason in the pending and loaded desktop panel; its next write
clears that earlier refusal. Closing a reader aborts
its pending GET. The original full HTTP and MCP consumers retain their default
contract; no persistence format or write authority changes.

## Measurements

The running release reported web and runtime-host revision `34b741354731`.
The route, answer builder, curation store, and client reader match the pinned
base `2614b079b3` byte for byte. Read-only loopback requests used the card's
full canonical project ID. The three samples completed on 2026-11-12 at
10:02:40 UTC:

| Request | Sample 1 | Sample 2 | Sample 3 | Response |
| --- | ---: | ---: | ---: | --- |
| `GET /api/monitor/seat-tick/settings` | 6329.02 ms | 604.51 ms | 571.64 ms | First: HTTP 500, curation deadline; next two: HTTP 200, 1,257,856 bytes |
| `GET /api/orchestrator/seat` | 182.67 ms | 268.47 ms | 426.37 ms | HTTP 200 in all three samples |

A further successful read measured 668,297 bytes under `settings`, 571,337
under `autonomy`, 19,607 under `turbo`, and 17,216 under `effective`. The closed
control was waiting for the full answer, including duplicated episode data.
The observed error was `curation panel read timed out`; the route awaited that
panel computation before it could return the saved cadence.

For the comparison, a read-only SQLite backup and tick journal were replayed
inside private state roots. Three alternating before/after pairs each started
one fresh Bun 1.4.0 process per revision and issued five sequential loopback
HTTP GETs. Both sides used the same recorded data, fixed clock, gate admission,
and absence of synthetic concurrent load. Timings run from request start to
complete response body; startup and queue admission are excluded. This exercises
the real route through a Bun HTTP listener, with Next's request/response types.
It measures the route in isolation; the candidate has not been deployed.

| Measurement | Before | After |
| --- | ---: | ---: |
| First-request samples | 805.82, 920.58, 945.07 ms | 205.99, 236.97, 186.57 ms |
| First-request median | 920.58 ms | 205.99 ms |
| All 15 requests, median | 150.85 ms | 116.28 ms |
| Warm requests, median | 141.57 ms | 114.67 ms |
| Response bytes | 1,252,222 | 3,772 |
| HTTP 200 responses | 15/15 | 15/15 |
| Curation/Turbo computations | Present | Zero |

[evidence/seat-tick-summary/timings.json](../../evidence/seat-tick-summary/timings.json)
contains every paired sample, phase timings, dataset fingerprint, collection
counts, serving/base revisions, and live samples. The earlier standalone
five-request runs remain in the retained evidence directory; their warm
medians varied with machine load. The alternating campaign above is the
comparison used here. Initial abbreviated-project-ID probes and authentication
refusals are retained separately and are excluded from the canonical samples.

## Rendered evidence and checks

The existing `src/components/kanban/kanbanBoard.browser.test.tsx` driver owns
the case `seat tick summary arrives before panel details`. A promise holds each
detailed response until the driver observes the pending panel, then releases
it. The initial closed card must have requested only summaries. The same
fixture and driver capture the base's placeholder while its detailed request
is held. English and Ukrainian, light and dark, phone and desktop use the real
stylesheet and controls. Geometry comes from rendered text ranges intersected
with every clipping ancestor; screenshots are also inspected visually.

Frames, source procedures, raw timing observations, and command logs are retained
under the stage's configured evidence directory. No private snapshot contents
or raw live response bodies are published in the repository.

The closed control's defining element is its saved cadence. The pending and
failed panels are defined by their status sentence; the loaded panel is defined
by its interval field. The phone sheet traps Tab and Shift+Tab and covers
background taps with its scrim. Scrollable desktop panels expose a 15 px native
scrollbar gutter.

At 320 px the existing Ukrainian row label was ellipsized; it now wraps. The
base and candidate both crop a later panel label at the native scroll edge in
the initial 320 px loaded panel. The capture driver frames complete text lines
near the start and end, recording its desired and actual scroll offsets. At
390, 1000 and 1440 px the initial loaded frames need no scroll adjustment.

The final command ledger is
[evidence/seat-tick-summary/checks.json](../../evidence/seat-tick-summary/checks.json).
It retains development failures and base comparisons alongside the final
results. Each test invocation names one file and gets a fresh HOME,
XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR under the stage scratch root. The
retained `procedures/run-file.sh` contains that setup; the outer command is
`bash "$GATE" --record "$TMPDIR/<run>.log" bash "$TMPDIR/run-file.sh" <file>`.
`GATE` is the installed release's `scripts/gate-slot.sh`. Long runs each use one
native completion wait; no check is restarted while its result is unknown.

Raw whole-file ESLint reports the same three errors on the base: two render
clock reads and an existing effect update. The project's lint comparator is
the publication policy. This stage runs no full typecheck or build, as the stage instructions require.
The publisher owns the repository's pre-push gate.


## Final verification

| Explicit test file | Passed | Failed | Assertions |
| --- | ---: | ---: | ---: |
| `src/app/api/monitor/seat-tick/settings/route.test.ts` | 34 | 0 | 268 |
| `src/components/orchestrator/SeatTickChip.dom.test.tsx` | 58 | 0 | 384 |
| `src/components/orchestrator/SeatTickSwitch.dom.test.tsx` | 25 | 0 | 173 |
| `src/components/mobile/MobileSeatTickSheet.dom.test.tsx` | 20 | 0 | 128 |
| `src/components/orchestrator/seatTickView.test.ts` | 25 | 0 | 200 |
| `src/components/kanban/kanbanBoard.browser.test.tsx`, filtered to this case | 1 | 0 | 752 |
| `src/styles/tokens.contrast.test.ts` | 8 | 0 | 230 |
| `src/styles/darkControls.contrast.test.ts` | 20 | 0 | 253 |
| Total | 191 | 0 | 2388 |

All eight final file commands exited 0. The new summary-route case fails on the
base (HTTP 500 instead of 200 while curation is unavailable). The refused-move
switch case passes on the base and on the repaired candidate. Lint policy:
10 files, 0 introduced errors, 3 matching base errors, exit 0.

The final browser run took 93.89 seconds inside the runner. It covers 40
contexts and 136 states, with 248 screenshots under `tick-after-frames` in the
retained stage evidence. The 320 and 390 px viewports are 844 px high; the 1000
and 1440 px viewports are 700 px high. Every closed frame requested only a
summary and showed its saved cadence on the first screen. Pending and failed
reads expose no editable defaults. Desktop refused writes retain the server's
reason while the detailed read is pending and after it completes.

[evidence/seat-tick-summary/rendered.json](../../evidence/seat-tick-summary/rendered.json)
records every measured state, field value, visible text, request sequence and
scroll offset, with zero text-range cuts or overlaps in the framed surfaces.
All 248 images were visually inspected: 150 match previously inspected images
byte for byte, and 98 new or changed images were inspected in labelled sheets.
No OCR was used. Whole viewport PNGs are the primary frames; `-detail.png`
images are supplemental element captures and may include offscreen canvas.

The retained evidence also holds `attempt1-checks`, `attempt2-checks`,
`procedures`, `visual-review`, the paired raw timings, and
`publication-checks.json` for the final hook and publication scan receipts.
The private replay snapshot and live response bodies stay outside published
repository data. The candidate timing is an isolated route measurement; no
production promotion is part of this change.

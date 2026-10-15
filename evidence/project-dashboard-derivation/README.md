# Project dashboard derivation

This implements the client-side fix designed in [the original audit](../../docs/perf/project-dashboard-derivation.md). The retained regression is the `ProjectDashboard derivation` describe block in `src/components/kanban/kanbanBoard.browser.test.tsx`, using the shared fixture's `project-derivation` scenario.

The dashboard reads one board-clock snapshot in both time units. Its project-owned projector retains equal relationships, branch groups, layout and bands. Layout traversal shares its child index. Reviewer folding retains its ownership and parent-rewrite plan across metadata-only polls. Expansion reuse rechecks placement predicates, while equal pinned, collapsed and expanded path sets stop downstream invalidation. The layout alias index resolves into fresh payloads, including timestamp and activity changes; duplicate paths use the full lookup. Card derivation keeps immutable membership indexes and pipeline summaries, retains member state when its inputs have no deadlines, checks time-dependent working/attention and retention predicates, and reconciles equal cards. Size/mtime refreshes use a reverse ownership index to update affected workflow references, task rows and unlinked workers while preserving relationship membership; represented layout payloads, changed identities, tasks, reviews, pipelines and deadline crossings still invalidate their consumers. Working counts revisit only running-turn candidates, using fresh file payloads. Caches retain one current projection and its relationship indexes, or use weak keys.

The unit cases compare incremental results with full derivation through edits, deletion, reordering, generation replacement, duplicate paths, seat changes, launch deadlines, attention expiry, retention, hydration and resumed/backwards time. The browser correctness case compares the complete nine-stage projection and the rendered card records byte for byte at the same logical times.

## Measurement contract

Final paired baseline: `836c8498ef913ad94d1d79c51c8b01d53b30d01b`. The original audit remeasured main `45d25ac796` before implementation. After main gained shared-driver options, this branch merged that revision, preserved both option paths and repeated the complete acceptance series against the updated baseline. The synthetic corpus contains 864 files, 284 flows, 619 tasks and 357 rendered cards. Six live sessions receive 40 transcript events/s in aggregate while the export conversation is open. Chromium 156.0.8078.4 uses CPU ×4, 1440 × 900, dark/en, normal motion and visible desktop scrollbars. The fixture supplies the route's 15-second named heartbeat during startup, and the driver requires a live connection before and after measurement. Each fresh context warms for three seconds, then measures at least 30 seconds with the real board clock running.

Pairs alternate before/after, after/before, before/after. Stream-only and 500 ms catalog-poll stress have separate three-pair series. The catalog stress changes one folded historical worker's size and mtime and dispatches the normal files event. The timed candidate must commit the latest catalog answer. All six session revisions must equal the emitted revision heads, all 357 cards must remain mounted, the reader must show streamed text, and scrolling must change position.

The visible conversation scroller receives a fixed schedule of 300 signed wheel requests at 100 ms intervals, reversing direction every 30 requests. Requests already more than 100 ms late are skipped and counted. The board remains mounted under the reader. This measures derivation stalls during conversation scrolling; it makes no frame-rate improvement claim.

The timed build wraps existing memo factories in the dashboard, board and band hook. Callback intervals align with the main thread's trace through window marks. The acceptance metric is the union of callback intervals within each browser task, without double-counting nested spans or enclosing renders. GC inside an interval remains included. Both variants use the same probes; the final probe revision records direct intervals and omits redundant per-callback user-timing entries. Window marks still align those intervals with the trace. Ordinary-source CPU profiles independently count the union of named derivation work and all sampled memo factories under the dashboard or board render, including anonymous factories through React’s mountMemo/updateMemo frames. Enclosing render work and GC are reported separately. Sampling is an estimate; the diagnostic intervals supply direct timing. Other browser long tasks are retained separately in the readings.

All heavy commands run sequentially through the installed `scripts/gate-slot.sh`, with isolated HOME, config, temporary and state directories and the closed control URL. The gate grants six CPUs and eight GiB; the ancestor quota is recorded per window. Load and throttled CPU time accompany each result. The fixture server binds port 0 and owns every API response. Browser contexts and servers close in `finally`; the owned runner handles deadline cleanup. Production was not used.

## Evidence files

- `measurements.json`: every final window, corpus/freshness/scroll checks, callback maxima, cumulative crossings, raw profile attribution and CPU observations.
- `equality.json`: full-output and rendered-output hashes, byte counts and unchanged-card identity counts at five checkpoints.
- `verification.json`: explicit touched-test paths, pre-existing assertion disposition and check-log hashes.
- `source-manifest.json`: measured and delivered source hashes and both source variants' bundle hashes.
- `artifact-manifest.json`: hashes and sizes of private traces, CPU profiles, screenshots and full window records.
- `iteration-history.json`: failed and partial measurements of earlier candidates, including the pilot whose wheel loop exceeded 30 seconds. These are development history and do not establish acceptance.

Full traces and profiles remain in private `.artifacts/` directories. The committed records contain bounded measurements and hashes. The fresh candidate frame was inspected directly: the open export reader, streamed text, scrollbar, board header and surrounding navigation render correctly.

## Replay

Use the installed wrapper supplied to the lane as `GATE`, an existing Chromium executable as `CHROME_BIN`, and its browser cache as `PLAYWRIGHT_BROWSERS_PATH`. Create isolated `home`, `config`, `tmp` and `state` directories under an OS temporary root named by `PD_SANDBOX`.

Build the baseline in a plain archive export of the recorded commit, with matching dependencies. Copy this revision's shared fixture and `buildEvidenceFixture.ts` into that export; keep all product modules at the baseline commit. Run the existing builder twice through the wrapper, setting `LLV_DERIVATION_TIMING=0` and `=1`, and point `PD_BASELINE_RAW` and `PD_BASELINE_TIMED` to the resulting fixture bundles. No checkout or branch switch is needed.

```bash
env HOME="$PD_SANDBOX/home" XDG_CONFIG_HOME="$PD_SANDBOX/config" \
  TMPDIR="$PD_SANDBOX/tmp" LLV_STATE_DIR="$PD_SANDBOX/state" \
  LLV_VIEWER_CONTROL_URL=http://127.0.0.1:9 \
  LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN="$CHROME_BIN" \
  PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" \
  DELEGATUS_WORK_SCOPE_CPU_QUOTA=600 LLV_OWNED_RUN_TIMEOUT_MS=1800000 \
  PD_PAIRS=3 PD_TIMED=1 PD_POLL_MS=0 PD_OUT=.artifacts/project-dashboard-timed \
  PD_BASELINE_TIMED="$PD_BASELINE_TIMED" \
  bash "$GATE" bun test src/components/kanban/kanbanBoard.browser.test.tsx \
  --test-name-pattern 'ProjectDashboard derivation'
```

Run each workload in a separate invocation: `PD_POLL_MS=0` for streaming alone and `PD_POLL_MS=500` for catalog stress, with a separate `PD_OUT` for each. Repeat both with `PD_TIMED=0`, `PD_BASELINE_RAW`, and the test pattern `ProjectDashboard derivation keeps derivation` for ordinary-source confirmation. Omitting `PD_POLL_MS` runs both workloads in one invocation, which needs a command lifetime above five minutes. A candidate-only regression can omit the baseline bundle variables; publication measurements include them.

An earlier partial series (`pd-static-timed`) stopped when its third baseline context received no scrolling or live reply. The screenshot and revision records showed a reconnect/resnapshot loop: the silent stream stub outlasted the client's 20-second watchdog during a slow mount. The final series uses the same heartbeat repair on both sides; the failed partial series remains in the development record.

A preceding candidate (`pd-folding`) passed direct timings but its raw-source analysis initially counted only named helpers. Inspecting the enclosing render stacks exposed anonymous memo work above 50 ms. That candidate was rejected; the driver now attributes those memo frames and has a synthetic regression for the undercount. The retained development record gives corrected raw results.

The first merged confirmation completed equality and all six stream windows before its outer command received SIGTERM at approximately five minutes, as the first catalog baseline started. The record retains those completed readings. The final four workload invocations each completed independently through the same gate. In the second ordinary-source catalog candidate, shared host load rose from 6.57 to 20.85; the 31.8-second window delivered 1,207 events, executed 20 catalog polls and observed 26 scroll events, with 265 late wheel requests skipped. Its largest browser task was 1,020.4 ms, with 31.2 ms attributed to derivation; its maximum sampled derivation across all tasks was 38.4 ms. These observations remain in the record, and no frame-rate improvement is claimed.

## Results

All three candidate pairs pass in each series, with zero tasks above 50 ms attributable to derivation. Values are the maximum cumulative derivation time within one browser task; raw values are CPU-profile estimates including anonymous memo factories.

| Pair | Stream memo ms, before → after | Catalog memo ms, before → after | Stream raw sampled ms, before → after | Catalog raw sampled ms, before → after |
| --- | ---: | ---: | ---: | ---: |
| 1 | 51.4 → 12.6 | 89.5 → 27.4 | 98.0 → 17.2 | 76.7 → 10.8 |
| 2 | 123.3 → 11.0 | 68.4 → 10.8 | 73.6 → 14.4 | 157.8 → 38.4 |
| 3 | 81.2 → 20.9 | 84.8 → 36.3 | 59.2 → 15.1 | 97.5 → 12.7 |

| Checkpoint | Cards | Retained card identities | Before/after full-output SHA-256 prefix |
| --- | ---: | ---: | --- |
| initial | 357 | 0 | `6b60cf362e664a8c` |
| clock | 357 | 357 | `6b60cf362e664a8c` |
| size-mtime | 357 | 357 | `8961c3d9976049e0` |
| task-status | 357 | 356 | `1540e9a58d377abb` |
| long-resume | 293 | 293 | `8e35c4f60da69d47` |

Both the complete nine-stage output and rendered card records are byte-equal at every checkpoint, with no timestamp normalization. The task-status edit changes only `task:t-export`; the 72-hour resume expires 64 cards and retains all 293 remaining identities. Full hashes and byte counts are in `equality.json`.

## Verification

Validation: 223 focused tests pass (4,484 assertions); TypeScript passes; changed-file lint reports zero introduced errors. The isolated 37-file touched-test comparison reports zero new failures and 22 pre-existing failures, with no tests removed or skipped. The acceptance driver passes 244 timed/equality/attribution assertions and 192 ordinary-source assertions.

Existing browser coverage: Overview incremental catalog, pipeline graphs/Past attempts, and the cross-project Overview pass. The board geometry case reports the same 14 px horizontal overflow at 640 × 720 in both themes on baseline and candidate; the conversation case reaches the same card-reordering wait timeout on both. Those two failures were replayed independently on the baseline, and historical evidence records were preserved. Local publication privacy passes.


The in-app focus case observes 6 unrelated LogFeed renders on both baseline and candidate; the fresh-tail case observes 3 on both. Both still expect zero. These are pre-existing reader memoization failures, reproduced by explicit test-name selection on each revision; this change leaves their assertions and test file intact.

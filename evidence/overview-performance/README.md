# Incremental Overview catalog

Issue #1838 was reproduced before changing product code on main
`7140fa6739dfd3fb4712878325a8ae19b2e1b8b4`, including the calm cards (#2800)
and newest-work ordering (#2794). The first browser observation recorded eight
changed payloads with long tasks of **567, 276, 242, 405, 418, 417, 450 and
429 ms**. See `step-one.json`.

The final comparison was rerun after merging main
`8f103d02e` and uses the existing kanban browser driver, the real Viewer
components and production stylesheet, and production React bundles. Its invented
catalog contains 194 projects, 1,071 conversations, 1,331 tasks and 1,071 pipelines;
12 workers are active and the remaining history stays in the input. Each update
increments one conversation's size and delivers another `/api/files` answer
through the fixture's normal refresh path. Both versions run sequentially in
one Chromium 153.0.8010.12 process, in fresh 1440 × 900 contexts.

| Measurement, eight changes | Main | Incremental |
| --- | ---: | ---: |
| Longest main-thread task per change | 312.6–517.4 ms | 21.4–33.4 ms |
| Median longest task | 348.4 ms | 30.0 ms |
| Long tasks (at least 50 ms) | 8 | 0 |
| Total blocking time above 50 ms | 2,714 ms | 0 ms |

`readings.json` keeps every sample, rendered board text and each card rectangle.
The text and rectangles match exactly. The two complete viewport screenshots
also match byte for byte (SHA-256
`6eeeea894fa72b02b0e567ee16494975a08127ec8c2c8f063ec50ca5ca0ef9fc`).

`PerformanceObserver` records long tasks. Chrome tracing supplies the longest
main-thread `RunTask` in each one-second observation window, including work below
50 ms. `taskDurationMs` is Chrome's aggregate main-thread work across that whole
window, including polling and unrelated timers; it is not one synchronous stall.
`Date.now` is held constant to compare rendered age labels and isolate changed
payloads from the separate board-clock refresh. Clock expiry is covered by model
tests. These are browser fixture measurements on a production-shaped catalog;
they do not measure the operator's live tab or server latency.

The new case is `Overview incremental catalog` in
`src/components/kanban/kanbanBoard.browser.test.tsx`. Run it by explicit path
through `scripts/gate-slot.sh`, with isolated `HOME`, `XDG_CONFIG_HOME`, `TMPDIR`
and `LLV_STATE_DIR`, and `LLV_KANBAN_BROWSER_TEST=1`. Set `CHROME_BIN` to a wrapper
that gives only Chrome a short owned `TMPDIR`; preserve the real
`PLAYWRIGHT_BROWSERS_PATH` for browser media tools.

For a comparison, set `OVERVIEW_BASELINE_BUNDLE` to the saved baseline browser
bundle. To rebuild that bundle, export the base commit into scratch, copy only
the current `issue1695Evidence.fixture.tsx` there (the added catalog scenario),
install its frozen dependencies in isolation, then invoke the existing
`src/components/kanban/buildEvidenceFixture.ts` builder through the gate. The
baseline bundle used here has SHA-256
`3df8d60645d9b8cd4b50ce7de54c8d8481d5b9995e9bbb917025854c2622d7f2`.
The case retains traces and screenshots under `.artifacts/overview-performance`
and commits its bounded readings under this directory.

Focused verification includes incremental/full-model equivalence, task edits,
project movement and ordering, foreign assignments, unresolved admissions, shared
workers, conversation generations, removals, review findings, seat designation,
clock expiry, and phone/desktop model parity. The existing Overview (#1820) and
calm task-card browser cases pass, including desktop 1440/1000 and phone 390,
English/Ukrainian and light/dark themes where those cases apply. The merged
main's prototype Telegram resend case also passes; the final browser run totals
five passing cases.

The main baseline already fails three other browser assertions: #1695 reports
14 px horizontal overflow at 640 px; newest-work ordering expects old state-line
text; the sidebar/board working-count case expects “5 working” where calm cards
render “5”. The Overview DOM test also expects the former “Assigned”/“Blocked”
labels. These failures were compared with the exported main tree and remain
unchanged; no assertion was relaxed to hide them.

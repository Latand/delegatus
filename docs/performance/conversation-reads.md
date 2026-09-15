# Conversation opening and read performance

Related: #1546, #1444, parent #1432. Base: `e74649a0dc7b56f7048a663d705477f6326eaa53`.

## Changes

- Reviewer resolution builds weakly held identity and membership indexes per immutable file revision. It preserves historical retries, first-match ordering, current-generation selection, archived fallbacks and cross-project membership. Switchboard uses stable empty events, separate structural memoization and an inactive overlay projection; CornerStatus keeps its own live data.
- The dashboard and Kanban share the same complete layout. The worker strip still uses that layout, including historical reviewer decks.
- Speech selection and redaction run once per contiguous answer per feed revision. The cache is local to the conversation/feed and only retains redacted results. Streamed content, engine or conversation changes produce a new resolver. Code-only answers are cached too.
- Catalog search applies registry project ownership before opening transcript heads. Stable scoped projections survive keystrokes; file size, modification time, engine, discovery and ownership revisions invalidate the relevant cache. Every page retains the current title/identity overlay. Cursor continuation reuses its frozen search ordering.
- Browser runtime snapshots opt into voice-body summaries. Every session, pending voice/response ID, receipt and lineage field remains. A voice call hydrates its own bodies before starting; an active call pauses queued output during an uncertain read and retries. Stop during hydration cannot start a later call. Full legacy snapshots remain available; older hosts safely answer the full representation. Full and summary cache entries stay separate, and targeted reads are not retained.
- Browser files reads omit execution input/output and flow specification bodies unused by the board. Full flow/pipeline routes retain them. Visible descriptions, editable prompts, historical records and recovery handles remain complete. Full and summary ETags are isolated.
- Cards sort within their existing columns by the latest observed agent execution among linked workers. A bounded existing transcript-tail parse supplies assistant/reasoning/tool timestamps. User messages, renames, polling, focus, task edits and wall-clock guesses do not advance this value. Unknown/no-work cards sort last; IDs break ties. Sorting changes no stored placement or task status. The existing idle divider only surrounds a trailing idle suffix, so it cannot override chronological order.

## Reproduction

Use the same dependency lockfile for both checkouts. Every test/build runs with private HOME, XDG, provider, state and temporary roots:

```sh
python3 scripts/run-isolated-performance.py bun test src/components/flows/flowModel.test.ts
python3 scripts/run-isolated-performance.py bun scripts/profile-reviewer-lookups.ts
python3 scripts/run-isolated-performance.py bun scripts/profile-catalog-search.ts <checkout> .artifacts/catalog-corpus
python3 scripts/run-isolated-performance.py bun scripts/profile-populated-viewer.ts <checkout> .artifacts/browser-profile
```

Run the last two commands separately against the base and candidate, retaining the same corpus directory for search. The browser harness bundles the actual Viewer with production React and stylesheet, on an ephemeral loopback server. Every application request is answered inside the invented fixture; it cannot send, mutate a live board, or use provider credentials. It exercises 975 files, 321 flows and 1,207 tasks, long histories in both transcript dialects, tool records, catalog updates and appended synthetic output. `same-answer` as the fourth argument retains the adversarial repeated-timestamp case; `cpu` records that case's CPU profile.

## Measurements

The machine ran Chromium at 1600 × 1000. Each browser sample includes five opens and 160 keyboard events. These are small samples, with ordinary host background activity. See `conversation-reads.json` for exact values and separate API wait/parse counters.

| Metric | Base | Candidate |
| --- | ---: | ---: |
| Long Claude, first measured open | 742 ms | 309 ms |
| Long Codex, first measured open | 631 ms | 207 ms |
| Short tool history | 544 ms | 157 ms |
| Warm Claude reopen | 280 ms | 86 ms |
| Warm Codex reopen | 279 ms | 92 ms |
| Input event to next frame, p95 | 104 ms | 26 ms |
| Longest main-thread task, including startup | 588 ms | 116 ms |
| Project query, first call: 8,247 catalog rows, 951 selected | 16,536 ms | 2,048 ms |
| Same project query, second call | 17,709 ms | 119 ms |

Browser open time starts at the actual DOM click, rather than Playwright's actionability/scroll wait. Keyboard enqueue delay uses the browser event timestamp; the subsequent frame timestamp includes render work. Neither is compositor timing. Mock API wait and JSON parsing are separately recorded and can include event-loop contention; they are not deployed server response times.

A separate repeated-timestamp stress corpus caused all 1,000 Claude fragments to belong to one spoken answer. The CPU profile attributed most time to repeated speech normalization/redaction. The same fixture before and after the speech cache went from multi-second opens and a 2,128 ms maximum task to 138–348 ms driver-observed opens and an 89 ms maximum task. Those driver times include Playwright overhead and are not comparable to the DOM-click table above.

The runtime fixture retains 100 sessions with canonical voice output: full JSON is 1,352,506 bytes; summary JSON is 105,906 bytes. Targeted bodies match the complete original session, and the journal remains unchanged. This establishes projection size and compatibility, not production runtime latency.

A bounded read-only projection comparison found the existing files representation was 7,270,599 bytes; removing only unused execution bodies produces 6,495,872 bytes. Local parsing took 33 ms and summary transformation/serialization 50 ms. This is a projection estimate over the same response, not a deployed endpoint benchmark.

## Verification and limits

- Production build and TypeScript pass. Focused tests cover historical bindings/current identity, search scope and invalidation, summary/full ETag isolation, voice hydration/pause/cancel, journal preservation, streaming speech revisions, and activity ordering.
- The expanded safety run reproduced seven existing failures in `TmuxComposer.runtimeSnapshot.dom.test.tsx` and 28 in `LogFeed.deliveryUncertainty.dom.test.tsx`, with identical failure names on the untouched base. No new failures appeared in either file. A combined DOM run also exposed shared-test-environment interference; the reader file passes independently on both revisions.
- ESLint cannot load the installed React rule under ESLint 10 (`getFilename` is unavailable). The identical invocation fails on the untouched base. Lint is unverified; no dependency changes are included.
- Warm opens used one animation-frame callback but still took 86–92 ms. This does not meet a 16 ms frame budget. Some interaction tasks still exceeded 100 ms; the largest was 116 ms. Cold client opens meet 500 ms in this fixture; production cold latency remains unverified.
- The files response is still 6.50 MB. Further reduction needs explicit summary/detail types and editor hydration for visible task descriptions, stage prompts and round notes. Truncating those fields here would change copy/edit behavior or risk saving an incomplete body. Historical membership and recovery evidence were retained.
- Runtime body reduction requires the updated runtime host. An older host returns full snapshots safely. Voice payloads and receipt recovery were tested with synthetic data; no real voice/provider operation or production lifecycle action ran.
- No deployment, live load test, restart, lock reset, board cleanup, transcript deletion or operator-browser mutation occurred.

## Integration review

Open work requiring an explicit combined review includes #1677 (dashboard, files and catalog routes), #1667/#1689 (dashboard, composer, runtime contracts/model/journal), #1670 (layout dependency), #1714 (pipeline types) and #1652 (composer recovery). No changes from those branches were adopted. Review both the actual-work sort and speech cache, as well as summary compatibility and original receipt recovery. Root owns merge/deployment and production qualification after review and green gates.

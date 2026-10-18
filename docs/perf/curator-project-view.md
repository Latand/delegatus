# Curator project-view replay (L4)

The retained-pass scope-history multiplier is removed. `curationView` reads
scope rows once, aggregates receipts by pass and timestamp in one history walk,
and retains the single-pass `readPass` path. Duplicate receipts preserve the
previous last-scope-wins result, including reverted receipts and missing-history
fallbacks.

`projectView` selects its scopes and rule/task lineage before decoding rule
payloads, builds the rule and per-scope maps in one pass, and shares immutable
rendered data through one `globalThis` owner across server bundles. Its LRU
holds at most 16 views and 8 MiB of serialized view data. Oversized views are
returned without being retained. Keys include database identity, role-memory
and curation revisions, project aliases, installation memory choice and curator
settings. Peer commits and independent settings files are checked before reuse.
Connection-relative version tokens and the reader generation have the same
shared owner as the reads.
Freshness boundaries expire the view; `nextAt` advances on each answer.

The HTTP response and `readCuration` are the production consumers of this view;
both read nested data. The returned top-level timing wrapper is fresh and nested
view data is frozen. `readCuration` reads its scope directly and selects the
same role's comparison rules without cloning the collection. Scope succession
keeps its transaction and write logic: the discovery census now reads scope
keys. Its producers remain lesson insertion/rewrite, operator delete/restore/
revert, curator apply/undo and the project view. No schema or persisted wire
shape changes. Caller resolution and `attentionCallerSources` remain for L3.

The operation is labelled `role-memory.view`; synchronous view work records
`memory.project-view`, including failures. HTTP and curator reads use the
cooperative refresh path. SQLite projects only the view fields from each scope
row, and the history iterator decodes at most 16 entries or 12 ms of synchronous
work before yielding. The response is assembled after all slices finish, and a
revision change during refresh refuses the mixed snapshot.

## Input and procedure

The baseline is `7ef6d95aa4e94d7e66bae87de7e8dcf24580d72a`. The implementation file hashes, copied
input digest, individual observations, all load averages and exact query plans
are in [the evidence record](../../evidence/curator-project-view.json).
The copy contains 3,947 role-memory rows (16,474,850 UTF-8 bytes), including 112 scope rows (13,180,030 bytes).
The four hot projects retain 12, 17, 23 and 50 passes. The target has 200 active
rules; its largest scope has 42. The input stays local. A later production
snapshot has a different digest and is a separate measurement.

Use the `probe.ts`, `profile-view.ts view` and read-only copy procedure in
[the audit](main-thread-blocking-audit.md#m4-replays-on-scratch-copies) with source
exports of the baseline and candidate. Copy the frozen input separately for
every case and phase. Both exports use the same dependency graph and Bun 1.4.0.
Run through the project's gate slot, with HOME, XDG_CONFIG_HOME, TMPDIR,
LLV_STATE_DIR and CODEX_HOME isolated and the Viewer control URL on a closed
local port. No probe connects to the serving installation.

Run `H8`, `D6-overview` and `D6-scope-read` six times, `role-projects` eight
times (four projects twice), and `profile-view.ts view` in two fresh processes.
The original H8/D6 readiness factory first runs `roleTarget`, which warms the
views. `role-projects` explicitly measures first reads too. Those original
measurements use the synchronous helper. Production HTTP and curator consumers
now use the yielding refresh measured separately below.

## Original audit probe

The original probe's wall clock brackets the application call. Its timer-gap
window also includes two synchronous `heapStats()` inspections. These native
inspections can outlast a memo hit by tens of milliseconds. Keep those raw
observations visible:

| Case | Before wall, ms | After wall, ms | Largest raw after timer gap, ms |
| --- | ---: | ---: | ---: |
| H8 | 4377.22–5319.66 | 0.246–0.270 | 15.76 |
| D6-overview | 4025.79–4352.12 | 0.663–1.463 | 36.00 |
| D6-scope-read | 4010.29–4600.75 | 24.100–78.743 | 94.60 |
| role-projects | 816.25–4051.10 | 0.269–323.348 | 334.57 |

Raw before one-minute load: 6.95–7.94.

Raw after one-minute load: 5.12–5.59.

The evidence also retains a superseded candidate replay at load 17.62–19.54
in `exploratoryReplay`. Its raw gaps exceeded the budgets while its H8 call
stayed below 0.9 ms. That diagnostic run includes the heap inspections; it
is excluded from final implementation claims. The corrected replay below
isolates timer delay around the application call.

## Loop-budget replay

Repeat H8 and D6-scope-read six times on fresh copies of the same input for
both revisions. Preserve every case factory. In the audit probe's measurement
loop, reset `maxGap` and `last` immediately after the pre-call heap/IO inspection
(`last = started`). Capture `maxGap` immediately after the existing 80 ms timer
settlement and before the post-call heap inspection. Move that inspection
after the capture. Record its duration separately as `helperAfterMs` and the
pre-call inspection as `helperBeforeMs`. Wall timing, the case work, the 10 ms
timer and the 80 ms settlement are unchanged.

| Case | Before wall, ms | After wall, ms | Before timer gap, ms | After timer gap, ms |
| --- | ---: | ---: | ---: | ---: |
| H8 | 4186.78–6383.68 | 0.237–0.282 | 4184.19–6376.58 | 0.077–0.163 |
| D6-scope-read | 4350.35–5171.76 | 20.485–49.333 | 4348.67–5171.84 | 10.535–19.822 |

Occupancy before one-minute load: 10.92–12.74.

Occupancy after one-minute load: 3.68–3.92.

These observations meet the measured H8 50 ms and scope-read 100 ms loop
budgets and the unchanged-view 1 ms budget. They describe these copied inputs
and recorded loads. They do not bound scheduler delays on another machine.

## Previous synchronous candidate: first reads and profiles

| Retained passes | Before first / second view, ms | After first / memo view, ms |
| --- | ---: | ---: |
| 17 | 1312.88 / 1118.19 | 236.18 / 0.272 |
| 50 | 3878.63 / 4051.10 | 323.35 / 0.269 |
| 12 | 905.97 / 816.25 | 220.29 / 0.283 |
| 23 | 1470.15 / 1472.80 | 217.78 / 0.269 |

The two before profiles put thousands of samples in `curationView` and
`readPass`. Each after profile contains one sample and no
`curationView` sample: the warm operation is shorter than the 1 ms sampling
interval, so the profiles cannot resolve its remaining work. The candidate
first-read results exposed the refresh gap fixed in this review round; the
current production consumers use the yielding path measured next.

## Cold and revised production refresh replay

The replay exercises the current async production path in three fresh Bun
processes with independent isolated state. Each process creates the same
deterministic fixture: 112 scopes, 200 active rules, 50 retained curator passes
and 15,245,443 bytes across the scope rows. The fixture's logical input digest
is `720c7f6a220c35d67560eebdab2a84a1972e9a78619e818b096d4446891d3848`.
H8 first reads the cold view, then measures an unchanged-revision hit. D6 reads
the overview and the largest scope. Three real `boundedPatch` scope revision
bumps then measure H8 refreshes and D6 scope reads at the new revisions. A 10 ms
timer records its largest delay through an 80 ms settlement after each call;
reported wall time brackets the application read only. Load averages are
recorded with each sample; the three runs ranged from 6.19–7.13 (1 min),
5.96–6.18 (5 min), and 5.87–5.95 (15 min). Bun was 1.4.0.

| Read | Wall time, ms | Largest timer gap, ms |
| --- | ---: | ---: |
| H8 cold first read | 73.54–127.53 | 6.21–17.57 |
| H8 unchanged revision | 0.31–0.62 | 0.10–0.14 |
| H8 after scope revision | 65.67–127.57 | 8.54–29.27 |
| D6 overview, warm | 1.89–4.07 | 0.09–1.07 |
| D6 scope, warm | 14.79–31.57 | 4.80–21.59 |
| D6 scope after scope revision | 70.39–126.79 | 6.54–22.42 |

All measured timer gaps meet H8's 50 ms limit and D6 scope-read's 100 ms limit.
Unchanged H8 reads remain below 1 ms. Cold and revised wall times include
yields between history slices; the loop remains available during that work.
Per-run timestamps, loads and repetitions are retained in the evidence record.
These generated-fixture runs measure refresh behavior and use a different
input from the frozen copy used for the original before/after table.

Queries use the existing `(collection, row_key)` index to restrict native
selection to scope keys, rule rows or request rows before returning selected
keys. Scope/rule identities and task lineage remain live reads on a cache miss;
this change introduces no persistent secondary index. Exact EXPLAIN plans,
including singleton and duplicate multi-value scope binds, are retained.

## Compatibility and verification

At a frozen clock, four project views and 24 curator pages from the original
implementation compare deeply equal to the candidate, including all pages of
the largest scope. Existing curation fixtures cover moves, rewrites, split
cutoffs, Undo, succession, task counts, stale cursors and refusal paths.

`src/lib/memory/roleView.test.ts` counts role-memory rows returned by real
collection reads: five to fifty retained passes leave this count unchanged;
ten to one hundred unrelated rules do too. Both samples invalidate the summary
cache. Pass metadata and the returned pass list still grow with the requested
history; scope payload decoding has no per-pass multiplier. Separate tests cover
zero-decode memo hits, both eviction bounds, independently loaded modules,
peer-process writes and restarted reads, freshness, settings, hostile role
filters, failed refreshes and monitoring. The foreign-ancestor succession
regression failed on the first candidate, passed on the baseline, and passes
on the final implementation.

Run only the touched paths, through the gate slot in isolated state:

```sh
bun test src/lib/memory/roleView.test.ts src/lib/memory/roleStore.test.ts src/lib/memory/curation/curation.test.ts
bun test src/lib/performanceSpans.test.ts src/lib/viewerLoopMonitor.test.ts
node --max-old-space-size=6144 node_modules/typescript/bin/tsc --noEmit --incremental false
```

All 116 memory tests and 18 monitor/span tests passed. The full type check
passed with the CI heap budget. Tests and the type check ran in scratch exports
with isolated state.

Publication uses the enabled repository hooks and the privacy publication gate.
The required hosted contexts remain `typecheck`, `privacy-publication`,
`privacy-tracker-audit` and `runtime-gate`. Hosted checks require publication;
this delivery retains the instruction to commit locally without a push.

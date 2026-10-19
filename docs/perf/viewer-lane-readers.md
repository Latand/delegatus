# Viewer readers under open-lane load

This change addresses the first three causes ranked by the 2026-10-19
diagnosis: repeated curator history reconstruction, registry projections, and
full pipeline reads during idle retirement. The remaining seat/card work,
registry write admission, and unscoped pipeline mutations remain separate
work. The controller keeps its four-lane selection limit and yields before admission,
then captures current work. This keeps the caller's reader burst separate from
the first selected lane.

## Contracts and callers

| Path | Producers and authority | Consumers and retained behavior |
| --- | --- | --- |
| Curator passes | `claimPass`, `patchPass`, and the scope-history writes in `applyCuration` | Launch, recovery, caller guards, apply admission, reconciliation, and startup placeholder cleanup read pass metadata. Display reads still reconstruct counts from history when their source revisions change. Settlement obtains reconstructed counts for its report. Undo continues to read history. |
| Registry selection | Existing registry writers, normalization, generation indexes, receipt state indexes, liveness projections, and conversation aliases | Startup selects memberships for the structured hosts and pending spawns in its row scope, including aliases. Retirement selects candidate hosts, their conversations, open receipts and undelivered messages. Conversation selection preserves collection order; session keys include the engine. |
| Pipeline evidence | Existing hot/archive writers, raw SQL and older writers observed by the existing evidence triggers | Startup and retirement share the compact snapshot reader. The added revision index selects changed identities, including deletion tombstones. Existing snapshots retain their previous values. No pipeline payload format changes. |
| Idle termination | Existing operation claim, native provider-turn proof, registry custody and signal ladder | Asynchronous preparation validates all hot/archive ownership. Every signal rechecks the prepared version and target identities. Provider recovery exempts only its freshly proven attempt; publication, source owners and other attempts retain custody. Unknown evidence defers termination. |

The curator count cache has one process-wide owner, an LRU limit of 32 entries
and a 512 KiB budget. It retains counts and source stamps. Database identity,
scope revision, curator metadata revision and project aliases invalidate it.
Authority reads bypass this derived cache.

Retirement retains compact claims for at most two state roots, each limited to
16 MiB. Preparation yields between approximately four-millisecond slices.
Unchanged reads reuse the projection; changed rows alone are decoded. Updating
a snapshot still copies compact references and rebuilds the target index in
yielding slices. That work scales with retained compact claims; it does not
copy historical pipeline payloads. The synchronous signal fence checks the
source version and matching target claims. Its version connection shares the
cache's process-wide lifetime across compiled bundles.

## Replay procedure

Run `scripts/replay-viewer-readers.ts` from scratch exports of the base and
candidate. Copy the same driver into the base export. Keep the exports'
dependency graphs identical, and run each command through
`scripts/gate-slot.sh` with private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and
`LLV_STATE_DIR`, `NODE_ENV=test`, plus `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`.
Use a freshly created empty state root for each command.

```sh
bash scripts/gate-slot.sh bun scripts/replay-viewer-readers.ts 15 before
bash scripts/gate-slot.sh bun scripts/replay-viewer-readers.ts 15 after
bash scripts/gate-slot.sh bun scripts/replay-viewer-readers.ts 30 before
bash scripts/gate-slot.sh bun scripts/replay-viewer-readers.ts 30 after
```

Each process generates 274 hot and 980 archived pipelines, sixteen attempts
per pipeline, 100 scope histories, 50 curator passes, and 4,000 registry
conversations, entries, memberships and receipts. It records cold reads and
six measured passes. Each pass combines curator and registry readers with a
controller tick, a one-row progress update, and archive insertion/deletion.
The timer observer remains active through a post-work callback. The candidate
refuses p95 loop delays over the complete cold/warm observation window above
50 ms, maximum delays above 500 ms, missing timer
samples, or more than four controller pipeline copies.

The output includes corpus digests, source fingerprints, interpreter version,
UTC bounds, CPU/memory cgroup limits, machine load, decode bytes, payload reads,
copy counts and loop-delay distributions. The registry-startup observation
compares the old membership enumeration with the production selector. External
controller ports are deterministic fixtures; these results establish the
synthetic replay bounds. Production acceptance still requires observation of
the deployed revision under live load.


## Recorded results

The final replay ran on 2026-10-19, 08:23:48–08:24:47 UTC, under Bun 1.4.0.
Each side used identical corpus, registry and dependency digests at its lane
count. The data contains approximately 166.94 MB of pipeline JSON and 14.32 MB
of role-memory scope JSON. The owned command had a three-CPU quota and an
8 GiB memory limit on a 24-CPU machine. Full load samples, limits, source and
driver fingerprints, cold observations and six passes per side are in
`evidence/perf/viewer-lane-readers.json`.

| Open lanes | Before p95 / max loop delay | After p95 / max loop delay | Selected pipelines per tick |
| --- | --- | --- | --- |
| 15 | 1243.4 / 1925.6 ms | 36.6 / 264.4 ms | 4 on all six passes, both sides |
| 30 | 1364.1 / 1943.9 ms | 40.0 / 253.4 ms | 4 on all six passes, both sides |

The p95 uses every recorded interval across the cold observation and six
passes. Per-pass tails remain in the artifact; cold setup and fingerprinting
are outside measurement. The first controller pass is observed.

| Repeated reader, median wall time | 15 lanes before / after | 30 lanes before / after |
| --- | --- | --- |
| Curator authority | 77.43 / 0.60 ms | 71.52 / 0.67 ms |
| Curator display counts | 69.53 / 0.78 ms | 68.85 / 0.66 ms |
| Registry retirement | 52.73 / 2.90 ms | 57.68 / 3.79 ms |
| Startup membership selection | 17.55 / 31.44 ms | 16.72 / 37.95 ms |
| Idle-retirement ownership | 401.43 / 0.40 ms | 472.98 / 0.52 ms |
| Ownership after one pipeline edit | 409.50 / 7.78 ms | 433.66 / 7.19 ms |
| Archive insert/delete and ownership checks | 823.58 / 19.02 ms | 939.59 / 17.83 ms |

Authority reads decode 473 bytes of pass metadata on each repeated call,
versus 14,317,348 bytes before. A fresh ownership check decodes no pipeline
payload after preparation; a single progress edit refreshes one 132,871-byte
row. The old complete reader materializes all 1,254 pipeline rows per check.
The `rawDecodedBytes` field counts the compact visitor's instrumented sites;
its zero on the old full reader does not mean that reader decoded nothing.

Startup's warm membership selection has a higher median in this fixture.
Its gain is limited to avoiding unrelated membership payloads and repeated
historical attempt resolution. No warm-startup speedup is claimed. Controller
payload work remains bounded by four selected rows, with a 531,619-byte maximum
in these passes; cache hits reduce decoding when selected rows repeat.

## Verification

The Node TypeScript check passed. Explicit-path comparisons for curator,
registry-reader, retirement, and evidence-index tests introduced no failures.
The comparator reproduced two base failures: the curator fixture's helper
cleanup and the synchronous-initialization contention assertion. The separate
production termination callback file passed all 42 cases.

The runtime-host rehearsal under Bun 1.4.0 completed succession in 507 ms and
answered 27/27 stable-listener and 27/27 runtime-socket probes over 15 seconds.
It used private state and ephemeral endpoints.

The final pre-push gate passed on the committed source: privacy, TypeScript,
changed-file ESLint, touched tests, Linux backend and Linux tests. Its touched
comparison sampled the six failing files on base `f090bde7` and reported zero
new failures, 37 pre-existing failures and no flaky cases. Those baseline
failures include spawn/connector fixtures, curator helper cleanup, a CPU-ticket
fixture, startup fixtures and the synchronous-initialization assertion. The new
scheduler checkpoint case and both new reader test files introduced no failure.
TypeScript completed in 237 seconds; the touched comparison in 153 seconds.
Every check used private state, home, config and temporary roots and a closed
Viewer control port.

The final gate command was `bash scripts/gate-slot.sh bun
scripts/local-gate.ts pre-push`, executed from a scratch copy of the commit;
its origin was the publication remote. No push or deployment was performed.


Main advanced during verification. Its additional loop-monitor label shared a
line with this branch's type union addition. Relocating this branch's label
removes that textual conflict. The artifact records measured and final source
fingerprints and a byte-identical Bun-transpiled JavaScript digest for that
file; all other production source bytes match the replay. This final type-only
edit cannot change the measured runtime work.

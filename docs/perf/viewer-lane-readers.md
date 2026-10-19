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

The final replay ran on 2026-10-19, 12:46:39–12:47:34 UTC, under Bun 1.4.0.
Each side used identical corpus, registry and dependency digests at its lane
count. The data contains approximately 166.94 MB of pipeline JSON and 14.32 MB
of role-memory scope JSON. The owned command had a three-CPU quota and an
8 GiB memory limit on a 24-CPU machine. Full load samples, limits, source and
driver fingerprints, cold observations and six passes per side are in
`evidence/perf/viewer-lane-readers.json`.

| Open lanes | Before p95 / max loop delay | After p95 / max loop delay | Selected pipelines per tick |
| --- | --- | --- | --- |
| 15 | 1200.3 / 1366.7 ms | 38.8 / 343.6 ms | 4 on all six passes, both sides |
| 30 | 1217.9 / 1748.6 ms | 25.7 / 254.6 ms | 4 on all six passes, both sides |

The p95 uses every recorded interval across the cold observation and six
passes. Per-pass tails remain in the artifact; cold setup and fingerprinting
are outside measurement. The first controller pass is observed.

| Repeated reader, median wall time | 15 lanes before / after | 30 lanes before / after |
| --- | --- | --- |
| Curator authority | 55.28 / 0.62 ms | 72.37 / 0.53 ms |
| Curator display counts | 49.80 / 0.86 ms | 58.52 / 0.73 ms |
| Registry retirement | 43.40 / 2.73 ms | 54.16 / 3.43 ms |
| Startup membership selection | 12.58 / 37.24 ms | 17.36 / 26.76 ms |
| Idle-retirement ownership | 349.25 / 0.42 ms | 473.77 / 0.26 ms |
| Ownership after one pipeline edit | 378.98 / 9.62 ms | 390.45 / 4.43 ms |
| Archive insert/delete and ownership checks | 757.86 / 21.35 ms | 763.27 / 11.10 ms |

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

After merging main `9cda6155`, the explicit startup test ran separately on
both revisions in identical isolated environments. The candidate completed
149 cases with 146 passes and three failed assertions. Main completed 149
cases with 144 passes and five failed assertions. All three candidate failures
also failed on main; neither run emitted a between-tests error. The candidate's
historical-host fixture completed within its explicit 30-second timeout and
closed its registry in `finally`.

The runtime-host rehearsal under Bun 1.4.0 completed succession in 508 ms and
answered 27/27 stable-listener and 27/27 runtime-socket probes over 15 seconds.
It used private state and ephemeral endpoints.

The replay measurements above were regenerated after the merge. The artifact
records the archived candidate tree and its complete production-source digest;
both candidate runs have the same source digest. Each lane count has matching
corpus, registry, driver and dependency digests across the two sides. Later
report and artifact edits change no production source.

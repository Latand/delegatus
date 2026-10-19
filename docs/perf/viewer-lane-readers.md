# Viewer readers under open-lane load

This change addresses the first three causes ranked by the 2026-10-19
diagnosis: repeated curator history reconstruction, registry projections, and
full pipeline reads during idle retirement. The remaining seat/card work,
registry write admission, and unscoped pipeline mutations remain separate
work. The ordinary controller's four-lane selection limit is unchanged.

## Contracts and callers

| Path | Producers and authority | Consumers and retained behavior |
| --- | --- | --- |
| Curator passes | `claimPass`, `patchPass`, and the scope-history writes in `applyCuration` | Launch, recovery, caller guards, apply admission, reconciliation, and startup placeholder cleanup read pass metadata. Display reads still reconstruct counts from history when their source revisions change. Settlement obtains reconstructed counts for its report. Undo continues to read history. |
| Registry selection | Existing registry writers, normalization, generation indexes, receipt state indexes, liveness projections, and conversation aliases | Startup selects memberships for the structured hosts in its row scope, including aliases. Retirement selects candidate hosts, their conversations, open receipts and undelivered messages. Conversation selection preserves collection order; session keys include the engine. |
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

```sh
bun scripts/replay-viewer-readers.ts 15 before
bun scripts/replay-viewer-readers.ts 15 after
bun scripts/replay-viewer-readers.ts 30 before
bun scripts/replay-viewer-readers.ts 30 after
```

Each process generates 274 hot and 980 archived pipelines, sixteen attempts
per pipeline, 100 scope histories, 50 curator passes, and 4,000 registry
conversations, entries, memberships and receipts. It records cold reads and
six measured passes. Each pass combines curator and registry readers with a
controller tick, a one-row progress update, and archive insertion/deletion.
The timer observer remains active through a post-work callback. The candidate
refuses p95 loop delays above 50 ms, maximum delays above 500 ms, missing timer
samples, or more than four controller pipeline copies.

The output includes corpus digests, source fingerprints, interpreter version,
UTC bounds, CPU/memory cgroup limits, machine load, decode bytes, payload reads,
copy counts and loop-delay distributions. The registry-startup observation
compares the old membership enumeration with the production selector. External
controller ports are deterministic fixtures; these results establish the
synthetic replay bounds. Production acceptance still requires observation of
the deployed revision under live load.

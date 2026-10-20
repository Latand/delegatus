# Keyed registry recovery

Relay recovery used to enumerate every held delivery and retained operation
owner before comparing the message key. Cold owners retain command bodies and
normalize against their reservation; the existing 128-row reader cache could
not hold the production history. Every unchanged request decoded that history
again. The persisted board-summary bootstrap already avoided these reads.

## Selection and bounds

`deliveryRegistryEntriesForKey` selects keys through the process-shared registry
readers, intersects them with the recipient's alias identities, then hydrates
the matching rows. The maximum is 256 matching rows per collection. An excess
refuses recovery before command hydration; the relay reports unavailable
evidence. There is no additional payload cache, retained projection or eviction
policy. SQLite remains the owner of the indexed data, and the existing reader
maps on `process` work across Next server bundles.

Both relay admission and `lookupOriginalSend` use this selection. The latter
still checks the original recipient, sender, command, payload, retry ownership
and redirect chain. A former seat's recovery reuses the result already verified
in the same synchronous decision. It does not repeat settlement selection.

Four partial expression indexes cover `clientMessageId` on held deliveries and
operation owners, in the current and archive tables. The existing cooperative
preparation installs them through asynchronous writer admission. Each distinct
lookup value gets a separate index seek, avoiding a multi-value ordering plan
that scans retained history. No persisted row fields, defaults, serialization,
retention rules or write contracts change. Existing reservation, direct-send,
retry and compaction writers maintain the indexes through ordinary SQL writes;
older readers keep their compatibility rows.

The next registry view observes peer key, recipient and disposition changes.
Already-issued immutable views retain their cut through the existing change
journal, including the new key selector for archived owners and deliveries.
Tests cover hot rows, archived rows, peer edits, reader reopen, alias recipients,
misses, unrelated recipients, over-budget refusal and query plans.

## Authority and optional memory

One authority decision canonicalizes each revocation once. Alias resolution
uses the existing alias-only registry method. Conversation facts select only
supersedence, generation presence, project ownership and launch directories;
they do not hydrate launch profiles or grant lists. These reads set a zero busy
timeout and use state admission's deferral signal, preserving an existing
transaction and restoring its timeout. Generation, project, revocation and
supersedence changes take effect on the next decision.

The memory hook hashes operation keys before loading the one command matching
a structured delivery token. An unproven native prompt reads only its own
conversation's evidence. A relay prompt needs evidence across conversations;
each evidence collection is capped at 256 rows before hydration. Above that
bound optional memory injection is skipped because authorship remains
unproven. The existing compaction and 200-owner completeness checks remain.
The bound also applies after a fresh process starts.

Monitoring uses fixed operation and phase labels: `registry.delivery-key`,
`orchestrator.relay-recovery` / `relay.select`, `orchestrator.authority` /
`authority.facts`, and `memory.delivery-evidence`. The loop-gap and performance
summary log formats remain unchanged.

## Reproducing the measurements

`scripts/profile-registry-reads.ts` runs against an isolated copy marked by
`.registry-read-profile-copy`. Prepare copies of the registry and state
databases with SQLite's read-only `VACUUM INTO`, together with the seat, project
alias, scan-snapshot and summary-bootstrap artifacts. Keep the same original
copies for each arm. Use isolated HOME, XDG_CONFIG_HOME, TMPDIR and state roots,
`LLV_STAGING=1`, the SQLite backend, and
`LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. Run through `scripts/gate-slot.sh`:

```sh
bun scripts/profile-registry-reads.ts --routes
```

Copy the identical driver into an export of the comparison revision. The
driver prepares the snapshot, exercises three relay and authority decisions,
then measures six paired polls across a real minute. The optional route pass
renders Home with React's server renderer and invokes the saved-summary HTTP
handler without running its deferred refinement. Assertions require a populated
seat, authorized manager, resolved recipient, successful bootstrap response and
nonempty HTML. No transport dispatch or live Viewer call occurs.

Output contains aggregate decode counts and bytes, CPU time, host load, the
available CPU count, corpus counts and the share of the minute occupied by
timer gaps over the Viewer's 500 ms threshold. Per-minute values use the
declared six-poll workload. These are scratch replay measurements, independent
of production request rates. Raw databases and request contents stay private.
Sanitized paired results are recorded in
`evidence/registry-keyed-recovery/readings.json`.

The 2026-10-20 replay used 63,624 retained rows, including 14,147 operation
owners. The comparison revision was `f335de650`; both arms used Bun 1.4.0
and three available CPUs. Across two fresh processes per arm:

| Unchanged operation | Base decodes / call | Base bytes / call | Candidate decodes / bytes |
| --- | ---: | ---: | ---: |
| Relay recovery, missing key | 14,137 | 134,666,033 | 0 / 0 |
| Manager authorization | 728 | 1,193,942 | 0 / 0 |
| Home HTML | 0 | 0 | 0 / 0 |
| Saved summary | 0 | 0 | 0 / 0 |

Six combined relay and authorization polls decoded 89,190 rows and
815,159,850 bytes per minute on the base, and zero on the candidate. All
polling samples had complete attribution. Home and saved-summary measurements
cover three repetitions per route pass. They do not measure cold refinement
or a complete browser navigation.

The two base polling windows spent 8.39% and 9.02% of their minute in gaps
above 500 ms; both candidate windows recorded zero. Maximum measured timer
gaps were 864 / 1,086 ms on the base and 110 / 115 ms on the candidate.
One-minute host load ranged from 6.21–11.00 on the base and 7.48–12.40 on the
candidate. These ranges describe the external load during the same polling
workload; elapsed times also include scheduling noise and garbage collection.

## Verification

The isolated 29-file selection passed the hook's `local-gate-tests.ts` runner:
zero new failures, six failures also present on the base, and one timing case
that passed on rerun. The selection includes the new bound and invalidation
tests, native memory controller, relay HTTP/MCP recovery, send settlement,
archived reader consistency and both monitoring record formats. The readings
artifact records the explicit test paths and comparison revision.

`bun node_modules/typescript/bin/tsc --noEmit`, changed-file
`scripts/eslint-changes.ts`, and `bun run privacy:check` all passed through the
gate-slot wrapper. Tests and checks used a scratch source export and isolated
state. No live service mutation or deployment was part of verification.

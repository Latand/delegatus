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
operation owners, in the current and archive tables. Two additional partial
indexes on current rows pair `clientMessageId` with `conversationId`. Recovery
uses that compound index to seek each message key and the recipient or alias
identities together, so unrelated owners sharing a popular key are not
examined or JSON-extracted. The existing cooperative preparation installs the
indexes through asynchronous writer admission. No persisted row fields,
defaults, serialization, retention rules or write contracts change. Existing
reservation, direct-send, retry and compaction writers maintain the indexes
through ordinary SQL writes; older readers keep their compatibility rows.

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

The refreshed 2026-10-20 replay used 64,202 retained rows, including 14,272
operation owners. It compared `8ff233dc` with the final candidate source
digest recorded in `evidence/registry-keyed-recovery/readings.json`. Both arms
used Bun 1.4.0 and three available CPUs. Each arm ran in two fresh processes
from independent copies of the same captured databases and artifacts:

| Unchanged operation | Base decodes / call | Base bytes / call | Candidate decodes / bytes |
| --- | ---: | ---: | ---: |
| Relay recovery, missing key | 14,264 | 136,187,714 | 0 / 0 |
| Manager authorization | 724 | 1,187,314 | 0 / 0 |
| Home HTML | 0 | 0 | 0 / 0 |
| Saved summary | 0 | 0 | 0 / 0 |

Six relay and authorization polls decoded 89,928 rows and 824,250,168 bytes
per minute on the base, and zero on the candidate. The warm per-poll totals
were 14,988 rows and 137,375,028 bytes on the base. All polling samples had
complete attribution. Home and saved-summary measurements cover three
repetitions per route pass. Both remained at zero registry decodes on both
arms. They do not measure cold refinement or a complete browser navigation.

The two base polling windows spent 10.15% and 13.92% of their minute in gaps
above 500 ms; both candidate windows recorded zero. Maximum measured timer
gaps were 1,266 / 1,870 ms on the base and 77 / 72 ms on the candidate. The
recorded one-minute load averages ranged from 6.89–18.35 and 10.00–17.22 in
the base arms, and 9.20–17.88 and 8.67–16.96 in the candidate arms. These
ranges describe the external load during the same polling workload; elapsed
times also include scheduling noise and garbage collection.

## Verification

The original task's isolated 29-file selection passed before this review fix.
For this round, the hook comparator reported a green head for
`deliveryKeyReads.test.ts` with no baseline checkout required; its focused run
passed seven tests and 86 assertions. `viewerLoopMonitor.test.ts` also passed
all ten tests and 52 assertions, preserving the loop-gap and performance
summary records. Typecheck, changed-file lint and privacy passed on the review
fix. The readings artifact records these commands and the earlier 29-file
result separately.

Tests and checks used isolated HOME, config, state and temp roots through
`scripts/gate-slot.sh`. Measurement databases were read-only copies; no live
service mutation or deployment was part of verification.

# Recorded check capacity

A handoff waits for native custody capacity for up to 30 seconds, bounded by
the producer's original monotonic deadline. A still-full queue answers
`status: waiting`, `retryable: true` and a bounded list of holders in the
caller's project. Retry the same ticket with a fresh request identity within
its original deadline. A waiting answer grants no custody and keeps the stage
running. Replaying an earlier request continues to return its original answer.

## Observation before the change

The admission guard in `src/lib/recordedChecks/store.ts` counted every active
ledger row: 128 globally and four per launch. Removal required acknowledgement
and settled notification delivery. Completed checks without acknowledgement,
and checks whose producers had disappeared, continued to consume admission
capacity.

On 2026-11-03, before changing source, a SQLite connection opened with
`mode=ro` and `PRAGMA query_only=ON` found:

| Record | Count |
| --- | ---: |
| `recorded_checks` | 128 |
| Acknowledged rows still awaiting delivery settlement | 6 |
| Settled producer receipts | 37 |
| Abandoned entries | 91 |
| Held `recorded_check_roots` rows | 237 |
| Entries with held roots | 122 |

Settled means a retained close report confirmed cleanup, or the recorder
proved dispatch never started. The remaining entries had no surviving recorder
or wrapper identity. Kernel process identities were checked alongside the
persisted host, recorder and wrapper identities; no live producer held these
slots. Receipt prefixes `4e5e48018039` and `00a0da9acf54` belonged to the
abandoned review in lane `80011b0c`; `0439e06f5f4a` was a settled build receipt
in lane `44b4c852`. The investigation performed no live-state writes.

## Admission and retention

`recorded_check_slots` owns the 128 global and four-per-launch admission bounds.
Its initial creation copies the existing ledger under one immediate SQLite
transaction. Reopening a store never reseeds released slots. Before refusing a
full admission, the writer checks at most 128 slot holders and releases entries
whose retained terminal proof confirms completion, or whose recorded native
owners are all proved unable to run. An elapsed deadline or missing identity
proof alone never releases a slot.

Slot release changes no receipt, result, replay key, delivery obligation or
evidence-root hold. Acknowledgement still requires the current retained result
and evidence revision. This also preserves unknown and failed outcomes without
crediting them as successful checks. Indexed launch and host readers return
every outstanding receipt, including those beyond the former admission limits.

The admission writer is `RecordedCheckStore.put`; asynchronous writes and
updates share it. Handoff, observer, acknowledgement and cancellation use these
writers. Reads, evidence pages and replay resolve the existing ledger and
history. Root retirement still requires acknowledgement. Stage report guards,
attempt summaries, host/session/owner holds and cancellation read retained
receipts; freeing a slot grants no stage-report exclusion.

Capacity retries unwind registry, host, sweep and database locks before waiting.
Each retry reacquires them and revalidates the attempt, source, roots, deadline
and native custody. File events wake the waiter; a bounded timer also detects
native exits that produce no write. The API exposes a waiting response after
the bound, with no accepted receipt or renewed producer deadline.

The observer releases settled or abandoned native watchers independently of
acknowledgement. Startup and readiness reconcile the durable delivery backlog
in pages of 32. Startup returns without awaiting deliveries; readiness has one
coalesced reader. Receipt events remain indexed and keyed. No performance gain
is claimed.

## Regression coverage

`src/lib/recordedChecks/capacity.test.ts` fills both capacity limits in a real
child writer, exits that writer, then reopens the database. Admission succeeds,
a live holder remains, and all replay records and root holds survive another
reopen. Both cases fail on the original main revision with the capacity error.

`src/lib/recordedChecks/lifecycle.integration.test.ts` also drives real native
handoff after abandoned capacity, waits while an independent owner acquires the
released registry lock and exits the holders, and checks the bounded API answer
when every holder remains live. Existing checkpoint and process-restart cases
assert that a settled result frees its slot before evidence acknowledgement.

Required publication checks remain typecheck, privacy-publication,
privacy-tracker-audit, runtime-gate and the repository pre-push hook.

# Migration worker observation

Read-only observation on 2026-09-21, before changing product code (#1983).
The live registry was opened with SQLite `mode=ro`; the replay used a private
backup, isolated state, disabled provider/delivery actuators and board writes.
No production process or container was controlled.

The production worker and this checkout had identical controller, coordinator
and registry source. Eighteen five-second process samples showed long bursts
at 98–100% of one core, RSS around 2.1–2.2 GB and 140–180 MB/s logical reads,
with virtually no writes. It also briefly idled: the observation does not prove
an unconditional timer loop. During 3,894 open-file samples no transcript file
was observed. The live registry held 9,753 conversations, 13 failed-recoverable
migrations and two applying reconfigures without a migration.

Running the production `reconcileMigrations` against the copy measured:

| Work | Calls | Time |
| --- | ---: | ---: |
| Entire pass | 1 | 80.069 s |
| `pendingDeliveries` | 9,740 | 74.317 s |
| `conversation` | 680 | 4.355 s |
| `readOnlySnapshot` | 2 | 0.733 s |

The payload counters recorded 644,365 conversation rows, 439,050 entry rows,
861,738 lineage rows and 552,565 receipt rows. A separate single-conversation
read with an additional MCP grant took 1.583 s and loaded 9,754 conversation,
6,658 entry, 13,358 lineage and 8,501 receipt payloads. Baseline-grant keyed
reads stayed bounded (20 conversation reads loaded 20 conversation rows).

The measured mechanism is historical-conversation reconciliation amplifying
grant validation: the coordinator calls `pendingDeliveries` even when its
initial snapshot already shows no pending delivery. That method reads the
conversation and entry; the SQLite lazy loader must assemble grant provenance
when a row claims an additional grant. Repeating it over the entire inventory
turns an otherwise quiet migration pass into tens of seconds of registry reads.
Grant validation must remain intact; eliminating unnecessary per-conversation
reads addresses the amplification at its caller.

With that caller filtered to actionable work, a subsequent replay on the
registry copy completed in 0.801 s: one `pendingDeliveries` call (2.9 ms), one
conversation read, and the initial snapshot. Parked failed migrations with
held or assigned delivery residue are also excluded; uncertain prior
actuations retain their reconciliation path. This is isolated replay evidence;
the live worker was not changed or restarted.

The earlier terminal-turn replay established progress with an idle readable
host. It did not establish progress during a runtime-host transport timeout.
The incident log separately records bursts of `native-queue-read` timeouts
about 15 ms apart. Neither the worker measurement nor that earlier replay
establishes that a currently unreadable host is idle.

## Revision observation

A subsequent read-only two-second sample still found a busy worker at 99.5%
CPU, 1.86 GB RSS and 145 MB/s logical reads. The read-only SQLite inventory
contained 9,757 conversations, the same 13 failed-recoverable migrations and
two orphaned applying reconfigures. This confirms the observed workload still
exists; it does not imply the branch has been deployed.

The production delivery-controller regression reproduced 606 native queue
reads in 60 simulated seconds with 100-ms admission wakes, a parked account
pick and six successful sends on another conversation. Execution bypassed
the background reconciliation deadline, and the parked target prevented the
whole-pass failure budget from activating. Native execution now keeps its own
per-conversation deadline; unrelated success cannot reset it. Original native
records and receipts remain unchanged while the socket cannot answer, and an
interrupt on the same conversation still progresses.

## Behavioral regression evidence

A further read-only sample before the journal-retry correction measured the
busy worker at 100.5% CPU, 1.86 GB RSS and 157.2 MB/s logical reads over two
seconds. SQLite `mode=ro` counted 9,762 conversations, 13 failed-recoverable
migrations and two applying reconfigures without migrations. The original
registry-amplification diagnosis still applies; no live state was changed.

The same acceptance files and shared fixture were copied into an export of
merge base `e2dd7970a`; production code in that export was unchanged. All
failures below are assertions reached through the production controllers.
External account/provider I/O, host adapters, process/board writers and clocks
are isolated. Registry, journal, queue, scheduler and migration decisions run
their production implementations. The socket fault accepts requests and never
answers; no test connects to an operator listener.

| Acceptance | Merge-base behavior | Fixed behavior |
| --- | --- | --- |
| Terminal provider-error pick | Receipt remains queued | Applied, migration committed, successor on chosen account |
| Slow inventory pass | Second scan before a full idle minute | No scan until a full minute after completion |
| Historical migration residue | 339 conversation/delivery reads in three cycles | Zero such reads; 13 failed migrations retained |
| Native background reconciliation | 601 reads per simulated minute | At most 7 reads |
| Native execution plus parked pick and healthy sends | 1,200 requests per simulated minute | At most 14 total requests including background reconciliation; six healthy sends and one same-target interrupt complete |
| Native receipt read timeout | Same-target interrupt cannot progress | Interrupt completes; total requests remain bounded by 14 |
| Unanswered effect-batch socket | 600 requests per simulated minute | At most 7 requests |
| Applying switch with unreadable host | 600 host checks per simulated minute | At most 6 checks; unrelated send and replacement choice progress |
| Message held behind failed switch | Send remains queued | Journal and delivery record settle failed; rendered card shows reason and resend control |
| MCP pick with unspecified Codex speed | Account selection refused | Account selection admitted with `fast: false` |

The pre-revision branch separately reproduced 606 native requests in the
mixed-target case. This identifies the execution bypass left after the first
background-only backoff fix. Bounds are asserted over 60 seconds of simulated
time with admission wakes every 100 ms. The controller-level tests supersede
the earlier helper-only scheduler and supplied-receipt regression claims.

## Journal-transition retry correction

The next review identified another bypass: `applying` was written outside the
switch's failure budget. With a parked peer, the overall drain pass succeeded,
so its backoff reset on every admission wake. Both the reviewed revision and
the unchanged merge base reproduced **600 unanswered applying transitions per
simulated minute**, including when the journal committed the transition but
its answer was lost. The original receipt and held delivery stayed pending.

All switch journal transitions now charge the pending operation's retry
deadline, including cancellation, deadline settlement and supersedence. A
replacement choice gets its own budget; failure to settle the previous choice
charges that replacement's budget. Controls run before supersedence cleanup
and remain eligible during the switch's cooldown. The executor's error handler
only handles executor failures: an unanswered `queued` or `applied` transition
preserves the actual switch outcome for reconciliation.

Seven additional production-controller cases fail behaviorally on the same
merge base and pass on the corrected branch:

| Unanswered transition | Merge-base behavior | Corrected behavior |
| --- | --- | --- |
| `applying`, receipt still queued | 600 requests/minute | At most 7; payload and receipt preserved |
| `applying`, committed but reply lost | 600 requests/minute | At most 7; applying receipt preserved |
| `queued` after pending migration | Switch wrongly failed | At most 7; queued after transport recovery |
| `applied` after successful migration | Switch wrongly failed | At most 7; applied after recovery, one successor |
| `failed` after executor refusal | 600 requests/minute | At most 7; original failure settles after recovery |
| Cancellation settlement | 600 requests/minute | At most 7; cancellation settles after recovery |
| Supersedence settlement | All six same-target interrupts blocked | Six interrupts complete; at most 7 failed transitions |

Each case includes a parked peer and six successful sends on another target.
The applying cases also prove that a replacement account choice progresses
immediately without inheriting the previous choice's deadline. Repeated
controls in the settlement cases cannot bypass the deadline.

The eight focused suites pass 166 tests. Additional reconfigure, injection and
recovery-contention suites pass 41 tests, with one existing assertion failure:
the reservation-refusal fixture expects the synchronous lock's exact sentence
but receives the asynchronous holder diagnostic. The identical assertion also
fails against unchanged merge-base production code. It does not exercise the
modified switch path.

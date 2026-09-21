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

With that caller filtered to active migrations and pending deliveries, the
same copied registry completed in 0.770 s: one `pendingDeliveries` call
(2.9 ms), three conversation reads, and the initial snapshot. This is isolated
replay evidence; the live worker was not changed or restarted.

The earlier terminal-turn replay established progress with an idle readable
host. It did not establish progress during a runtime-host transport timeout.
The incident log separately records bursts of `native-queue-read` timeouts
about 15 ms apart. Neither the worker measurement nor that earlier replay
establishes that a currently unreadable host is idle.

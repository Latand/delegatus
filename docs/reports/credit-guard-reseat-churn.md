# Bound repeated paid-credit reseats and scoped stop writes

## Cause and change

The paid-credit guard requests a conversation reseat in
`src/lib/runtime/accountCreditGuard.ts`. A dead generation with a retained busy
turn can wait until migration hygiene stops its intent. Hygiene subsequently
clears the rolled-back migration, allowing the next guard pass to request the
same move again. The recovery obligation remains owed throughout this loop.

`src/lib/agent/registry.ts` now commits one `creditGuardReseat` receipt with the
automatic request. Its evidence covers the canonical conversation, source
generation and path, account and launch settings, target, writer epochs,
delivery admission sequence, interruption-cut identity, and substantive source
and target quota/credit values. Probe timestamps and migration bookkeeping are
excluded. A stopped receipt on unchanged dead or unhosted evidence suppresses
another automatic request. The receipt survives migration cleanup, normalization,
archiving of the stopped intent, and a fresh process. Evidence is read inside
the admitted registry transaction. No additional in-memory counter is used.

The existing interruption-obligation store continues to expose the unfinished
record as `owed`. A new delivery, account/credit change, generation, live host,
or new interrupted turn can authorize recovery. Source credit recovery delivers
the preserved continuation. Manual reseat and reconfigure callers keep their
explicit authority. A receipt is initialized when an automatic request is
admitted; older records remain readable. This change adds no UI or startup
mutation.

The same registry file's `stopSweepCovers` now checks conversation scope before
applying an opt-out. Its common predicate governs deferred sweep writes,
pending-decision reads, withdrawals, and settlement before account changes.
Conversation intents cover their owned migration. Engine intents, including
legacy intents with an omitted scope, retain their existing coverage and
decision order. Removing a completed sweep marker leaves the reseat receipt
intact.

## Shared paths checked

- Automatic producer: `accountCreditGuard.ts`, forwarding the interruption-cut
  identity after its existing custody and target checks.
- Explicit producers: conversation migration API, pipeline reseat, and runtime
  reconfiguration; their ordinary requests bypass the automatic guard.
- Persistence and recovery: registry conversation normalization, JSON and SQLite
  readers, cold intent lookup, and `clearRolledBackConversationMigration`.
- Stop consumers: synchronous stop, sliced stop, resumed sweep, pending opt-out
  reads, and migration hygiene through `reaperRuntime.ts`.

Open changes touching these paths were inspected: #4144, #4066, #4050, #3710,
and #3668. Their relevant hunks concern separate paths. #4163 addresses archive
retention; #4151 tracks recovery custody attribution. This fix addresses the
repeated producer and the stop's write scope.

## Disposable-fixture measurements

Baseline: main revision `13353544440d1ec601ea8ceac1b229bd21aff3f5`.
Runs used Bun 1.4.0 on Linux on 2026-11-17–18 UTC. Every test command had private
HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR beneath the stage scratch root,
and the Viewer control URL used a verified closed loopback port. Tests ran in
source exports with shared installed dependencies. Production state was unused.

The production-shaped fixture has 1,283 conversations: 1,249 source-account
history rows, 20 target-account rows, four engine-owned migrations and ten
other-engine conversations, plus 1,249 delivered history reservations and three
held reservations. One history conversation is the reseat subject. The old stop
writes 1,248 foreign cold conversations and three foreign hot conversations.
Each stop measurement runs ordinary archive hygiene after the stop: a write
first promotes a cold row, and rearchiving creates its next retained version.

| Measurement | Baseline | Fixed |
| --- | ---: | ---: |
| Foreign conversation writes per sliced stop | 1,251 | 0 |
| Foreign conversation writes per synchronous stop | 1,251 | 0 |
| Foreign conversation writes per resumed stop | 1,251 | 0 |
| Conversation archive versions per stop, each of the three paths | 1,248 | 0 |
| Stops in one simulated hour, twelve five-minute intervals | 12 | 1 |
| Foreign conversation writes in that hour | 15,012 | 0 |
| Conversation archive versions in that hour | 14,988 | 1 |

The fixed hour's one version is the reseat subject's ordinary archival after
migration cleanup. These are deterministic write counts over disposable
fixtures. No production hourly rate, disk-byte saving or latency gain is claimed.

## Red and green checks

The regression files were first run against baseline production code with fresh
isolated state. The corrected scope measurement includes rearchiving and a
240-second timeout for the baseline hour case.

| Command after the recorded stage gate | Baseline result / exit | Fixed result / exit |
| --- | --- | --- |
| `bun test --timeout=60000 ./src/lib/runtime/accountCreditGuard.reseat.test.ts` | 7 pass, 3 fail / 1 | 14 pass / 0 |
| `bun test --timeout=60000 ./src/lib/agent/registry.migrationStop.scope.test.ts` | 1 pass, 5 fail / 1 | 7 pass / 0 |

The baseline credit failures reproduce repeated reseats after real JSON and
SQLite process restarts and after a timestamp-only quota refresh. Subsequent
cases cover recovery with new evidence, a revived host cut, changes during
asynchronous writer admission, and writer refusal without consuming evidence or
changing delivery receipts. Two complete former retry intervals pass after the
first stopped attempt in separate fresh processes, with the obligation still
owed and no additional intent. Each restarted process receives the frozen clock
and reports it back. The live-host probe retains the same interruption-cut
identity so the host's status is the evidence that reopens the attempt.

Scope cases count persistence writes and archive rows for three stop paths,
exercise both engine/conversation decision orders, and keep a foreign send
eligible while a conversation stop's sweep remains pending. The fixed tests
include the additional adversarial cases added after the initial red runs.

Each focused command used the supplied gate wrapper's `--record` option with
a fresh absolute log under stage TMPDIR and one native `wait_for_check` call.
Retained logs: `red-reseat.log`, `red-metrics.log`, `green-reseat.log`, and
`green-scope.log` in the stage evidence directory. The early scope run's short
hour timeout was superseded by the completed baseline measurement above.

The pre-push planner's complete touched-tests selection is compared one explicit
file at a time through the unchanged project comparator. Its ordinary
five-minute file and fifteen-minute run limits apply to every invocation. The
initial eight-worker aggregate exited 1 with eight file timeouts. A subsequent
serial aggregate completed eleven files with zero new failures before an added
campaign-wide execution limit stopped it; that incomplete aggregate is retained
as inconclusive. The final committed tree requires all selected per-file verdicts
and the repository privacy gate. Final verdicts and command exits are recorded
in the stage handoff. Publication and operational observation belong to the
pipeline's later owners.

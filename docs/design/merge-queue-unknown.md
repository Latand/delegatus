# UNKNOWN mergeability in the merge queue

A reviewed PR whose mergeability remains UNKNOWN gets an ancestry check after
three minutes from the first observed head. The runner compares the immutable
base and reviewed head. When that head lacks the base, it takes the existing
BEHIND path: a mechanical base update where eligible, otherwise a reviewed
refresh lane. Pending or missing checks on the old head do not delay that refresh.
The resulting head must pass its own required checks before merge.
An unreadable comparison grants no refresh authority. Conflict, review and
head-change guards keep their existing stops.

Settled green checks remain checking while GitHub alone stays UNKNOWN; the
90-minute limit still applies to missing or unfinished required checks.
An aged checking lane also enables readiness rotation by persisted read time,
even when its head already contains the base. Other ready PRs can proceed;
a settled UNKNOWN update releases its base-update slot after the same bound.
Repository merge reservations still serialize writes. This uses the existing
poll cadence and head clock, with no new persisted timer. Deferred update wait
reasons clear in the sweep that observes their owner leave the live queue.

## Incident evidence

Read-only inspection on 2026-11-05 covered the service journal from
2026-11-04 20:45Z through 2026-11-05 00:30Z and the persisted merge records.
Times below are UTC. Journal transitions and forge merge timestamps are named
separately because confirming the merge takes another read.

| Record | Observation |
| --- | --- |
| PR #3637 | Retried at 21:11; checking at 21:18:36; blocked at 22:41:28 with the 90-minute check timeout. Its persisted head clock started at 21:11:05.845. |
| PR #3635 | Updated at 21:12:59, merged at 21:33:23 according to its merge receipt, confirmed in the journal at 21:33:26. |
| Five followers | Their journal reasons named the update of #3635 from 21:13 through 21:18. No new readiness transitions appeared until after #3637 stopped. |
| PR #3539 | Resumed at 22:43:52, updated at 22:45:23 and merged at 23:00:19 according to its merge receipt. |

**Observed:** #3635 merged while #3637 remained checking. The followers kept
the old update reason after #3635 merged, and resumed after #3637 timed out.

**Inferred from the runner:** while #3635 had a recorded base update, that
record enabled rotation. Its departure removed that condition; UNKNOWN #3637
then monopolized readiness reads until the long timeout. Thus the interval
following #3635 was queue starvation, beyond the time needed to serialize its
merge. The journal does not prove why GitHub kept answering UNKNOWN.

## Verification

`src/lib/forge/autoRefresh.test.ts` exercises the real sweep with deterministic
forge ports, delivery ownership and a fixed clock. Cases cover the short bound,
restart, exact updated-head checks, current-base UNKNOWN with ready peers,
retired update labels, failed ancestry reads and the existing safety stops.
Run it by explicit path in isolated HOME, XDG_CONFIG_HOME, TMPDIR and
LLV_STATE_DIR. The adjacent merge and store files remain part of the focused
verification. No live queue state is changed by these tests.

Verification on 2026-11-05 used Bun 1.4.0 and separate direct commands, each
with a fresh isolated environment, log and recorded exit status. The base
comparison used the final regression file with `autoMerge.ts` from
`3fbbe72c6`. No build, typecheck, live queue mutation or deployment ran.

| Command | Result |
| --- | --- |
| `bun run test src/lib/forge/autoRefresh.test.ts -t 'unknown queue:'` on base | 8 pass, 16 fail; exit 1 |
| `bun run test src/lib/forge/autoRefresh.test.ts` on fix | 274 pass; exit 0 |
| `bun run test src/lib/forge/autoMerge.test.ts` on fix | 157 pass; exit 0 |
| `bun run test src/lib/forge/autoMergeStore.test.ts` on fix | 139 pass; exit 0 |

Eight independent production mutations were tested in scratch source copies
with the `unknown queue:` cases. Disabling ancestry-triggered refresh,
readiness rotation, retired-label clearing or expired-update slot release
caused 9, 3, 2 and 1 failures respectively. Disabling requested-change,
moved-head or red-check stops caused 2, 1 and 1 failures. Swallowing the
conflict handoff caused 1 failure. Every mutated run exited 1; the unchanged
production code passed all 24 cases. These are behavioral checks through
`sweepAutoMerge`, including fresh-process replay of the retained clock and
read order. They make no production latency or performance claim.

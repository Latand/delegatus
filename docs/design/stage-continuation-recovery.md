# Pipeline continuation after host restart

## Publication repair and retry recovery

A refused publication reserves one repair request under a durable message key.
Its 20-minute window starts at `refusedAt`, including delivery admission and
the repair turn. The controller settles the keyed send through the normal
delivery receipt resolver. A failed send ends the repair; at the deadline, a
held reservation is withdrawn under asynchronous writer admission and its
operation identity is checked again before the write. Claimed or uncertain
deliveries retain their uncertainty. Late delivery preflight also checks that
the repair is still owed and inside its original window.

After a failed or expired repair, `resolve-decision` and `retry-stage` accept
recovery when delivery failed, the producer is gone, the producer finished, or
an expired reservation proves no dispatch. A failed delivery can retain
duplicate-risk evidence from an earlier dispatch; that evidence alone does
not keep the repair pending. An active turn, live background work or another
outstanding message still refuses recovery. Unknown producer activity with an
uncertain delivery also refuses. The refusal names the delivery operation and
its current state. Producer and receipt reads occur outside the shared pipeline
mutation lease; revision, attempt and repair identity guards apply afterwards.

The next controller tick refreshes parked repair records, including legacy
records with no send key or start timestamps. Failed deliveries and gone
producers settle the repair without another prompt or automatic publication;
the lane stays parked for an answer. The action paths also refresh this evidence.
An accepted decision reserves one fresh attempt and records the revision the
caller answered, so replaying that answer preserves its reservation even when
the evidence refresh changed the old repair record.

`publicationRecovery` retains failed publication operations by accepted SHA,
including their cause, operation identity, ownership epoch and next retry time.
An infrastructure deadline is recorded separately from a check failure; the
check failure's detail retains the first named assertion when available.
Automatic attempts use the existing 1/5/15-minute delays. The first interrupted
publisher with no failure evidence retains its immediate retry. Exhaustion
records a null next retry time. An exhausted infrastructure deadline parks for
capacity recovery and requests no producer repair. An explicit request permits one further push
without renewing the automatic allowance for that head. New stage attempts,
controller restarts and delivery takeover preserve the counter. Takeover also
records a settled failure the old controller has not observed yet.

Each head retains its newest 64 failure records and a total count. The compact
pipeline read exposes the current head's counters and newest four failures;
the full read retains all stored records and other heads. These are persisted
records, with no process-local cache.
The focused regressions are `publicationRecovery.test.ts`,
`repairDelivery.test.ts`, `publicationHistory.test.ts`,
`parkedPublication.test.ts` and `store.test.ts` in `src/lib/pipelines`.

## Observed failure

Read-only evidence collected on 2026-10-09 from `get_pipeline(full: true)`,
`conversation_messages`, interruption obligations and the runtime journal.
The cited pipelines were left untouched. All times below are UTC.

| Pipeline | Stage / attempt | Native abort | Continuation requested | Park recorded |
| --- | --- | --- | --- | --- |
| 2665bf87 | build / 1 | 10:00:04.350 | 10:00:54.300 | 10:10:54.834 |
| b9d499cf | reconcile / 1 | 10:00:04.350 | 10:00:54.109 | 10:10:54.637 |
| e7852bfd | merge / 1 | 10:00:04.350 | 10:00:53.918 | 10:10:54.452 |
| 54a2b0a8 | fix / 3 | 10:00:04.349 | 10:00:53.695 | 10:10:54.248 |

Each attempt retained a `turn_cut` provider wait labelled `aborted stage turn`,
with a park recovery summary ending in `continuation refused`. An operator
retry subsequently replaced the attempt error with `automatic provider retry
cancelled by operator retry`; it also removed the controller wait, so that
field no longer establishes the historical refusal predicate.

All four had already delivered a first pipeline continuation between
09:59:41 and 09:59:47. The agent produced output, then a second native abort
closed that turn. The journal recorded `session-status` with `host=unhosted`,
`turn=idle`, `activeTurnId=null`, and `writerClaim=null` between 10:00:05.023
and 10:00:05.062. No subsequent session publication occurred before the park.
The first continuation's operation was delivered. No operation or delivery
reservation existed for any second-cut continuation key. The earlier build / 1
attempt of 54a2b0a8 showed the same delivered-continuation / abort / refusal
sequence at 05:32–05:43.

## Cause

`enqueueStructuredMessage` checked `runtimeIdleKillMatches` before reaching
host republication or `recoverDeadStructuredConversation`. That predicate
requires `host=hosted` and a current writer claim. An unhosted session therefore
returned false on every tick without attempting recovery or reserving delivery.
The default `resumeSeveredTurn` port reduced the delivery error to a boolean;
the engine replaced it with the bare refusal string.

The durable transcript reader still returned a terminal native abort matching
each saved cut, with complete prompt history and no prompt newer than that cut.
The runtime host's missing conversation writer was sufficient to refuse the
continuation even when those stage guards passed. This was a conversation-host
recovery gap; restarting the serving runtime host alone could not supply its
missing writer.

The retained restart obligations explain why #2570 did not fill the gap:
at 09:58:26 each was discharged as `a pipeline stage: its controller retries
the attempt`. Startup explicitly leaves pipeline cuts to the pipeline engine
(`startup.ts`, `accountedRestartHostKeys`). The native abort marker can arrive
after the restart witness, making this stage enter provider-cut recovery.
That recovery then required the very host it was responsible for restoring.

## Recovery contract

An eligible idle continuation first republishes or resumes the durable current
structured conversation when its runtime session is absent, dead or unhosted.
It creates no send reservation during that recovery. Afterwards it rechecks
stage eligibility and captures the recovered session's current idle revision
and writer claim. Runtime admission and execution retain their existing idle
fences and stable continuation key.

A superseded conversation, account migration, mismatched current generation,
or earlier unknown/admitted continuation remains fenced. Recovery failure,
missing publication, active turns, attention, retirement blocks and stage guard
changes retain specific reasons. The pipeline port forwards the delivery reason;
transport exceptions and diagnostic-free custom ports receive distinct reasons.

## Regression evidence

`engine.test.ts` drives two native aborts around a delivered continuation,
a runtime outage, an unhosted publication and a later restored runtime. It uses
the real durable transcript reader, registry, delivery admission and runtime
journal. The same stage and conversation receive one continuation per cut,
without a fresh pipeline attempt. It fails against the unchanged lane base.

`structuredMessageDelivery.test.ts` covers absent/dead/unhosted sessions,
in-process republication, real structured recovery into a fresh registry claim,
replay deduplication and recovery-time refusals without send reservations.
The automatic fresh-claim case and all four restart recovery cases fail on base.
Existing uncertain-outcome and pre-execution-refusal tests remain in that file.

Every test invocation uses an explicit private state directory under the OS
temporary root, a private HOME and TMPDIR, and a Viewer control URL on closed
loopback port 9. Checks name only the two touched test files.

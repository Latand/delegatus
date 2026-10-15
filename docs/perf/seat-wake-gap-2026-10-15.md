# Seat wake gap, 2026-10-15

Read-only incident audit of **00:20:00–05:10:00 UTC**, against deployed
`781ecd4c33482d7486683d19d61a8b0bc8c14d38` and audit checkout
`45d25ac796d5824713c9fb57d65f57efea61041b`. Only this report changes the
worktree. Production was read through the installation's stored state,
SQLite connections opened with `mode=ro`, and the user service journal.
There was no restart, deploy, live HTTP probe, registry import, or production
test. Source identifiers E1–E10 below give the queries and time bounds.

The first post-deploy wake was prepared at **00:33:53.333Z** and appeared in
the seat's native transcript at **05:03:42.442Z**: **4 h 29 min 49.109 s**.
Deployment success was recorded at **00:28:32.843Z**, so arrival was
**4 h 35 min 9.599 s** after settlement. The configured interval was 15 minutes;
its deadline was 00:43:32.843Z. The first attempt happened within that
interval and failed during host recovery. [E1, E2, E4, E5]

The recovery guard compared the registry with the dead host's old identity
after the recovery itself had acquired a new writer claim. It rejected its
own change with `seat-mcp-unavailable`. An isolated replay through the real
spawn function reproduces the failed receipt and released registry entry.
Subsequent checks continued producing owed-work candidates, but admission
refused them before a send operation existed. At 05:03 a separate recovery
published a host; the next tick queued the original wake. That same check
then retired the newly queued wake using an earlier `absent` observation and
queued a duplicate. Both defects remain in the audit checkout. [E1–E3, E8, E9]

The MCP outage was surfaced on an existing board card at 00:33:54.019Z.
Automatic recovery and the one-interval arrival guarantee failed. Calling the
entire episode invisible would overlook that card. [E2]

## Identity and clock

All times below are UTC on 2026-10-15. The project is
`repo-9312b7c49a53edae0e66a40b1d9b2594`, seat epoch **54**, conversation
`conversation_2056dd22…`, native session
`9ad91219…`. Epoch and designation stayed constant
through this window. The 04:53 backup proves `enabled=true`,
`wakeIntervalMinutes=15`, updated at 00:24:53.591Z. [E2]

The timer checks every five minutes (`src/lib/monitor/seatTick.ts:142`);
the 15-minute setting governs ordinary wake eligibility. Event obligations
can wake sooner. Journal `at` values are check/reconciliation timestamps,
not transport completion times. Several reconciliation rows can belong to
one check. The last preceding check was quiet at 00:19:30.173Z. [E1, E8]

## Deployment, host, and delivery reconstruction

| UTC | Evidence and consequence |
| --- | --- |
| 00:24:32.724 | W0, a lane-event wake, queued. Delivery operation `53226f80…` was created at 00:24:33.655. Native arrival was 00:24:35.508; registry delivery acknowledgment was 00:24:37.634. [E1–E3, E5] |
| 00:24:48.201 | Deployment `checkout-ab787165…`, key `rot54-deploy-781ecd4c`, requested revision `781ecd4c…`. [E4] |
| 00:24:57.700 | Seat turn completed. Structured event sequence 5026 says `turn-ended/completed`, 5027 says idle. The stored conversation later records this terminal time, observed at 00:29:49.831. [E2, E5] |
| 00:28:11.624 | Last heartbeat of the predecessor's stdio MCP launcher. Its last successful call was 00:24:53.601; the retained heartbeat says ready with zero failed calls. This proves a stopped heartbeat, without identifying the exact process exit instant. [E6] |
| 00:28:18.840–00:28:32.843 | Build completed, launcher applied the release, new runtime host took its singleton fence, and deployment settled successfully. Runtime-host PID 1834890, epoch 569: fence waiting 00:28:22.379, acquired 22.388, journal open 23.648, consumers recovered 23.651, listener ready 23.654. New Viewer PID 1834964; service readiness banner at 00:28:32.581. Apply completion 00:28:32.711; deployment terminal success 00:28:32.843. [E4, E7] |
| 00:33:45.940 | Tick credited W0's earlier delivery. This timestamp is accounting, not a second arrival. [E1, E3] |
| 00:33:53.333 | W1 prepared for deploy-settled, own-lane-settled and lane-event. Initially it carried five items and deferred two. The worker asks and maintenance outcome accumulated later. [E1] |
| 00:33:54.019 | Existing MCP-outage card `16c17487…` updated in Inbox. [E2] |
| 00:33:55.358–00:33:55.854 | Resume-successor receipt `95810f30…` was created and failed with `seat-mcp-unavailable`. The seat entry ended dead, owner null, host null, claim epoch 2, `stdio:released`, no process, no pending action. No send operation was assigned to W1. The 04:53 backup preserves this state. [E2, E9] |
| 00:38:58.717–04:58:42.846 | Fifty-three candidate wakes report `seat-mcp-unavailable`. W1 remains the single outstanding durable attempt, dispatch `refused`, operation null. Candidate keys in the tick journal do not imply that those candidates were admitted or separately queued. [E1, E2] |
| 00:58:42.093 onward | Worker-ask enters the agenda. Eventually three asks are present: lanes `be292f34` (provider stop), `1037a8c1` (merge held by Journal startup), and `f0aa1063` (finished without a PR). The count grew over the window; all three were not present at 00:33. [E1, E2, E5] |
| 01:23:42.977 / 02:08:41.344 | Unmerged-PR, then stalled, enter the wake reasons. Lifecycle events confirm work continued in other lanes while this seat was unavailable. [E1, E2] |
| 03:08:40.651 | Maintenance run `maint_28e924a2b2c9ca2db74669d1` succeeded, changing 13 tasks with 15 recorded writes. The 03:08:42.003 check first adds maintenance-settled. [E1, E2] |
| 05:03:04.469–05:03:05.434 | Resume-successor receipt `9fd45deb…` completed. Runtime events 4724441/42 admit/register the spawn at 05:03:04.685/.689; 4724443 publishes hosted/idle at 05:03:05.079 with writer epoch 3; 4724445 marks the spawn delivered at 05:03:05.434. A fresh MCP launcher started at 05:03:05.231. Retained records do not identify the initiating caller. [E2, E3, E6, E7] |
| 05:03:40.381 check | Opening reconciliation sees W1 absent, refreshes its payload, then queues it under its original key. Operation `b8efef95…` is created at 05:03:41.896 and admitted at 41.937. Runtime receipt 4724446 says queued at 41.938, position 1; 4724447 says delivering at 42.396; turn-start event 4724449 is at 42.438. [E1–E3] |
| 05:03:42.442 | W1 actually appears in the native transcript. Its displayed snapshot time is still 00:33:53, although its agenda was refreshed with subsequent asks and maintenance. The code passes `wake.preparedAt` to the refreshed payload formatter. [E5, E8] |
| 05:03:40.381 reconciliation stamp / 05:03:43.344 wake stamp | After the successful queue admission, reconciliation retires W1 as `unresolved-age` using its pre-send `absent` observation. The same check builds W16 for the still-uncredited obligations. Its operation `41a7c5f7…` is created at 05:03:46.534; event 4724451 queues it at 47.201, position 2. [E1–E3, E9] |
| 05:04:00.633/.654 | Runtime/registry mark W1 delivered. These acknowledgment times follow the native arrival by about 18 seconds. [E3, E5] |
| 05:06:23–05:06:30 | An operator input interrupts the running turn and is delivered. It happened after host revival and W1 arrival, so that input cannot explain the 05:03 recovery. [E3, E5] |
| 05:09:04.446 | Tick recognizes delivery of retired W1, explicitly credits none of its obligations because a successor wake already carries them. [E1] |
| 05:09:08.698 | Check skips a new wake because the seat is progressing. W16 still has a queued runtime receipt inside the requested window; it has no native arrival before 05:10. A later registry read records its delivery at 05:10:13.293, outside this audit window. [E1, E3, E5] |

## Every recorded check and wake

E1 contains **60 rows**: 56 wake verdicts, two landed reconciliations, one
retirement and one busy-seat skip. Of the wake verdicts, one is the initial
recovery failure, 53 are MCP admission refusals, and two say queued. All wake
verdicts name five displayed items. `Deferred` is the remaining item count.
The journal's candidate cursor is included; it is not proof of delivery credit.

Reason codes: D deploy-settled; O own-lane-settled; L lane-event;
W worker-ask; U unmerged-pr; S stalled; M maintenance-settled.
Result `MCP` means no new delivery: the MCP/dead-host admission check refused
before the outstanding-wake fence branch. `F` means the first recovery
attempt returned failed. `Q` means accepted into the delivery queue and needs
the arrival evidence above. The last `busy` row is the only busy-seat skip
in this interval. [E1, E8]

| UTC | Verdict | Key | Reasons | Deferred | Cursor | Result |
| --- | --- | --- | --- | ---: | ---: | --- |
| 00:24:32.724 | wake | W0 | L | 1 | 23446 | Q |
| 00:33:45.940 | landed | W0 | — | 0 | 23467 | landed |
| 00:33:53.333 | wake | W1 | D,O,L | 2 | 23468 | F |
| 00:38:58.717 | wake | W2 | D,O,L | 3 | 23468 | MCP |
| 00:44:53.682 | wake | W3 | D,O,L | 6 | 23468 | MCP |
| 00:49:04.613 | wake | W4 | D,O,L | 7 | 23468 | MCP |
| 00:53:51.337 | wake | W4 | D,O,L | 6 | 23468 | MCP |
| 00:58:42.093 | wake | W5 | D,O,L,W | 6 | 23476 | MCP |
| 01:03:47.118 | wake | W6 | D,O,L,W | 7 | 23476 | MCP |
| 01:08:42.154 | wake | W6 | D,O,L,W | 7 | 23476 | MCP |
| 01:13:42.807 | wake | W7 | D,O,L,W | 8 | 23476 | MCP |
| 01:18:47.473 | wake | W8 | D,O,L,W | 6 | 23476 | MCP |
| 01:23:42.977 | wake | W9 | D,O,L,W,U | 8 | 23476 | MCP |
| 01:28:41.750 | wake | W9 | D,O,L,W,U | 7 | 23476 | MCP |
| 01:33:41.812 | wake | W9 | D,O,L,W,U | 7 | 23476 | MCP |
| 01:38:41.360 | wake | W9 | D,O,L,W,U | 7 | 23476 | MCP |
| 01:43:41.255 | wake | W9 | D,O,L,W,U | 7 | 23476 | MCP |
| 01:48:41.505 | wake | W10 | D,O,L,W,U | 8 | 23476 | MCP |
| 01:53:42.879 | wake | W10 | D,O,L,W,U | 8 | 23476 | MCP |
| 01:58:41.685 | wake | W10 | D,O,L,W,U | 8 | 23476 | MCP |
| 02:03:41.814 | wake | W11 | D,O,L,W,U | 10 | 23476 | MCP |
| 02:08:41.344 | wake | W12 | D,O,L,W,U,S | 11 | 23476 | MCP |
| 02:13:40.944 | wake | W12 | D,O,L,W,U,S | 11 | 23476 | MCP |
| 02:18:41.133 | wake | W12 | D,O,L,W,U,S | 11 | 23476 | MCP |
| 02:23:42.230 | wake | W12 | D,O,L,W,U,S | 11 | 23476 | MCP |
| 02:28:41.599 | wake | W12 | D,O,L,W,U,S | 11 | 23476 | MCP |
| 02:33:40.820 | wake | W12 | D,O,L,W,U,S | 11 | 23476 | MCP |
| 02:38:40.562 | wake | W12 | D,O,L,W,U,S | 11 | 23476 | MCP |
| 02:43:40.658 | wake | W12 | D,O,L,W,U,S | 11 | 23476 | MCP |
| 02:48:40.234 | wake | W12 | D,O,L,W,U,S | 11 | 23476 | MCP |
| 02:53:40.697 | wake | W12 | D,O,L,W,U,S | 11 | 23476 | MCP |
| 02:59:01.346 | wake | W13 | D,O,L,W,U,S | 11 | 23476 | MCP |
| 03:03:41.715 | wake | W14 | D,O,L,W,U,S | 11 | 23476 | MCP |
| 03:08:42.003 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 03:13:43.471 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 03:18:41.391 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 03:23:41.073 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 03:28:42.571 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 03:33:42.370 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 03:38:41.345 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 03:43:48.880 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 03:49:00.372 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 03:53:48.303 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 03:58:40.430 | wake | W15 | D,M,O,L,W,U,S | 13 | 23476 | MCP |
| 04:03:40.922 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 04:08:48.454 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 04:13:41.145 | wake | W15 | D,M,O,L,W,U,S | 13 | 23476 | MCP |
| 04:18:41.746 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 04:23:42.646 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 04:28:42.194 | wake | W15 | D,M,O,L,W,U,S | 13 | 23476 | MCP |
| 04:33:41.349 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 04:38:41.763 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 04:43:41.481 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 04:48:41.118 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 04:53:42.338 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 04:58:42.846 | wake | W15 | D,M,O,L,W,U,S | 12 | 23476 | MCP |
| 05:03:40.381 | retired | W1 | — | 0 | 23476 | retired (absent) |
| 05:03:43.344 | wake | W16 | D,M,O,L,W,U,S | 12 | 23476 | Q |
| 05:09:04.446 | landed | W1 | — | 0 | 23476 | landed |
| 05:09:08.698 | skipped | — | — | 0 | 23476 | busy |

For W1–W16, prepend
`seat-tick:repo-9312b7c49a53edae0e66a40b1d9b2594:54:digest-`
to the digest below. W0's full key is
`seat-tick:repo-9312b7c49a53edae0e66a40b1d9b2594:54:2026-10-15T00:04:36.048Z:lane-event:2e3aa62bf5bf72f1db13518a95c56bbf65bab195cc38eb08e9dda1bd4012a6f0d:prompt-9cff8f8692ff716f`.
Only W0, W1 and W16 have seat-wake delivery records in this window. [E1, E3]

| Key | Digest suffix |
| --- | --- |
| W1 | `7061b4ed84c1d78cf6706320c0605931` |
| W2 | `fad35dbb28f59d91acc702ee874630ce` |
| W3 | `e418e3a71549c21fce4b3c2199e7e9c8` |
| W4 | `c8c1cb871959d1ff43452e65c23efac3` |
| W5 | `21500d0f4f5af1c6fffd1b1bd29d1c9e` |
| W6 | `9e5966c44c90110f75ba154dccb095d4` |
| W7 | `9fd1493891004c7559e51371bf765c57` |
| W8 | `e8c0848e569da4dd4a7b77f7afffb966` |
| W9 | `0e49955b6b9f86addafed2007e85fc13` |
| W10 | `6f946c34266d897d014fa15f6f8e49de` |
| W11 | `936baae01e85bbbc235438e308e4b6d0` |
| W12 | `22be4254cd67c3c3998e933a1df2fd18` |
| W13 | `1348579db8515554d5a14568680da5cc` |
| W14 | `55b46a8b06631f765f2d05b0e5ab9f6d` |
| W15 | `d1576fd84135f634a2024c59d3107d27` |
| W16 | `c255b563802a1d65759e156f4216e335` |

There is no journaled check between 00:24:32 and the 00:33 opening
reconciliation. The deploy replaced the processes during this interval.
`startSeatTick` silently drops timer invocations while another sweep, the
restart gate, or the update drain is active (`seatTickController.ts:2247`).
The retained journal cannot count those unrecorded invocations or identify
which gate suppressed each one. After startup, the recorded checks continue
at approximately five-minute spacing. [E1, E4, E7, E8]

## Code path and cause

File:line references below name the audit checkout. The controller, recovery,
fence and accounting files are byte-identical to the deployed revision.
`structuredSpawn.ts` differs because HEAD includes the later orphan cleanup;
the deployed claim and authorization sites are at lines 2412 and 2438
(current lines 2414 and 2451 respectively). [E8]

1. **The deploy leaves a completed seat to ordinary delivery recovery.**
   `bin/launcher-relaunch.mjs:491` marks the web/runtime children stopping and
   awaits `stop()` before relaunch. Startup adoption in
   `src/lib/runtime/startup.ts:1570` admits pending work, then at line 1571
   excludes a terminal conversation without it. This seat had completed at
   00:24:57 and had no post-deploy delivery reservation. The runtime-host
   singleton fence was acquired in nine milliseconds; it did not remain held
   against a successor for hours. [E2, E4, E7]
2. **A stale MCP heartbeat is eligible for recovery only with proven dead-host
   liveness.** `src/lib/monitor/seatMcpHealth.ts:39` makes the predecessor
   heartbeat dead after two minutes. `seatTickController.ts:1441` captures
   the entry/receipt identity, asks for targeted liveness, and allows only
   `host_gone_turn_settled` or `host_gone_turn_open`. Lines 1459–1473 accept
   one exact dead-host cleanup but otherwise require that captured identity
   to stay unchanged. [E6, E8]
3. **Recovery invalidates that identity itself.**
   `src/lib/delivery.ts:814` enters
   `src/lib/runtime/structuredRecovery.ts:380`. It reserves the successor at
   line 451 and calls `spawnStructuredConversation` at line 495 with
   `authorize: assertAccountAuthorized`. That callback at line 444 reruns
   the old admission guard. The real spawn has already called
   `registry.claimStructuredHost` at `structuredSpawn.ts:2414`, increasing
   `claimEpoch` and setting `claimOwner` (`src/lib/agent/registry.ts:7836`).
   Its next authorization at deployed line 2438 therefore throws. Cleanup
   projects a dead host and releases the claim; it never reaches `startHost`.
   This is the production receipt's error and registry shape. [E2, E8, E9]
4. **The refusal bypasses automatic replacement.**
   `structuredRecovery.ts:514` rethrows `DeliveryAdmissionRefusedError`
   before classifying an unpublished terminal recovery failure.
   `seatTickController.ts:1522` rotates only for
   `structured_revival_impossible`; this failure is `seat-mcp-unavailable`.
   It leaves W1 refused and unreserved. Later candidate checks hit the MCP
   branch at line 1813 before the outstanding fence branch. [E1, E2, E8]
5. **The age watchdog is skipped when admission is closed.**
   `seatTickController.ts:1110` returns immediately when `mayDispatch` is
   false, before the age-retirement and unresolved-attempt reporting path.
   W1's fence bound is `max(60 minutes, 2 × wake interval)`
   (`src/lib/monitor/seatTickFence.ts:44`, `:162`): with a 15-minute interval,
   it expired at 01:33:53.333. The snapshot at 04:53 still has W1 refused
   with no operation. The generic MCP card existed; the age path supplied
   no bounded recovery from this state. [E1, E2, E8]
6. **Recovery then creates a duplicate.**
   `seatTickController.ts:1123` retries W1, line 1132 records the returned
   dispatch, and line 1142 stores its new operation. The function continues
   to age retirement at line 1186 with `observed` still `absent`.
   `seatTickFence.ts:162` considers that old observation retirable and
   `seatTickAccounting.ts:703` moves the attempt to retired. A fresh wake is
   now allowed. The production operations and isolated two-send replay
   agree. [E1–E3, E8, E9]

The exact later liveness subreason is **not retained**. The 53 rows prove the
MCP admission refusal; they do not record whether targeted evidence was
unverified, threw, or changed identity during the asynchronous read.
`admissionFor` collapses these cases to null. The evidence establishes the
first recovery's self-refusal and the repeated gate outcome; it does not
justify asserting that the same internal branch ran on all 53 checks. [E1,
E2, E7, E8]

The delivery queue held W1 only from 05:03:41.896 until arrival. Its original
4.5-hour wait occurred before a delivery operation existed. The seat was
terminal in the retained pre-recovery snapshot. Ordinary busy-seat handling
appears at 05:09, after the seat resumed work. Service logs contain many
short loop gaps (largest retained value in this window: 13,309 ms), while
tick rows continue throughout the outage; those logs provide no evidence of
a single event-loop pause spanning the incident. [E1–E3, E7]

## What changed in the deploy

The preceding release was `61799bbc…`; the 00:24 request promoted
`781ecd4c…`. Its first-parent additions were #2892 (bounded delivery locks
and cold snapshots), #2872 (login/native fixture cleanup), #2893 (read-aloud
voice), #2900 (account migration settlement), #2880 (voice task composition),
#2898 (child control access and spawn receipt recovery), #2899 (MCP reads and
controller hooks across processes), and #2874 (privacy test timing).
Neither the seat controller nor `structuredRecovery.ts` changed between
those releases. The operational change was the launcher succession and the
loss of the old seat host/MCP connection. [E4, E8]

The offending callback addition came earlier, in **`16ac07ec9795` / #2835**
on October 14: it inserted `request.admissionGuard?.()` into
`assertAccountAuthorized`, and carried the old guard into the recovered
delivery result. The seat identity guard had been introduced by
`8ac6b5d974` / #2697 on October 11. The latter had fixed the earlier
dead-seat/dead-MCP incident; #2835 makes that guard run across mutations it
was never designed to accept. `src/lib/delivery.ts:831` also prefers the
returned old guard over the authority-only guard for a newly spawned host,
so fixing only the first authorization call would leave a later refusal.
[E8, E10]

The audit checkout adds #2901 and #2869/#2790 after the running release.
The latter adds orphan termination around the resume claim. It does not
repair the guard handoff or the stale-observation retirement. [E8]

## Proposed repair and regression coverage

**P1 — make recovery own its admission transition.** Keep the captured
dead-host identity guard through reservation and competing-writer checks.
Once recovery acquires its own writer claim, validate the exact reservation,
claim owner/epoch and recovery operation it owns, together with current seat
epoch, conversation, account/curator authorization and drain authority.
Pass that successor-aware guard through spawn publication and queued-send
admission. Do not keep comparing the successor to the predecessor's identity,
and do not globally remove admission checks: #2835's curator and competing
composer/seat protections still matter. Apply this across
`structuredRecovery.ts:443`, `structuredSpawn.ts:2414` and `delivery.ts:831`.

**P1 — give an owed wake a bounded recovery outcome.** Persist the admission
reason, last recovery attempt, next retry and deadline independently of
permission to send. Execute the age/overdue accounting even when
`mayDispatch` is false. Recover a proven-dead designated host on the first
post-deploy/restart check, retaining the original wake key. Before one
configured interval expires, require actual arrival evidence or update a
durable actionable failure card with the failed recovery, next action and
deadline. For a proven unpublished failure, use the existing guarded
replacement path; retain lookup-only treatment for an uncertain or already
admitted send. The existing MCP card is a useful surface to update.

**P1 — retain a wake immediately after queue acceptance.** On a retry that
returns an operation, persist it and finish reconciliation as retained, or
re-read authoritative delivery evidence before any retirement. Do not apply
an `absent` result obtained before admission to that new operation. Fence
retirement atomically against operation/dispatch changes as well as the
client key. This prevents W1 and W16 both carrying the same obligations.

**P2 — make the diagnosis observable.** Journal each admission decision's
host verdict, failure class, gate and next retry; record dropped timer
invocations with their gate. Distinguish payload refresh time from the
original prepared-at time. Record the initiating surface for host recovery
without identities or message contents.

E9 demonstrates three useful regression targets:

- The unchanged `src/lib/monitor/seatTickController.policy.test.ts`, selected
  by `--test-name-pattern 'shared composer recovery'`, already fails the
  cleared, retained-dead-claim and MCP-grace success cases: **5 pass, 3 fail**.
  Keep the five passing failure/race controls.
- Extend that fixture through real `spawnStructuredConversation`, stubbing
  only runtime RPC and engine start. Assert that a deploy-settled wake can
  cross claim acquisition, publication and delivery under its original key.
  The audit's real-spawn replay failed before engine start, with claim epoch
  2, `stdio:released`, a failed receipt and `seat-mcp-unavailable`.
- Seed a refused, recordless wake; advance 270 minutes; make MCP healthy;
  have delivery return queued with an operation. Assert one send, original
  key retained, no retirement and no early obligation credit. The audit
  replay made **two sends** and retired the first `unresolved-age`.

Also cover a controller restart with that durable state, a closed-admission
deadline, a live busy seat, a concurrent composer replacement, a seat epoch
change, a drain beginning during recovery, and an uncertain original send.
Use simulated time to assert the 15-minute arrival-or-visible-failure bound.
Runtime-host changes, if chosen for the repair, additionally require the
two-generation rehearsal in AGENTS.md. No implementation or committed test
is claimed by this read-only stage.

## Evidence queries and validation

All production queries below concern `[2026-10-15T00:20:00Z,
2026-10-15T05:10:00Z)`, unless a narrower or contextual bound is stated.
Read observations were made during this audit after 05:06Z. Live stores can
advance; the named 04:53 backups preserve the pre-recovery state. Public
evidence includes shortened machine record references and projected fields only; native
message text, account names, capabilities and absolute home paths are omitted.

Use these local aliases for the commands. UUIDs in prose are shortened for
publication. Bind `CID` and `SID` to the full values resolved privately by
these indexed lookups; the queries below use those full bound parameters:

```sh
STATE="$HOME/.config/delegatus/state"
PROJECT=repo-9312b7c49a53edae0e66a40b1d9b2594
```

```sql
SELECT row_key FROM registry_rows
WHERE collection='conversations' AND row_key LIKE 'conversation_2056dd22%';
SELECT row_key FROM registry_rows
WHERE collection='entries' AND row_key LIKE 'claude:9ad91219%';
-- SID is the suffix after 'claude:'. Require one result per lookup.
```


**E1 — tick journal.** Read at 05:15:43Z and retained in private scratch.
The exact Python selection was:

```python
rows = [json.loads(l) for l in (s / 'seat-tick/runs.ndjson').read_text().splitlines() if l.strip()]
r = [x for x in rows if x.get('project') == p
     and '2026-10-15T00:20' <= x.get('at', '') < '2026-10-15T05:10']
```

Here `s=Path.home()/'.config/delegatus/state'` and `p` is PROJECT above;
the command ran as `rtk proxy python3 - <<'PY'`. The table is generated from
these 60 records. A second selection with `at < '2026-10-15T00:20'` and
`[-2:]` supplied the two preceding quiet checks. Retention is 500 global
rows (`src/lib/monitor/journalStore.ts:205`); there was retained coverage
before the requested start.

**E2 — stored registry, tick settings, lifecycle and maintenance.** Python
opened each database with
`sqlite3.connect(f'file:{file}?mode=ro', uri=True)`. These were the selected
keys/queries (parameters are the identifiers above):

```sql
SELECT collection,row_key,value_json FROM registry_rows
WHERE json_extract(value_json,'$.conversationId')=? OR row_key=?;
-- CID, 'claude:' || SID
SELECT value_json FROM registry_rows
WHERE collection='conversations' AND row_key=?;
-- CID
SELECT collection,row_key,value_json FROM state_rows
WHERE (collection='seat_tick_settings' AND row_key=?)
   OR (collection='seat-tick-v3' AND row_key=?);
-- 'p:' || PROJECT, 'project/' || PROJECT || '/'
SELECT collection,row_key,value_json FROM state_rows
WHERE collection IN ('tasks','board_maintenance_runs')
AND (row_key LIKE '%16c17487%'
     OR value_json LIKE '%maint_28e924a2b2c9ca2db74669d1%');
```

Files: live `agent-registry.sqlite` and `state.sqlite`, plus
`backups/sqlite/agent-registry-2026-10-15T04-53-50-473Z.sqlite` and
`backups/sqlite/state-2026-10-15T04-53-50-168Z.sqlite`. The latter pair are
historical snapshots at their filename timestamps, not observations of
current host state. The task brief was read from
`tasks/t:313561b2…` in `state_rows`.
`orchestrator-seats.json` supplied epoch/designation; the mandate was not
copied. Lifecycle selection was:

```python
j = json.loads((s / 'lifecycle-journal.json').read_text())
rows = [o for o in j['events'] if o.get('project') == p
        and '2026-10-15T00:20' <= o.get('at', '') < '2026-10-15T05:10']
```

There are 50 project lifecycle events in that interval. Examples anchoring
the accumulated obligations: 23469 stage_failed at 00:26:16.195, 23476
stage_completed at 00:28:51.651, 23524 publish completion at 00:54:51.973,
23549 review completion at 01:15:42.576, and 23566/23567 waiting/blocked at
02:02:12.341. Lifecycle progress does not establish seat delivery.

**E3 — delivery and runtime journal.** Live registry selection:

```sql
SELECT row_key,value_json FROM registry_rows
WHERE collection='heldDeliveries'
AND json_extract(value_json,'$.conversationId')=?;
-- CID; then filter createdAt to the audit bounds
SELECT seq,kind,occurred_at,payload_json,operation_id FROM events
WHERE occurred_at>=? AND occurred_at<?
AND json_extract(payload_json,'$.conversationId')=?
AND kind NOT LIKE '%item%' ORDER BY seq;
-- '2026-10-15T00:20:00.000Z', '2026-10-15T05:10:00.000Z', CID
SELECT operation_id,conversation_id,idempotency_key,request_json,receipt_json
FROM operations WHERE operation_id IN (?,?);
-- the failed 00:33 and successful 05:03 resume receipt IDs
```

Runtime database: `runtime-events-bb38046574072bf9.sqlite`.
The 00:33 spawn operation is no longer retained there; its failed registry
receipt is retained in E2. The first retained runtime event for this seat in
the window is 4724441 at 05:03:04.685. Earlier native turn events and registry
receipts therefore supply the pre-recovery history. `delivery-progress.sqlite`
and `handoff-queue.sqlite` were also inspected by conversation/original key;
neither supplied evidence of a W1 send queue before 05:03. W1's null operation
in the historical tick snapshot is the stronger contemporaneous evidence.
The later W16 delivery acknowledgment is explicitly outside the time bounds.

**E4 — deployment.** Read-only JSON selection:

```python
for o in json.loads((s / 'self-update/deployments.json').read_text()):
    if o.get('deploymentId', '').startswith('checkout-ab787165'):
        # retain revision, phase, terminal, createdAt and updatedAt only
        pass
```

The same deployment/revision was followed through `self-update/history.jsonl`
and `self-update/apply.json`, bounded to 00:24:48–00:28:33Z. The request's
terminal `updatedAt` is the settlement boundary used in the latency
calculation. The startup record was
`runtime-host-startup/legacy-runtime-host-1834890.json`; its `phases` array
provides the fence and readiness times. Running process CWDs resolved to
the `781ecd4c3348` release directory.

**E5 — seat arrival and turn state.** Resolve the native transcript from the
E2 conversation's `generations[-1].path`; inspect only timestamp/type/UUID
and message-kind metadata within the audit bounds. User rows with actual
wake content occur at 00:24:35.508 and 05:03:42.442. The latter contains the
00:33:53 snapshot stamp. Correlate these with:

```python
rows = [json.loads(l) for l in
        (s / 'structured-host-events' / f'{sid}.jsonl').read_text().splitlines()]
selected = [o for o in rows if 4950 <= o.get('seq', 0) <= 5030
            and o.get('kind') in ('turn-started', 'turn-ended', 'session-status')]
```

This host journal has sequence numbers without timestamps. Sequence 4953
starts W0's operation, 5026 ends it completed, 5027 is idle, 5028 is the
recovered idle host, and 5029 starts W1. UTC placement comes from the native
transcript and runtime events, not an invented timestamp for these rows.

**E6 — MCP heartbeat.** For the seat's completed receipt
`0bb8dc1d…`, read its capability digest internally
and open `mcp-runtime/sessions/<digest>.json`. Project only `startedAt`,
`checkedAt`, `lastSuccessfulCallAt`, `ready`, `failedCalls` and PID. Do the
same for the 05:03 successor receipt. Digests and capability values were
withheld from this report. This is historical evidence from October 14
21:55Z through October 15 05:03Z, used only for the bounded outage.

**E7 — Viewer and runtime-host service logs.** Exact command:

```sh
rtk proxy journalctl --user -u delegatus.service --utc \
  --since '2026-10-15 00:20:00 UTC' \
  --until '2026-10-15 05:10:00 UTC' --no-pager -o json
```

Explicit `UTC` on the bounds matters: `--utc` alone changes display time.
Records were filtered by MESSAGE, seat/session IDs and component. The
05:03 caller search additionally used 05:02:50–05:03:12Z. It found runtime
event-cursor recovery at 05:03:04.973 and no initiating HTTP surface.
The 00:28 logs show startup recovery of another project's severed turn and
pipeline cut handling; they contain no such recovery for this completed
seat. Host termination/retirement journals were searched by CID/SID; their
only seat entries were at 05:13, outside the window.

**E8 — source and history.** Local commands, bounded by commit IDs rather
than wall time:

```sh
rtk git log --first-parent --format='%h %s' 61799bbc..781ecd4c
rtk git diff 61799bbc..781ecd4c -- src/lib/runtime/structuredRecovery.ts src/lib/runtime/structuredSpawn.ts
rtk git diff --name-only 781ecd4c HEAD -- src/lib/monitor/seatTickController.ts src/lib/runtime/structuredRecovery.ts src/lib/monitor/seatTickFence.ts src/lib/monitor/seatTickAccounting.ts src/lib/runtime/structuredSpawn.ts
rtk git blame -L 1423,1474 -- src/lib/monitor/seatTickController.ts
rtk git blame -L 438,447 -- src/lib/runtime/structuredRecovery.ts
rtk git show 16ac07ec9 -- src/lib/runtime/structuredRecovery.ts
rtk proxy bash -lc 'git show 781ecd4c:src/lib/runtime/structuredSpawn.ts | nl -ba'
```

**E9 — isolated executable checks.** A private `/tmp` archive of HEAD was
used, with `node_modules` linked to the installed release after comparing
`bun.lock` byte-for-byte (SHA-256
`22588d87096818a35d0d5367ecf485780bdbb57640dd8c049a1c4e8c90d3136b`).
All HOME/config/temp/state roots were under that scratch directory, and
`LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. Every test ran serially through
the exact release wrapper required by the stage:

```sh
# AUDIT names the private /tmp archive; run from that directory.
env HOME="$AUDIT/isolation/home" XDG_CONFIG_HOME="$AUDIT/isolation/config" \
  TMPDIR="$AUDIT/isolation/tmp" LLV_STATE_DIR="$AUDIT/isolation/state" \
  LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 \
  bash "$HOME/.cache/delegatus/self-update/bb38046574072bf9/releases/781ecd4c3348/scripts/gate-slot.sh" \
  bun test src/lib/monitor/seatTickController.policy.test.ts \
  --test-name-pattern 'shared composer recovery'
```

The shell expands the wrapper's `$HOME` before `env` substitutes the test
home. The unchanged-file run returned 5 pass / 3 fail in 753 ms, at
approximately 05:24Z. Scratch diagnostic runs used the same wrapper with
explicit paths `src/lib/monitor/seatWakeGap.audit.test.ts` (real spawn
boundary, expected-success assertion fails) and
`src/lib/monitor/seatWakeRetirement.audit.test.ts` (one-send assertion fails,
two observed). They started no engine CLI or live server. An initial RPC
stub lacked `append`; it was corrected to include successful command,
transition and event projection before the production-shape result was
accepted. These are diagnostic failures demonstrating unfixed defects.

The real-spawn fixture extends the existing shared-recovery case with:

```ts
return spawnStructuredConversation({ ...input, client: fakeRuntimeClient }, {
  startHost: async () => {
    starts++;
    throw new Error("unexpected host start after guard");
  },
});
// fakeRuntimeClient: command -> queued receipt; transitionOperation -> receipt;
// append -> successful projection. Result before startHost:
// starts=0, receipt.error="seat-mcp-unavailable", entry.claimEpoch=2,
// entry.status="dead", entry.structuredHost.endpoint="stdio:released".
```

The duplicate fixture uses the existing `childFixture`, `childRig` and
`refuseBeforeReservation(503)` helpers. After creating an owed terminal child
and recording the first refusal, it advances `now` by `270 * MINUTE`, sets
MCP healthy, and returns `{ok:true, outcome:"queued", operationId: ...}`
from delivery. Its one-send assertion fails with two distinct keys; the
original appears in `retiredWakes` with reason `unresolved-age`.

The privacy gate initially refused full internal UUIDs; they were shortened
for publication and the lookup parameters remain privately resolvable.
Final privacy validation and worktree scope are recorded below. No source file was touched, so no implementation
type/build/lint or runtime-host rehearsal is represented as passed. The
project's future repair still owes the touched tests, local privacy gate,
and required CI contexts (including privacy-publication and runtime-gate;
workflow sources also define typecheck, Journal startup and platform tests).
CI was not dispatched by this read-only stage.

**E10 — prior-answer search.** Project-scoped then unscoped
`search_transcripts`/`search_memory` queries used variants of
`seat wake deploy gap`, `00:33:53 05:03`, `seat tick delivery busy deploy`,
`wake pending restart`, `seat-mcp-unavailable`, and
`seat wake recovery admission guard claim`. The memory hit
`m_5c624e2666d228cc8f97a662` was opened by ID: it covered older idle-only/FIFO
wake rules and supplied no proof of this incident. Other recovery-specific
memory searches returned no relevant result.

Transcript hits were read with `conversation_messages` at the returned
transcript paths. The October 10 audit conversation
`7226c18a…`, assistant conclusion at 22:28:53Z,
described 31 post-deploy MCP refusals, later composer recovery and an outage
card. The October 11 review of #2697, conclusion at 07:28:11Z, reported
passing recovery/race checks. Paths were resolved through search and are
omitted here because they include account identities. E8 checks that older
answer against today's code; E9 disproves treating its old green result as
current validation.


Final report validation: **privacy gate PASS**, with committed known-value
fingerprints and the explicit report path; whitespace check PASS. Only
`docs/perf/seat-wake-gap-2026-10-15.md` is an untracked worktree output.
The branch and HEAD remain those supplied by the controller. No commit,
staging or publication was performed. Validation recorded at 2026-10-15T05:29:52Z.

The successful privacy command, run inside the isolated archive with the
same four sandbox roots as E9, was:

```sh
LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json \
  bun scripts/privacy-publication-gate.ts --require-known-values \
  --repository "$AUDIT" --paths docs/perf/seat-wake-gap-2026-10-15.md
```

The worktree checks were `git diff --no-index --check /dev/null
 docs/perf/seat-wake-gap-2026-10-15.md`, `git status --short --ignored
 --untracked-files=all`, `git branch --show-current`, and `git rev-parse HEAD`.

## Limits and stage result

The investigation establishes the first recovery failure, the entire
retained tick sequence, absence of a reserved W1 send before recovery, its
actual native arrival, and the duplicate caused by stale retirement
evidence. It names a concrete repair and reproduces both code defects in
isolated tests.

Two historical details cannot be recovered from the retained records: the
subreason inside each later `admissionFor` refusal, and the initiator of the
05:03 host recovery. Searches covered the tick journal, historical/live
registry, lifecycle journal, runtime operations/events, delivery stores,
native/structured transcript events and service journal. No missing
credential or additional current production access can reconstruct decisions
that these paths did not record. The report does not attribute that recovery
to a browser action or claim a specific liveness subreason without evidence.

This completes the read-only audit contract. The production arrival
guarantee and committed regression coverage remain work for the repair
stage; this report does not claim either has been implemented.

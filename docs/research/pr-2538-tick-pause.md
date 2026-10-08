# #2538: the seat pauses its tick while waiting on the operator — what is useful in it

Research date: 2026-10-09. Main read: `419c0f67b3ebf94afe52f81070f31bab647d77c3`
(the pipeline's starting commit, equal to `origin/main` when read). PR head:
`347ffd5a8` on `pipeline/mandate-the-seat-turns-its-tick-off-whil-3bbac5a0`,
merge base `3a8822996`. File:line references name those revisions.

## The requirement

Operator, 2026-10-09 ~02:35 Kyiv, seat chat (verbatim, Russian):

> «То, что было пауза тикера, кстати, я не знаю, надо посмотреть, что там
> такого, может, там что-то интересное. 2459, 2462, я не знаю. Надо
> исследовать, и может быть, да, может быть, что-то, если полезное, то тоже
> продолжить.»

That is: look at what the tick pause holds and continue it if it is useful.
This document covers #2538 only; #2462 has its own document.

## Verdict

**Close #2538 without merging, and hand its one useful residue to lane
58e782ee (#2346) as a regression case.** Reasons, each shown below:

1. The problem it targets does not recur on current main. Since #2486
   (2026-10-03) the tick versions every agenda item and stops re-sending a
   reason that produced no change. An unchanged wait on the operator wakes the
   seat at most twice and then stays quiet (§3).
2. Its only lever is a mandate clause, and the mandate has no bytes left. On
   v41 the clause breaks the envelope bound and both rotation-history budgets
   (§4). Paying for it means cutting other mandate text or shrinking what a
   rotation carries, which is what #2577 depends on.
3. It adds a failure the tick does not have today. A tick the seat turned off
   stops every wake for the project, including the wake for a lane the operator
   unblocks from the card. Nothing turns it back on (§5).

What is worth keeping: the operator-wait case as a test. Lane 58e782ee is
widening the interval reminder for open lanes, and that is the one change in
flight that could bring repeated operator-wait wakes back (§6).

## 1. What the PR changes

Four commits, three files, +59 −18.

| Change | Where (PR head) |
| --- | --- |
| Mandate version 39 → 40 | `src/lib/orchestrator/prompt.ts:91` |
| The v30–v39 contract kept under a name, for exact-match upgrades | `prompt.ts:171` (`SEAT_TICK_CONTRACT_V30`) |
| **The new clause**, appended to the seat tick contract: "Nothing in flight (lane, CI, merge, agent), only an operator answer owed: file the question, seat_tick_settings enabled:false naming the wait; re-enable when work moves." (169 bytes) | `prompt.ts:181-184` |
| The v30–v39 clock section added to `SHIPPED_CLOCK_SECTIONS`, so delivery replaces it in a stored mandate | `prompt.ts:230` |
| Version test → 40, fingerprint for v40 | `prompt.test.ts:80-118`, `:165` |
| `V39_CLOCK_SECTION` fixture and an exact-once upgrade test; clause ≤ 170 bytes | `prompt.test.ts:292-312` |
| Envelope bound relaxed from `MAX − 3 900` to `MAX − 3 700` | `prompt.test.ts:759` |
| Legacy fallback wake bound 1 700 → 1 800 bytes; complete settlements in a cropped legacy wake 4 → 3; the maintenance label now always summarized | `seatTickController.test.ts:2727`, `:6906`, `:6952`, `:7071` |
| The 435-child test counts only complete outcome bullets | `seatTickController.test.ts:4479` |

No controller code changes. The whole mechanism is the seat reading one
sentence and calling a tool it already has. The PR is not draft, has no
review, and was pushed with `LLV_SKIP_HOOKS=1` after the shared host's disk
filled during the native Codex gate (PR body). Hosted checks at the head:
`darwin-identity` failed and the rest passed or were skipped.

**Origin.** The lane `3bbac5a0` has no pipeline record on this board:
`get_pipeline 3bbac5a0` answers "pipeline not found", and `list_pipelines`
with that id answered empty when the seat looked on 2026-10-06 20:01 UTC.
That evening the seat asked the operator in chat and in a question report
whether to review #2538 or leave it alone. The operator answered a different
question, and #2538 has had no owner since. No issue names it, and no
transcript or memory on this machine holds its brief.

## 2. What main already has, by other means

| Mechanism | Where on main | Effect on an operator-only wait |
| --- | --- | --- |
| Agenda item versions (#2486, 2026-10-03): pipeline, task, PR and signal items carry a content hash; a shown version is not offered again | `src/lib/monitor/seatTick.ts:2164-2181` (`agendaVersion`), filter at `:1362-1370` | A parked lane or open PR that does not move is offered once |
| Versioned reasons with nothing unseen are skipped | `seatTick.ts:1384`, `:1390-1391` | An interval wake over only already-shown items is not sent |
| Retry guard: a reason whose wakes changed nothing stops after `retryGuard: 2` | `seatTick.ts:145`, `:1396-1405`, `guardCount` `:911` | Unversioned repeats stop too, with a board card that says so |
| Mandate: "Never wait on the operator inside a wake's turn." and "seat_tick_settings turns the tick off or on … with a reason shown on the board." (v21+) | `src/lib/orchestrator/prompt.ts:163-164` | The seat already has the tool and the permission |
| Mandate reports: "say when you stop the tick or wait on the operator" (v29, #2236) | `prompt.ts:413` | The wait is already reported to the operator |
| Tick off still checks and journals, and sends nothing | `seatTick.ts:1244-1255` | Same as the PR's end state, when someone chooses it |
| The operator's own four-stop tick switch (#2602, merged 2026-10-08) | `src/components/orchestrator/SeatTickChip.tsx`, `src/components/mobile/MobileSeatTickSheet.tsx` | The operator can pause or slow the tick in one gesture |

So main already does the controller's half of the job: an unchanged wait is
deduplicated. The PR adds a seat-side switch-off on top of that.

## 3. Does the problem still happen? Evidence

### 3.1 Deterministic replay of the decision on current main

The tick's decision is a pure function (`seatTickDecision`), so the
operator-wait case can be replayed exactly. The probe ran from an export of the
named commits under the stage's temporary directory, with `HOME`, `TMPDIR` and
`LLV_STATE_DIR` there and `LLV_VIEWER_CONTROL_URL` on a closed port. It
exercised only the decision module; no Viewer and no runtime host ran. It
makes 24 hourly checks (61 minutes apart, default 60-minute interval) over a
board that never moves, and commits each wake as landed:

```ts
// probe.ts <tree>: hourly checks over 24 h with a board that never moves.
const { seatTickDecision, seatTickWakeCommit, seatTickWakeCommitPlan, DEFAULT_SEAT_TICK_POLICY,
  SEAT_TICK_WAKE_INTERVAL_MS } = await import(`${root}/src/lib/monitor/seatTick.ts`);
// A: one lane parked on an operator decision (state "inert", design stage)
// B: one ready PR from a finished lane, waiting for the operator's merge word
// C: both
for (let h = 0; h < 24; h++) {
  const d = seatTickDecision({ /* board above */ now: NOW + h * 61 * MIN, changeFingerprint: "unchanged", state, ... });
  state = d.verdict.kind === "wake"
    ? seatTickWakeCommit(d.state, seatTickWakeCommitPlan(d.verdict, { fingerprint: "unchanged", eventsThrough: 0 })!, now)
    : d.state;
}
```

| Board that waits only on the operator | main `419c0f67b` | lane 58e782ee head `9b9a1db23` |
| --- | --- | --- |
| A. lane parked on a decision | 2 wakes in 24 h: hour 0 `interval`, hour 1 `stalled` ("pipeline … is parked"); then `quiet — nothing owed` | same 2 wakes, then quiet |
| B. ready PR waiting for a merge word | 1 wake (`unmerged-pr`), then quiet | 1 wake, then quiet |
| C. both | 2 wakes, then quiet | 2 wakes, then quiet |
| Empty board, seat's own proposal unanswered | at most one `proactive` wake per 24 h (`proposalIntervalMs`, `seatTick.ts:143`, `:1521-1525`) | unchanged |

The repetition #2538 describes, the same unchanged wake every interval, does
not occur. The wakes that remain are the first sighting and the stall
confirmation. The PR's clause would act during the first of them, so even with
it the seat saves at most one wake per wait.

### 3.2 What the seat actually received, 2026-10-02 … 10-08

The seat-tick run journal (`state/seat-tick/runs.ndjson`) is live state and no
Delegatus tool exposes it, so it was not read. `lifecycle_events` has no seat
tick event type ("unknown lifecycle event type"). What was read: the seat's
own transcripts, located through `search_transcripts` and read in place,
with every user record starting "Seat tick — " taken as one delivered wake,
along with the seat's tool calls up to the next operator message.

- 189 distinct wakes from 2026-10-02 16:50 to 2026-10-08 23:11 UTC.
- 44 had no mutating call (no `create_pipeline`, `pipeline_action`,
  `update_task`, `spawn_agent`, `send_message*`, `create_task`, deploy or
  tick change):
  - 31 on 10-02 … 10-04, at the 15-minute running-children cadence, while
    three to four lanes were in flight ("Усі чотири лінії…", "Три лейни
    працюють, нових подій немає"). That is in-flight work, which the PR's own
    clause excludes ("Nothing in flight").
  - 10 on 10-07 21:48 … 10-08 06:53, each answered "Failed to authenticate:
    OAuth session expired". The cause was an expired seat login, which #2617
    (merged 2026-10-08) now reports and recovers.
  - 3 more on 10-06 and 10-08, each with 13 lanes moving, or a deploy report
    just filed.
- Twice the seat ended a wake on an ask that only the operator could answer,
  2026-10-06 20:54 and 22:50 UTC (a fresh login link for a measurement). The
  next wakes, 45 and 64 minutes later, each carried other news, and the seat
  made 17 and 11 mutating calls in them.

None of the 189 wakes was a repeated idle wake over an operator-only wait.

## 4. What finishing it would cost on v41

Measured on the merge of main and the PR head (`git merge-tree`), exported to a
temporary directory. Conflicts were resolved mechanically: version 42, main's
test bounds kept. Tests ran by path with isolated `HOME`, `TMPDIR`,
`LLV_STATE_DIR` and `XDG_CONFIG_HOME`, and with `LLV_VIEWER_CONTROL_URL` on a
closed port. The controller file ran through `scripts/gate-slot.sh`.

**Conflicts.** `prompt.ts`: one hunk (version 41 vs 40). `prompt.test.ts`: four
hunks (version test, stale assertions, fingerprints 40/41 vs 40, envelope
comment and bound). Main took v40 (#2530, issue reports) and v41 (#2544,
prototype review) after the PR's base. The clock section has not changed since
v30, so the PR's `V39_CLOCK_SECTION` fixture text still matches; only its name
and the "v30–v39" comment go stale. The review-budget lane (3c2b56d1)
already plans v42 (`docs/design/review-budget-cap-and-merge.md:175-191` on its
branch), so this would be v43 and conflict again.

**Budgets: four failures after the mechanical resolution.**

| Test | Bound | Main | With the clause |
| --- | --- | --- | --- |
| `prompt.test.ts` "the role table keeps the delivered default inside the structured envelope" | delivered < 29 400 (`MAX − 2 600`) | 29 379 | **29 549** |
| `prompt.test.ts` "any edit to the default mandate text moves its version" | fingerprint | — | new fingerprint `e4f243d3…` (mechanical) |
| `handoffDigest.test.ts` "the delivered default mandate fits the delivery bound with room for a rotation's history and handoff" | history room > 4 096 (`HISTORY_BUDGET_BYTES`) | passes (about 4 111) | **3 941** |
| `handoffDigest.test.ts` "what delivery appends stays inside its share of the envelope" | ≤ 14 900 | 14 823 | **14 993** |

Relaxing the first bound to `MAX − 2 450` still leaves the two rotation
budgets red. Finishing therefore means cutting about 170 bytes of other mandate
text, or accepting that a rotation carries less than one full history budget.
The PR's own body measured 3 787 bytes of room at its base; main has spent
about 1 200 of them since (#2518 alone took 1 100).

**Controller tests carry over.** `seatTickController.test.ts` on the merged
tree and on main fails the same 34 cases, all in "seat authentication recovery
through production seams" in this sandbox (the failure sets are identical by
name). The five tests the PR edits pass on the merged tree.

**Every legacy-seat wake loses 170 bytes.** A seat whose mandate predates the
contract gets the clauses inside each wake (`seatTickController.test.ts:2723`).
The PR measured the fallback wake at 1 770 bytes and raised its bound. A
cropped legacy wake then fits three complete lane settlements where it fitted
four, so the fourth waits for a later wake.

**Size of the remaining work:** the conflicts, one byte-budget decision, a
rewrite of the clause, the hazard in §5, then review. Every seat receives the
change, on its next spawn, adoption or rotation. Review risk is above its
size: a mandate edit changes every seat's behaviour, and this one makes the
seat silence its own clock.

## 5. The hazard the clause introduces

`enabled:false` stops every wake for the project (`seatTick.ts:1244-1255`
returns before any candidate is composed). Nothing re-enables it on its own.
Only `seat_tick_settings` (`src/lib/mcp/bindings.ts:4169`) and the panel route
(`src/app/api/monitor/seat-tick/settings/route.ts:143`) write the setting. The
clause's "re-enable when work moves" needs a seat turn, and with the tick off
only a message to the seat starts one.

The operator often answers somewhere other than the seat's chat:
`resolve-decision` from the card or the "needs you" panel resumes the lane
directly (`src/app/api/pipelines/[id]/route.ts:30`, `:127-135`). The
prototype choice from #2544 tells the seat, but a stage decision does not.
Then the lane runs, completes and leaves a PR, and no wake reaches the seat.
This is exactly the silent stop that the tick's design keeps calling out ("a
tick that broke says nothing at all", `seatTick.ts:1237-1243`). A
seat-initiated switch-off would need an expiry (`untilMinutes`) or a
controller-side re-enable on operator activity. Both add machinery to save at
most one wake per wait (§3.1).

## 6. Relation to the open lanes

**Seat wake and tick, #2346 (lane 58e782ee, at build).** Its design
(`docs/design/seat-tick-idle-wakes-2346.md` on its branch) finds that the
retry guard stops the running-work cadence after three wakes (its C2). Its fix
(`seatTick.ts` on `9b9a1db23`) exempts `interval` from the guard while
`hasPeriodicWork` holds, and re-offers lanes and live children as periodic
items. A parked lane counts as an open lane (`isOpenLane`, `seatTick.ts:184`).
It stays quiet today only because its item carries a stall token, which the
periodic filter excludes (§3.1, column 2). That filter is the one guard
between #2346's change and a parked-on-the-operator lane waking the seat every
interval. The useful residue of #2538 belongs there: one decision test with
one lane in `inert` state, unchanged for 24 checks, expecting no wake after
the stall wake, on the branch before it merges. This adds a test; the lane's
design stays as it is.

**Seat auto-rotation, #2577 (lane afc9c5cc, at build).** Two contacts.
(a) Bytes: the clause takes the rotation history below `HISTORY_BUDGET_BYTES`
(§4), and auto-rotation makes rotations routine, so the history it carries
matters more. (b) Its design rotates an idle seat while wakes are off
(`docs/design/seat-auto-rotation.md:252-256` on its branch). A successor
seated over a tick the incumbent switched off inherits the off setting. The
tick's operator instructions reach a seat only on a scheduler-fired wake, so
the successor never reads why the tick is off. #2538 would make that case
common; without it, it stays rare.

**Review budget (lane 3c2b56d1, at build).** It edits the merge-bar and review
lines of the same mandate and claims v42. It saves 52 bytes, too few to fund
this clause. Continuing #2538 would rebase on it and conflict on the version
and fingerprint again. Nothing in #2538 bears on the review cap itself.

## 7. Options

| Option | What it takes | Trade-off |
| --- | --- | --- |
| **A. Close #2538; give lane 58e782ee the operator-wait test (recommended)** | The seat closes the PR with a pointer to this document (no MCP tool closes PRs, so a merger or the forge does it) and messages the 58e782ee builder one test case | Saves at most one wake per operator wait, which main already almost achieves; no mandate bytes, no new silent-stop path |
| B. Continue as written | Rebase to v42/v43, cut about 170 bytes elsewhere in the mandate or reduce the rotation history, re-measure the legacy wake, add an expiry or re-enable path for §5, review | Saves one wake per wait for a 170-byte, every-seat behaviour change plus new machinery |
| C. Keep the idea in the controller (no mandate text) | Nothing today: §3.1 shows the controller already stops after the stall wake | Revisit only if lane 58e782ee's periodic reminder starts re-offering parked lanes |

## Deferred — not currently justified

- **A seat-initiated tick switch-off for operator waits** (the PR's clause).
  It saves at most one wake per wait on current main, costs 170 mandate bytes
  the envelope does not have, and opens the silent-stop path in §5.
- **An expiry on a seat-initiated switch-off** (`untilMinutes` in the clause).
  It only exists to repair the clause's own hazard.
- **A controller re-enable on operator activity** (`recordOperatorRequest` on
  `resolve-decision` turning the tick back on). This is new coupling between
  pipeline actions and tick settings, with no case that needs it while the
  tick stays on.
- **A distinct "waiting on the operator" quiet state in the tick.** Main's
  dedupe already goes quiet. A separate state would only change the journal
  wording.
- **Carrying the PR's test-robustness edit** (`seatTickController.test.ts:4479`,
  counting only complete outcome bullets). It is harmless, but the test it
  hardens passes on main without it. If a cropped-bullet miscount ever shows
  up, it is a one-line change.

## Checks run, and the one not run

- `git diff` of the PR against its merge base and against `origin/main`;
  `git merge-tree` for conflicts; the version history of
  `ORCHESTRATOR_PROMPT_VERSION` (`git log -S`): v38 #2449/#2483, v39 #2483,
  v40 #2530 (2026-10-06), v41 #2544 (2026-10-07).
- Decision replay (§3.1) on main and on lane 58e782ee's head; `prompt.test.ts`,
  `handoffDigest.test.ts` and `seatTickController.test.ts` on the merged tree,
  and the latter two on main, all isolated as described. The only process
  exercised was the `bun test` and `bun` processes running those modules; no
  Viewer and no runtime host was started.
- `seat_tick_settings` read for this project: on, default 60 minutes, last
  written by the seat on 2026-10-08 23:36 UTC; no fence.
- `search_transcripts` ("seat turns its tick off", "unchanged wake operator
  answer tick off idle", "seat_tick_settings enabled:false operator", Russian
  phrasings) and `search_memory` ("seat tick off while waiting on operator",
  "seat tick wake"). Nothing earlier solved or discussed this. The memory hits
  concern the tick's key bound, monitor-prompt cap and diagnosis recipe.
- **Not run:** reading the live seat-tick run journal. No Delegatus tool
  exposes it, and the brief forbids live state. The seat's transcripts stand
  in for it (§3.2): they show what was delivered, but not checks that ended
  quiet.

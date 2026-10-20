# Pre-push touched-test gate under load

Originating requirement: the operator's messages of 2026-10-19 05:55Z and
2026-10-20 about 08:30Z, in a private chat. They are not quoted here because
the conversation is private. The task that carries them asks for this outcome:
the touched-test comparison in the pre-push gate, run locally and by the
publisher, returns a complete verdict under the machine's normal busy load.
It must not weaken what the gate checks: no new failure may pass unseen, and
privacy, types, lint and refusal behaviour stay as they are. Its acceptance
asks for zero per-file 300 s expirations and a P90 complete-gate time under
10 minutes, in 30 runs at load 25–30.

Written against `main` at `144c87e12`. Every file:line below is on that commit.
Earlier work: `docs/verification/pre-push-touched-tests.md` (#3106, #3123)
raised the head workers to eight and widened the publication window. Neither
change touched a test's own cost.

## Summary

| | |
| --- | --- |
| Cause | Two limits sit at the cost of the tests themselves. (a) The heaviest engine files are single-threaded and need 207–296 s of CPU. `engine.providerReset` uses 98% of the 300 s file budget at load 19 and at load 27. (b) Many engine tests take 5–14 s under load against bun's default 5 s per-test timeout. A timed-out test keeps running and breaks every test after it in the file. That cascade does two things: it pulls the gate into baseline, diagnostic and confirmation runs, and it ends two more heavy files early, which hides their real cost. Under load it can even refuse unchanged main (E2). Lifting only the timeout (E3) uncovers that hidden cost: four files expire at 300 s and the run hits its 900 s deadline. Quotas never throttled (at most 0.1 s per test file), and the work slice used 4.6–9.4 of its 18 CPUs. |
| Fix | (1) A 60 s default per-test timeout in the shared test command and gate callers, and 60 s for the three explicit 30 s timeouts whose tests reached 20.7–30 s. (2) Split the ten engine files whose head run exceeds half the 300 s budget into parts of at most 150 s. (3) The per-file line marks a file that exceeds half its budget. The budgets, the eight head workers, admission and the verdict rules stay as they are. |
| Proof | 30 after-runs and 10 before-runs of the real pre-push hook on the same lane branches at load 25–30 (§3). |

## 1. Measured root cause

### Conditions

- Machine: 24 logical CPUs (i9-12900K: 8 P-cores with two threads each,
  CPUs 0–15, and 8 E-cores, CPUs 16–23), `powersave` governor.
- Placement, read from the kernel during the runs: each test file runs in its
  own `delegatus-gate-<uuid>.service` in `delegatus-agents-work.slice` with
  `cpu.max 60000 20000` (300%) (`scripts/owned-runner.ts:127`). The slice has
  `cpu.max 360000 20000` (1800%). On this installation agent CPU placement is
  off (`DELEGATUS_AGENT_CPU=off` in the service environment since 2026-10-07):
  every agent host is a weight-100 scope in `delegatus-agents.slice` with no
  quota, and all gates share one weight-100 work slice beside them.
- Gate: unchanged `scripts/gate-slot.sh` → `scripts/local-gate-tests.ts`, 8
  head workers (`scripts/local-gate-tests.ts:43`), 300 s per file (`:39`).
  E3 alone used a scratch copy of the runner that adds `--timeout=30000` to
  `bun test`. E2 and E3 also kept each file's output and JUnit report.
- Selection: the 29 `src/lib/pipelines/engine.*.test.ts` files, which is what
  a change to `engine.ts` selects (`scripts/local-gate.ts:77-81`). Head = base
  commit `144c87e12`, compared against `HEAD~1`.
- Isolation: scratch clone, private HOME, XDG_CONFIG_HOME, TMPDIR and
  LLV_STATE_DIR, `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`.
- A 2-second sampler read each runner service's `cpu.stat` (usage,
  `throttled_usec`) and `cpu.pressure` (`some` total = time runnable but not
  running), the work slice's counters, and the 1-minute load.
- Load: E2 and E3 added transient sibling scopes in `delegatus-agents.slice`
  (weight 100, no quota, two spinning processes each), standing in for busy
  agents. They started once the gate was admitted and stopped at its verdict.
  The number was chosen from ambient load: E2 had three, E3 two.

### Runs (seconds)

| Run | Load min/median/max during execution | Outer admission | Head | Baseline | Diagnostic + confirmation | Comparator wall | Work-slice CPUs avg / throttled | Verdict new/pre-existing/flaky |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| E1 ambient | 12.2 / 19.0 / 30.2 | 212.5 | 444.6 | 150.5 | 173.8 | 768.9 | 9.4 / 1.2 s | pass 0/7/153 |
| E2 three burner scopes | 12.5 / 27.2 / 39.5 | 202.4 | 471.3 | 186.0 | 229.1 | 886.4 | 6.7 / 0.0 s | **refuse 2**/56/63 on unchanged main |
| E3 two scopes + 30 s test timeout | 16.0 / 23.8 / 57.9 | 250.6 | 578.0 | > 375 | — | > 953 (owned 900 s deadline) | 4.6 / 0.0 s | **none**: 4 files expired at 300 s |

The phases add up to the comparator wall. The comparator also credits 52–62 s
of "CPU admission". Those are waits reported by tests that exercise CPU-queue
fixtures; they fall inside the phase times and add no wall time. The head never
came out green on unchanged main, so every run paid for a baseline. E3's
ambient load spiked to 57.9 midway, so it does not count as a load 25–30 run.

### Heavy files (seconds; wall from the comparator, CPU and stall from the file's own cgroup)

| File | Solo (`taskset`), load 13–16 | E1: wall / CPU / stall | E2: wall / CPU / stall | E3: wall / CPU / stall |
| --- | --- | --- | --- | --- |
| `engine.providerReset` | 229.3 on P-cores, 212.7 on E-cores | 295.5 / 294.0 / 1.9 | 293.7 / 278.7 / 5.7 | **300.2** / 244.1 / 19.0 |
| `engine.providerBudgetPoolOutput` | — | 251.2 / 250.3 / 2.6 | 242.9 / 228.1 / 6.5 | **300.3** / 240.6 / 19.7 |
| `engine.providerBudgetOutput` | — | 253.2 / 252.6 / 2.2 | 248.3 / 233.6 / 6.4 | 126.0 / 92.3 / 15.1, cut short by a 30 s timeout |
| `engine.ports` | 279.1 (load 48) | 228.2 / 205.4 / 3.5 | 242.0 / 181.0 / 8.5 | **300.3** / 188.5 / 16.3 |
| `engine.providerBudgetChains` | 129.0 | 9.5, cascade (62 fail) | 25.5, cascade (59 fail) | **300.2** / 235.0 / 19.7 |
| `engine.succession` | — | 207.4 / 207.8 / 0.3 | 225.5 / 218.7 / 1.6 | 229.0 / 222.4 / 1.6 |
| `engine.providerChains` | 25.7, cascade (43 fail) | 11.9, cascade (47 fail) | 11.6, cascade (47 fail) | 200.7 / 137.2 / 19.7 |
| `engine.recoveryAuthority` | — | 161.2 / 151.8 / 1.3 | 164.2 / 142.8 / 3.3 | 189.6 / 159.0 / 5.5 |
| `engine.recovery` | — | 134.0 / 124.5 / 1.7 | 131.2 / 112.7 / 3.5 | 157.1 / 126.1 / 5.8 |
| `engine.recoveryAdmission` | — | 130.8 / 121.5 / 1.4 | 127.6 / 110.7 / 2.9 | 153.7 / 124.2 / 4.2 |

No file's own 300% quota ever throttled it: 0.0 s for every file above, at
most 0.1 s for any test file in any run, and 0.8–1.3 s for the comparator's
own service. At the commit #3106 measured (`89fb1d290`),
`engine.providerReset` took 201.2 s on E-cores at load 16.5, the same cost
as today: the file has sat close to the limit since then. A lane's pre-push
run on 2026-10-20 shows the same files expiring at 300.2–300.3 s, with
`engine.succession` at 293.3 s.

### Where the time goes

1. **File size.** At load 19–27 each heavy file keeps one CPU busy
   for its whole wall time (CPU/wall 0.94–1.00). It is never throttled, and
   run-queue stall stays under 3.5% of wall. The CPU cost of the same work
   rises about 30% between a solo run at load 15 (213–229 s) and eight
   concurrent files at load 19–27 (279–294 s), because shared cores run each
   thread slower. That leaves `engine.providerReset` 1–2% below the budget,
   and a slower moment expires it. In E3, during the spike to load 58,
   CPU/wall fell to 0.63–0.81. Stall accounts for 16–20 s of that; the rest
   is off-CPU time I did not attribute (I/O pressure was not sampled).
2. **Per-test timeouts cascade.** These tests run under bun's default 5 s
   timeout (`bunfig.toml` sets none). Under load the first test of
   `engine.providerBudgetChains`, `engine.providerChains`, `engine.ports` or
   `engine.activation` takes 5.0–6.8 s and times out. Bun moves on while the
   timed-out test keeps writing the shared store, so the next tests fail in
   about 50 ms each (`pipeline.runs[0].attempts[0]` undefined): 43–62
   failures per file, plus between-tests errors. `engine.providerChains` does
   this even solo at load 16. Consequences:
   - the baseline reruns those assertions, and 59 failing assertions amount to
     a full file (184 s);
   - a between-tests error forces full-file diagnostic runs (176 s);
   - flaky confirmation rounds follow (174–229 s);
   - in E2, a different test timed out on the diagnostic retry, and the gate
     refused unchanged main with 2 "new" failures. In E2, every failure outside
     the six deterministic ones below began with a 5 s timeout, whether the
     comparator labelled it flaky (63), pre-existing (both sides timed out) or
     new. E1 kept no logs to check.
3. **The cascade hides cost.** With a 30 s default (E3), the two cascading
   files run in full:
   - `engine.providerBudgetChains`: 25 s → 300 s, expired;
   - `engine.providerChains`: 12 s → 201 s.

   The head grew to 578 s, four files expired, and their full-file base
   diagnostics ran the owned runner past 900 s. Per-test durations from E3's
   JUnit reports (1,600 cases in completed files): 44 over 5 s, 18 over 10 s,
   9 over 15 s. The slowest tests that rely on the default took 12.6–13.9 s.
   One test with an explicit 30 s timeout timed out during the spike
   (`engine.providerBudgetOutput.fixture.ts:97`); its siblings took up to
   25.6 s.
4. **Base rerun is a consequence.** The baseline only runs for failing heads.
   Without cascades and expirations it covers only the six deterministic
   failures (below), at 1–6 s each.
5. **Concurrent gates leave the slice half idle.** The work slice averaged
   4.6–9.4 CPUs out of 18, with 0–1.2 s throttled per run.
6. **Head order.** Files run alphabetically. A replay of the measured
   per-file times reproduces all three heads (445, 471 and 578 s).
7. **Admission.** It cost 202–251 s before the comparator started (6 shared
   slots, a 9–13-deep queue). Admission is excluded from the execution budgets
   by design and belongs to the fenced CPU queue
   (`src/lib/runtime/cpuAdmission.ts`).

Six tests fail deterministically on main inside the gate's environment, on
both sides:

- `engine.creation`: linked checkouts serialize Git writes (`.git/hooks` ENOENT);
- `engine.controllerPass`: a bounded reconciliation preserves another lane's
  CPU ticket (`pipeline evidence changed during preparation`);
- `engine.activation` #1692;
- `engine.provisioning` #522;
- two `engine.routing` cases (`flow store busy`).

They cost little, because a pre-existing failure takes no reruns, but they mean
no engine push has a green head. They are separate defects (see Deferred). E3
also showed one failure that was not a timeout and that it never got to
classify: `engine.provisioning`, a due busy wait surviving a restarted
controller race.

## 2. Fix

E2 and E3 together show that neither change works alone. The timeout without
the split expires four files (E3). The split without the timeout keeps the
cascades, the false refusal and the hidden cost (E2).

1. **Per-test timeout 60 s.** Pass `--timeout=60000` in the comparator, all
   three merger call paths, and the package test command. Multi-file platform
   CI and direct runs use `bun run test <explicit files>`. The implementation
   rehearsal found that Bun 1.4.0 ignores `[test] timeout = 60000`: the two
   provider-chain files still timed out at 5000 ms. A preload calling
   `setDefaultTimeout` also loses its override after the first file
   ([upstream report](https://github.com/oven-sh/bun/issues/45192)). The CLI flag
   applies to every file and retains explicit per-test timeouts. Raise to `60_000` the three explicit `30_000` timeouts whose
   tests reached most of that limit in E3:
   - `src/lib/pipelines/engine.providerBudgetOutput.fixture.ts:97`: up to
     25.6 s, and one test timed out;
   - `engine.providerSignals.test.ts:68`: 24.4 s;
   - `engine.controllerPass.test.ts:86`: 20.7 s, a test that holds a real
     20 s job.

   The full implementation rehearsal exposed another existing limit: the
   72-hour missing-reset simulation took 99.7 s and failed its explicit 90 s
   timeout after the split. Its timeout is 150 s in
   `engine.providerReset.part2.test.ts`; its assertions and the 300 s file
   deadline are retained. The earlier 300 s file expirations hid this cost.

   The CLI flag covers the gate's head and base samples, its
   reruns, the merger's own `bun test` calls
   (`scripts/merge-batch.ts:358,669,709`), CI and the direct package command, so a
   test passes or fails the same way everywhere.
   Other explicit timeouts stay unless the protocol shows one tripping. Sizing:
   the worst test on the default took 13.9 s and the worst on an explicit
   timeout 25.6 s, in E3 with spikes to load 58. 60 s leaves 2.3× to 4.3×
   margin. A hanging test still fails, after 60 s, inside the unchanged 300 s
   file budget. The only check given up is "this test finishes within 5 s",
   and that already failed on unchanged code under load.
2. **Split every engine file whose head run exceeds 150 s** (half the file
   budget) into parts of at most 150 s, balanced by the per-test times in a
   full run's JUnit reports:
   - three parts each: `engine.providerReset`, `engine.providerBudgetOutput`,
     `engine.providerBudgetPoolOutput`, `engine.ports`,
     `engine.providerBudgetChains`, `engine.succession`;
   - two parts each: `engine.providerChains`, `engine.recoveryAuthority`,
     `engine.recovery`, `engine.recoveryAdmission`.

   The implementation calibration ran the original cases with the effective
   timeout. It measured 304–308 s for both output files and 370 s for
   succession, so those three files each need three parts for the 150 s target.

   The two provider-output files split through engine and activity parameters of
   `registerProviderOutputBudgetCases`. Every part keeps the `engine.` prefix,
   so an `engine.ts` change still selects it. The parts' JUnit totals must
   equal the original file's (same names, same count). A replay of E3's head
   times, including its spike, projects the longest file at 140 s and the
   8-worker head at 465 s. Add the six deterministic baseline failures at
   1–6 s, and a run without new flakes completes in about 475 s.
3. **Mark files that are growing back.** The per-file line at
   `scripts/local-gate-tests.ts:319` appends `over half the 300 s file budget;
   split it` when a head file passes 150 s. It is a hint and blocks nothing.
   The provider-budget files were split once before (`9b31bf1bc`) and grew back
   to the limit.

Unchanged: the 300 s file, 900 s run and 300 s confirmation budgets; eight
head workers; CPU quotas; admission and queue order; the verdict, refusal and
flaky rules; privacy, types and lint.

Both gates get the same logic. Delegatus's publication and an agent's own push
both run `.githooks/pre-push` → `scripts/local-gate.ts` →
`scripts/local-gate-tests.ts` from the checkout being pushed, and `bun test`
uses that checkout's comparator command. A branch picks up the fix when it merges
main. Until then, its publication runs the old hook. Lanes that edit one of the
split files will have a merge conflict to carry into the parts. The only open
PR that touches the gate's files (#2926: `scripts/gate-slot.sh`,
`scripts/owned-runner.ts`) changes neither the runner command nor these tests.

### Rejected

| Alternative | Why not, from the measurements |
| --- | --- |
| Timeout change alone | E3: four 300 s expirations and no verdict. |
| Split alone | E2: the 5 s cascades remain, with 186 s of baseline, 229 s of confirmation and a false refusal of unchanged main. The split files would still cascade. |
| Size workers to the scope's CPU quota | No quota throttled: at most 0.1 s per test file, 0–1.2 s for the slice. Fewer workers lengthen the head; the replay gives 641 s at 4 workers versus 445 s at 8. |
| CPU time instead of wall time in the deadline | At load 19–27 the heavy files run at 0.94–1.00 CPU per wall second, so CPU time is the same 279–294 s and still at the limit. It does nothing for per-test timeouts. |
| Per-file budget derived from measured cost, or simply raised | It keeps the check only by stretching the worst case. A growing file stays invisible, and the head tail does not shrink. Splitting keeps 300 s and cuts the tail. |
| Cache base results per base commit | The base cost came from cascades and expirations, which the fix removes. Caching is also explicitly ruled out by the project's gate rules (no baseline results are cached). |
| Raise only the gate's timeout (`--timeout` in `runFiles`) | It misses the merger and agents' direct runs, which hit the same cascades, so the gate would disagree with every other runner. |
| Turn agent CPU placement on, or raise the work slice's weight | Stall, the only thing weight changes, was at most 3.5% of wall at load 19–27. It is the operator's installation setting and outside this fix. |
| Longest-first head order | Needs a cost table per file. After the split, the replay gives 465 s alphabetical against 434 s longest-first. Not needed for the target. |

## 3. Measurement protocol for acceptance item 3

**Branches.** Three lane branches captured at the start, each changing
`src/lib/pipelines/engine.ts` so the whole engine family is selected. Record
their head SHAs in the evidence. If one of them has a real failing assertion,
keep it, because it exercises the baseline path.

**Sides.** M0 is main before the fix and M1 is main with it.

- Before: the branch merged with M0, with `origin/main` = M0.
- After: the same branch merged with M1, with `origin/main` = M1.

Each side lives in its own scratch clone. Its `origin` is a local bare repo
with `main` pinned to that side, so the hook's fetch cannot move it. The stage
forbids scratch commits: compute each merged tree with `git merge-tree`, check
out the existing main revision detached, and export the merged tree into its
index and working tree with `git read-tree --reset -u`. The hook includes both
staged and working-tree changes. Record the captured lane SHA, main SHA and
merged tree hash. No measurement creates a commit or pushes a ref.

**Command.** Run the real hook from the clone root:
`bun scripts/local-gate.ts pre-push`, with private HOME, XDG_CONFIG_HOME,
TMPDIR and LLV_STATE_DIR and `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`.
Run one hook at a time, with nothing else of yours on the machine.

**Load.** Load must be 25–30 for a run to count.

- At admission, when `pre-push: CPU admission for publication checks` gives
  way to the first step, read the 1-minute load as `a`.
- Start `n = max(0, round((27 − 8 − a) / 2))` sibling scopes:
  `systemd-run --user --scope --slice=delegatus-agents.slice -p CPUWeight=100 -p MemoryMax=256M`,
  two spinning processes each.
- Stop them by their recorded unit names at the verdict.
- Sample load every 2 s. A run counts only if its median load during execution
  is 25–30. Record every other run too, but repeat it.

**Order.** Do 30 after-runs, cycling through the three branches, and one
before-run after every third after-run: 10 before-runs, alternating so both
sides see the same conditions. Each run took 15–20 minutes here including
admission, so the 40 runs need about 12 hours.

**Per-run record**, added to `evidence/perf/pre-push-touched-tests.json` and
`docs/verification/pre-push-touched-tests.md` (no new driver files):

- side, branch, head and base SHAs, selection size;
- `a`, `n`, load min/median/max;
- outer admission (hook start to admitted start);
- complete-gate time (admitted start to verdict line);
- the comparator's `timing` line;
- head, baseline and confirmation walls;
- each file's wall, complete/incomplete, and the half-budget marker;
- verdict counts and each NEW line;
- for each file, cgroup CPU, `throttled_usec` and `cpu.pressure` from a
  2-second sampler reading the runner services in the work slice.

**Pass criteria**

- Across the 30 counted after-runs, no file reports `runner did not finish
  (124)` or `incomplete` at ≥ 300 s.
- P90 of complete-gate time (27th of the 30, sorted) is under 600 s. Outer
  admission is reported beside it and excluded, as the gate's budgets exclude
  it; it measures the depth of the fenced CPU queue.
- No after-run on an unchanged branch reports a NEW failure. Every NEW that a
  completed before-run reports also appears in the after-runs of that branch.
- Two controls run on the after side at load 25–30 and must refuse: an engine
  test with a broken assertion, and an engine test that never resolves (it
  must fail at 60 s).
- The before-runs show the current expiration and P90 rates on the same
  branches.

If P90 misses while expirations are zero, the next knob is ten head workers:
the replay gives 393 s, and the slice had 8–13 CPUs to spare. Measure it
under the same protocol before changing it.

## Deferred — not currently justified

- **Cancel a timed-out test's work** so that one timeout cannot cascade into
  the next tests (a harness change in `engine.fixture.ts`). At 60 s, timeouts
  should be rare. Revisit if the protocol still shows any.
- **Fix the six deterministic failures on main** listed in §1. Each is its own
  defect; the seat should file them. They do not affect the time targets,
  because pre-existing failures take no reruns.
- **Engine tick cost in tests.** `engine.providerBudgetOutput` runs about 190
  simulated ticks per test, at about 16 s per test, so about 80 ms of CPU per
  tick. Making ticks cheaper would shrink every engine file. That is product
  engine work and needs its own measurement.
- **Outer admission (202–251 s)** belongs to the CPU queue lane.

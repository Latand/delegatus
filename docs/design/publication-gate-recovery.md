# Publication gate recovery under load

## Measurements before implementation

The retained logs and one controlled run on 2026-11-11 (UTC) gave these
measurements. The controlled run used the source at `1037130e`, a detached
clone with its own gate caches, and an uncommitted comment in
`src/lib/pipelines/engine.ts`. It selected 67 engine test files. All state,
homes and temporary files were isolated; the remote gate runner was disabled.

| Observation | Types | Lint | Touched tests | CPU admission inside the hook |
| --- | ---: | ---: | --- | ---: |
| Earlier engine publication that day | 578 s | 20 s | 900 s execution budget exhausted; 58 file summaries; 41 green files; baseline never started | 33.045 s |
| Controlled run, 15:26:50 to 15:42:29 | 636 s | 7 s | Same budget exhaustion; 58 summaries; 41 green files; 13 incomplete files; baseline never started | 33.643 s |

The controlled hook took approximately 939 seconds. Its outer measurement
command waited another 268 seconds for admission before starting the hook.
Types and tests ran concurrently. Privacy passed; the hook does not print that
phase's duration. The selected Linux backend and Linux test phases were stopped
before running when touched tests failed. The runner also reported an owned
survivor during teardown; its recorded process was absent on inspection after
the run. The run is a failure, including its cleanup observation.

One-second samples covered all 58 reported head-file cgroups. Load1 ranged
from 30.1 to 120.5 on 24 logical CPUs. Across the observed lifetime of those
cgroups, weighted `cpu.pressure full` stall time was 5.6%, with a median of
5.3% and a maximum of 9.5%. Sampling omits the beginning and end of some unit
lifetimes. These figures describe this loaded run; they establish no idle
machine comparison or throughput gain.

The earlier report's 271 files were discovery candidates. The planner selected
67 engine siblings plus three changed tests. The shared fixture selected zero
additional files. CPU admission is already excluded from the hook, comparator
and publisher execution budgets. The observed missing behavior was automatic
recovery when the comparator itself exhausted its budget.

## Caller behavior and implementation

Keep the accepted head while publication retries. The publisher uses its
existing persisted delays of one, five and fifteen minutes. After those
retries it parks with the cause. An uncertain remote write still requires
reconciliation before another write.

The comparator throws `BudgetExhausted` when its aggregate budget, baseline
setup budget or filtered file execution budget expires. Its CLI prints
`touched-tests: no verdict:` and exits 75. Ordinary comparator errors retain
exit 1. The publisher also recognizes the exact budget diagnostics emitted by
older accepted heads. Assertions, other failed checks, privacy findings and
failed cleanup remain decisive.

After every worker settles, an aggregate interruption retains any file-level
error already observed. The comparator reports that diagnostic with exit 1
alongside the interruption reason, so a cleanup refusal still prevents a
publisher retry. A runner deadline alone retains the capacity-retry behavior.
The same precedence applies after the baseline comparison: a new file or
ownership error stays in the blocking output if assertion confirmation or the
full-file diagnostic retry later times out. A repeated or newly observed error
from a completed diagnostic retry also remains decisive. Matching pre-existing
errors keep their comparison policy; a between-tests error still owes its
existing full-file retry before it becomes decisive.
New assertions established by that complete retry also retain their `NEW`
identity and reason when a later confirmation expires, is cancelled, or
refuses ownership or cleanup. They return exit 1 and prevent automatic retry.
Initial assertions still owe filtered confirmation; a deadline with no
established refusal retains exit 75. The process controls in
`scripts/local-gate-tests.retry.test.ts` exercise both outcomes across fresh
comparator processes with a fixed clock and test schedule.
The checkpoint controls exercise both a real surviving child followed by
aggregate expiry and a clean expiry that resumes green files in a new process.

Completed green head files remain reusable under the existing source,
selection, environment, toolchain and cleanup checks. A fresh comparator
process resumes the remaining files. Every failing file still receives the
existing baseline comparison and confirmation rules. Green heads retain the
existing policy that needs no baseline sample. Selection, worker defaults,
per-file limits, aggregate limits and confirmation limits remain unchanged.

A privacy report containing only `configuration_error` proves that the scanner
could not judge the commits. The publisher computes this fact from complete
output before redaction and clipping. It removes the exception if changed
paths cannot be read or include `scripts/privacy-*` or
`scripts/generate-privacy-*`. Another decisive check refusal also prevents the
exception. The settled result carries `privacyConfigurationFault: true` and
`outcome: not-landed`; the existing recovery path records an interruption and
retries without requesting a producer repair. A real privacy finding retains
its refusal. The scanner and its rules are unchanged.

## Acceptance controls

| Item | Change or retained behavior | Control |
| --- | --- | --- |
| 1. Measure first | Historical logs and one controlled engine run above | Retained phase logs, per-file summaries, CPU samples and machine samples |
| 2. Charge execution time | Existing CPU admission credit retained | `local-gate-tests.cpuQueue.test.ts`: eight waiting files fill the pool; a ninth must execute after admission exceeds its run budget. Removing comparator credit fails this control. Execution without admission still expires. |
| 3. Finish shared selections | Existing bounded pool and green checkpoints retained; exhausted runs now retry automatically | `local-gate.checkpoints.test.ts`: first process exits 75 after eight completed files; the next reuses all eight and completes the same selection. `local-gate.test.ts` and checkpoint selection controls retain every selected group. |
| 4. Distinguish privacy configuration | Persist complete-output proof and use interrupted recovery | `publicationHistory.test.ts` consumes the real scanner formatter. `publicationRecovery.gateFaults.test.ts` checks mixed findings, another failed test, changed scanner input, unreadable paths, clipping, a fresh reader process and successful publication after the input recovers. |
| 5. Native startup under load | See native measurements below | The two existing startup cases run unchanged in purpose under explicit CPU quotas, with owned-child and receipt assertions retained. |
| 6. Preserve protections | Product budgets, planner, discovery and scanner unchanged | Typed versus ordinary comparator errors, filtered execution expiry, CPU-credit mutation, decisive refusal precedence and privacy counterexamples |

The original two-file CPU-credit control stayed green when its comparator
credit was removed: both files started together. The strengthened control
fills all eight workers and observes the ninth file's completion. This makes
the mutation test exercise the admission-to-next-file boundary.

## Native startup measurements and cause

Each command ran the two reported cases in isolation under Bun 1.4.0. Each
series used five fresh state roots per CPU quota. The default scope quota was
300%. Command wall time includes wrapper startup and any admission. The load1
ranges are samples at the end of each command.

| CPU quota | Base passing commands | Bounds-only passing commands | Fixed passing commands | Base median wall | Fixed median wall | Base / fixed load1 range |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 25% | 1/5 | 2/5 | 5/5 | 16.468 s | 4.704 s | 13.4 to 15.9 / 8.3 to 9.4 |
| 10% | 5/5 | 2/5 | 5/5 | 15.397 s | 12.851 s | 9.5 to 14.2 / 6.1 to 7.7 |
| Default | 2/5 | 3/5 | 5/5 | 5.689 s | 1.138 s | 9.5 to 13.2 / 6.8 to 7.1 |

The baseline also failed at the default quota. The expected five green
baseline commands at that quota could not be confirmed. Load differed across
series; completion counts and latencies describe each observed run.
The final complete native file passed all 34 tests in
9.86 seconds, including the real Codex 0.166.0 socket case.

Increasing the deadlines alone retained the failures. A controlled FIFO probe
then captured the native process sleeping in `pipe_write` while the fixture
held the reader and waited for native exit. Its final write was 20,001 bytes.
New pipes on this machine were observed at both 8,192 and 65,536 bytes; the
probe forced 4,096 bytes and reproduced the deadlock. Linux can reduce new
pipes to two pages when a user's soft page limit is reached.
[Kernel documentation](https://docs.kernel.org/admin-guide/sysctl/fs.html#pipe-user-pages-soft)
describes that behavior and the refusal to enlarge pipes above the limit.

The fixture now observes its first 34-byte block, releases the reader, and
then waits for native exit. It observes the independent waiter before
releasing it. The unlink case still removes the sink name while the reader
is held. The owner-loss case uses a small payload so both owners can remain
held until the fixture dies. The clipping cases retain their full burst and
all byte-count, size, redaction, receipt and owned-child assertions.

Every delayed fixture requests a one-page FIFO through `fcntl` and reads the
actual capacity back. Both named tests check that capacity. This affects only
their own descriptor and changes no kernel setting. The waiter watchdog is
30 seconds; fixture child-close, parent and test limits remain nested at 15,
40 and 60 seconds for drain tests. Owner-loss admission has 20 seconds,
child death 15 seconds and final cleanup 10 seconds within its 60-second test.
The production transport and its deadlines are unchanged.

## Recovery test file budget

In the initial measurement, the complete recovery file took 319.15 seconds,
exceeding the gate's existing
300-second file limit. Its 14-case publication consumer seam moved unchanged
to `publicationRecovery.gateFaults.test.ts`. The two complete files then passed
123 cases in 191.48 seconds and 14 cases in 27.59 seconds. Their combined 2,915
assertions equal the original file's count. Both files remain selected by the
ordinary changed-test rule. Machine loads were unmatched; these timings record
the observed fit within the file limit.

A later publication exhausted the same 300-second limit in the remaining
123-case recovery file; its baseline completed in 288.97 seconds. The two
existing files now divide those cases further: 72 remain in
`publicationRecovery.test.ts`, and 51 repair-decision cases move unchanged
into `publicationRecovery.gateFaults.test.ts`, which now has 65 cases. All 36
test declarations retain their exact contents. The complete files pass with
137 cases and the same 2,915 assertions, in separate isolated gate-slot runs
of 143.08 and 108.38 seconds. These observations record completion within the
unchanged file limit on their respective loads. Selection, confirmation,
ownership and cleanup checks remain unchanged.

This adds a mechanical test-split commit after the native repair. The planned
privacy, comparator, fixture-isolation and native-repair commits retain their
order. Measurements required two other changes to the brief: the original CPU
control needed a full worker pool, and native recovery needed a FIFO barrier
repair beyond larger deadlines. The measurement clone used an uncommitted
comment because commits belong to the assigned worktree.

The machine-readable [measurement record](../../evidence/publication-gate-recovery.json)
contains the phase data, per-file timings, native series and controls. Detailed
logs remain in retained private evidence. Only one full gate was run; its
failed result above remains part of the record.

## Git verification and baseline comparison

The complete `git.test.ts` run reported 208 passes, six failures and three
between-test errors in 442.62 seconds. The same six selected cases failed on
`1037130e` with the same three errors. Four fixture failures disappear on both
revisions when the fixtures resolve system Git instead of the inherited agent
Git wrapper: both selected runs then report four passes and two failures.
The remaining unreadable-role-memory cases have identical assertions on base
and head: the first damages two rows where it expects one, and the second
never reaches its damage boundary. Those existing cases remain unchanged.
This comparison establishes no introduced failure; the full Git file is not
green. The measurement record retains all counts and command times.

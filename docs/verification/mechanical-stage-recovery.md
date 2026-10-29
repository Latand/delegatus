# Mechanical stage recovery

## Diagnosis

The investigation read the retained lane records and stage conversations on
2026-10-29, and the source at `308ba22a`. The lane records are observations;
the regression tests establish the causal paths below without operating on
the running installation.

### Settlement admission

`src/lib/pipelines/controllerJobs.ts:20` allowed four active settlement jobs.
The controller used those jobs for publication too
(`src/lib/pipelines/engine.ts:13007` and `:13028`). A publisher waiting for CPU
admission in `src/lib/pipelines/git.ts:1930` retained its job, so four
publishers could prevent another passed stage from getting a settlement job.
Provisioning already had separate capacity; settlement did not.

The timeout also used the stage report time
(`src/lib/pipelines/engine.ts:12460`). A report can
arrive while its producer still has a live turn. For example, the retained
refresh attempt in lane `0d7852d4` reported at 03:34:19 UTC and recorded stage
completion at 08:19:45 UTC. Its original report and accepted head survived the
manual recovery. The old timeout therefore counted time before admission was
needed. A refusal at one poll could claim fifteen minutes of unavailable
capacity immediately. The retained records do not name the four job holders
or prove continuous saturation throughout that interval.

### Interrupted spawn

Lane `22074cb0`, publish attempt 2, retained a start at 08:47:16 UTC with no
activation, call count, launch id, conversation, session, transcript or pane.
It was parked; attempt 3 launched after the explicit retry.

`src/lib/pipelines/engine.ts:9011` persisted `spawning` before constructing and persisting the
activation at `:9061`. Restart between those writes left exactly that row.
The process-local spawn set disappeared on restart, and `:9081` parked the
row. No registry dispatch had been reached at this checkpoint. The fix writes
the activation in the first spawning checkpoint. Recovery of an older row
first checks the original registry keys and their membership. A counted call
without a receipt, conflicting receipts or retained host evidence continues
to require reconciliation.

### Cancelled commit

Lane `f9f8b370`, inventory attempt 1, retained a commit-repair request at
08:42:43 UTC containing only cancellation, naming its declared output. The
producer's response at 08:55:05 UTC reported no file defect and made no edits.
The explicit retry later accepted the output in the same attempt.

The additional lane `d6ab7243` has the same shape: a read-only verifier with
one declared Markdown output. Its retained repair request is timestamped
10:09:35 UTC; the producer answered at 10:15:36 UTC that no document change
could answer the cancellation. The stage eventually passed at 11:55:14 UTC,
still on attempt 1. The seat also observed cancellations around 10:55 UTC and
before 11:54 UTC, including a failed explicit retry. Those later observations
are not separate entries in the retained attempt, so their exact command
start, exit and cancellation authority cannot be reconstructed from it.

`src/lib/workflows/provision.ts:48` and `:69` produce the bare cancellation result
when the command's AbortSignal is already aborted or aborts in flight. The
executor kills and reaps the owned command group before answering. Settlement
supplies its cancellation signal from its authority revalidator
(`src/lib/pipelines/engine.ts:12348`); a changed lane, branch owner, review flow or unreadable
authority aborts it. The retained repair record contains no triggering fence
or raw exit status, so it cannot establish which observation cancelled that
historical invocation. The later deploy alone supplies no such evidence.

The load-related deadline hypothesis remains unconfirmed. The executor's own
budget emits `command timed out after …ms` (`src/lib/workflows/provision.ts:71`),
whereas an aborted signal emits `command cancelled` (`:69`). The production
settlement wrapper supplies the authority signal and preserves the commit's
timeout (`src/lib/pipelines/engine.ts:12359` at `83973ce6`). Its controller job
has no additional cancellation timer. The provider observer's fifteen-second
deadline explicitly defers Git settlement (`src/lib/pipelines/engine.ts:12674`
in the repaired source). A slow poll can delay these callbacks; the code does
not establish that the observed loop gaps caused these particular cancellations.
The fix handles both typed deadline expiry and bare signal cancellation with
the same persistent bound, without turning a diagnostic hook refusal into a retry.

`src/lib/pipelines/git.ts:803` distinguished deadline expiry from a hook refusal, but let bare
cancellation fall through to `commitRefusal` at `:949`. `src/lib/pipelines/engine.ts:5598`
therefore asked the producer to repair files. The fix distinguishes a null
exit status with bare cancellation and empty stdout. A hook's exit status or
any diagnostic retains the existing refusal path. The real-Git restart tests
abort a held pre-commit command through its signal and exercise this path.

## Recovery policy

| Stop | Automatic retries | Retained state |
| --- | --- | --- |
| Settlement job unavailable | Three retries after 1, 5 and 15 minutes, each with a new 15-minute admission window | Attempt, accepted head, pass, publication reservation |
| Restart before spawn reservation | Three retries after 1, 5 and 15 minutes | Attempt and original launch keys; an admitted matching receipt is adopted |
| Bare commit cancellation or controller deadline | Four retries after 30, 60, 120 and 240 seconds | Passed attempt, index, worktree, accepted head and ownership receipts |

Admission clocks start at the first capacity refusal. Publication has its own
four-job pool; settlement releases its active permit while its publisher
waits. The scheduler still retains custody of both jobs. Git's existing locks,
ownership checks and receipts decide whether a result can be accepted. This
change makes no latency or throughput claim.

An unchanged declared-output tree reuses its original ownership receipt. A
repaired tree receives a new receipt after the earlier receipt is validated;
an unreadable or invalid receipt parks with its cause and remains untouched.

Every exhausted stop parks with its cause and retry count. The retry fields
are stored on the existing attempt and survive decoding in a new process.
New attempts start with these optional fields absent. Explicit control,
history and ownership refusals, privacy diagnostics, and file-naming hook
failures retain the existing decision or producer-repair path.

## Shared record paths

- `tickRunStage` writes and consumes `spawnInterruptionRetry`; the activation
  builder and registry remain the launch producers, and the existing receipt
  reader resumes an admitted launch.
- `parkUnadmittedStageSettlement` writes `settlementAdmissionRetry`;
  `settlePendingStageGit` and controller admission consume its due time.
- `commitStageTree` writes the typed `commitCancelled` result;
  `commitPassedStage` consumes it using the existing `stageCommitWait` writer
  and reader. Other Git callers retain their ordinary failure handling.
- The existing pipeline JSON/SQLite writers, candidate cloning and intent
  checkpoints preserve the optional attempt fields. The registry decoder
  accepts their writer output. List projections expose the existing state
  detail; no new settings or schema migration is needed.

The seat controller, merge queue timeout and stage push guard are outside this
change. The shared engine edits concern settlement and spawn checkpointing.

## Reproduction

Run each named file separately through the project's gate wrapper, using
`checkEnvironment` followed by `isolatedEnvironment` in a scratch checkout:

- `src/lib/pipelines/engine.controllerPass.test.ts`: held production publisher,
  independent settlement, admission retry cap.
- `src/lib/pipelines/engine.mechanicalRecovery.test.ts`: fresh interpreter for
  each recovery, real Git cancellation and restart, preserved pass and head,
  launch receipt adoption and rejection, atomic activation checkpoint.
- `src/lib/pipelines/stageCommitRepair.test.ts`: cancellation versus hook
  diagnostics, successful retry, exhaustion, existing producer repair controls.

The publication-pool regression, admission recovery, launch recovery and
commit cancellation regressions fail on the captured main implementation.
The completed verification report records the final importer inventory,
individual results, baseline comparisons and merged-head typecheck.

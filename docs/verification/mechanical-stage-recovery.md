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
to require reconciliation. A retained report, verdict, output (including an
empty output), completion marker or refusal also prevents relaunch. The safety
cases start with the production report writer's output and remove launch
handles before restarting the process.

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
has no additional cancellation timer. The authority reader uses the general
state-admission helper (`src/lib/pipelines/stageBranch.ts:59`), whose default
budget is thirty seconds (`src/lib/state/lockWait.ts:46`). That helper retries
typed admission deferrals; its compact projection receives no deadline and
can reject immediately on a busy or incoherent read. Such a rejection also
reaches settlement's abort handler. No retained record establishes that the
helper's timed-retry branch fired during these incidents.

The provider observer's fifteen-second
deadline explicitly defers Git settlement (`src/lib/pipelines/engine.ts:12600`
at `83973ce6`). A slow poll can delay these callbacks; the code does
not establish that the observed loop gaps caused these particular cancellations.
The fix handles both typed deadline expiry and bare signal cancellation with
the same persistent bound, without turning a diagnostic hook refusal into a retry.

`src/lib/pipelines/git.ts:803` distinguished deadline expiry from a hook refusal, but let bare
cancellation fall through to `commitRefusal` at `:949`. `src/lib/pipelines/engine.ts:5598`
therefore asked the producer to repair files. The fix distinguishes a null
exit status with bare cancellation and empty stdout. A hook's exit status or
any diagnostic retains the existing refusal path. The real-Git restart tests
abort a held pre-commit command through its signal and exercise this path.
An additional production-controller case rejects one read from a real
authority-reader instance while a real Git hook is held, then restores the
reader. It checks that the controller's own signal cancels the command and
that the preserved pass retries without a producer repair turn.

Repeated authority cancellation exposed another boundary at `a99b2cff`:
the retry wait was checkpointed (`src/lib/pipelines/engine.ts:12521`), while
the exhausted-budget park at `:5636` existed only on the settlement candidate.
The final authority-abort guard at `:12573` discarded that park. Recovery now
revalidates the original ownership proof after stopping the
finished command's watcher, then checkpoints only the budget and canonical
park state. It accepts no Git work through that path. The park is durable
before its task note is delivered, so a note failure cannot repeat Git.
Fresh-process cases cover exhaustion, a superseding pause, a changed peer,
unreadable proof, task-note failure and an explicit retry of the same receipt.

### Pre-push admission expiry

The retained history for lane `010e56e7` classifies three refusals at
13:46:22, 14:40:14 and 15:14:18 UTC on 2026-10-29. All three name the
CPU-admission phase on the same accepted head, with seven changed files.
The history records zero recoverable failures and three total attempts.
These are classification times: the corresponding publisher journal entries
are at 13:40:07, 14:40:10 and 15:14:17 UTC.

At `4389d935`, `scripts/cpu-admission.ts:45` supplies a default 30-second
SQLite contention budget to the admission helper. Each busy episode spends
the remaining budget (`scripts/cpu-admission-lock.ts:24` and `:37`), while
ordinary queue waiting does not. Repeated short lock waits can therefore
exhaust those thirty seconds after many minutes in the CPU queue. The helper
then reports that checks did not start (`:12`); the CLI exits 1
(`scripts/cpu-admission.ts:103`). This is independent of the publication
execution budget: `scripts/local-gate.ts:823` waits for admission without an
execution deadline, and credits CPU waiting separately.

The publisher classifies the complete captured output before bounding it
(`src/lib/pipelines/git.ts:2017` at `4389d935`). Its deadline classifier
(`src/lib/pipelines/publication.ts:26`) recognized execution expiry, but did
not recognize this admission expiry. The resulting refusal retained
`retryableDeadline: false`. With changed files, recovery treated it as a
check failure and requested a producer repair despite the absence of a check
verdict. The retained producer response reported no file defect.

### Restart continuation delivery (deferred)

The additional class is confirmed in the retained frontend attempt 3 of lane
`08315f24`, proto-fix attempt 1 of `f9f8b370`, and sonnet-extra-fix attempt 3
of `6ec5a459`: each stopped on continuation 1 with unconfirmed delivery.
The deployment times and repeated frontend stop are seat observations; the
retained error does not identify the failed delivery operation.

At `3f13c7b4`, `src/lib/pipelines/engine.ts:6550` gives each continuation
three minutes. At `:6655`, a missing acceptance, outstanding delivery or
unconfirmed completion parks before the three-continuation count advances.
Only confirmed delivery permits a later continuation. Production completion
proof is the registry's admitted-and-delivered receipt (`:2532`); enqueueing
uses the reserved client message id (`:2408`). Existing controls in
`src/lib/pipelines/engine.restoreContinuation.test.ts:415` and `:434` prohibit
a second send while that proof is pending or unreadable.

This class is outside the implemented recovery policy. Safely recovering a
failed delivery requires reconciling the queue and runtime receipt, including
transport uncertainty and cancellation, before reusing or replacing its
delivery. Increasing this deadline or issuing another continuation alone
would leave the duplicate-delivery question unanswered. No continuation,
runtime-host or delivery-queue behavior changes here.

## Recovery policy

| Stop | Automatic retries | Retained state |
| --- | --- | --- |
| Settlement job unavailable | Three retries after 1, 5 and 15 minutes, each with a new 15-minute admission window | Attempt, accepted head, pass, publication reservation |
| Restart before spawn reservation | Three retries after 1, 5 and 15 minutes | Attempt and original launch keys; an admitted matching receipt is adopted |
| Bare commit cancellation or controller deadline | Four retries after 30, 60, 120 and 240 seconds | Passed attempt, index, worktree, accepted head and ownership receipts |
| Pre-push admission lock-wait expiry before checks start | Three retries after 1, 5 and 15 minutes | Accepted head, passed attempt and per-head publication history |

Admission clocks start at the first capacity refusal. Publication has its own
four-job pool; settlement releases its active permit while its publisher
waits. The scheduler still retains custody of both jobs. Git's existing locks,
ownership checks and receipts decide whether a result can be accepted. This
change makes no latency or throughput claim.

The settlement wait follows the publication job's complete lifetime, including
an initial version-read failure before its callback starts. That failure releases
scheduling custody so the same pending publication can be retried.

Admission recovery requires the admission phase and the helper's explicit
expiry with no started heavy-check phase or decisive refusal in the complete
output. Queue progress alone supplies no such proof. The existing
`retryableDeadline` flag retains the capacity policy across readers; optional
`admissionDeadline` metadata preserves the admission reason. Classification
happens on both complete streams before redaction and output truncation; only
the classification and redacted diagnostics are retained. The existing per-head history counts each
operation once across restart and takeover, and stops after three retries.

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
- `publishPipelineBranch` writes admission metadata with its captured failure;
  executor and operation receipts retain the same result. The store, recovery
  history and takeover keep the existing retryable-deadline flag. New readers
  use the optional admission field for the reason; older readers ignore it.

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
- `src/lib/pipelines/publication.test.ts`: production admission-helper output,
  started-check and refusal vetoes, incomplete admission evidence.
- `src/lib/pipelines/git.test.ts`: production publication capture classifies
  both streams before redaction, retaining refusal vetoes and redacting output.
- `src/lib/pipelines/parkedPublication.test.ts`: real Git hook admission expiry,
  unchanged accepted head, persisted retry history, process restarts, exhaustion
  and a subsequent genuine check refusal.

The publication-pool regression, admission recovery, launch recovery and
commit cancellation regressions fail on the captured main implementation.
The completed verification report records the final importer inventory,
individual results, baseline comparisons and merged-head typecheck.

# Stage push settlement and pull request delivery

## Commits the attempt made without a hook receipt (2026-10-21)

Two passed fix stages could not settle on 2026-10-21 because settlement
refused a commit the attempt itself had made in its worktree. The evidence
below comes from each launch's receipt directory, each worktree's own HEAD
reflog and the stage agents' command records; times are UTC. No live state
was changed.

| Lane, attempt | Evidence and cause |
| --- | --- |
| `ce3a00a0` fix, attempt 2 | The launch started at 04:32:36 on `653ff2ce`. At 04:35:50 the agent ran `git -c core.hooksPath=.githooks commit`, creating `b60b75d1` (reflog `commit:`). Its receipt directory has no `commits/` entry at all. The turn completed at 04:36:30. The retry and its successor started on `b60b75d1` and were refused for it. |
| `ab42a936` fix, attempt 1 | The launch started at 05:10:41 on `b60b75d1`. At 05:11:49 the agent ran `git merge --no-ff --no-commit origin/main` (clean), and at 05:14:07 it ran `git -c core.hooksPath=.githooks commit`, creating merge `b72eeaa2` (reflog `commit (merge):`). At 05:22:35 a plain `git commit` created `172db603`, whose receipt exists. Settlement refused `b72eeaa2`. |

The receipt writer is the post-commit/post-merge branch of the launch's
generated hook, `src/lib/git/stageAttemptGuard.ts:49-82` at `a58ac024`, which
writes `commits/<sha>` at lines 66, 74 and 78. That hook is reachable only
through the `core.hooksPath` entry the launch appends to `GIT_CONFIG_COUNT`
(`src/lib/git/agentHistoryGuard.ts:203`). The settlement check reads those
receipts in `src/lib/pipelines/stageAttemptPush.ts:392` at `a58ac024` and
refuses at line 407. Its only other proof, reflog recovery, ran only for
launches that predate start receipts (line 306).

Hypotheses tested:

- **A non-conflicting `git merge` runs none of the receipt hooks: refuted.** A
  merge that creates a commit runs `post-merge`, and the guard writes the
  receipt while `MERGE_HEAD` still exists. A `--no-commit` merge writes it at
  the concluding `git commit` through `post-commit`. The existing post-merge
  argument test and a scratch probe on git 2.43 both show the receipt.
- **The cause in both lanes: the agent overrode the hooks path.** Git reads
  command-line `-c` settings after `GIT_CONFIG_COUNT` entries, so
  `-c core.hooksPath=.githooks` replaces the guard's hook directory. In
  `ce3a00a0` the repository's own pre-commit hook still ran and printed its
  privacy and eslint verdicts, and no receipt hook ran. Both agents had read
  `git config --get core.hooksPath` minutes earlier, which shows the launch's
  generated directory, so the override reads as an attempt to commit with the
  repository's hooks on.
- **An OOM kill right after a commit can lose its receipt: confirmed, though it
  was not this incident's cause.** Git moves the branch, appends the reflog
  entry, and only then starts `post-commit`. A kill in that window keeps the
  commit and loses the receipt. The new test kills the committing process
  group from the `reference-transaction` hook's `committed` phase and
  reproduces it. In `ce3a00a0` the receipt was already missing because of the
  override.

### Fix

The receipt for a commit or merge is now written before Git moves the
branch, by the invocation that writes the commit
(`src/lib/git/stageAttemptGuard.ts:51-77` and `:89-105`). The launch's
`prepare-commit-msg` hook records an intent: the tree of the index being
committed and the parents the commit will have (HEAD, then each `MERGE_HEAD`
line). Git runs that hook for `commit` and for a merge that creates a commit,
`--no-verify` included, before it writes the commit object. The hook files
the intent under the Git process that runs it, named by its PID and its start
time from `/proc` (or `ps` where `/proc` is absent).

The same process then runs the `reference-transaction` hook in its `prepared`
phase, before the ref update. If an intent exists for that process, and the
commit it is moving `HEAD` or a branch to has exactly the intent's tree and
parents, the hook writes `commits/<sha>` and removes the intent. A kill after
the ref update and before `post-commit` or `post-merge` therefore leaves the
receipt in place. `src/lib/git/agentHistoryGuard.ts:73` now reads the
transaction's input once for both guards.

An intent proves nothing outside its own invocation. Three things can abort
a commit after `prepare-commit-msg` has run: a failing editor, a refusing
`commit-msg` hook, or the guard's own author check. The aborted process never
reaches the ref update, and its intent stays filed under a process that has
exited. A later writer with the same tree, parents, identity and time is
another process and gets no receipt. That covers an unguarded commit in the
lane, a `reset` or `update-ref` (whatever its reflog message reads), and an
import from another checkout. Settlement reads receipts only, exactly as on
`a58ac024` (`src/lib/pipelines/stageAttemptPush.ts` is unchanged). The reflog
replay the first round added proved commits from an intent keyed only by tree
and parents, so an aborted invocation's intent could attest another writer's
commit. That replay and its version 2 start receipt are removed.

A commit made with the launch hooks overridden (`-c core.hooksPath=…`) runs
none of the launch's hooks, so it has neither an intent nor a receipt.
Nothing Git records tells it apart from an imported commit. It stays
unproved; both incident commits were of this kind. The builder rules ask for
a plain `git commit`, and the park names the recovery below, which now
accepts such a head in place.

When settlement still refuses, the park names the recovery. The lane's
creator, its project's seat or the operator reviews the head and calls
`pipeline_action publish` with `acceptedSha` set to the clean worktree HEAD.
`src/lib/pipelines/engine.ts` (`custodyAcceptance`) then accepts it in place.
That includes a HEAD that is still the passed commit, as when a refused
foreign push parked an otherwise unchanged lane. It requires a custody park,
the exact HEAD, a clean worktree and the previous passed commit as an
ancestor. It records a `recovery` entry in the delivery journal, completes the
pass, publishes it and advances, with no successor lane. Without
`acceptedSha`, `publish` still retries the proof.

The builder work rules (`src/lib/roles/defaults.ts`), which builders and fix
rounds both carry, send suites, typecheck and builds through the
heavy-command wrapper by default and ask for a plain `git commit`. The stage
launch's test guidance (`src/lib/pipelines/testGuidance.ts`) names the
installed `gate-slot.sh` for them and the 4–8 GB scope cap.

### Verification

`src/lib/pipelines/stageAttemptPush.test.ts` runs real repositories and the
real generated hooks in isolated state. The host-death cases kill the
committing process group from the `reference-transaction` hook's `committed`
phase, after the branch moved and before `post-commit` or `post-merge`. These
settle:

- a clean merge;
- a clean merge concluded by `commit`;
- a conflicted merge concluded by `commit`;
- an ordinary commit, inherited by a host-lost replacement, by an operator
  retry and by a manual silent retry;
- an attempt's own commit after accepted or published history;
- an own commit after a fast-forward of current main.

Each of these fails on `a58ac024` with the incident's refusal.

These are refused:

- a commit aborted by its editor, by `commit-msg` or by the author check,
  followed by a same-tree, same-parents, same-identity commit, either made
  unguarded in the lane or made in another checkout and imported by
  `GIT_REFLOG_ACTION=commit git reset --hard` (reflog `commit: updating
  HEAD`). All six cases were accepted with `{ ok: true }` by the first round
  (`cff58910`). Keying intents by a constant instead of the process turns the
  three reset cases red again;
- a foreign shared-identity commit with the subject `updating HEAD`, reached
  by `GIT_REFLOG_ACTION=commit git reset --hard`, before and after a main
  fast-forward;
- a foreign shared-identity merge reached by `update-ref -m "merge
  origin/main: Merge made by the 'ort' strategy."`;
- an ordinary commit and a clean merge made under a command-line hooks path
  override;
- a same-identity commit made after the attempt ended;
- an own amend or rebase whose `post-rewrite` receipt was lost.

The earlier forged-reflog, foreign-worktree, other-identity and
dropped-history cases still refuse.
`src/lib/pipelines/parkedPublication.test.ts` covers the seat's in-place
acceptance, its authorization and clean-worktree refusals, and an accepted
head equal to the passed commit.

## Stage worktree and published integration recovery (2026-10-19)

The task evidence identifies three occurrences on 2026-10-18. The investigation
read each retained pipeline's full prompt and its attempt's messages; the times
below are the messages' action observations in UTC, rather than the task's
later approximate report times. No live installation state was changed.

| Occurrence | Evidence and cause |
| --- | --- |
| Refresh lane `31c13470`, PR #3034 | At 10:11 the attempt described a scratch-clone commit and push; by 10:12 the native stage guard had refused the different Git repository. Its later in-worktree commits could not erase that permanent refusal. The generated refresh brief named the delivery branch without naming the committing checkout, the working rule sent builders to scratch exports, and the wrapper instructed a push. |
| Refresh lane `261bb2e6`, PR #3060 | At 20:19 the attempt reported its delivery push, and by 20:25 its checks were green. Settlement refused `9e450476` for missing in-worktree creation evidence. The same generated refresh brief, working rule and push instruction applied. A green report could not supply that receipt. |
| Fix lane `1228112e`, PR #3063 | At 20:21 the attempt described preparing a scratch-clone commit; at 20:22 it described fast-forwarding that commit into the pipeline checkout. Settlement refused `bdedbcb9`. Its build brief already said to commit in the stage worktree and never push, while the shared working rule still directed all work into a scratch export. It created no remote delivery to adopt. |

The originating requirement is that stage agents commit only in their stage
worktree and leave pushes to the pipeline. `src/lib/roles/defaults.ts` now
limits scratch exports to builds, tests, probes and renders.
`src/lib/pipelines/prompts.ts` names the stage worktree as the only place for
edits, staging and commits and reserves publication to the pipeline. This
launch instruction overrides older stored scaffolds and brief instructions.
The assembled refresh and fix prompts from `src/lib/forge/autoRefresh.ts`
receive the same instruction without changing merge-queue refresh ownership.

The narrow recovery in `src/lib/pipelines/stageAttemptPush.ts` permits an
unreceipted integration only when it is already on the owned delivery branch.
It fetches and verifies the base against that remote, confirms it is origin's
default branch in the same GitHub repository, and reconstructs every introduced
merge with `verifyPassedHeadIntegration`. The candidate must preserve starting
and accepted history and exactly match Git's clean merge trees. Extra commits,
extra merge content, conflicts, a different merge source, an unpublished result
and recorded Git refusals remain refused. The local checkout must be clean and
on its owned branch. Both the local and remote heads are reread before and after
fast-forward adoption.

The forge must report the exact candidate head on an open PR targeting the
same base, with a nonempty green rollup and every configured required context.
Pending or unavailable checks defer settlement for a fresh read; no receipt is
manufactured and no new pass is transferred to arbitrary foreign work.
`commitAndAdoptStageBranch` records the accepted report provenance; the existing
stage settlement and publication paths persist and publish that accepted SHA.
A remote that already holds it requires no push. No persisted schema changes.

| Contract path | Producers and consumers checked |
| --- | --- |
| Working rules | Full and short defaults, builder plain/fix variants, registry resolution, stored effective roles, assembled stage prompts and role previews. |
| Stage prompt | Ordinary builders, generated refresh/fix stages, role-less writable stages, local-only and comparison delivery; read-only stages retain their commit prohibition. |
| Integration proof | Explicit `publish acceptedSha` retains its existing tracking-ref read; automatic settlement supplies a freshly fetched, verified base SHA. Both use the same isolated clean-tree comparison. |
| Settlement | `commitAndAdoptStageBranch` invokes receipt verification; the writable passed-stage path accepts its result, updates provenance and queues normal publication. Producer repair keeps its stricter local receipt requirement. |

`src/lib/pipelines/prompts.test.ts` and `src/lib/pipelines/roles.test.ts` pin
the instructions, including a generated refresh and its fix stage.
`src/lib/pipelines/stageAttemptPush.test.ts` uses real isolated Git repositories
and native hooks, with fixture forge responses. It covers local and remote-only
adoption, a fresh-process replay, extra work, altered merge trees, non-main
parents, absent publication, check failures and local/remote races. The existing
receipt and explicit publication tests remain the other consumers' coverage.
This change claims no performance gain.

The historical diagnosis and verification below describe earlier revisions.

## A. Read-only diagnosis

The investigation read the two refused build attempts, their native HEAD
reflogs, their commit and push receipts, and the corresponding branch tips.
No production record, hook, branch or checkout was changed. The deployed
revision was `917189ae`; the comparison main was `e7507d588`.

| Attempt | Attempt started (UTC, 2026-10-16) | Guard prepared | Own commits with receipts | Additional imported main commit |
| --- | --- | --- | --- | --- |
| One-commit build | 07:55:50.592 | 07:55:57.208 | `3c789db240` | `e7507d588` |
| Three-commit build | 08:39:53.318 | 08:40:01.340 | `9c0247d1e`, `85b8a2c1b`, `f1cda6447` | `e7507d588` |

Both worktree reflogs show a fast-forward merge of newer main before the
stage's commits. Each own commit has its empty creation receipt; both pushed
tips have delivery-target push receipts. The imported main commit has no
creation receipt for either attempt. Their complete suffixes contain two and
four commits respectively, below the former 256 limit.

At the deployed revision, `src/lib/pipelines/stageAttemptPush.ts:99` reads the
whole starting-head suffix, and `:106`–`:107` requires every entry to have both
an in-window commit timestamp and an attempt receipt. It never distinguishes
already published base history. The refusal at `:135` collapses the missing
receipt and count-limit causes into one message. This explains both incidents:
all stage-created commits were proved, while their imported main ancestor
failed the same predicate. Multiple own commits and hook installation timing
did not cause these two refusals. Both guards existed before the own commits.

`src/lib/git/stageAttemptGuard.ts:48` at that revision records only
`post-commit`; a fast-forward creates no commit and must never acquire a
creation receipt. A true merge, patch application and rewrite also need
creation coverage. `:77` skips the hook's suffix check when pushing the lane's
own HEAD; the controller then performs the full check, which is where these
in-worktree pushes were refused. This hook branch grants no settlement proof.

The PR defect is independent. On comparison main,
`src/lib/pipelines/engine.ts:4201`–`:4231` and `:4843`–`:4860` publish and
advance a successful stage without ensuring a PR exists. The two reported
completed lanes now have manually attached links; their passed build/review
records show why a late manual link does not establish controller delivery.

## B. Commit proof

Settlement reads ancestry and worktree reflog evidence in pages of 128.
There is no total commit or push-receipt cap. Native receipts attest commits,
true merges, applied patches and every rewritten commit, and existing
repository hooks still receive their original input and arguments. A merge
receipt requires Git's in-progress `MERGE_HEAD` state during `post-merge`.
Fast-forwarding to an existing merge has no such state, regardless of its
parent count or caller-supplied reflog action. Ordinary, `--no-verify` and
octopus merges retain creation proof; squash and fast-forward hooks retain
Git's native argument. A commit's author or
committer date does not override a native creation receipt.

An unreceipted commit is accepted only with a native creation entry in this
exact worktree during the attempt, or as an ancestor of the base tip read and
fetched from the actual delivery remote. A local tracking ref cannot confer
that authority. Native fallback accepts commit, amend, cherry-pick, patch,
rebase creation and true-merge entries. Fetch, checkout, reset and fast-forward
entries do not prove creation. This is the defined fallback for launches that
predate the hooks; it also covers a local commit made before hook preparation.
An unknown commit is refused with its full hash and missing-evidence reason.

Every existing starting receipt, including a versionless receipt, requires
independent commit receipts for its own suffix. A matching shared publication
identity and reflog text cannot fill a missing receipt. Only launches with no
starting receipt retain the pre-receipt recovery path.

Existing starting receipts, accepted ancestry, clean owned branches, outstanding push
candidates, exact delivery ownership and final local/remote checks remain
required. Remote unavailability defers verification. Publication recovery
continues to refuse adoption of arbitrary remote-ahead commits. A proved local
follow-up after an earlier push is left for ordinary controller publication.
A bypassed pre-push hook cannot defeat native creation proof, while every
recorded but unconfirmed push candidate still refuses settlement.

The producer is `prepareStageGitGuard` at fresh dispatch; agent environment
policies carry its binding into native Git hooks. The persisted `start.json`,
`base`, `commits` and `pushes` records are consumed by producing-attempt
settlement in `stageBranch.ts`. The early refusal reader and restart recovery
use those same records. No stored format changes. Ordinary controller commits
and read-only stage output commits retain their existing write paths.

## C. PR delivery

After remote publication, direct settlement, terminal local review output
and the durable publication retry call
`ensureStagePullRequest` before advancing. The same check closes the migration
gap for an older lane reaching the end of review. It looks up an open PR for
the delivery repository, branch, base and accepted head, refusing a fork,
ambiguous match, closed linked PR or stale head. A stage-created PR is reused.

If absent, the controller uses the producing stage's summary as its body,
checks the title and body with the shared publication detectors and committed
fingerprints, and invokes the repository privacy gate when that repository
provides it. A refusal sends no PR text to the forge. Creation uses a private
body file and the engine's existing App-write environment. Every create,
including a command that returns an error or loses its reply, is followed by
branch discovery. The verified PR number is persisted as `delivery.target.pr`
under the existing lane mutation fence. An unverified PR blocks advancement.
A publishing delivery without a supported PR service cannot claim success.
Local-only lanes with publication disabled need no PR.

Existing producers of `delivery.target.pr` are pipeline creation and delivery
takeover; manual work links and report provenance remain separate link inputs.
The new producer writes the same optional numeric field. Forge work-link
resolution, refreshed-lane admission and delivery recovery continue consuming
it through the existing store and link resolvers. No schema or default changes.

Git and forge waits run outside the state mutation lease, under its existing
owned lane lock and cancellation fence. PR work has loop-monitor attribution
and the `pipeline.pull-request` performance site. The change claims no speed,
memory or startup improvement and adds no per-tick whole-store read or cache.

## Verification procedure

Run each test file in a fresh process and private HOME, XDG_CONFIG_HOME,
LLV_STATE_DIR and TMPDIR through the required gate-slot wrapper. The shared
engine fixture cleans its state after a file, so reusing it across test files
in one process is invalid. Run the identical new test files on comparison
main and head; retain individual names and outcomes in the evidence record.

- `src/lib/pipelines/stageAttemptPush.test.ts`: A's one/three-commit replay;
  B's 260-commit suffix, native creation operations, legacy fallback,
  backdated receipt, exact foreign refusals and forged tracking-main control.
- `src/lib/pipelines/stagePullRequest.test.ts`: creation, existing PR,
  lost response, refusal, private text, repository gate refusal, all three
  forge await cancellation points, and a lane migrated at review completion.
- `src/lib/pipelines/engine.ports.test.ts`: existing attempt custody/restart,
  remote/local/claim races, and native detached pushes beyond 256 commits.
- `src/lib/git/agentHistoryGuard.test.ts`: original hook input, author/history
  protection, warmed hook repair and fresh-process verification.

Also run the pipeline Git, settlement and publication tests by explicit path,
TypeScript, changed-file ESLint, the publication privacy gate and the required
hosted PR checks. Evidence records must identify the source revision/digests,
the comparison main, the command and each observed result. No live state or
runtime-directory test sweep is involved.

## Observed results

The new regression files were run unchanged on comparison main
`9d3e9b3df` and implementation `cfd55fc824`. The proof file has 15 failing
cases and one passing legacy-local control on main; all 16 pass on the
implementation. The PR file has 21 failing cases on main and all 21 pass
on the implementation.

The explicit-file runs also pass 101 settlement cases, 171 pipeline Git
cases, 129 native history-guard cases, nine performance-span cases and all
24 native publication cases. The ports file passes 139 cases and retains
two managed-admission failures reproduced on main. The full publication
file reaches its five-minute deadline on both revisions. Before that cutoff,
main records five per-test timeouts and head records no failed case. The
24 native cases finish separately on both revisions.

TypeScript, changed-file ESLint and the committed-fingerprint publication
privacy gate pass. ESLint reports six existing unused-variable warnings
and no errors. The machine-readable record is
`evidence/stage-push-settlement.json`; individual cases precede each file's
totals and source digests identify the implementation that was exercised.

The complete local pre-push hook passes privacy, types and lint, then refuses
a provider-budget file timeout in its parallel branch sample. It identifies
six other failures as pre-existing, including the matched full publication
file timeout. The provider-budget control subsequently runs alone with all
74 cases passing on each revision (main 226.51 s, head 224.17 s). The hook's
refusal and these controls are both retained in the evidence. The hook escape
is used for the dependency-free worktree after equivalent isolated checks;
the checkout with frozen dependencies supplies the checks.

The Linux backend rehearsal and the 17 explicit platform test files selected
by the repository pre-push plan pass on the merged implementation.

## Publisher environment regression (2026-10-17)

On `490e9fad7`, the hook's complete 26-file touched-tests selection against
`02f9301fc` reproduces exactly 35 NEW failures and seven pre-existing failures.
Three confirmation runs per side retain all 35 failures. The two affected
files are `engine.ports.test.ts` (19 new failures) and
`stagePullRequest.test.ts` (16). The unchanged two-file agent control has zero
new failures and two pre-existing failures.

The controlled difference is the four `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`,
`GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` variables: agents inherit the
configured publication identity, while the publisher has none of them.
`pipelinePublicationHookEnv` preserves Git identity variables, and `realExec`
overlays its supplied environment onto the parent environment. With those
variables absent, the fixtures' repository-local Fixture identity becomes the
commit identity. The legacy creation check expects the publication identity.
The hook and test preload already scrub inherited Git config bindings; the
preload also confines global config, templates and hooks to its private root.

`realWorktreeLane` now explicitly supplies the four publication identity
fields when modeling agent Git commands. Stage-PR commits use that same helper
and deterministic clock. The repository-local Fixture config stays available
as a control. The native fixture also prepares the real starting receipt and
generated hooks at every fake dispatch, using the reserved client attempt id for its
launch binding. Successor stages get their own starting head and receipts.
Bindings follow commands in the dispatched lane; upstream writers and deliberate
unguarded custody controls retain their own environment. Detached agent commands
use the custody fixture's explicit launch environment.
Settlement uses those receipts without resolving an ambient publication
identity. The no-start legacy path retains its identity check.

Two fresh-process regression cases run successor-lane and PR creation checks
with missing or conflicting ambient identities. The conflicting case also
uses custom publication settings. Both inherit a rejecting hooksPath and a
private global config, assert that those files stay unchanged, fail before the
fixture repair, and pass afterwards. Each child runs one explicit test file
so the engine fixture's cleanup remains scoped to its process.

The fixture-only complete touched-tests phase passed in both environments:
publisher zero new / six pre-existing failures; agent zero new / five
pre-existing failures. Both have zero flaky outcomes. The focused PR file
passes all 23 cases. The exact explicit-file command, environment construction, 35 red
identities, baseline findings and tested source digests are recorded in
`evidence/stage-push-environment.json`. These phase runs execute the modified
working tree on top of `490e9fad7`; the source digests identify that tree.

TypeScript, changed-file ESLint and the committed-fingerprint publication
privacy check pass. The required hosted checks (`privacy-publication`,
`privacy-tracker-audit`, `runtime-gate`, `typecheck`) run after the pipeline
publishes the fresh commits. This repair performs no push or rebase.


## Creation-proof review corrections (2026-10-17)

The repeated publisher replay of `490e9fad7` confirms exactly 35 new,
seven pre-existing and zero flaky failures against `02f9301fc`. Its unchanged
two-file agent control has zero new, two pre-existing and zero flaky failures.
The only identity difference is the presence of the four launch-provided Git
author/committer fields. Both modes scrub the same inherited configuration and
isolate HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR.

The review regression cases cover imported merge commits with native and forged
reflog actions, shared-identity imported commits with versioned and versionless
starts, and original post-merge hooks for ordinary, `--no-verify`, fast-forward
and squash merges. The reviewed implementation fails seven of those eight
cases. Remote review base `1d55d9d23` passes seven; its existing failure is the
extra forged-action imported merge control. The final implementation passes
all eight. An additional octopus case proves that an ancestral original lane
head need not remain a direct parent of a genuine merge.

The former versionless missing-merge-receipt success assertion is replaced by a
pair requiring independent evidence: a retained receipt succeeds, and a missing
receipt refuses with the exact commit hash. Existing successor, rebase and PR
assertions remain intact. The shared native fixture now models the production
reservation and guard preparation instead of relying on versionless recovery.

The shared paths remain `prepareStageGitGuard` at dispatch, environment
bindings in agent publication policy, native hook receipt writers, and
`settleStageAttemptPush` plus its early refusal reader at settlement. No new
stored field, publication path or retry mechanism is introduced.

The final phase and static-check outcomes are recorded in
`evidence/stage-push-environment.json` under `proofFixVerification`. All runs
use the installed gate-slot wrapper, explicit paths and private state. The
pipeline owns publication and the required hosted checks after publication.

After the full phases, TypeScript required the fixture's partial Git environment
to use a partial-record type. Bun 1.4.0 emits byte-identical JavaScript before
and after that erased annotation correction. The evidence retains both the
tested and final TypeScript digests plus their common JavaScript digest.

The final complete 26-file phases pass against `02f9301fc`: publisher zero new,
six pre-existing and zero flaky failures (head 436,101 ms); agent zero new,
five pre-existing and zero flaky failures (head 429,207 ms). The proof file's
32 cases and PR file's 23 cases pass. The 16 focused rebase and custody controls
also pass with their assertions unchanged. TypeScript, changed-file ESLint and
the committed-fingerprint publication privacy gate pass. No push, rebase,
merge or runtime restart is part of this correction.

## PR successor provisioning bases and main ancestry (2026-10-22)

Observed on starting revision `351d63b1`: a successor whose provisioning
`baseBranch` names its PR branch refuses a stage's merge of current main.
The real-remote reproductions in `src/lib/pipelines/stageAttemptPush.test.ts:67`
advance main before and after creating the lane record, respectively. They
create the merge through the generated attempt hooks, restore a stale tracking
ref, then call the production `commitAndAdoptStageBranch` settlement path.
Both fail on the starting revision with the reported missing-creation refusal
for the imported main commit. Both pass after this change.

### Exact cause and the successful counterexamples

At `351d63b1`, `src/lib/pipelines/stageAttemptPush.ts:345` constructs
`refs/heads/${pipeline.baseBranch}`. Lines 346 and 351 query that branch on
the delivery remote and fetch its exact SHA, bounded to five and ten seconds.
The first unreceipted ancestor triggers this read, at line 398; the sampled tip
is reused only within that settlement call. The check never reads cached
`origin/main`. Thus a main commit already published before lane creation can
still fail: the freshly verified branch is the PR branch.

The provisioning branch comes from the caller's `baseBranch`, defaulting to
main (`src/lib/pipelines/engine.ts:12329`, `:12395` and `:12404`). Delivery's
branch and PR number do not replace that choice. With an explicit `baseRef`,
creation resolves locally without a fetch (`engine.ts:12374`,
`src/lib/pipelines/git.ts:175`). Otherwise the controller resolves the branch
at provisioning (`engine.ts:8638`); `git.ts:240` bounds its fetch to 60 seconds.
That startup fetch selects the checkout's starting commit independently of
settlement's later ancestor proof.

The retained primary pipeline records show:

| Lane | Created, UTC | Provisioning base | Settlement observation |
| --- | --- | --- | --- |
| `61c8e017` | 2026-10-21 20:37:56.560 | PR branch | Refused main ancestor `99b45bc7` in both build attempts. |
| `c8ece66c` | 2026-10-22 01:10:52.999 | PR branch | Refused main ancestor `c0870096` in its merge stage. |
| `972bb442` | 2026-10-21 21:56:20.510 | main | Published sync-stage merge `c58753f2`; its main parent was `8d8d88bc`. |
| `a87fa971` | 2026-10-21 23:07:06.395 | main | Published sync-stage merge `f87268e5`; its main parent was `5f811d62`. |

The two successful lanes verified main because their provisioning base was
main. Their retained sync-stage reports also record merges with hooks enabled.
The shared refusal wording in `93e9ab14` has a separate trigger: its base was
main, and its third attempt was refused for merge `a0517575` made by an earlier
attempt. Creation-receipt recovery belongs to PR #3156. Its reviewed diff
leaves the production settlement function unchanged; this change leaves its
guard, receipt writer, engine recovery and existing test cases untouched.
The local-gate files owned by PR #3128 are also unchanged.

### Resulting proof and verification

`src/lib/pipelines/stageAttemptPush.ts:348` now names origin's main for the
imported-ancestor exemption. It queries that remote directly and fetches the
exact observed SHA before checking reachability. A forged or stale tracking
ref supplies no proof. The existing lazy, per-call cache and five/ten-second
bounds remain. A failed remote operation defers; an absent or malformed main
cannot authorize the imported commit. Main never supplies a creation receipt
for the attempt's own merge.

The producer and consumers keep their existing contracts: provisioning writes
`baseBranch`/`baseRef`; stage hooks write attempt commit receipts;
`commitAndAdoptStageBranch` invokes settlement and retains its head guard;
producer repair invokes the same verifier with its accepted-head boundary;
publication consumes the accepted SHA. No stored fields or schemas change.
The existing published, tested clean-integration recovery keeps its additional
forge and default-branch checks.

The focused regressions also cover pushed and repair settlement, foreign
parents with a forged tracking-main ref, and lookup/fetch timeouts, missing
main and malformed remote output. Local, pushed and repair paths all refuse
foreign parents. On the starting revision the pushed case incorrectly passes:
the delivery branch can attest its own foreign suffix. The corrected proof
refuses it and preserves both tips. All test repositories and state are private;
no live installation is exercised. This change claims no performance gain.

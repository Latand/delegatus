# Stage push settlement and pull request delivery

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

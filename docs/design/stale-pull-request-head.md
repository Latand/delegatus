# Publication when a pull request head stays stale

Publication continues on fresh Git evidence as soon as a fresh PR read shows an
older head and Git proves the delivery branch contains the accepted commit
after that head. If Git cannot prove it, the existing bounded forge re-reads
and refusal remain. It does not close or reopen a pull request. Avoiding that
write also avoids an uncertain close/reopen outcome during an outage.

`src/lib/pipelines/stagePullRequest.ts` requires a settled successful publication
receipt for the accepted commit and current delivery owner/epoch. An available
pull request must pass every existing identity, state, repository and base
check. Its older head must be a commit proven to be an ancestor of the accepted
commit. A final, bounded `git ls-remote` must return exactly that commit at the
delivery branch. An unavailable forge can also defer confirmation when the same
receipt and fresh remote proof hold. Cached tracking refs supply no proof.
Ownership and target checks run again after each Git await; controller settlement
retains its existing cancellation fence. The initial lookup and the verification
after PR creation use the same proof. A body refresh still needs its exact text
read back before its write can count as confirmed.

The controller continues on Git evidence and checks the forge later. It leaves
PR state untouched, avoiding uncertain close/reopen outcomes during an outage.
The delivery record persists a rejected PR identity or divergent head against
its epoch and accepted commit. An outage cannot erase that refusal.
A later same-PR read can supersede an obsolete identity refusal only after the
identity is corrected, the stale head is proven an ancestor, and exact Git
publication proof plus current ownership pass again. Offline, foreign and
divergent retries retain their refusal. The attempt's persisted `error` records
deferred forge confirmation.

A final-fix PR body refresh also persists its accepted head, PR number and exact
report summary while forge confirmation is deferred. A bounded auto-merge sweep
continues reconciliation after the lane completes and after a process restart.
It rebuilds the same body text, runs the existing privacy checks, reads back the
exact result and then clears the pending refresh. Failed or still-stale reads
retain the record with a durable retry time. A legacy summary larger than the
reader's 60 KiB limit receives the existing classified size refusal before the
writer records an intent; the lane remains valid for recovery.

The merge controller keeps linked PRs on the normal forge path while PR identity,
reviews, checks and protection can be read. Once a PR read succeeds, a later
endpoint outage blocks automatic landing, retaining any observed head, state,
review or check refusal. This durable stop also survives a later unavailable PR
read. An initially unavailable PR read may fall back only with a settled publication
receipt and exact review-head or acceptance/integration evidence. The fallback
fetches the current base, proves a fast-forward is possible, reserves the merge,
pushes without force and reads the base again to prove the reviewed head landed.
For a fork PR it resolves exactly one configured Git remote whose repository
identity matches `target.prRepository`; it never lands the base through the
delivery fork's push remote. Uncertain pushes are reconciled from Git before any
retry. A refusal keeps the task open. Forge-dispatched merges retain the forge's
exact-head check and `--match-head-commit` fence. Explicit review-head mismatches
are refused before either landing transport is selected.

These refusals remain:

- A returned PR head that is divergent, absent, malformed or unavailable locally
  as an ancestor cannot explain the publication.
- A delivery branch that moved away from the accepted commit, or cannot be read,
  supplies no current publication proof.
- A PR from another owner/repository fails the existing identity checks. Wrong
  branch, base, number, state and ambiguous discovery retain their refusals too.

Review capture still binds to the exact published Git commit. The forge merge
runner still requires its PR head to equal the reviewed chain tip and dispatches
with `--match-head-commit`. The mismatch refusal uses the chronologically latest
successful review's captured `reviewHeadSha`, `outputBaseHead` or
`report.provenance.head`, so an older review does not override later review
evidence. The same mismatch guard runs under the reservation lock and again
in the writer callback after credential acquisition. Git-only continuation uses
that same chronologically latest successful review
and authorizes no merge unless its evidence binds the exact published commit.
Explicit acceptance and integration records retain their existing checks.
Privacy refusals retain their existing handling. Git-only landing uses no forge reads or writes.

## Baseline reproduction

Before changing production code, an isolated regression was run against main
`8ee4db2e42`. It drove the real controller publication path with a local bare
remote and a read-only forge stub returning an older ancestor. The remote
contained the exact accepted commit, but the lane entered `needs_decision` with
`the delivery pull request differs in headRefOid` after all bounded re-reads.
The regression expected completion and failed. No live forge state was used.

`src/lib/pipelines/parkedPublication.test.ts` exercises stale-head recovery,
unavailable reads, refusal persistence, and wrong repository, branch, number
and missing-head retries through the controller across a serialized restart.
Its forge fixture discovers by head before validating the base.
`src/lib/pipelines/stagePullRequest.refresh.test.ts` covers delivery changes across Git
awaits and completed-lane body refresh after a fresh process starts.
`src/lib/forge/autoMergeStore.test.ts`
drives local bare remotes through exact-review Git-only landing, linked and
unlinked mismatched-review refusal, healthy red/pending check holds, linked-PR
offline landing, fork/upstream landing, changed-owner and divergent-base
refusal, then checks task completion. Synthetic head-only tests explicitly
provide no Git proof and retain their earlier refusal expectations.

## Regression coverage

The retained fix regressions use isolated state and local bare Git remotes:

- `autoMergeStore.test.ts`: `F1` covers all three review capture fields, exact
  heads, explicit acceptance and publication integration; `F2` replays a durable
  queued merge; `F3` holds red/pending checks, changed heads, draft/closed state,
  review refusals and protection outages through a later unavailable PR read.
- `autoMerge.test.ts`: `F2` changes review proof after PR, reviews, protection,
  merge-method and credential awaits. Exact queued merges and terminal local
  declared outputs remain positive controls.
- `autoMergeStore.test.ts`: `F4` lands the latest reviewed head offline when an
  older review captured another head, with stages declared in a different
  order. A latest mismatched review refuses; acceptance and integration controls
  still land.
- `stagePullRequest.refresh.test.ts`: `F5` passes the writer's actual deferred intent
  through the store and a fresh process at the reader's 60 KiB limit. A larger
  legacy output receives a classified size refusal before an intent or forge
  body write can be made.

The existing `parkedPublication.test.ts` cases retain the real publication-path
coverage for stale heads and unavailable reads. Final validation uses explicit
file paths, typecheck, changed-file lint, the publication privacy gate and the
pre-push hook's own touched-test selection against main.

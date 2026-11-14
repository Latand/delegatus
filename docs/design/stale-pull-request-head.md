# Publication when a pull request head stays stale

Publication continues on fresh Git evidence after the existing bounded forge
re-reads. It does not close or reopen a pull request. Avoiding that write also
avoids an uncertain close/reopen outcome during an outage.

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

The choice is to continue on Git evidence and check the forge later, rather than
resyncing a PR. The delivery record persists a rejected PR identity or divergent
head against its epoch and accepted commit. An outage cannot erase that refusal;
a later PR read must resolve it, or a new delivery epoch or accepted commit must
make the rejection irrelevant. The attempt's persisted `error` records deferred
forge confirmation.

A final-fix PR body refresh also persists its accepted head, PR number and exact
report summary while forge confirmation is deferred. A bounded auto-merge sweep
continues reconciliation after the lane completes and after a process restart.
It rebuilds the same body text, runs the existing privacy checks, reads back the
exact result and then clears the pending refresh. Failed or still-stale reads
retain the record with a durable retry time.

The merge controller admits Git-only landing for a published PR-free or linked
lane only after the exact passed head has a settled publication receipt and
captured review-head or exact acceptance/integration evidence. It fetches the
current base, proves a fast-forward is possible, reserves the merge, pushes
without force and reads the base again to prove the reviewed head landed.
Uncertain pushes are reconciled from Git before any retry. A refusal keeps the
task open. Forge-dispatched merges retain the forge's exact-head check and
`--match-head-commit` fence.

These refusals remain:

- A returned PR head that is divergent, absent, malformed or unavailable locally
  as an ancestor cannot explain the publication.
- A delivery branch that moved away from the accepted commit, or cannot be read,
  supplies no current publication proof.
- A PR from another owner/repository fails the existing identity checks. Wrong
  branch, base, number, state and ambiguous discovery retain their refusals too.

Review capture still binds to the exact published Git commit. The forge merge
runner still requires its PR head to equal the reviewed chain tip and dispatches
with `--match-head-commit`. Git-only continuation authorizes no merge unless the
review evidence binds the exact published commit. Privacy refusals retain their
existing handling. Git-only landing uses no forge reads or writes.

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
`src/lib/pipelines/stagePullRequest.test.ts` covers delivery changes across Git
awaits and completed-lane body refresh after a fresh process starts.
`src/lib/forge/autoMergeStore.test.ts`
drives a local bare remote through exact-review Git-only landing, mismatched
review refusal, linked-PR offline landing, changed-owner and divergent-base
refusal, then checks task completion. Synthetic head-only tests explicitly
provide no Git proof and retain their earlier refusal expectations.

## Verification

Checks ran sequentially on 2026-11-14 through the gate runner, with isolated
HOME, XDG configuration, state and temporary directories. Each test file had
its own recorded command and terminal verdict. These results cover the review
repairs and final source.

| Command or scope | Result |
| --- | --- |
| `bun scripts/privacy-publication-gate.ts --require-known-values --check-commits --base origin/main` | Passed |
| `bunx tsc --noEmit` | Passed |
| `bun scripts/eslint-changes.ts --base origin/main` on seven changed TypeScript files | Passed; 0 introduced errors |
| `bun test --timeout=60000 src/lib/pipelines/stagePullRequest.test.ts` | 171 passed |
| `bun test --timeout=60000 src/lib/forge/autoMergeStore.test.ts` | 151 passed |
| `bun test --timeout=60000 src/lib/pipelines/parkedPublication.test.ts` | 137 passed, 10 failures; comparator against `origin/main` found no new failures |

The parked-publication suite's direct run has ten failures; the repository
comparator reproduced its aggregate failure on both base and head and found no
new failures. The local bare-remote tests cover exact-head review fencing,
linked-PR landing while the forge is unreadable, and task completion only after
Git proves the reviewed commit reached the base. The completed-lane recovery
test starts a fresh process, writes the saved summary once, verifies the body
read-back and clears the pending refresh. A replacement owner inserted after
the PR read keeps the refresh pending and sends no body write.

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
retain the record with a durable retry time.

The merge controller keeps linked PRs on the normal forge path while PR identity,
reviews, checks and protection can be read. A red or pending check never selects
Git landing. An unavailable forge may fall back only with a settled publication
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
drives local bare remotes through exact-review Git-only landing, linked and
unlinked mismatched-review refusal, healthy red/pending check holds, linked-PR
offline landing, fork/upstream landing, changed-owner and divergent-base
refusal, then checks task completion. Synthetic head-only tests explicitly
provide no Git proof and retain their earlier refusal expectations.

## Verification

Checks ran on 2026-11-14 through the gate runner with isolated HOME, XDG
configuration, state and temporary directories. Git tests used system Git
first in PATH. Each command was recorded and awaited to a terminal verdict.

| Command or scope | Result |
| --- | --- |
| `bun scripts/privacy-publication-gate.ts --require-known-values --check-commits --base origin/main` | Passed on final source and documentation |
| `bunx tsc --noEmit` | Passed on final source |
| `bun scripts/eslint-changes.ts --base origin/main <four changed TypeScript files>` | Passed on final source; 0 introduced errors |
| `bun test --timeout=15000 src/lib/forge/autoMergeStore.test.ts` | 153 passed; 2 process-restart follower cases timed out at 15 seconds. The same named cases timed out on merge base at the default 5-second limit (144 passed). |
| `bun test --timeout=15000 src/lib/pipelines/stagePullRequest.test.ts` | 172 passed. |

Focused stale recovery, deferred body/takeover and ownership-boundary controls
passed. The local bare-remote tests cover exact-head review fencing, healthy red and
pending PR checks, linked-PR landing while the forge is unreadable, fork landing
to the declared upstream, and task completion only after Git proves the
reviewed commit reached that base. The completed-lane recovery test starts a
fresh process, writes the saved summary once, verifies the body read-back and
clears the pending refresh. A successor takeover inserted after the PR read
leaves the previous owner disabled and sends no body write. The two
process-restart follower timeouts remain limited to the same named base controls.

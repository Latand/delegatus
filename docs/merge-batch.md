# Merger procedure

The `merger` role takes one required text parameter, `prs`, containing
comma-separated `N@reviewedSha` pairs. It defaults to Codex / GPT-6.1-Sol /
high, with read-write access and no child spawning. Use a single run stage or
`spawn_agent`; no additional MCP tool is needed. The seat must have merge
authority and exclude PRs whose live `merge.state` Delegatus already holds.

Run from the repository with a dedicated `TMPDIR` for this pass. Keep that
directory for every command; the run record is `$TMPDIR/merge-batch.json`.
The launched agent must have the machine noreply author and committer identity
described in [CONTRIBUTING](../CONTRIBUTING.md).

```sh
bun install --frozen-lockfile
bun scripts/merge-batch.ts build '12@abcdef1,13@1234567'
bun scripts/merge-batch.ts land
```

On a native Codex launch, `land` and `gate --local` print a fresh `runId` before
starting work. If the command yields while still running, call the native
`wait_for_check` once with that ID and the phase as its `reason`. The callback
returns the exit code and report tail after the phase ends and releases any
batch lock it owns. This includes a refusal because another run owns the
lock, and runs that finish before the wait attaches. The driver owns the
hosted check loop and schedules each heavy child. Run it directly to leave
the shared slot available between checks. If the recorder exits without a
terminal record, the wait reports an unknown result. Preserve the batch
state and reconcile the worktree and forge before clearing a stale lock.

`build` fetches fresh main and each listed PR, checks its open/non-draft/main
base and reviewed head, and allocates a temporary worktree on a unique
`merge-batch/…` branch. It leaves the caller's checkout untouched. In list
order, it squash-applies each PR as one commit. A conflict or a different
stable patch-id from a binary, zero-context diff defers that PR for the entire
pass, including rebuilds. The commit contains the title, PR number, first
body paragraph (up to 600 characters), and deduplicated machine credit.
Human `users.noreply` author identities add no trailers; an existing
non-machine `Co-Authored-By` trailer is refused.

## Landing with required GitHub checks

`land` verifies the owned worktree and its linear chain of reviewed patches.
It scans the candidate commits and generated PR body with the trusted scanner
from current main. It pushes only the batch branch and opens or updates one PR
with the original PRs and their closing issue references. The repository's
tracker audit runs as a required hosted check on the published candidate.

The script reads main's required check contexts from branch protection and
requires strict updates. It waits for the required checks on the published
tip to finish green. Optional failures leave the required verdict unchanged.
When a required check fails on the batch, the script reads the same check on
each member's reviewed head. A completed red on that head identifies a culprit.
For privacy checks, a diagnostic that identifies a batch commit or changed
line or path can also establish attribution. The script records the failing
tip, context and members, drops the named patches, and rebuilds. An
unattributable red reports the context and tip and stops the pass.

Main movement triggers reconstruction from the reviewed patches and another
trusted scan of the candidate and PR body. Updates use a lease on the owned
branch, and every new tip needs fresh hosted results. Three membership rebuilds
are allowed. Main-only refreshes preserve that budget. Every land iteration
spends one of 240 polls, recorded across restarts. Other branches use the
ordinary publication hook.

Before merging, the script checks each member's `reviewDecision` and all
pages of reviews. A human request for changes stands until that reviewer
approves or dismisses it. Comments and pending reviews leave it standing.
A member with an outstanding human request returns to its lane, and the
script rebuilds the remainder. An outstanding human request on the batch PR,
unreadable reviews or unverified App installation authority stop the merge.
The script checks main and reviewed heads again and uses
`gh pr merge --rebase --match-head-commit`. It verifies the landed chain's
patches and closes each unchanged original with its landed SHA and batch URL.
Original branches and moved PRs remain available for their lanes.

## Optional local validation

Run `bun scripts/merge-batch.ts gate --local` between `build` and `land`
to investigate the candidate with local checks. Add `--browser` for full
browser campaigns. Landing uses the reviewed patches and hosted verdict
independently of any local validation receipt.

The local command records the tested main and tip, ordered PR numbers,
reviewed head SHAs and stable patch-ids. It installs frozen dependencies and
runs TypeScript, comparative ESLint, tests and the trusted privacy scanner.
The commands run one at a time through `scripts/gate-slot.sh` in isolated
state. Tests also use isolated home, config and temp roots, a Viewer control
URL on a closed port, and individual files with JUnit reports.

Every validation rebuilds the touched-path union from the current candidate diff
and every input PR's immutable reviewed patch base and head, including withheld,
moved and deferred PRs. The existing `touchedTests` selector chooses changed test
files and adjacent `.test.ts` / `.test.tsx` files in each Git tree. The inventory
contains the native files from the real merged candidate: main plus each PR's
actual changes. A PR supplies a reviewed test blob only for a file changed
between its immutable review base and reviewed head. All other selected files,
including unchanged adjacent tests and files changed only by main or another
PR, use the merged candidate's version. An unchanged stale copy at a PR head
supplies no detector and never defers that PR. Unrelated repository tests stay
outside this gate.
Identical file versions are sampled once within that validation. Different
reviewed versions of files PRs actually changed run separately; removing a PR
cannot hide a restored native assertion. A changed detector keeps its own
assertions even when another member changed the same file.

When main changed a file that a PR also changed independently, the script
three-way merges main's contract update into that reviewed detector. It accepts
only a clean merge whose zero-context stable patch-id, relative to main, is
identical to the PR's original test patch. The PR's added or changed assertions
remain in every confirmation and removal probe. A conflict, deletion or changed
patch retains the original detector and its refusal rules. Adapted detectors
are listed separately in the exact tuple's receipt and report, and are rebuilt
from immutable Git objects on every validation. An unreviewed change to the
built tree still refuses the gate and publication.

A reviewed detector of a PR outside the candidate (deferred, moved, culprit) is
skipped and listed under "Skipped test files": it can import code the candidate
does not carry, and its native files still run. Full browser campaigns
(`*.browser.test.*`) are opt-in with `gate --local --browser`; each UI PR ran its own
browser checks in review, so by default they are listed as skipped.

The baseline is a fresh sample of the selected native main tests at that
candidate's main SHA. Candidate-only files and assertions supply no baseline
evidence. A test failing on both main and the candidate is pre-existing, reported
separately and permitted regardless of main's nonzero test exit. A between-test
error, a runner exit that disagrees with its report, or a run that leaves no
usable report is recorded as that file's fault; a fault native main produces in
the same file makes the candidate's fault there pre-existing. A file main cannot
complete is compared on the cases both sides completed: the cases the candidate
fails there run again on main by themselves, and the result main reports for
each is its baseline. When those cases cannot report together, each runs alone,
so one case that aborts main never erases another's result. A removal subject
whose file aborts reruns the cases under investigation the same way. The candidate's failures main still cannot report
are listed as not compared. A gate that cannot run, including
installation or type checking, stops with its own cause.

A new failure gets three subsequent observations of its file. Every confirmation
rerun discovers additional failures against the same baseline; a new identity
needs its own three observations. Six rounds bound confirmation. A passing
observation permits an intermittent failure; missing or skipped assertions never
provide passing evidence. Exhausting the budget stops the batch.

Confirmed failures are checked on subjects with each PR removed, preserving the
exact detector under investigation. Every subject installs frozen dependencies.
A behaviour conflict stops the pass. A clearing omission names the responsible
PR; multiple clearing omissions report `integration: needs both`. If no single
omission clears it, combined removals find a minimal clearing set. If all
implementation removals leave a failure, native test inventories are checked on
the tested main and each member's reviewed base and head. A case absent on main
and added by a member names that member with reason
`member-specific: adds the failing test`; the remaining batch is rebuilt and
gated. Each member's increase in native registrations identifies contributors
to a group of identical case names; occurrence numbers can change when those
independent additions are merged. An observed native-main failure with the same
case name in another file is pre-existing, including a moved case, and appears
in the receipt and batch PR body. When changed files and literal-name matches do not show that failure,
Bun locates candidate files with a case-name filter over the remaining main tests,
including unchanged parameterized and computed titles. Each matching failure
must then occur in a full native main file run before it grants an exemption.
The filter can skip setup tests and make a healthy main case fail; that filtered
observation alone supplies no baseline verdict.
Otherwise the gate retains the detector and refuses publication with its
attribution rule. The baseline inventory and partial decisions survive refusal.

Removal subjects rebuild main plus the remaining PRs' actual changes. Only the
detector under investigation is held fixed: either the native merged test or a
reviewed test file its PR actually changed, with any clean main-contract
adaptation described above. This applies to single omissions, combined removals
and the all-removed control. Untouched files keep each subject's native contents.
If the all-removed control remains red without native evidence of a moved
failure or member-added case, retain the detector and refuse the batch without
assigning a culprit. Historical stale-copy attribution records remain
readable in the append-only report; new validations never create them.
A case that passes on main and breaks on the candidate, a new file fault
included, drops only the PR whose removal clears it; the batch is rebuilt and
the rest is validated again.

The receipt keeps the tested tuple, current decisions and skipped test files.
A main-only refresh can carry the receipt as diagnostic history when the
ordered membership, reviewed heads and stable patch-ids still match. The
original tested tuple stays fixed, and `carried` records each rebuilt main,
tip and time. An explicit local validation in progress restarts when the
membership changes. Earlier receipts and test attributions remain available
for inspection. Each attribution retains the tuple, detector source, failure
identity, confirmations and removal observations.

## Deferred resolutions

After the batch lands (or becomes empty), resolve each deferred PR:

```sh
bun scripts/merge-batch.ts resolve 13
# Read resolving.work in merge-batch.json. Resolve and stage conflicts there.
bun scripts/merge-batch.ts resolve 13
```

The first call starts a merge of the new main into the reviewed head in a
separate temporary worktree. The next call commits the staged resolution,
checks it, and makes a normal fast-forward push to the original PR's head
repository. The result is `needs-review <sha>`; the merger never merges that
resolution in this pass. The seat assigns an independent branch review,
including `git show --remerge-diff <sha>`, before listing its newly reviewed
head in the next batch. A failed resolution gate can be retried after its
cause is addressed, with the recorded resolution kept for inspection.

Resolution tests use the local gate's shared native-main comparison and bounded
confirmation. Each selected file runs alone in a fresh isolated home, temp and
state root on the resolution and on the exact main merged into it. The baseline
is sampled anew for every resolution attempt; the earlier batch baseline supplies
no evidence here. Pre-existing assertions and file faults permit publication;
confirmed new failures withhold the original branch push. Between-test and file
errors are judged from the file's standalone run, so a bundled-only error is
rerun alone before any verdict. Incomplete main files use the local gate's named-case
probes. Dependencies, types, lint and privacy keep their gates.
The report records each resolution's main and tip, selected files, pre-existing,
intermittent and uncompared results, and confirmed new failures, including a
failed attempt kept for inspection.

The report separates pre-existing, intermittent and attributed test failures,
including confirmation and omission evidence when local checks ran. It also
records hosted check attribution. It has one row per input: `merged <main sha>`, `needs-review <sha>`,
`culprit <check: attribution>` or `head-moved`, plus the batch URL. A deferred
row initially says `needs-review pending resolution`; it is unfinished until
the merger resolves it or reports why the pass failed. The run succeeds when
every row is final and the batch merged or became empty. GitHub failures,
unattributable red checks, exhausted membership
revalidations and an exhausted polling bound fail the pass. Keep the
private run record and worktrees for inspection; worktree cleanup owns their
eventual removal. Do not push main or change branch protection.

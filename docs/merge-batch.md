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
bun scripts/merge-batch.ts gate            # add --browser to run full browser campaigns
bun scripts/merge-batch.ts land
```

`build` fetches fresh main and each listed PR, checks its open/non-draft/main
base and reviewed head, and allocates a temporary worktree on a unique
`merge-batch/…` branch. It leaves the caller's checkout untouched. In list
order, it squash-applies each PR as one commit. A conflict or a different
stable patch-id from a binary, zero-context diff defers that PR for the entire
pass, including rebuilds. The commit contains the title, PR number, first
body paragraph (up to 600 characters), and deduplicated machine credit.
Human `users.noreply` author identities add no trailers; an existing
non-machine `Co-Authored-By` trailer is refused.

`gate` validates one exact candidate: main's full SHA and the ordered list of
PR numbers with their full reviewed head SHAs. It installs frozen dependencies,
runs TypeScript, comparative ESLint, tests and the trusted publication gate.
Every command runs through `scripts/gate-slot.sh` (a shared machine slot,
CPU-pressure admission and its own scope in the CPU work slice; see
`docs/design/cpu-placement.md`), and the script queues them so no two run at
once: a merger that ran installs, type checks and test files side by side inside
its own scope was killed by its memory cap twice. Commands use isolated state;
tests also use isolated home, config and temp roots, a Viewer control URL on a
closed port, and run one file at a time with JUnit reports.

Every validation rebuilds the touched-path union from the current candidate diff
and every input PR's immutable reviewed patch base and head, including withheld,
moved and deferred PRs. The existing `touchedTests` selector chooses changed test
files and adjacent `.test.ts` / `.test.tsx` files in each Git tree. The inventory
contains those native candidate files plus their versions at the reviewed head
of each PR in the candidate; unrelated repository tests are outside this gate.
Identical file versions are sampled once within that validation. Different
versions run separately; removing a PR cannot hide a restored native assertion.
A reviewed detector of a PR outside the candidate (deferred, moved, culprit) is
skipped and listed under "Skipped test files": it can import code the candidate
does not carry, and its native files still run. Full browser campaigns
(`*.browser.test.*`) are opt-in with `gate --browser`; each UI PR ran its own
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
implementation removals leave a failure, attribution cannot be proven: the gate
names the failing tests, retains their detectors and refuses publication. Test
authorship and literal assertion syntax supply no attribution or exemption.
A case that passes on main and breaks on the candidate, a new file fault
included, drops only the PR whose removal clears it; the batch is rebuilt and
the rest is validated again.

The script holds three kinds of state: immutable reviewed patch bases and heads,
one completed validation receipt, and an append-only attribution log. The receipt
names the candidate tuple and built tip, current decisions and skipped test
files with their reasons.
Removing a culprit, main movement, head movement or rebuilding a changed patch
voids it completely. All gates, scoped detector discovery and baseline sampling
restart; no corpus, baseline, pass list or detector selection survives as evidence.
There is no validation cache. Publication and merge require the receipt's tuple and
tip to match, with fresh main and head checks at both boundaries.

Each attribution entry records its establishing tuple, detector source, failing
test identity, confirmations and removal observations. Rebuilds and main refreshes
never delete or rewrite entries. The report prints historical evidence for every
withheld culprit while current pre-existing and intermittent results come from
the completed validation. Clean PRs remain in input order and their complete
rebuilt candidate must pass before publication. Culprit heads stay unchanged.
Privacy and other non-test gates retain their existing attribution and stop rules.

`land` requires a fully validated exact candidate and tip, checks original heads
again, pushes only the owned batch branch, and creates one batch PR. Its body carries the
original PR references and their closing issue references. It obtains required
check names from main's protection and waits for those checks to be present,
finished and green. Optional failures do not hold this batch. A red required
check is attributed only through diagnostic commit/path notices in its failed
workflow log. A red without a usable notice stops without merging; ordinary
checkout log hashes cannot accuse a PR.

Main movement triggers reconstruction from the original reviewed patches, full
validation and a lease-protected update of the owned batch branch. Three refreshes
are allowed. The merge uses `gh pr merge --rebase
--match-head-commit`, preserving one commit per original PR. It verifies the
landed chain's patches, then closes each unchanged original with a receipt
linking its landed SHA and batch PR. Original branches stay in place. A head
that moves after landing stays open, with that fact in the run record.

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

The report separates pre-existing, intermittent and attributed test failures,
including confirmation and omission evidence. It has one row per input: `merged <main sha>`, `needs-review <sha>`,
`culprit <check: attribution>` or `head-moved`, plus the batch URL. A deferred
row initially says `needs-review pending resolution`; it is unfinished until
the merger resolves it or reports why the pass failed. The run succeeds when
every row is final and the batch merged or became empty. GitHub failures,
unattributable red checks and exhausted refreshes fail the pass. Keep the
private run record and worktrees for inspection; worktree cleanup owns their
eventual removal. Do not push main or change branch protection.

# Contributing

Outside pull requests are welcome. This page covers the one thing that is
easier to get right before you commit than after: the identity your commits
carry.

## Your commit identity reaches the default branch

Git records an author and a committer on every commit, and a squash merge lifts
both into a `Co-authored-by:` trailer on the commit that lands on `main`. This
repository is public, so that trailer is published — and the
`privacy-publication` check reads it before the merge composes it.

An identity passes when its address is on the forge's
`users.noreply.github.com` host, which GitHub issues for exactly this reason,
or when it is a machine-attribution mailbox. A personal address is reported as
`email_address` with a `merge_boundary:` line naming the commit, and the merge
is blocked until the branch is re-authored.

To use your no-reply address, turn on **Keep my email addresses private** under
GitHub's email settings, then point the checkout at the address it shows you:

```sh
git config user.email '<the no-reply address GitHub shows you>'
git config user.name '<your name or handle>'
```

Commits already written can be re-authored with `git rebase --exec`, or with
`git commit --amend --reset-author` for a single one.

## Everything else the check reads

The same check reads the files you changed and the commit messages you wrote.
Keep account handles, addresses, tokens, absolute home paths, and transcript
excerpts out of both — [docs/privacy-publication.md](docs/privacy-publication.md)
describes what it looks for and why. Run it before you open the pull request:

```sh
bun run privacy:check
```

Findings name a class and a count, never the value that matched, so a failing
run tells you where to look without republishing what it found.

## Commits from launched agents

Delegatus sets the author and committer environment for every launched agent,
including pipeline stages and plain spawns. The default is the controller's
Delegatus machine identity. Git configuration stays untouched, and agents can
keep their machine attribution trailers.

An agent must add a new commit on top of work authored by someone else. The
launch environment installs Git hooks that refuse
amends and other history changes which remove commits authored by a different
identity, including `--reset-author` and `--no-verify` amends. New commits,
merges and amendments of the configured machine's commits remain available.
The same protection applies to detached HEAD history; moving a detached HEAD
back past another author's work is refused. Existing repository hooks still
run, including the publication gate. If `core.hooksPath` points at the guard,
a symlink to it, or an older generated guard retained from a previous launch,
it chains to the checkout's `.githooks` instead. A forwarded hook that invokes
the guard again is chained only once; author and stage checks still run on
every entry. This environment policy is intended for cooperating agents and
does not isolate hostile shell commands. Author reuse through `commit -C`,
`cherry-pick` and `am` is also refused when it would create a commit carrying
another author's identity. Hooks live under the launching home's cache so
container-launched agents can reach them on the host.

To configure an installation's agent publication identity, set
`DELEGATUS_PUBLICATION_NAME` and `DELEGATUS_PUBLICATION_EMAIL` in the launching
Viewer and runtime host environment. The legacy `LLV_` spellings also work;
the `DELEGATUS_` spelling takes precedence. Use a machine display name and a
mailbox whose local part is exactly `noreply` or `no-reply`. Personal mailboxes,
the forge's merge composer mailbox, empty values and malformed identities
refuse the launch with an error that withholds the configured values. These
settings apply to newly launched agents after the next deploy.

## GitHub writes from launched agents and from the engine

In a repository this installation declared as an App repository, a push, a
pull request creation or edit, a merge and a branch update made by a launched
agent or by the pipeline engine go out as the Delegatus GitHub App, with a
short-lived installation token asked for that one repository and for exactly
`contents: write`, `pull_requests: write` and `metadata: read`. None of those
writes falls back to a person's credentials: when the App credential is
missing, locked, suspended or refused, the write stops with a message that
starts `Delegatus refused this GitHub write` and nothing is sent.

**The declaration** is `forge-app-repositories.json` in the state directory, a
JSON array of `owner/name`, for example `["acme/widgets"]`. It is off by
default: with no file, no repository is declared and a launch adds no shim, no
rewrite and no variable. A second repository is one more string in the array,
after the App is installed on it and its credential item exists. The file is
read at every launch, so a change needs no restart, and a file that is not such
a list refuses the launch instead of reading as empty. Every repository that is
not listed keeps the credentials and the commands it had.

**The covered kinds** are a written list, `FORGE_APP_GH_COMMANDS` and
`FORGE_APP_API_WRITES` in `bin/forge-app-token.mjs`: `gh pr create`, `pr edit`,
`pr merge`, `pr update-branch`, and the same four through `gh api`. A kind the
App holds no permission for (an issue, a workflow dispatch, a run rerun, a
release, a comment) is not on the list, is not rerouted, and runs as it always
did. Adding a kind is a decision about the App's permissions.

One issue is filed by Delegatus itself: the bug report an operator approved
(`issue_report`, `src/lib/issueReports/publish.ts`). In a declared App
repository it goes out as the App on a token asked for `issues: write` and
`metadata: read` alone (`FORGE_APP_ISSUE_PERMISSIONS`), so the App needs the
`issues` permission granted before a report can be filed there; without it the
report is refused and nothing is sent as a person. An agent's own
`gh issue create` is not covered and runs as it always did.

One action has one classification in every spelling `gh` accepts: `pr new`
for `pr create`, a pull request given as its URL (which names the repository
from any directory, before `--repo`), a REST path or its absolute
`https://api.github.com/` URL, flags joined to their values (`-ftitle=x`,
`-XPUT`), and both placeholders, `{owner}/{repo}` and `:owner/:repo`, filled
from `GH_REPO` or the checkout. The repository is read the way `gh` reads it:
an empty `--repo` or `-R` and an empty `GH_REPO` are absent, so the next source
in `gh`'s order (the flag, `GH_REPO`, the checkout) names it; a subdomain of
github.com, a user name and a port in a URL are dropped; and a pull request URL
is read by its start, whatever follows the number. A covered kind whose
repository is named in a form the shim cannot read (a repository number, one placeholder beside a
written name) is refused, and so is one typed in a checkout whose first GitHub
remote is undeclared while another is declared, until `--repo` names it. An
alias the operator defined with `gh alias set` is not expanded.

- **`gh` in an agent's shell** is a shim (`bin/forge-app-token.mjs gh`) once a
  repository is declared. For a covered kind aimed at a declared repository it
  mints a token, starts `gh` with it as `GH_TOKEN` and an empty configuration
  directory, and revokes it when `gh` exits. Every other command reaches `gh`
  with the arguments and the environment it was typed with. `gh` 2.45 reads a
  pull request's classic project cards before `gh pr edit`, which an
  installation token may not; the shim then names the REST form,
  `gh api -X PATCH repos/<owner/name>/pulls/<number>`, which is covered too.
  The shim is found because its directory is first on `PATH`, and an engine
  types commands into a login shell whose profile may put directories of its
  own in front. So each agent launch asks `bash -lc` (and `$SHELL`) which `gh`
  and which `git` it finds in the launch environment and is refused, with the
  path it found, when either is any file but its shim. Keep `gh` and `git` in
  a directory the login profile does not prepend, such as `/usr/bin`.
- **`git push` to a declared repository** is rewritten, in the agent's
  environment only, to a push URL that one credential helper answers, with
  every other helper cleared for that URL. SSH remotes are rewritten the same
  way. Fetches, and pushes to every other repository, keep the remote and the
  credentials they had. The rewrite written at launch matches a remote spelled
  as the declaration spells it or in lower case. It matches by prefix, so a
  sibling whose name starts with a declared one is caught too; the helper
  answers that push from git's ordinary helpers, over HTTPS. A refusal answers
  `quit=true`, also from a shim that finds no helper file or no `bun` or
  `node`, so git never goes on to askpass or a terminal prompt.
- **`git` in an agent's shell** is a shim too. Every command but a push goes
  straight to the real `git`, with no process started in between. A push runs
  `bin/forge-app-token.mjs git`, which reads the checkout's remote URLs and the
  URLs typed on the command line and, for each that names a declared
  repository in a spelling the launch rewrite does not match (other letter
  case, a user name or a port in the URL, `www.github.com`, an explicit
  `pushurl`, a shorthand the checkout's own `insteadOf` expands), adds a
  rewrite of that exact spelling to the App's URL for that one command. Git
  asks for a credential before any hook runs, which is why this is done in
  front of `git` and not in `pre-push`. A push the shim cannot start the helper
  for is refused. A git alias that stands for `push` is not expanded.
- **The engine** (`src/lib/forge/autoMerge.ts`) merges and updates a branch
  through `AutoMergePorts.write`: `forgeAppWriter` for a declared repository,
  the plain `gh` runner for any other. A refusal blocks the merge with the
  refusal as its reason. The push that publishes a lane's branch
  (`src/lib/pipelines/git.ts`) and the push and `gh pr create` that finish a
  workflow (`src/lib/workflows/provision.ts`) run with `engineForgeWriteEnv()`,
  the same push rewrite and the same `gh` and `git` shims.
- **Batch landing** (`scripts/merge-batch.ts`) checks its principal against an
  installation endpoint. Run from a launched agent in a declared repository,
  that check and the merge both go through the shim.

The App's registration and its verified installation id live in the operator's
encrypted Secret Service collection, as one item with the attributes
`service=delegatus-github-app` and `repository=<owner/name>`; the helper reads
it with `secret-tool`. Nothing about the App is stored in this repository, in
state files or in logs, and a token exists only in the memory and environment
of the process that asked for it. `bun bin/forge-app-token.mjs token` prints one
on captured stdout and refuses a terminal. The declaration names repositories
and holds nothing secret.

A push that edits `.github/workflows` needs a `workflows` permission the App
does not hold and is refused by GitHub itself. Nothing here changes git or
`gh` configuration on disk, so a person's own terminal behaves as before. The
shims are POSIX shell; on Windows a launched agent keeps the environment it had.

## Batch landing

The shipped Merger lands reviewed pull requests through the batch procedure a
project's instruction files name. This repository's procedure is
`scripts/merge-batch.ts`. Install frozen dependencies in the caller checkout,
then use the script: build with the pairs, gate, then land. The script owns a
temporary batch worktree and records its run in `$TMPDIR/merge-batch.json`;
inspect that record and its report. The script runs every gate command one at
a time; follow the assembled gate guidance for checks you run yourself, using
the project's own commands. After the batch lands, run `resolve N` for each
deferred PR, resolve its conflicts in the recorded worktree, stage only those
resolutions and run `resolve N` again to gate and fast-forward its branch.

Every tuple change voids the entire validation: restart every gate, native test
inventory, reviewed detector snapshots and fresh native-main baseline; carry no
corpus, samples, pass list or detector selection as evidence. Rebuild the
touched-path union from the candidate diff and every input PR's immutable
reviewed patch base and head, including withheld, moved and deferred PRs. Use
`touchedTests` to select changed tests and adjacent `.test.ts`/`.test.tsx` files
in the native candidate and the reviewed tree of each PR in the candidate, and
rediscover restored native files. A detector of a PR outside the candidate is
skipped with a note. Full browser campaigns are opt-in (`gate --browser`): each
UI PR ran its own browser checks in review. Unrelated repository tests are
outside this gate. Deduplicate identical file versions only within that
validation.

Failures, errors and between-test errors that a test file produces on native
main are pre-existing and never stop the batch; a file main cannot complete is
compared on the cases both sides completed. Candidate-only files and assertions
have no baseline evidence. New failures need three subsequent file
observations, including identities first seen during confirmation, within six
total rounds. A passing observation permits intermittency; missing or skipped
assertions provide no passing evidence. Removal probes preserve the detector
being judged and install their own dependencies. Clearing omissions name the
culprit or integration: needs both. The exception is a stale reviewed detector:
a PR's copy of a test file its patch never changed, which main changed after its
base; the script defers only that PR with the main commit and file, and
`resolve N` merges main into it after landing. A case that passes on main and
breaks on the candidate, a new between-test error included, drops only the PR
whose removal clears it; the script rebuilds and lands the rest. Record
attribution in an append-only log with its establishing tuple, failing
identities, confirmations and removal evidence; retain and print it after every
main refresh. A PR the batch landed is closed with a "Landed on main as <sha>
through #B" comment.

## Review exports

From the lane, run `bun scripts/review-export.ts <reviewed-commit>` with the
stage's `TMPDIR` set. It exports committed source into a new scratch checkout
and returns its directory, resolved commit and dependency status as JSON.
Matching manifests, Bun lockfiles and patch files let it borrow the lane's
`node_modules` through a link. Reviewers treat that link as read-only; caches
and build output belong in the scratch checkout. Never run an install there.
Local or workspace dependencies, changed inputs and absent dependencies return
`unavailable`, leaving the source ready for code review without an install.
If a required check needs that incompatible graph, report the access gap.
The stage's scratch teardown removes the export and its link together.

## Local hooks

Enable once in each clone (linked worktrees inherit the setting):

```sh
git config core.hooksPath .githooks
```

Pre-commit checks staged whitespace, privacy using the committed known-value
fingerprints, and eslint on staged source files. These checks read working-tree
content, including unstaged edits in a partially staged file. Pre-push checks
publication including commit messages and identities, incremental TypeScript,
changed-file lint, and touched test files. ESLint in both hooks and the merger
compares each changed file with its version at the merge base with `origin/main`.
Only additional errors block: counts are matched per file, rule and message,
excluding locations/source frames embedded in React diagnostics. New files have
an empty baseline; deleted files are ignored. The output names introduced sites
and counts existing base errors. Warnings do not block; tool/config failures do.
Privacy and TypeScript still check absolutely. Base linting runs only for the
selected files, in the same gate slot as head linting. Controller stage commits
allow fifteen minutes for hooks; a controller deadline keeps the passed attempt
in committing and retries with backoff, without asking the stage to repair
files or parking the lane. CPU admission and its wait accounting follow the
shared heavy-work gate policy.
Tests run by explicit file path under
an isolated home, config, state and temp root. Git repository variables exported
to hooks are removed from child checks so fixture repositories remain isolated.
On Unix the sandbox lives under `/var/tmp`, including when a pipeline inherits
a `TMPDIR` under the operator's scratch tree. Browser tests keep their rendered
capture drivers and are not selected by the hook.

Touched tests run the branch first, up to eight explicit head files at once, each
in its own owned process and isolated roots. A green branch skips the baseline
entirely. For a red branch, only failing files run on the merge base, filtered
to failing assertions; runner diagnostics need the whole file. Both kinds share
one three-worker baseline pool, with the filter chosen per file.

The publisher and direct hook share `src/lib/pipelines/gateBudget.ts`.
Changes to `src/lib/pipelines/engine.ts` and its `engine.*.ts` siblings,
`src/lib/pipelines/git.ts` or `src/lib/pipelines/parkedPublication.test.ts`
reserve 25 minutes for the push and 24 for its hook. Other changes retain 15
and 14 minutes. The publisher applies this rule
to repositories using `scripts/local-gate-tests.ts`; other repositories keep
their existing 15-minute limit. An unreadable diff in an opted-in repository
reserves the larger bounded window. All checks still owe a verdict, and an
explicit caller deadline takes precedence. File, phase and paired-confirmation
budgets remain unchanged.

The three verdicts read as follows.
`PRE-EXISTING`: the assertion failed the initial sample on both sides. It is
classified on those two samples, runs no further, and permits the push.
`FLAKY`: the assertion failed the initial head sample, passed the initial base
sample, and then gave mixed results on at least one side. It is listed with the
file, suite/test name and pass/fail counts for both sides, and permits the push.
`NEW`: the assertion fails every head sample and never fails on base. It
refuses the push.
Only an assertion that could end as `NEW` is confirmed: it runs up to three more
times on each side, filtered by its full test name in its file. A failure on
any base retry or a pass on any head retry makes it `FLAKY`. New tests have
zero base observations. Missing, skipped or incomplete retry results are gate
errors, never passing evidence.
A failure on both initial samples gets no reruns because neither label it could
end with blocks the push; reruns there bought only the label and cost three
filtered runs per side on every push that touched the file. An intermittent
test that happens to fail both initial samples is therefore printed as
`PRE-EXISTING` for that push.
A file whose run is broken on the base the same way as on the head never
blocks. "The same way" means the same diagnostic identity: the file, the kind
of diagnostic, and its first error line, with the checkout path and the
private sandbox path replaced by placeholders. That covers an error between
tests and a run that did not finish (no complete report, a timeout, a runner
exit that disagrees with its report). Such a diagnostic prints as
`PRE-EXISTING ... (the base run of this file is broken the same way)`. A
between-tests diagnostic only the head shows gets one isolated full-file
retry. If it disappears, it is `FLAKY`; if it repeats, it stays `NEW`. A
different diagnostic is retained as `NEW`; a new assertion still refuses the push.
Incomplete reports, ownership failures and failed cleanup retain their strict
verdict without this retry. A base file that did not finish while the head finished it,
or failed to finish differently, remains a gate error. During confirmation a
side may repeat the between-tests errors of its own initial sample; any other
runner or between-tests error in a retry is a gate error.
Fixed and removed/skipped assertions are listed within sampled failing files;
a wholly green file produces no baseline-only informational verdicts.
When several assertions share the same file, suite and test name, retry
evidence and the initial base/head comparison preserve their occurrence numbers;
a recovered occurrence is `FIXED` while a separately failing head occurrence
remains `NEW`.

When a complete comparison still reports new between-tests diagnostics and
also labels flakiness, the hook reruns that check phase once in fresh isolation
before parking the lane. Its new-failure count must match the diagnostic rows.
A new assertion, a runner failure, an incomplete comparison or failed ownership
cleanup vetoes this retry. A retry without a verdict preserves the first
refusal. Both attempts share the push execution budget and existing admission;
the retry never starts another push or repeats publication effects.

Clean head samples and failures already present in the initial base sample
incur no reruns. An occurrence with a complete passing head retry or failing
base retry is already `FLAKY` and leaves the later confirmation selections.
Unresolved occurrences still receive up to three rounds per side. The base and
head of a round run concurrently in separate sandboxes, with at most three
files per side. Both sides settle before evidence is judged, including when
one refuses. Duplicate names retain their occurrence identities; filtering one name can still execute
its other occurrences. The rounds share a five-minute budget across all
candidate files and both sides, including baseline checkout and dependency setup.
Counts on a `FLAKY` row stop at its classification. Each child command is capped
by the remaining budget; exhausting it blocks with a gate error. This adds at most
five minutes of subprocess execution/setup, plus ordinary report parsing and
sandbox cleanup. For an unresolved occurrence after an initially passing
base sample, three independent reruns detect a one-in-ten base failure with
probability `1 - 0.9^3 = 27.1%`.
Four independent base samples detect it with probability `34.39%` overall;
rare or correlated failures can still evade this bounded sampling. Head
recovery supplies a separate opportunity to identify intermittency.

Baseline results are not cached. Every failure receives a fresh base sample
and fresh filtered confirmation runs.

Mandatory privacy inspection runs without admission alongside the isolated
pre-push checks. Both verdicts must pass; either refusal or timeout stops the
other half and waits for owned process cleanup. Privacy keeps its refusal text
and exit behaviour. The heavy phase takes one shared slot: types then lint run
alongside touched tests then Linux checks, the runtime chain and native Codex. Each lane stops the others on failure, retains its own
verdict and uses the shared execution deadline. Nested capped steps reuse the
admitted slot while retaining their own process scope and quota. Pre-commit
lint runs directly for up to 40 staged files and takes admission for larger
selections.

The pre-push gate reuses the platform import closure to scope Linux tests.
Viewer/runtime-host and native Codex verification run locally only for
`Dockerfile`, `src/runtime-host/**` or `bin/**` changes. Every PR runs both jobs
under the Dockerfile pin; `runtime-gate` joins them into one stable context
and is a required check on main. A PR pushed before the workflow landed needs
another push or close and reopen to report it.
Scoped Linux tests use the same merge-base
comparison as touched tests, so a platform test `origin/main` already fails is
`PRE-EXISTING`. A push that changes no file against the merge base (a read-only
stage, a branch that only trails `origin/main`) runs privacy with
`--check-commits` and nothing else; a push that changes only `.md`, `.mdx` or
`.txt` files skips types. Any other changed file keeps every scoped check.
The native Codex phase runs the files that start the Codex executable once per
supported version (`verify-native-codex-runtime.ts --engine-only`) and the rest
once (`--shared-only`), with those checks running concurrently. Local publication
gives the shared selection its merge base through `LLV_GATE_COMPARE_BASE`; it uses the
same isolated comparator and bounded retries as touched tests. Hosted shared
verification keeps its absolute verdict. Both modes isolate every file's
roots and preserve nested service CPU placement and admission accounting.
A caller that kills the
push at a limit of its own hands the hook a Unix-millisecond deadline in
`LLV_GATE_PUSH_DEADLINE`; the controller's publication sets it a minute before
the selected 15- or 25-minute push limit. With a supplied deadline, the fetch
of `origin/main`, a cold-cache Bun or Codex install and every step use it.
A direct hook derives the same default after planning when no caller supplied
one; its initial fetch and planning precede that default. CPU queue waits extend it,
including waits during installation and earlier steps; once the remaining
execution budget is spent, nothing starts. A stopped step takes with it every process
that inherited its environment and every scope `gate-slot.sh` gave it; one that
survives fails the push with its PIDs. The shared native
contracts, which the hosted `Bun runtime pin` workflow also runs, are stopped
and named as left to that workflow; a decisive step still running is stopped
with `no verdict within the push budget`, naming the check, which the
publication retries as an interrupted push. A manual heavy phase has a fifteen-minute execution limit.
Bun and Codex fixtures are cached under
`${XDG_CACHE_HOME:-$HOME/.cache}/delegatus-gate`. Dependency or allowlist changes
also run the shared supply-chain check; CI audits weekly and by dispatch.

Heavy commands run through `scripts/gate-slot.sh`: six slots by default,
`LLV_GATE_SLOTS` to change the count, `LLV_GATE_MEM` for the systemd memory cap
(default `8G`), and a default Node heap of 6144 MB. The slot locks live in
`/var/tmp`, the files the installed `/var/tmp/llv-gate` uses, so both gates
share one set of slots; `LLV_GATE_LOCK_DIR` overrides the directory. Stage starts and gates share a durable FIFO CPU queue. After ten minutes,
the head can start under sustained pressure, with two seconds between admissions.
A test, a driver or any instance on a state directory of its own queues its
stage starts in `<state>/cpu-gate`, never in the machine queue; a stage ticket
nobody polls for a minute is passed over.
Queue waits are excluded from hook and command execution budgets. On Linux a
gate then runs in its own scope in
`delegatus-agents-work.slice` with a 300% CPU quota; without a reachable user
systemd manager, or when the kernel shows no CPU quota on the gate's scope, it
refuses with exit 69 unless `DELEGATUS_AGENT_CPU=off`
(docs/design/cpu-placement.md). Without flock (macOS), the slot lock is omitted. Linux commands run in a transient service with
`KillMode=control-group`, a two-second TERM-to-KILL bound and a finite execution deadline
(`LLV_OWNED_RUN_TIMEOUT_MS`, default fifteen minutes) and a kernel watchdog. A recorded caller start
identity detects a hard-killed wrapper; detached descendants stay owned by the
service. Surviving children fail the command before the manager reaps them.
Linux requires a reachable user systemd manager. macOS and Windows use an
independent identity-bound guardian with best-effort execution and one warning
per owning run; a detached child can escape between guardian polls. The strong
lifetime guarantee applies to Linux native containment, as recorded in
`docs/verification/test-child-lifetime.md`.
An existing `NODE_OPTIONS` is preserved. Production builds cap page-data
workers at two to fit the gate's three-CPU quota. The Viewer build and its
runtime consumers share a private source tree with read-only dependencies;
they neither contend on another build's `.next/lock` nor consume its output.
The hook labels CPU admission for publication checks and prints its measured
queue wait, excluded from the execution budget.

Run an individual test as `bash scripts/gate-slot.sh bun test <file>` with an
isolated home, config, state and temporary root. The preload registers real
Node and Bun children before spawn returns, checks for survivors, and reaps
them before deleting its temporary root. Direct and nested Linux test runners
enter their own service before test modules load. Portable runs use an independent
guardian. Fixtures with blocking barriers check their recorded
parent identity within the barrier; asynchronous fixtures check it on a timer.

Reviewers use the same baseline comparator directly, without invoking a push:

```sh
bash scripts/gate-slot.sh bun scripts/local-gate-tests.ts --base <captured-base-sha> <explicit-test-paths...>
```

Use the base commit captured for the review. For a PR without a captured base,
resolve `git merge-base origin/main HEAD` once and record that SHA. Select the
test files required by the changed behavior, including the file that failed;
never pass a directory. The helper runs each file separately on the base and
the current working tree in isolated environments. Its detached temporary
clone leaves the review checkout, refs and worktree registration untouched.
New test files have no base observations and are judged on the head alone.

Retain the command, base/head commit lines and named outcomes as review
evidence. Record any uncommitted reviewed changes separately: the head commit
line identifies HEAD, while the head sample executes the working tree.
`PRE-EXISTING` and `FLAKY` outcomes belong in review notes; a base failure alone
does not warrant a finding or a failing PR verdict. `NEW` failures still
block. Missing or incomplete comparison evidence is a check gap to resolve,
never proof that a failure existed on the base. Other independently evidenced
defects in the diff retain their findings.

`LLV_SKIP_HOOKS=1` skips both hooks for a false positive. A fetch failure uses
the last `origin/main`; a missing merge base fails the push. The hook warns
when main is ahead. Missing tesseract/ffmpeg/ffprobe defers named media paths to
CI OCR. The two required privacy checks remain strict and unchanged; local
hooks do not replace trusted CI enforcement. macOS and Windows CI keep scoped
jobs with timeouts, and Bun verification remains available by dispatch.
Docker PR builds are limited to image inputs, push nothing, end at the
45-minute job timeout, and are cancelled when superseded or closed. Merge-batch branches skip image verification. App changes verify
amd64; image recipes and installation inputs verify both Linux
architectures. One PR build and one publication can run at once in separate
single-build slots, leaving publication independent of the PR queue.
Main and v* tag image publishing are preserved,
as are npm publishing and the in-image candidate rehearsal.

`scripts/rebuild.test.ts` exercises the actual host deploy command against a
port-0 server behind the team gate, including credentials, redirect refusal,
receipt replay and terminal exit codes. The changed test is selected by the
pre-push touched-tests gate. Run it by path in isolated home/config/state.

After this workflow switch, a merge already waiting on a removed check name
may need to be re-armed once. Main's branch protection requires exactly three
checks, `privacy-publication`, `privacy-tracker-audit` and `runtime-gate`, with
strict updates enabled.

## Running selected tests

Use `bun run test <explicit test files>` through `scripts/gate-slot.sh`, with
private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR and a closed
LLV_VIEWER_CONTROL_URL. The package command passes a 60-second default timeout
to every file. Bun ignores a `[test] timeout` key, and a preload timeout reaches
only its first file on the pinned runtime. Explicit per-test timeouts still
apply. The pre-push comparator and merger pass the same CLI timeout.

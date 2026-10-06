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
run, including the publication gate. This environment policy is intended for
cooperating agents and does not isolate hostile shell commands. Author reuse
through `commit -C`, `cherry-pick` and `am` is also refused when it would create
a commit carrying another author's identity. Hooks live under the launching
home's cache so container-launched agents can reach them on the host.

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
selected files, in the same gate slot as head linting.
Tests run by explicit file path under
an isolated home, config, state and temp root. Git repository variables exported
to hooks are removed from child checks so fixture repositories remain isolated.
On Unix the sandbox lives under `/var/tmp`, including when a pipeline inherits
a `TMPDIR` under the operator's scratch tree. Browser tests keep their rendered
capture drivers and are not selected by the hook.

Touched tests compare one initial head sample with one initial sample of the
merge base. The three verdicts read as follows.
`PRE-EXISTING`: the assertion failed the initial sample on both sides. It is
classified on those two samples, runs no further, and permits the push.
`FLAKY`: the assertion failed the initial head sample, passed the initial base
sample, and then gave mixed results on at least one side. It is listed with the
file, suite/test name and pass/fail counts for both sides, and permits the push.
`NEW`: the assertion fails every head sample and never fails on base. It
refuses the push.
Only an assertion that could end as `NEW` is confirmed: it runs three more
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
diagnostic only the head shows, or one whose error line differs, is `NEW` and
refuses the push. A base file that did not finish while the head finished it,
or failed to finish differently, remains a gate error. During confirmation a
side may repeat the between-tests errors of its own initial sample; any other
runner or between-tests error in a retry is a gate error.
Fixed and removed/skipped tests remain listed separately.
When several assertions share the same file, suite and test name, retry
evidence and the initial base/head comparison preserve their occurrence numbers;
a recovered occurrence is `FIXED` while a separately failing head occurrence
remains `NEW`.

Clean head samples and failures already present in the initial base sample
incur no reruns. The three rounds share a five-minute
budget across all candidate files and both sides, including baseline checkout
and dependency setup on a cache hit. Each child command is capped by the
remaining budget; exhausting it blocks with a gate error. This adds at most
five minutes of subprocess execution/setup, plus ordinary report parsing and
sandbox cleanup. After an initially passing base sample, three independent
reruns detect a one-in-ten base failure with probability `1 - 0.9^3 = 27.1%`.
Four independent base samples detect it with probability `34.39%` overall;
rare or correlated failures can still evade this bounded sampling. Head
recovery supplies a separate opportunity to identify intermittency.

The baseline cache stores only complete green initial samples, so a base with
a failing assertion is sampled once on every push and never read from the
cache. A parsed
baseline retry failure evicts its green entry immediately, even when a later
file in that retry batch errors; any aborted baseline retry also evicts the
entry. Neither retry verdicts nor head results are cached. Even a warm green
baseline needs fresh base retries before a candidate failure can become `NEW`.

The pre-push gate reuses the platform import closure to scope Linux tests,
Viewer and runtime-host verification under the Dockerfile's Bun pin, and the
supported native Codex fixtures. Scoped Linux tests use the same merge-base
comparison as touched tests, so a platform test `origin/main` already fails is
`PRE-EXISTING`. A push that changes no file against the merge base (a read-only
stage, a branch that only trails `origin/main`) runs privacy with
`--check-commits` and nothing else; a push that changes only `.md`, `.mdx` or
`.txt` files skips types. Any other changed file keeps every scoped check.
Bun and Codex fixtures are cached under
`${XDG_CACHE_HOME:-$HOME/.cache}/delegatus-gate`. Dependency or allowlist changes
also run the shared supply-chain check; CI audits weekly and by dispatch.

Heavy commands run through `scripts/gate-slot.sh`: six slots by default,
`LLV_GATE_SLOTS` to change the count, `LLV_GATE_MEM` for the systemd memory cap
(default `8G`), and a default Node heap of 6144 MB. The slot locks live in
`/var/tmp`, the files the installed `/var/tmp/llv-gate` uses, so both gates
share one set of slots; `LLV_GATE_LOCK_DIR` overrides the directory. On Linux a
gate waits while CPU pressure is high (sampled again when it takes its slot),
then runs in its own scope in
`delegatus-agents-work.slice` with a 300% CPU quota; without a reachable user
systemd manager it refuses with exit 69 unless `DELEGATUS_AGENT_CPU=off`
(docs/design/cpu-placement.md). Without flock (macOS), the slot lock is omitted.
An existing `NODE_OPTIONS` is preserved.

`LLV_SKIP_HOOKS=1` skips both hooks for a false positive. A fetch failure uses
the last `origin/main`; a missing merge base fails the push. The hook warns
when main is ahead. Missing tesseract/ffmpeg/ffprobe defers named media paths to
CI OCR. The two required privacy checks remain strict and unchanged; local
hooks do not replace trusted CI enforcement. macOS and Windows CI keep scoped
jobs with timeouts, and Bun verification remains available by dispatch.
Docker PR builds are limited to image inputs, with a 45-minute timeout and
cancellation of superseded runs. Main and v* tag image publishing are preserved,
as are npm publishing and the in-image candidate rehearsal.

`scripts/rebuild.test.ts` exercises the actual host deploy command against a
port-0 server behind the team gate, including credentials, redirect refusal,
receipt replay and terminal exit codes. The changed test is selected by the
pre-push touched-tests gate. Run it by path in isolated home/config/state.

After this workflow switch, a merge already waiting on a removed check name
may need to be re-armed once. Branch protection needs no change: keep exactly
`privacy-publication` and `privacy-tracker-audit`, with strict updates enabled.

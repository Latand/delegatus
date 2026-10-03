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

To configure an installation's agent publication identity, set
`DELEGATUS_PUBLICATION_NAME` and `DELEGATUS_PUBLICATION_EMAIL` in the launching
Viewer and runtime host environment. The legacy `LLV_` spellings also work;
the `DELEGATUS_` spelling takes precedence. Use a machine display name and a
mailbox whose local part is exactly `noreply` or `no-reply`. Personal mailboxes,
the forge's merge composer mailbox, empty values and malformed identities
refuse the launch with an error that withholds the configured values. These
settings apply to newly launched agents after the next deploy.

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

The pre-push gate reuses the platform import closure to scope Linux tests,
Viewer and runtime-host verification under the Dockerfile's Bun pin, and the
supported native Codex fixtures. Bun and Codex fixtures are cached under
`${XDG_CACHE_HOME:-$HOME/.cache}/delegatus-gate`. Dependency or allowlist changes
also run the shared supply-chain check; CI audits weekly and by dispatch.

Heavy commands run through `scripts/gate-slot.sh`: six slots by default,
`LLV_GATE_SLOTS` to change the count, `LLV_GATE_MEM` for the systemd memory cap
(default `8G`), and a default Node heap of 6144 MB. Without a user systemd
manager, commands run directly; without flock (macOS), the slot lock is omitted.
`LLV_GATE_LOCK_DIR=/var/tmp` joins the existing machine gate's lock files.
Otherwise locks live in a `delegatus-gate` directory under the runtime/temp root.
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

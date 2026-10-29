# Pipeline dependencies and commit identity

## Delegatus stage toolchain

Linked worktrees of this repository (`package.json` name `delegatus-cli`) use a
shared installation under the common Git directory's
`delegatus-dependencies/v1`. Its key includes the complete Bun lockfile,
manifest, Bun configuration, npm configuration, referenced patch bytes,
platform, architecture and Bun version. A source checkout's installation is
never evidence that its current lockfile built those installed packages.

Provisioning, every stage launch, settlement and publication validate this
installation. The repository's post-merge hook refreshes it immediately after
a merge; pre-commit and pre-push repeat preparation before running checks.
Only an installation with a completed receipt for those inputs may be linked.
On a miss, Bun installs the captured inputs once with `--frozen-lockfile
--ignore-scripts --backend=copyfile`, including development dependencies.
The installation is published by rename before any worktree links to it.
Package tools share that installation; run dependency preparation again after
editing dependency inputs, rather than installing through the shared link.

A kernel lock serializes cache writers. On POSIX the installer inherits that
lock independently of its controller's lock, so ownership survives until the
last installer exits. A fresh process then discards the recorded unfinished
build and retries. Windows uses a separate locking handle; an interrupted
build is preserved and reported for inspection there.
Queueing, installation and linking share a three-minute deadline;
cancelled or failed setup refuses with `stage environment: dependency
preparation failed` before checks or agent launch. The previous dependency
link remains intact until a replacement install succeeds. An older real
dependency directory is preserved under `preserved-*` in the cache rather
than deleted. Those preserved directories require an owner's cleanup choice.
Completed cache entries retain every registered worktree's current target and
the four newest unused input graphs; older unused entries are removed under
the same lock. An incomplete entry is preserved and reported for inspection.

The worktree owns only its dependency symlink. Package files are installed
once per input graph, with no per-worktree package copy. Local and workspace
dependencies require an explicit policy before this repository can use them.
Ordinary checkouts and other repositories retain the policy below.

## Other repositories

Provisioning borrows an existing dependency installation only when the source
and worktree manifests, supported lockfiles and package-manager configuration
match byte for byte. Workspaces, local dependency references and patched
installations require a private install. Existing worktree installations stay
in place. Dependencies must be ignored by Git before provisioning adds them.

| Platform | First choice | Fallback |
| --- | --- | --- |
| macOS | Per-file APFS clonefile through `COPYFILE_FICLONE_FORCE` | Private writable copy |
| Linux | Per-file filesystem reflink through `COPYFILE_FICLONE_FORCE` | Private writable copy |
| Windows and other platforms | Private writable copy | Private install if copying is unsupported |

A forced clone fails when the filesystem cannot share blocks. It never silently
copies the full installation. Each cloned file has its own inode; dependency
writes and lockfile changes remain local. Internal dependency symlinks are
rebased into the clone. A link outside the installation prevents writable
sharing. Disk-full and permission errors stop provisioning and preserve the
source; they do not select the sharing fallback.

A private install is required during stage provisioning when manifests,
lockfiles or package-manager configuration differ, when workspaces or local
dependencies need lane-local resolution, or when even a private copy cannot be
made. The package manager uses its usual shared download cache. This avoids
letting an installer follow a link into the source repository. Every stage
launch releases a source-owned dependency link, including resumed read-only
stages, while preserving private installations and unrelated links. Publication
releases a source-owned link before its frozen Bun install. Provisioning and
settlement prepare an isolated clone or copy only for matching inputs. Otherwise
they run `bun install --frozen-lockfile --ignore-scripts --backend=copyfile` in the worktree before
hooks can run. Provisioning and publication copy package files from the cache
to keep later writes local to the worktree. The provisioning install has a
three-minute execution limit; cancellation or
failure refuses provisioning or settlement. When the source has installed tools
but the lane lacks a manifest, its private install must succeed before provisioning
can succeed. A repository with neither a manifest nor source tools needs no
dependency preparation. Private tools remain in the lane.

`worktreeDependencies.test.ts` exercises the platform choices, clone flags,
private writes, internal links, failure cleanup and access transitions. The
native-filesystem case accepts either a successful forced clone or its explicit
unsupported-filesystem fallback. macOS and Windows branches are exercised
through injected platform values on the test runner.

## Repository authorship

User repositories use the configured `user.name` and `user.email` for both
author and committer. Git resolves repository, worktree, global and included
configuration. Inherited author variables and role-specific identity overrides
cannot replace that choice. Delegatus adds its no-reply co-author trailer.
Missing or incomplete user configuration retains the existing Delegatus
machine author, with the same co-author trailer. No Git configuration is
written. Invalid values and failed reads refuse without exposing values.

The checked-in publication policy opts a project into machine authorship:
`package.json` declares a `privacy:check` script using the publication gate,
and `scripts/privacy-known-value-fingerprints.json` exists. This repository
therefore retains its current author, privacy checks and attribution policy,
including after a checkout or repository rename. Names and remotes never
select the policy.

The selection is rebound before each structured, terminal or headless launch.
Claude settings, Codex shell policy, the configuration sandbox and the history
guard consume that same selection. Settlement, reconciliation and workflow
merges use it too. The history guard adds the trailer during message
preparation, preserves repository hooks, and keeps its existing protection
against replacing another author's history.

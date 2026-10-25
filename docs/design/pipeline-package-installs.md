# Pipeline dependencies and commit identity

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
they run `bun install --frozen-lockfile --ignore-scripts` in the worktree before
hooks can run. The install has a three-minute execution limit; cancellation or
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

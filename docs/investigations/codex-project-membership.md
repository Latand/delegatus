# Codex project membership after moving a chat

This investigation records one observed move and proposes checks before any
integration. A Codex client's project assignment and the working directory
recorded for a chat can diverge. Delegatus currently classifies the chat using
the working directory.

## Reproduction and observation

1. Start a local Codex chat from folder A and wait for Delegatus to discover it.
2. Add a second repository B as a project in Codex. B must have a canonical
   identity distinct from A's: a different `origin` remote, or no `origin` and
   a different local path.
3. Move the existing chat into project B using the Codex project picker.
4. Compare the Codex project and chat lists, the local transcript header, and
   the project assigned to the chat in the Delegatus catalog.

| Surface | Observed after the move |
| --- | --- |
| Codex | The project list included B. The existing chat reported B's project ID. |
| Local transcript | The same chat's `session_meta.cwd` still pointed to A. |
| Delegatus | The catalog still grouped the chat under A and had no project row for B. |

A same-origin clone of A, or a linked worktree of A, resolves to A's canonical
identity. Delegatus already groups it under A's project row, so there is no row
for B to add, and creating one manually returns `DUPLICATE_PROJECT`. Both
paths derive the identity from the repository's `origin` in the shared git
configuration
([`projectIdentityFromRepositoryRoot()`](../../src/lib/projects/identity.ts),
[manual creation](../../src/lib/projects/curation.ts)). This reproduction does
not apply to those layouts.

This was an observation of one local Desktop move. It does not establish event
delivery to another client, update latency, or the behavior of remote projects.

## Why a rescan cannot discover this move

The [transcript scanner](../../src/lib/scanner/describe.ts) reads cwd from
the transcript header and resolves it through `projectInfoFromCwd()`. This
preserves the parent repository for linked worktrees, including layouts it
can recognize after deletion. Scanning the same cwd again still produces A.
A change of Codex project affiliation alone leaves the grouping unchanged only
while the cwd's canonical identity stays stable. The same folder can change its
key, for example when Git is initialised in it or an `origin` is added.
Delegatus aliases verified same-folder successions and renames proven by the
forge, so the old key keeps resolving to the new one
([succession](../../src/lib/projects/succession.ts)); an unproven remote
change is not aliased.
The Codex project assignment is separate metadata that the scanner does not
use. An empty Codex project also supplies no transcript in its own directory
from which the scanner could infer a project.

A chat genuinely started with cwd B can enter normal discovery. Delegatus can
also add a [manual project](../../src/lib/projects/curation.ts) for B before
any transcripts exist, provided B's canonical identity differs from every
existing project. Adding the project alone leaves the moved chat associated
with A in Delegatus.

The [Codex method catalog](../design/codex-api-update/METHOD-CATALOG.md)
already defers project operations to preserve this grouping. The
[checked-in protocol schema](../../src/lib/accounts/protocol/0.170.0/experimental.json)
describes paginated `project/list`, project roots, `Thread.projectId`, and
`project/changed` and `thread/project/updated` notifications. Schema presence
only establishes that those capabilities can be investigated. Verify version
support and cross-client visibility before relying on them.

## Options to evaluate

| Option | What it would cover | What to verify |
| --- | --- | --- |
| Keep transcript discovery and manual project creation | An owner can add an empty project and discover chats started from its root. | Confirm the interface makes the destination of existing chats understandable. |
| Read Codex projects where the protocol supports it | Empty local projects can appear after resolving permitted roots through the existing canonical project rules. | Validate roots and authority in the existing local permission model. Check pagination, empty projects, removal, and distinct repositories with the same display name. |
| Show Codex project affiliation for a chat | The interface can expose the move separately from its cwd-based grouping. | Correlate thread and project IDs within the owning host and account. Verify delivery of moves and recovery after missed events. |
| Offer an explicit import or link | An owner can resolve unsupported clients or ambiguous roots. | Require an explicit choice of project or root and verify how that choice is removed. |

Start by testing read-only discovery against a supported local client. Test the
affiliation separately because adding B to the sidebar can work even if a
second client cannot observe the moved chat. An explicit link is a fallback
if the native metadata is unavailable or ambiguous. Private Desktop
preferences are an unsuitable source of truth.

Any affiliation should preserve the chat's working directory, repository
identity, board ownership, existing PR and usage associations, and artifact
read permissions. A move supplies no authority over a new directory. Reuse
canonical project and worktree identities where roots resolve. Keep a
multi-root or unresolved project ambiguous until there is an explicit match.
Keep the relationship local to the owning installation.

## Verification before implementation

| Scenario | Evidence to collect |
| --- | --- |
| Supported and older clients | Capability negotiation, pagination, and actual event delivery when the move happens in a different client. Confirm unchanged behavior when the capability is unavailable. |
| Empty project and restart | One project row per canonical project key across cold start, refresh, and restart, including when a manual row already exists. A permitted root whose identity matches an existing project (same-origin clone, linked worktree) shares that row. |
| Existing chat moved from A to B | Same thread ID, preserved cwd and permissions, updated affiliation. Check repeated moves and a subsequent turn. |
| Different paths and identities | Same repository across live and deleted worktrees, unrelated checkouts with the same name, fork remotes, and projects with several roots. |
| Access changes | Hidden or revoked workspaces, different accounts, and remote projects cannot add unauthorized rows or change access, runtime routing, or artifact visibility. |
| Missed notifications and busy clients | Reconciliation after a disconnect, bounded and coalesced metadata reads during bursts, and no full transcript rescan for an affiliation change. |
| Other chat sources | CLI-only Codex, Claude, and existing manual project behavior continue to use their established paths. |

The reproduction gives a reason to test these options. The scope of this
proposal is documentation and verification planning.

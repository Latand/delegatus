# Recover sibling worktree projects

Linked worktrees seen alive by a scan or catalog pass are recorded in
`worktree-map.json`, including checkouts whose transcripts start in a
subdirectory. Recording happens before a warm catalog summary is reused and
before the resolver returns its first live result. Removing the checkout with
ordinary Git commands preserves its repository grouping across a restart.
The recognizer order remains the one in AGENTS.md.

Older directory projects recover automatically at Viewer startup, after
hot-state activation and under the release fence, and after each complete
catalog rescan. Recovery is a state-mutating startup step admitted by
`assertStateStartupMutation`. It commits mappings, aliases, migrated board
records and lifecycle reasons together in SQLite. A run with no proven folds
changes nothing. The board maintenance panel has no recovery controls.

Every fold records its source, target and corroborating reason in the existing
lifecycle journal. A failed commit applies none of the folds; the next startup
or complete catalog rescan retries. If a catalog refresh fails after the commit,
the next startup retries the refresh without repeating the fold or its event.
Partial and read-only scans leave recovery for a complete rescan. The maintenance
timer and server-side archiving remain outside this recovery's scope.

Seats can inspect proposed folds and exclusions through the read-only Viewer
MCP diagnostic:

```json
{"tool":"backfill_worktree_projects","arguments":{"dryRun":true}}
```

The MCP apply path is removed for every caller, including the operator root;
`dryRun: false` is rejected. An optional `project` restricts the target
repository. Dry-run performs no writes, no rescan and no MCP receipt
publication, even when a request key is supplied.

An agreeing recorded mapping can recover a removed checkout at an arbitrary
path. Without that mapping, the checkout must share its parent directory with
a known repository and match one of its sibling names: `<repo>-lane-<n>`,
`<repo>-pipeline-<id>`, `<repo>-review`, or `<repo>-v<version>-<suffix>`.
Subdirectory cwds record the checkout root. Recovery requires a recorded mapping,
an agreeing native transcript repository hint, or a branch hint confirmed against
that repository's refs. A matching sibling name alone leaves the project separate.
Every affected checkout transcript, including descendants, must be readable and
carry no conflicting repository or project identity. One conflicting descendant
excludes the entire checkout. Ambiguity is checked against all known repositories
before the optional project filter is applied. Reports identify the corroborating
evidence or the reason for exclusion. Existing directories, ambiguous repositories,
conflicting mappings and mismatched directory keys remain untouched.
Recovery never adds a second project naming scheme. Before demotion to the
retained release, the fenced rollback checkpoint projects the committed mappings,
aliases and journal events/cursor into its legacy files alongside the board
mirror. A failed checkpoint prevents demotion until it succeeds. Grouping,
manual board preferences and recovery reasons survive rollback and return.

## Verification record

The initial read-only live measurement contained 6,466 catalog records and
9 projects: 4 directory projects, 15 directory records and 10 distinct
working directories. The worktree map contained 560 entries. Nine directories
were unmapped and seven of those were removed; none matched the supported
sibling suffixes. This catalog differs from the earlier issue observation.

The live dry-run proposed zero folds and left 10 directories alone. Digests
of the catalog, map, aliases and project curation were unchanged. Applying to an isolated copy
under the OS temporary root completed a catalog rescan of 6,470 records and
folded zero projects. The four additional records arrived between observations.
Only counts are retained in `evidence/worktree-recovery/rehearsal.json`.

Focused regressions cover first observation, warm catalogs, ordinary Git
removal across a fresh process, supported suffixes, descendants, native hints,
ambiguity, competing mappings, corrupt state, retry and dry-run immutability.
Automatic regressions cover startup and full rescans, idempotence, owner and
release fences, atomic failure, and a candidate-to-preceding-release-to-candidate
round trip with an old-release scan and journal append. The existing kanban
browser driver checks that the maintenance panel remains reachable and readable
without recovery controls or copy at 390px and 1440px in English and Ukrainian;
its aggregate record is
`evidence/worktree-recovery/rendered.json`.

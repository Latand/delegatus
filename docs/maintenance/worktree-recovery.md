# Recover sibling worktree projects

Linked worktrees seen alive by a scan or catalog pass are recorded in
`worktree-map.json`, including checkouts whose transcripts start in a
subdirectory. Recording happens before a warm catalog summary is reused and
before the resolver returns its first live result. Removing the checkout with
ordinary Git commands preserves its repository grouping across a restart.
The recognizer order remains the one in AGENTS.md.

For older directory projects, open the project's board maintenance controls
and choose **Preview recovery**. The list shows proposed folds and everything
left alone with its reason. **Apply recovery** records the mappings, aliases
the directory keys through the existing project succession mechanism, migrates
board records and rescans the catalog. The maintenance timer never applies
this recovery. Server-side archiving is outside this action's scope.

The same action is available through the Viewer MCP tool:

```json
{"tool":"backfill_worktree_projects","arguments":{"dryRun":true}}
```

Apply uses `dryRun: false` with a fresh `clientRequestId`. Only the operator
root or a designated orchestrator may apply through MCP. An optional `project`
restricts the target repository. Dry-run performs no writes, no rescan and no
MCP receipt publication, even when a request key is supplied.

A removed checkout must share its parent directory with a known repository
and match one of its sibling names: `<repo>-lane-<n>`,
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
A failed rescan retains the mappings; preview and retry to
finish. Recovery never adds a second project naming scheme.

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
The existing kanban browser driver exercises Preview and Apply at 390px and
1440px in English and Ukrainian; its aggregate record is
`evidence/worktree-recovery/rendered.json`.

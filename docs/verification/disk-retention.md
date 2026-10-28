# Disk retention

Implementation of [the retention plan](../design/disk-retention-fix.md).

Agents receive two directories. `$TMPDIR` holds exports, builds, tests and
probes. The attempt ledger owns its retirement. `$LLV_EVIDENCE_DIR` holds
screenshots, rendered frames and videos; retention never enumerates that
folder. Pipeline evidence uses `state/evidence/<pipeline-id>/`; other launches
use `state/evidence/agents/<launch-digest>/`. Existing evidence links beneath
the historical OS temp location remain readable. The evidence route continues
to admit raster images only.

Fresh launches, startup adoption and account migration register their scratch
and config allocations. Legacy adoption examines at most 32 direct children
of the private scratch container per pass, using a persisted cursor. It
requires the builder's directory shape, private permissions, matching local
ownership and either no marker or the expected regular marker. Adoption starts
a new one-day orphan retention period. Process, socket, repository-link,
container, mount and identity checks still apply before removal. Shared OS
temp folders are excluded from adoption.

An unreadable directory no longer aborts allocation measurement for an entire
temp sweep. Empty uv source-distribution markers and Git worktrees whose links
stay within the same recorded attempt are disposable. Unknown metadata,
missing link targets and links outside the attempt keep it. Release retention
can unlink generated regular files and symlinks after fresh protection and
inode checks; a symlink's target stays intact.

A completed or closed pipeline past four days can release a stale hold after
preservation. A private Git index captures tracked and untracked work in a
backup ref beneath `refs/delegatus/worktree-backup/`; the original branch stays.
Ignored artifacts and media are copied into the evidence folder and checked
by size and SHA-256. A manifest records the ref, parent, tree, branch and media
paths. Changed copies get versioned destinations. The sweep verifies the
snapshot, ref, evidence and current holders again before forced removal.
Active owners, recent writes, locks, nested repositories and unknown ignored
data continue to hold the checkout.

A standalone hook enters the owned runner before allocating a sandbox,
forwarding its arguments, runtime flags and stdin. Admitted children share
the same journal and CPU-wait budget. Gate sandbox creators record exact
paths and directory identities there. After command and child cleanup, the runner removes
those recorded allocations, including on a deadline. An identity change keeps
the replacement and refuses cleanup.

The release owner observes disk pressure without requiring an open browser.
On large volumes the default warning threshold is 10% of capacity, capped at
100 GiB with a 10 GiB floor. Small temporary volumes keep proportional limits.
`LLV_DISK_PRESSURE_FREE_GIB` sets a threshold in GiB; `0` selects the legacy
10/12 GiB warning and recovery rule. Recovery requires 20% headroom above the
warning threshold. The existing critical worktree admission limit stays.

Pressure advances idle sweep timers at opening and at most once every
15 minutes, keeping their retention periods and guards. Attempt sweeps use the
32-root pressure budget. One Ukrainian board notice and one bridge report are
recorded per episode, with bridge reporting subject to its project setting.
The board notice resolves on recovery. Durable receipts and destination keys
deduplicate retries and Viewer restarts. Reports sort measured categories by
size; allocation estimates remain lower bounds. The alarm owns no deletion
path.

Verification runs use detached exports and production environment builders,
with private HOME, config, state, inbox and temp directories and a closed
Viewer control endpoint. Tests select explicit files and run serially through
the gate wrapper. The four original defects have regressions observed failing
on the captured `origin/main`; the same tests run against the implementation.
Hosted publication, build and runtime checks remain the pipeline's checks.


## Verification record

[evidence/disk-retention.json](../../evidence/disk-retention.json) records the
commands, per-file outcomes, baseline comparisons and SHA-256 of every changed
TypeScript file. Every command used the production `checkEnvironment` and
`isolatedEnvironment` builders. The gate ran explicit files serially, with each
command's exit appended to its log. Scratch exports held all fixtures and
checks; no live registry or retention target was used. The real standalone
hook is also tested through its CLI: a phase remains open until the owned
deadline, after which its recorded sandbox is absent. That regression fails
on current main. A default five-second legacy process-scan case timed out
in an earlier run; the final whole file uses the plan's sixty-second case
budget, alongside two clean-main control runs with that same budget.

The four regressions were rerun on captured `origin/main` at
`cca87131968c270db72d6155076da8ecf1c232d4`. Each failed on its intended assertion:

| Defect | Regression on main | Full file on implementation |
|---|---:|---:|
| Unreadable directory, inspection refusal and failed-report recovery | 3 failures | 75 pass |
| Real uv layouts and internal fixture Git links | 3 failures, 1 passing control | 21 pass |
| Legacy-root adoption and uv retirement through the ledger | 2 failures | 31 pass |
| Generated regular release output | 1 failure | 125 pass |

The filesystem run enabled the real Docker fixtures. Container-private files,
uv markers and internal pointers clear; pins, unknown metadata, and missing or
external pointers stay. The worktree suite passes all 390 cases, including
backup refs, dirty and untracked work, copied media, a changed backup ref and
live-owner refusals. The alarm tests use seven real processes over two episodes
and retain exactly two cards, two bridge reports and three early-pass requests.

The clean `bunx tsc --noEmit` run passes. A native Codex 0.162.1 metadata probe
accepts both production permission profiles; it issues no model request.
Named workspace profiles inherit `:workspace`, as described in the
[official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
The offline agent-browser check opens a data URL, verifies its title and closes
under a production unrestricted attempt's managed TMPDIR. It uses Chromium's
headless shell and the harness's `--no-sandbox` argument. The owning runner
finishes with exit 0 and no surviving owned processes.

Of 42 explicit test files, 36 pass. Six retain the same 81 assertion failures
in two fresh whole-file runs on clean main at
`1facbf0fd24449e076a6ee1eef8cc3c857439049`:

| File | Matching existing failures |
|---|---:|
| `src/lib/runtime/startup.test.ts` | 4 |
| `src/lib/pipelines/stageCompletion.test.ts` | 25 |
| `src/lib/monitor/seatTickController.reporting.test.ts` | 27 |
| `src/lib/monitor/seatTickController.delivery.test.ts` | 22 |
| `src/lib/stateOwnership.test.ts` | 1 |
| `src/lib/stateOwnership.entryPoints.test.ts` | 2 |

The record preserves their exact assertion names. These include unreadable
pipeline ownership, missing registry indexes, existing startup expectations,
an MCP registry-reader refusal and an outdated CLI usage expectation. Their
expectations remain intact. Head repeats retain the same failure sets.

For an identical minimal stage fixture, rendered prompt measurements were
13,288 bytes for the base builder, 13,284
for the overlapping task-progress change and 13,459 for this implementation.
The largest measured role was 19,182 bytes; the production prompt-bound tests
pass below their 32,000-byte limit. The later main change edits different lines
in the two shared files. The four cleanup paths remain unchanged on that main.

No performance improvement is claimed. Windows-specific and macOS execution
remain CI work. Publication privacy passes locally; hosted privacy-publication,
build, bun-runtime, runtime-gate and native-codex-runtime remain the pipeline's
publication checks. Changes to `src/lib/runtime/startup.ts` require the
project's three review rounds before promotion. Host retirement is untouched.

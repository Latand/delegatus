# Disk stops refilling: retention fixes, managed temp, durable evidence, disk alarm

Status: implementation plan, 2026-10-28, read-only architect stage. Nothing here
is built. Every code citation was read on `origin/main` at `4572c4423` (this
lane's base; `HEAD..origin/main` was 0 commits at 12:40Z). Live numbers were
read on the operator's machine between 12:40Z and 13:20Z by read-only commands
(`df`, `du`, `find`, a `VACUUM INTO` copy of the attempt ledger, the sweep
report files). No sweep, removal or write ran against live state.

## 0. Originating requirement

Repeated disk exhaustion requires automatic reclamation of Delegatus-owned
temporary data and an investigation of the earlier incidents. Screenshots and
rendered frames used by prototypes and reports must survive cleanup in durable
evidence storage. The cleanup fixes must address the recurring causes and carry
regression coverage before publication.

History named by the specification: disk full 2026-10-01 (#2404), 2026-10-06
(#2571/#2595, #2198), 2026-10-22 at 99% (fixes #3208, #3217), 2026-10-26 at
86%, 2026-10-28 at 97%.

Acceptance, from the pinned specification:

- Each of the four causes fixed at its cause, each with a regression test that
  fails on `origin/main` (isolated state directories only).
- Agents' scratch for builds and tests lands under managed attempt temp;
  screenshots and rendered frames for prototypes and reports land in one
  durable evidence folder that retention never deletes; role scaffolds and
  stage prompts that send agents to `/var/tmp` or `/tmp` change to the managed
  locations.
- Worktrees of closed or completed lanes whose only blocker is a stale guard
  are reclaimed after a backup of any uncommitted work (branches kept); busy
  and live-owner trees stay.
- Below a free-space threshold (a setting with a sane default) Delegatus runs
  its sweeps early and raises one alarm on the seat's board card and in the
  bridge log naming the largest categories; it never deletes anything outside
  its own records.
- No deletion by name, glob, age or owner alone anywhere.

What the operator wants, read plainly: the disk must stop filling without a
human, and the only things that must survive are the screenshots for
prototypes and reports. This plan is judged against that.

## 1. What the machine shows now

| Observation | Value | Source |
|---|---|---|
| Root volume | 1742 GiB, 96.7% used, 55.5 GiB free | `df -B1 /` |
| Disk-pressure report | level `ok`, no episode, warning at 10 GiB | `state/disk-pressure-report.json` at 11:24:41Z |
| Stage scratch (`statePath("scratch")`) | 736 GiB | `du -xs` |
| Attempt ledger | 436 rows, 454.1 GiB attributed; 309 `llv-stage-*` (158 released, 151 not), 127 `llv-stage-config-*` (≈0) | copy of `state/attempt-temp.sqlite` |
| Attempt sweep last tick | checked 32, removed 0, held 32, errors 0, 380 GB over the 100 GiB cap | `state/attempt-temp-report.json` at 11:08:00Z |
| Unregistered `llv-stage-*` in scratch | 316 (312 without owner marker, 4 with a marker but no ledger row); ≈280 GiB by difference | directory listing vs ledger |
| Their creation dates (ctime) | 308 on or before 10-22, 8 after #3217 landed on 10-23 | `stat` |
| Legacy temp sweep | last report 2026-10-22T21:28:56Z (87 errors); none written since | `state/temp-sweep-report.json` |
| `/var/tmp` | 53 GiB: agent-named `delegatus-merge-*`/`-review-*`/`-integration-*` ≈32 GiB, other agent-named 15.4 GiB, gate leftovers `delegatus-test-comparison-*` (19, 4.6 GiB) and `delegatus-local-gate-*` (31, 0.1 GiB) | `du -xs /var/tmp/*/` |
| `/tmp` | 5 GiB | `du -xs` |
| Worktree holds | `ignored-files` 82 (23.3 GiB, details mostly `.artifacts/…`), `not-created-by-delegatus` 130 (6.9), `in-use` 55 (4.5), `local-only-commits` 23 (3.3), `uncommitted` 9 (1.5), `live-conversation` 16 (1.1), `open-pipeline` 34 (0.7); removed 0 | `state/worktree-sweep-report.json` at 10:52:47Z |
| Live agents without a managed `TMPDIR` | 101 Claude/Codex processes carrying `LLV_SPAWN_CAPABILITY` and no `TMPDIR` (seats and agents in project roots; one in a pipeline worktree), 119 with `TMPDIR` under scratch | `/proc/*/environ`, names only |

The 40 largest ledger roots (≈213 GiB), each run through the attempt tree
predicate (`find … -print -quit`, the expression at
`src/lib/runtime/attemptTempFilesystem.ts:134-136`):

| First hold the predicate hits | Roots | GiB (floor) |
|---|---:|---:|
| Git link inside a test-fixture tree (`…/llv-test-run-*/…/.git/worktrees`, or a linked `.git` file) | 12 | 104 |
| Empty uv marker in a real cache layout (`cache/uv/sdists-v9/.git`, `uv-cache/sdists-v9/.git`, `.cache/uv/sdists-v9/.git`, `cache/sdists-v9/.git`) | 12 | 46 |
| None | 16 | 63 |

Of the 16 clean roots, 15 belong to completed or closed lanes. Ten were
probed: nine are held because a live Codex host (`bun → node → codex`, started
2026-10-27 07:09) still carries the root in `TMPDIR`; one (lane 5edeeb61,
closed) has no process or socket reference, so another check holds it
(symlink inventory or container mounts). Hosts outliving their lanes are host
retirement's defect, which lane cea6a6d1 (#3464) is changing; this plan does
not touch it.

## 2. The causes, rechecked on `origin/main`

**Cause 1 — the legacy temp sweep aborts on one unreadable entry. Holds.**
`measureBytes` catches `opendir` (`src/lib/tempSweep.ts:513-516`) but iterates
outside it (`:518`). Probe in scratch: Bun 1.4.0 resolves `opendir` on a mode
000 directory and throws `EACCES` on the first iteration; Node 22 throws at
`opendir`. The throw escapes `keep()` (`:692`), which the in-use, hold, young and
deferred branches call outside any `try` (`:704-740`), and the
accounted-checkout loop (`:661-669`) is also outside one. `sweepStaleTempDirs`
then rejects, `runTempSweepInHelper` never reaches `recordTempSweep` (`:873`),
and the report stays dated 10-22. The audit counted 46 such failures.

**Cause 2 — attempt retention refuses real uv layouts. Holds, and is wider.**
`attemptTempFilesystem.ts:134-136` exempts an empty `.git` file only under
`…/uvcache/sdists-vN/…`. Probe: `tmp/cache/uv/sdists-v9/.git` (empty) is a
hit; `tmp/uvcache/sdists-v9/.git` is not. uv 0.12 writes the empty `.git`
directly under `sdists-v9` beside `CACHEDIR.TAG` (checked in the user's own
uv cache). The same regex is in `tempSweep.ts:559` for the legacy sweep. The
sample shows a second class with more bytes: Git links whose both ends sit
inside the same settled root (test fixtures under `llv-test-run-*`). The
predicate holds any `*/.git/worktrees` or `*/worktrees/*/gitdir` whatever
it points to.

**Cause 3 — retention visits only registered roots. Holds; three sources.**
`AttemptTempStore.due` (`src/lib/runtime/attemptTempRetention.ts:61-63`)
selects ledger rows only. (a) Roots created before #3217 (2026-10-23) were
never registered and carry no owner marker. The legacy sweep is the only
pass that sees them, and it aborts (cause 1) and holds every tree containing
a `.git` directory (`tempSweep.ts:372-378`). (b) Roots are still created without
registration: `materializeStructuredHostAccess` registers only when `owner` is
passed (`src/lib/runtime/structuredSpawn.ts:211-221`). The resume and adoption
paths in `src/lib/runtime/startup.ts:2126` and `:2685` and the account
migration paths in `src/lib/accounts/migration/provider.ts:380` and `:545` pass
none, and `tempOwnerForSpawn` (`structuredSpawn.ts:273-279`) returns none
when a conversation has no single pipeline membership. (c) Agents without a
managed `TMPDIR` (seats, project-root agents: the unrestricted branch at
`structuredSpawn.ts:193-201` returns the account environment unchanged) and
agents that pick `/var/tmp/<name>` themselves write where no record exists, so
nothing may delete it.

**Cause 4 — release retention stops at a generated regular file. Holds.**
`src/lib/selfUpdate/retention.ts:347` passes `next-env.d.ts` (the classifier
`disposableIgnored`, `src/lib/pipelines/worktreeSweep.ts:385-395`, accepts the
names in `REBUILDABLE_FILES`, `:331`); the refusal is the next check,
`retention.ts:351`, which accepts only a directory. The loop breaks, the
release is kept as `uncommitted`, and every older release stays.

**Worktree guards. Hold.** `worktreeSweep.ts:1287` (`open-pipeline`, from
`pipelineHoldsCheckout`, `:310-312`, which also holds a completed lane whose
`closeTeardown`, `closeReport`, `activationCloseRequested` or `delivery` is
unsettled, `src/lib/pipelines/types.ts:1093-1100`), `:1301` (process,
merge-batch and conversation holders, `:1095-1107`), `:1361` (`uncommitted`)
and `:1365` (`ignored-files`; `.artifacts` is never disposable, `:386`). None
has an age limit for a settled lane.

**Disk-pressure guard. Silent until 10 GiB.** `src/lib/state/diskPressure.ts:31-33`
warn below 10 GiB, recover at 12, refuse new worktrees below 2. On this volume
that is 0.6% free; the report says `ok` at 96.7% used.

## 3. Where agents are sent to `/tmp` or `/var/tmp`

| Place | What it says or does | Change |
|---|---|---|
| `src/lib/artifact/localFile.ts:38-43` | Evidence roots default to `/var/tmp` only: "renders land under `/var/tmp/<lane>/`". This is why briefs send renders there; scratch is under `$HOME`, which `projectRoots` drops (`:72-74`). | Default roots become `[statePath("evidence"), "/var/tmp"]` (§4); comment rewritten. `/var/tmp` stays readable so old links keep working. |
| `src/lib/roles/defaults.ts:150` (`DELEGATUS_MECHANICS`, every stage) | "$TMPDIR is … removed when the stage settles; … never in a directory you name under /tmp or /var/tmp." Names no place for frames that must outlive the stage. | Add one sentence naming `$LLV_EVIDENCE_DIR` for screenshots and rendered frames for prototypes and reports, and saying it is kept. |
| `src/lib/pipelines/prompts.ts:124` (prototype lanes) | "report their frame directory" with no location. | "write frames under `$LLV_EVIDENCE_DIR`". |
| `src/lib/roles/defaults.ts:223` (visual critic) | Produces product frames, location unnamed. | Same sentence through `DELEGATUS_MECHANICS`; no extra text. |
| Orchestrator scaffold (`ROLE_DEFAULTS` `orchestrator`, `defaults.ts:233`) and the spawn line, which carries only `EARLIER_ANSWERS_MECHANICS` (`defaults.ts:145-149`: "a spawned agent … has no stage scratch") | Nothing about temp; seats write `/var/tmp/delegatus-merge-*` (≈32 GiB now). | One sentence: scratch is `$TMPDIR`, renders go to `$LLV_EVIDENCE_DIR`; never name a directory under `/tmp` or `/var/tmp`. |
| `src/lib/mcp/server.ts:3868` (`publish_prototype_review` description) | "evidence roots (normally /var/tmp)". | "(the evidence folder, and `/var/tmp`)". |
| `docker-compose.yml:39-41` | Mounts host `/var/tmp` read-only for evidence. | No change needed: `$HOME` is already mounted at the same path, so the evidence folder is visible. Comment updated. |
| `scripts/local-gate.ts:203-205`, `scripts/local-gate-tests.ts:371` | Gate sandboxes `delegatus-local-gate-*`, `delegatus-test-comparison-*` under `/var/tmp`; a killed gate leaves them, and no sweep owns that name. | §5 B4. |
| `scripts/merge-batch.ts:610`, `:1006`; `src/lib/selfUpdate/service.ts:1705`; `scripts/capture-readme-media.ts:52-53`; `scripts/profile-reopen.ts:112` | Fixed `/var/tmp` roots, each removed in its own `finally`. | Unchanged; listed so the builder does not chase them. |
| Learned rules r_11869280a7e42499 and r_39ed1fd0281cdfff (delivered to every stage) | Tell stages to keep later-needed data "in a durable non-repo folder named in the task details". | After B ships, the curator rewrites r_11869280a7e42499 to name `$LLV_EVIDENCE_DIR` for media (rule text stays out of the repository). |

No role preset, workflow template or review-loop preset in live state names
`/tmp` or `/var/tmp` (counted in `state/role-presets.json`,
`workflow-templates.json`, `review-loop-presets.json`).

## 4. Locations and how retention treats each

| Location | Holds | Retention |
|---|---|---|
| `statePath("scratch")/llv-stage-*/`, `llv-read-only-stage-*/` (stage `TMPDIR` is its `tmp/`) | Builds, tests, exports, probes | Attempt ledger. Reclaimed once the attempt is settled or the lane closed (or, for an orphan row, one day after registration), when no process, socket, checkout symlink or container mount references it and no Git link leads outside it. Cap 100 GiB raises the per-tick budget from 4 to 32. |
| `$HOME/.cache/delegatus/attempt-temp/llv-stage-config-*` | Agent config sandbox | Same ledger, unchanged. |
| **`statePath("evidence")/<pipelineId>/`** (new; `$LLV_EVIDENCE_DIR`), and `statePath("evidence")/agents/<launchId>/` outside lanes | Screenshots, rendered frames, capture videos for prototypes and reports; the worktree backups' copied `.artifacts` | **Never deleted.** No sweep lists it: it is outside scratch and the temp roots, the ledger's `register` regex and location check refuse it, it holds no checkout. The image and artifact routes serve its rasters; `publish_prototype_review` reads it. Measured and named in the alarm. |
| `/tmp`, `/var/tmp` direct children named `llv-*` | Legacy and killed-run residue | Legacy temp sweep: 24 h quiet, not in use, no checkout, own uid, trash journal. |
| `/tmp`, `/var/tmp`, other names | Whatever agents and other tools wrote | Never deleted. Measured as "unmanaged temp" in the alarm. |
| Pipeline worktrees | Lane checkouts | Worktree sweep; §5 C adds the stale-guard rule with backup. Branches are never deleted. |
| Self-update releases | Old releases | Release retention; §5 A4. |

## 5. The changes

Four lanes, each mergeable alone, in this order: A (the causes) frees the
most and needs nothing else; B (locations) stops new growth; C (worktrees)
depends on B's evidence folder; D (alarm) reads what A and C report. A's
`startup.ts` change touches the structured host start path: three review
rounds (AGENTS.md). Every test runs by explicit path through the gate-slot
wrapper with isolated `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`.
Red/green for every new test: run the file on a scratch export of `origin/main`
with the new test copied in (it must fail for the stated reason), then on the
branch (it must pass):

```
bash scripts/gate-slot.sh env HOME=<sandbox>/home XDG_CONFIG_HOME=<sandbox>/config \
  TMPDIR=<sandbox>/tmp LLV_STATE_DIR=<sandbox>/state bun test --timeout=60000 <file>
```

Tests that need permission denial skip when running as uid 0 and say so.

### A1. Cause 1: one unreadable entry never ends a sweep

Change (`src/lib/tempSweep.ts`): wrap the `for await` at `:518` in its own
`try`; an iteration error stops that directory, marks the measurement a lower
bound and continues. Make the per-candidate body of `sweepStaleTempDirs`
(`:671-792`) one `try` whose `catch` pushes to `report.errors` (the function's
own contract, `:566`), and wrap the accounted-checkout loop (`:661-669`) the
same way. In `runTempSweepInHelper`, when the sweep still throws, record a
failed report `{at, failed: true, error}` so `tempSweepStatus` shows the failed
pass with its time and error.

Test (`src/lib/tempSweep.test.ts`): a sandbox root with an old `llv-a/` holding
`locked/` at mode 000 and a stale `llv-b/`; real `measureBytes` (no `measure`
port). Red on main: `sweepStaleTempDirs` rejects with `EACCES`. Green:
resolves, `llv-b` is removed, `llv-a` is kept with an `errors` or held entry,
the report file is written.

### A2. Cause 2: one Git-link classifier for attempt trees

Change (`src/lib/runtime/attemptTempFilesystem.ts`): the `find` stops being a
yes/no. It prints every marker (`.delegatus-keep`, any `.git` that is not a
directory, every `*/worktrees/*/gitdir` file), NUL-separated, capped at 10 000
(over the cap holds). A small classifier reads each one (at most 4 KiB) and
holds the root when:

- `.delegatus-keep` exists;
- a `.git` file starts `gitdir:` and its target, resolved lexically and
  physically, lies outside the root (a linked checkout of an outside repo);
- a `gitdir` file under `worktrees/` names a checkout outside the root (an
  inside repo with an outside worktree);
- a `.git` file is non-empty and not a `gitdir:` pointer, or a marker cannot
  be read.

Disposable: an empty regular `.git` whose parent directory is `sdists-v<N>`
(any cache root name; the old `uvcache/` form stays covered), and Git links
whose both ends are inside the root. The container path (`containerCommand`
`inspect`, `:155-157`) prints the same list with each marker's first 4 KiB and
maps `/attempt` back to the root. `tempSweep.ts:559` (`gitCheckoutMarker`)
uses the same sdists rule, exported from one place.

Tests (`src/lib/runtime/attemptTempFilesystem.test.ts`), each a settled
fixture root:

| Fixture | Main | Branch |
|---|---|---|
| `tmp/cache/uv/sdists-v9/.git` empty | held (red) | clear |
| `tmp/uv-cache/sdists-v9/.git` empty | held (red) | clear |
| `tmp/run/repo` with `git worktree add tmp/run/wt` (both inside) | held (red) | clear |
| `.git` file pointing to a repo outside the root | held | held |
| repo inside whose `worktrees/x/gitdir` names a checkout outside | held | held |
| `.git` file under `sdists-v9` with content | held | held |
| empty `.git` at `tmp/proj/.git` (no `sdists-v`) | held | held |
| `.delegatus-keep` | held | held |

One more in `attemptTempRetention.test.ts`: a released, settled root holding
the uv layout is removed by `sweepAttemptTemps` (red on main: `held: 1`).

### A3. Cause 3: every stage root is on the ledger

Change, part (a), adoption: `AttemptTempStore.adopt` plus a bounded adoption
step at the start of each attempt tick (32 names per tick, cursor by name).
It registers a direct child of the real `statePath("scratch")` only when its
name matches the `mkdtemp` shape `^llv-(read-only-stage|stage)-[A-Za-z0-9]{6}$`,
it is a directory and no symlink, owned by this uid with mode 0700, and has no
ledger row. The row is `{pipelineId: null, launchId: "adopted", createdAt: now}`.
An existing `.delegatus-attempt-owner` marker is accepted when its content is
the store's own (`attempt-temp.sqlite\n`), which covers the four roots with a
marker and no row. An adopted row is an orphan, so `attemptTempState` makes
it eligible one day after adoption, and every other guard of the sweep still
applies. The creation proof is the code: `structuredSpawn.ts:205` is the only
writer of those names in that directory (`git grep 'statePath("scratch")'`).

Part (b), no new unregistered roots: the resume, adoption and migration
calls (`startup.ts:2126`, `:2685`; `provider.ts:380`, `:545`) pass an owner,
resolved like `tempOwnerForSpawn` from registry memberships, falling back to
`{pipelineId: null, launchId}`, and `tempOwnerForSpawn` returns that fallback
when membership is ambiguous. An unowned root's host cleanup keeps today's
immediate removal on a clean release (`structuredSpawn.ts:222-228`), and the
ledger row is forgotten with it.

Tests (`attemptTempRetention.test.ts`): an unregistered `llv-stage-AbC123/`
in a sandbox scratch with an injected clock two days on and an empty scan;
red on main: still present after `sweepAttemptTemps`; green: adopted on tick
1, removed after the age. Negatives on both: a root whose path is in a scanned
process's `paths` stays; `my-proof/` and a symlinked `llv-stage-XyZ789` are
never registered. In `attemptTempProduction.test.ts` (or the structured spawn
test that already builds the real access): materializing through the
production call used by the resume path leaves `AttemptTempStore.has(scratch)`
true (red on main). Inputs come from the real builders (rule r_5de9616d231fe9f0).

### A4. Cause 4: generated regular files no longer stop release cleanup

Change (`src/lib/selfUpdate/retention.ts:346-364`): when `disposableIgnoredPath`
accepts an entry that is a regular file or a symlink, remove it with one
`unlink` after the same fresh `protect`/`heldByProcess` observation the
directory branch uses (`:356-359`), with an identity (`dev:ino`) recheck
immediately before the unlink. A symlink is unlinked itself; its target is
never touched. Then re-read `worktreeStatus` as the directory branch does.
The report counts the bytes as reclaimed generated output.

Test (`src/lib/selfUpdate/retention.test.ts`, its existing fixture release
builder): a clean old release with ignored `.next/` and `next-env.d.ts`. Red
on main: kept with reason `uncommitted`. Green: removed. Negatives on both: an
ignored `notes.txt` keeps the release; a `next-env.d.ts` replaced between the
inspection and the unlink (identity changed) keeps it.

### B. Managed temp and the durable evidence folder

B1. `statePath("evidence")` is created at spawn as
`<evidence>/<pipelineId>/` (or `agents/<launchId>/`), mode 0700, and handed to
the agent as `LLV_EVIDENCE_DIR`. Restricted stages get it as a second write
root: the Codex permission profile at `structuredSpawn.ts:246-251` and the
Claude `readOnly` gate passed at `structuredSpawn.ts:2168` and
`startup.ts:2146`. `evidenceRoots()` defaults to it plus `/var/tmp`
(`localFile.ts:43`); `LLV_EVIDENCE_ROOTS` still replaces the default.

B2. Agents that today get no `TMPDIR` (`structuredSpawn.ts:193-201`: seats and
project-root agents) get a registered scratch root like stages, owner
`{pipelineId: null, launchId}`; their live host holds it, and the orphan rule
reclaims it a day after the host is gone. Long `TMPDIR` paths are known to
overflow Chromium's socket limit (rule r_7f1d20f0a75a6962); stages already
live with it, and the builder checks agent-browser once under the new seat
`TMPDIR` before merging.

B3. Prompt text per §3. Before writing it, measure the delivered stage prompt
against its 32 000-byte bounds (`engine.creation.test.ts:251`,
`stageCompletion.test.ts:448`, `runtimeSwitch.test.ts:1115`) on `origin/main`
and on the head of PR #3395, which edits `src/lib/roles/defaults.ts`'s working
rules; write within the smaller headroom and give before/after byte counts
(rule r_a7edff278adff2c0). Prompt wording gets no phrase test (AGENTS.md).

B4. Gate sandboxes: `createGateSandbox` and the test-comparison sandbox write
their path into the owned run's record before use, and the gate-slot runner
removes exactly the recorded paths after the command exits, including after a
deadline kill. Nothing is matched by prefix.

Tests: `structuredSpawn` test with the real builder — a restricted stage's
environment carries `LLV_EVIDENCE_DIR` under the sandbox state, writable, and
an unrestricted spawn now has `TMPDIR` under scratch with a ledger row (both
red on main). `localFile` test: a PNG under the sandbox `statePath("evidence")`
is admitted as `evidence`; an `.svg` and a `.json` there are refused (red on
main for the PNG). A retention guard test: one fixture state with files in the
evidence folder, then `sweepStaleTempDirs` over the production root set,
`sweepAttemptTemps` with adoption, and the worktree sweep; every evidence file
remains (it passes on main too; it keeps the promise from regressing). Gate
test (`scripts/local-gate.test.ts`): a gate killed by its deadline leaves no
sandbox behind (red on main).

### C. Worktrees held only by a stale guard

A completed or closed lane's worktree is reclaimed after a backup when, at
least `FINISHED_WORKTREE_RETENTION_MS` (four days) after its terminal time,
the only holds left are:

- `open-pipeline` caused solely by `pipelineActivitySettled` being false
  (`closeTeardown`, `closeReport`, `activationCloseRequested`, `delivery`
  records), with `state` in `completed`/`closed`;
- `uncommitted`, `local-only-commits`, or `unmerged-commits`;
- `ignored-files` whose kept entries are all under `.artifacts/` or are image
  and video files (`png jpg jpeg webp gif avif mp4 webm`).

Still kept, unchanged: any process, merge-batch or conversation holder
(`heldBy`, `:1095-1107`), `locked`, `missing`, `recent-writes`, nested
worktrees, `not-created-by-delegatus`, a lane in any other state, and
`ignored-files` with any other kept class (an unknown ignored file stays the
operator's call; the alarm names the count).

Backup, then remove:

1. Commit the worktree state with a private index
   (`GIT_INDEX_FILE=<tmp> git add -A`, `write-tree`, `commit-tree -p HEAD`)
   and store it as `refs/delegatus/worktree-backup/<pipelineId>/<short-head>`
   in the parent repository. Its parent chain keeps local-only commits
   reachable even from a detached HEAD.
2. Link (`link(2)`, same filesystem; copy otherwise) the kept `.artifacts/`
   entries and media into `<evidence>/<pipelineId>/worktree/<relative path>`,
   then compare sizes and hashes.
3. Write `<evidence>/<pipelineId>/worktree-backup.json`: ref, head, branch,
   paths, bytes.
4. Re-read every guard (`busyNow`, `:1418`), verify the backup ref's tree
   equals a fresh `write-tree` of the worktree and every copied file matches,
   then `git worktree remove --force`. The branch ref is never deleted.

Tests (`src/lib/pipelines/worktreeSweep.test.ts`, its existing `lane()`
fixtures, injected clock past four days):

| Case | Main | Branch |
|---|---|---|
| completed lane, `closeTeardown.phase: "running"`, no holder | kept `open-pipeline` (red) | removed; branch present; backup ref present |
| completed lane, a modified and an untracked file | kept `uncommitted` (red) | removed; `git show <ref>:<path>` returns both contents |
| completed lane, ignored `.artifacts/frame.png` | kept `ignored-files` (red) | removed; evidence copy byte-identical |
| backup ref moved to another tree between steps 1 and 4 | — | kept, no removal (rule r_1a36e0a809c59d5e) |
| process cwd inside | kept `in-use` | kept `in-use` |
| live conversation | kept | kept |
| lane `running` | kept | kept |
| ignored `data.db` outside `.artifacts` | kept | kept |
| completed one day ago | kept | kept |

### D. Disk-pressure guard

Threshold: the episode opens below `min(10% of volume capacity, 100 GiB)`,
never below today's 10 GiB, and closes above 1.2 × that. On this volume:
100 GiB to open, 120 GiB to close, so it fires now (55.5 GiB free).
Setting: `LLV_DISK_PRESSURE_FREE_GIB` (a number of GiB; `0` keeps today's
10/12 GiB behaviour), read in `diskPressure.ts` beside the constants at
`:31-33`, with the effective value written into the report
(`warningBytes`). The 2 GiB worktree admission refusal is unchanged.

Trigger: the existing observation (`readDiskPressureInHelper`, `diskPressure.ts:251`, at most every 30 s), when it
opens an episode and then at most every 15 minutes while it stays open, asks
each sweep for an early pass: the temp sweep timer (`tempSweep.ts:898-934`)
and the worktree sweep timer (`worktreeSweep.ts:1965-1993`) re-arm at 0 when
idle; the attempt tick runs with the over-cap budget of 32; the self-update
service starts its retention pass (`src/lib/selfUpdate/service.ts:863`) when
idle. Early means sooner only: no age, guard or retention period is shortened.

Alarm, once per episode, after the consumer sizes arrive (the existing
`diskPressureWakeReady`, `:203-206`):

- the seat's board card: a seat-tick card through `ensureSeatTickCard`
  (`src/lib/monitor/seatTickController.ts:334`), new kind `disk-pressure`,
  `instance` = the episode, resolved when the episode closes; on the board of
  the project that owns the serving Delegatus install, so it is one card
  machine-wide;
- the bridge log: `recordManagerReport` with origin `seat-tick` and key
  `disk-pressure:<episode>` (precedent: `src/lib/monitor/seatAutoRotation.ts:198-213`),
  in Ukrainian (the operator's interface language), subject to the project's
  Bridge reports setting;
- the existing seat wake item `disk-space` and System panel notice stay.

The text names free space and the largest categories, read from the records
the sweeps already write plus the existing consumer walk: stage temp (ledger
total, with held-by-live-agent and over-cap split out), unregistered scratch,
worktrees by hold reason, releases kept, the evidence folder (kept by design),
unmanaged `/tmp`/`/var/tmp`, and the rest of the volume as "outside Delegatus"
(used minus the above, attributed to nothing). The guard has no delete path of
its own.

Tests (`src/lib/state/diskPressure.test.ts`, injected probe and clock): a
1742 GiB volume with 55.5 GiB free opens an episode (red on main: level `ok`);
`LLV_DISK_PRESSURE_FREE_GIB=0` restores the 10 GiB rule; the early-pass ports
are called once at opening and not again inside 15 minutes; one card and one
bridge report per episode across three observations and a restart (persisted
episode); recovery above 120 GiB resolves the card; the label lists categories
largest first.

## 6. Rollout

1. Lane 06603f80 is cleaning by hand now; no lane of this plan runs a sweep
   or a removal against the live machine. Builders prove behaviour in sandboxes
   only.
2. A merges first. After deploy, the first hour runs with
   `LLV_TEMP_SWEEP=dry-run` (an existing switch, `tempSweep.ts:389-394`) so the
   operator reads what adoption and the new classifier would remove before it
   does; then back to `on`.
3. B, then C (C's backup writes into B's folder), then D.
4. After each deploy, compare `temp-sweep-report.json`,
   `attempt-temp-report.json`, `worktree-sweep-report.json` and `df` against
   §1.

## 7. Out of scope

- Host retirement (`src/lib/runtime/structuredHostRetirement.ts`, lane
  cea6a6d1, #3464). It holds most clean settled roots today; once hosts
  retire, those roots fall to the normal settled rule.
- Docker and containerd data, project directories, the shared Bun cache,
  transcripts: outside Delegatus's records. The alarm shows them only as
  "outside Delegatus".
- Agent-named directories already in `/var/tmp` and `/tmp` (≈47 GiB): no
  record proves who made them, so nothing deletes them; lane 06603f80 and the
  operator decide. B stops new ones.

## 8. Deferred — not currently justified

- Host-event ledger compaction (`src/lib/runtime/eventStore.ts:607`, 18.5 GiB
  at the audit). Real growth, outside the four causes; it needs its own
  checkpoint-aware design.
- A size cap or age limit on the evidence folder. The operator asked that
  screenshots stay; its size is shown in the alarm so the question can be asked
  with numbers later.
- Shortening retention periods under pressure (four days, the one-hour pushed
  lane, 24 h quiet floor). Early passes come first; shorter periods trade away
  recovery time nobody asked to give up.
- A Settings UI field for the threshold. The environment setting matches the
  other retention knobs (`LLV_TEMP_SWEEP_MAX_AGE_HOURS`,
  `LLV_ATTEMPT_TEMP_CAP_BYTES`).
- Dropping the `live` rule for stages with declared outputs or the visual
  critic (`attemptTempProduction.ts:23-24`), which B's evidence folder makes
  unnecessary for frames. Removing it changes what a running lane can reread;
  revisit once B has shipped.
- The audit's 106 GiB durable measurement directory and the
  `not-created-by-delegatus` worktrees (130, 6.9 GiB): no Delegatus record
  covers them.

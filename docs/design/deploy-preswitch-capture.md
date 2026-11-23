# Pre-switch protected-host capture while the baseline Viewer serves

Status: design, 2026-11-03. Scope: `scripts/deploy-checkout.py` on a checkout
install supervised by a user systemd unit, and one new read-only helper that
ships in the target release. Nothing here changes the serving Viewer, the
runtime host, any production timeout or `complete_activity()`.

## Originating requirement

Operator, 2026-11-03 17:06:59Z, relayed to the work installation's
designated seat (the elided parts carry local paths):

> The Deployer must build, rehearse, preflight and execute the exact reviewed
> target through supported native procedure for delegatus.service, then prove
> actual autonomous ticker wake. […] Preserve other agents, settings, paused
> lanes, dirty bootstrap and Codex0.166.0. If normal admission refuses, report
> exact refusal; no impersonation or bypass.

Operator, 2026-11-03 about 18:44Z: «окей тепер просто переконайся що вони
доб'ють» ("okay, now just make sure they finish it").

Constraint recorded on the operator side, 2026-11-03 18:31Z, relayed to the
seat:

> Merely merging/building a3384376 or choosing its MCP binary cannot make its
> new Viewer code run before switch. […] Preserve full/current protected
> capture and all identity/cgroup checks; no live hotpatch, copied capability,
> partial inventory or ping substitution.

The seat's brief adds two more forbidden moves: raised production timeouts and
a weaker `complete_activity()`. Its acceptance is either a real baseline
preflight that succeeds, or a separately reviewed procedure. That procedure
must preserve four things: complete current protected-host capture, the
identity and cgroup ownership checks, the named-unit start obligation, and
post-switch verification.

## Answer in one paragraph

The baseline cannot produce a capture that passes `complete_activity()` on this
installation at its current fleet size and load. The projection refusal is only
the first of several refusals. The one successful baseline answer of the day
would still have failed the guard on six conditions (M3). Merging the product
fix does not change what the baseline runs, and a quieter window does not cure
the incompleteness. Recommended: option B. The procedure takes its agent-host
inventory from a read-only census that ships in the reviewed target release.
The census runs the product's own liveness function against the live state
directory, in a process the procedure owns, with no token, no capability and
no Viewer. Its answer goes through the unchanged `complete_activity()`.

The preflight's baseline health read fails for the same baseline defect, but
far less often: it only needs `ok`, never completeness. It stays unchanged.
The Deployer repeats the read-only preflight within a pre-registered bound,
because modeled pass rates are 36 to 80% per preflight (M1, M9). A narrowed
health read (B2-b) is specified under "Deferred". It is built only if that
bound is exhausted on exactly the known refusal.

## How the pre-switch reads reach the baseline

Line numbers are on `main` at 14387a89, the base of this design. The serving
baseline 3c617726 is byte-identical for `scripts/deploy-checkout.py`,
`bin/mcp-server.mjs`, `src/lib/mcp/largeReads.ts`,
`src/lib/lifecycle/inventorySelection.ts`, `src/lib/state/historyProjection.ts`
and `docs/deploy-checkout.md` (checked with `git show 3c617726:<path> | cmp`).
Where the baseline differs, its line is given as "baseline :N". `main` at
7da98480 (merged 18:48:18Z) changes only authority checks in
`src/lib/mcp/bindings.ts`, which moves the lines cited below down by one.

1. Preflight reads three things through MCP. The first is the baseline health
   check, `agent_activity {liveOnly:true, limit:1}`
   (`scripts/deploy-checkout.py:1312`), which `baseline_ready` requires within
   30 s (`:789-792`). The second is the protected capture,
   `agent_activity {liveOnly:true, compact:false, limit:200}` through
   `complete_activity()`, retried for 30 s (`:793-796`). The third is the
   capture's refresh immediately before the stop, one shot (`:979`).
   `--start` runs preflight in the launching process (`:1396`) and again in
   the detached worker (`:115`).
2. The MCP child is `bin/mcp-server.mjs` from the bootstrap checkout
   (`:640-642`, created at `:746`). The wrapper selects the runtime through the
   installed release pointer (`bin/mcp-server.mjs:39-47`, `:149-171`), so the
   child runs the serving release's `dist/mcp-server.mjs`. Process evidence at
   18:41Z: wrapper cwd at bootstrap e5afc955, selected runtime cwd at
   3c617726.
3. The stdio service forwards every tool call to the serving Viewer's
   `/api/mcp` (`src/lib/mcp/server.ts:5259-5267`, baseline `:5251`;
   `src/lib/mcp/largeReads.ts:19-24`, `:75-84`). The baseline Viewer process
   computes the answer.
4. Inside that Viewer a live-only read is not a full inventory, so its answer
   budget is 800 ms (`src/lib/mcp/bindings.ts:7066`, `:7168-7169`, `:7190`;
   baseline `:7063`, `:7165-7166`, `:7187`). Only a read that includes gone
   rows gets 8 s and a prepared registry (`:7069`, `:7191`).
5. The pipeline references are projected after transcript hydration, under the
   same answer deadline (`src/lib/lifecycle/liveness.ts:1229` and `:1534`,
   baseline `:1258` and `:1563`). The projection takes every pending identity
   of the pipeline collections (`src/lib/state/historyProjection.ts:326`,
   `:345`). Before projecting the first one it refuses if the deadline has
   passed (`:364`). One pending row is enough; with none it reads at once
   (`:352-361`).
6. A transcript tail the 800 ms budget did not reach is reported as
   `evidenceSource: "projection"` (`liveness.ts:1245`, `:1618`). A catalog that
   did not complete within 650 ms is reported `stale` or `pending`
   (`bindings.ts:7062`; `inventorySelection.ts:227-237`). Hosted paths missing
   from the catalog are recovered only up to 64 (`liveness.ts:917`). Each of
   these is a refusal in `complete_activity()`
   (`scripts/deploy-checkout.py:549-559`).

So the product fix (lane a3384376) can change step 5 only after a switch puts
it in the serving Viewer, and it does not touch step 6.

## Measurements

All are read-only. The live database was opened with `mode=ro` and
`PRAGMA query_only=1`. M5's calls ran under this stage's own agent identity;
no call here used the operator token.

| # | When (UTC) | Conditions | Observation |
|---|---|---|---|
| M1 | 18:54:08 to 18:57:08 | load average 28 to 40 on 24 cores; `history_pending` sampled every 100 ms, 1,791 samples | Pipeline rows pending in 90.8% of samples (0 to 5 rows, mean 2.9). Empty in 3 runs of 8.0, 4.6 and 3.8 s. 16 arrivals from 5 rows of the open collection: one running lane (4 arrivals), two paused lanes (4 each), two completed lanes (2 each). Lane state read from `state_rows` at the same time |
| M2 | 18:57:39 | same database; the projection query of `historyProjection.ts:103-110` run read-only for the 4 then-pending rows (49 KB to 449 KB payloads) | 0.9 to 4.5 ms per row |
| M3 | 17:42:06 (record in the deployer's private evidence) | baseline; `agent_activity` compact, limit 200; agent caller; answered `ok` | 103 rows, `catalog: "stale"`, `evidence: "pending"`, `unverifiedCount: 87`, `undescribedHostCount: 3`, `unselectedCount: 1` |
| M4 | 18:41:11 to 18:41:24 (record of lane a3384376's bounded diagnostic) | baseline; exact procedure client with the operator token | Health read twice and capture shape once. All `tool_failed`, "history projection preparation exceeded its deadline", after 7.6, 1.7 and 2.7 s |
| M5 | 18:59:43 and about 18:59:52 | baseline; this stage's own agent identity; exact capture arguments; 5 pipeline rows pending at 18:59:51 | Both `tool_failed`, "history projection preparation exceeded its deadline" |
| M6 | 17:42:20 and 18:04:33 (deployer records) | real `--preflight`, unchanged plan, script run from the target release | Both exit 2, `Procedure stopped: RuntimeError`. The second ran 35.8 s: the 30 s baseline-readiness bound plus overhead |
| M7 | 18:58:24 | `systemctl --user show` and the cgroup tree | Unit already in `delegatus.slice`, `cpu.weight` 1000, `KillMode=process`; 292 processes in the unit's cgroup subtree |
| M8 | `deploy-verdicts/` under the state directory | primary records of earlier runs on this installation | Five detached switches passed preflight and reached a pass verdict between 2026-10-06 and 2026-10-10, protecting 3 to 14 stages each. The last run was 2026-10-11. The history projection entered the liveness path on 2026-10-18 (3aa3efbb, #3032). The 800 ms budget and the guard date from 2026-10-06 (2f431c43, b061e748) |
| M9 | 19:04:53 to 19:12:53 | as M1, 8 minutes, 4,796 samples; load average 24 to 17 | Pending in 66.1% of samples (mean 1.8). 66 empty runs, the longest 14.3 s. 131 arrivals from 10 rows: the two paused lanes 41 and 43, the running lane 20, other lanes 1 to 10 |
| M10 | from M1 and M9 | model: health reads back to back within the 30 s bound, each taking M4's 1.7 to 7.6 s plus the procedure's 1 s retry sleep (`:46`); a read passes if no pipeline row is pending when it ends | One preflight's health check passes with probability 36 to 58% at M1's load, 68 to 80% at M9's. Real record: 0 of 2 (M6) |

M3 matters most. Even a baseline read that did not hit the projection refusal
fails `complete_activity()` on six conditions: `unselectedCount`,
`recoveryPending`, the stale catalog, `evidence: "pending"`, `unverifiedCount`
and the projected evidence source. M3 was a compact read and the capture asks
for `compact:false`. Compact form changes only the output fields; the coverage
flags are computed the same way (`bindings.ts:7214-7230`). `unselectedCount: 1`
with 103 rows under a limit of 200 is not a cap. A fold of generations into one
row (`liveness.ts:1485-1496`) is the leading candidate; it is unconfirmed.

M8 explains why the procedure used to work: smaller fleets and no projection on
the read path. M10 rests on one assumption: the projection is the health
read's only blocker. Two facts outside the model are the unexplained first
`outcome_unknown` of a fresh child and the state-lock admission
(`historyProjection.ts:297-303`).

## Options

What each option must preserve, as named in the brief:

- **P-capture**: complete, current protected-host capture.
- **P-own**: identity and cgroup ownership checks.
- **P-start**: the named-unit start obligation.
- **P-post**: post-switch verification.

### A. A quieter window: pause new lane starts while the baseline read drains

Evidence against:

- Pausing starts does not stop the writes that keep the queue full. No new
  lane caused any arrival in M1 or M9. The two paused lanes were the heaviest
  writers in M9 (84 of 131 arrivals), so even pausing every lane would not
  empty the queue.
- The drain itself is cheap (M2: under 5 ms a row). The refusal comes from the
  800 ms budget being spent before the drain starts (M4: 1.7 to 7.6 s per
  call).
- An answer that escapes the refusal still fails `complete_activity()` on M3's
  conditions. A window quiet enough to fix that needs roughly the fleets of M8,
  which means stopping the work the capture exists to protect.

Preserves all four, because nothing changes. Risk: it does not work for the
capture, and pauses delay every lane. **Rejected for the capture.** For the
health read alone, a quieter moment does help (M10); option B uses that.

### B. Reviewed procedure change: a read-only census from the target release

The procedure stops asking the serving Viewer for its agent-host inventory and
runs a census helper from the verified target release directory instead. The
plan already names that directory (`releaseDir`), and preflight already checks
its HEAD, cleanliness and `BUILD_ID` (`deploy-checkout.py:772-775`). The census
calls the same product function the Viewer uses for `agent_activity`,
`agentLivenessSnapshot` (`liveness.ts:1160`), with three sources replaced:

1. **Inventory.** The census lists exactly the product's own owned-host set:
   live registry owners and live spawn-receipt hosts (`hostedTranscriptPaths`,
   `liveness.ts:868-883`) plus active headless review rounds (`:1237-1240`).
   Each is described with the production `describeTranscript`. No catalog is
   used, so no generation can be pending or stale. Every hosted path is in the
   inventory, so the capped recovery of `liveness.ts:917` has nothing left to
   recover. This narrower selection drops nothing the procedure consumes. The
   procedure keeps only rows whose host is `alive` with a `pid`
   (`deploy-checkout.py:799-810`, `:980-985`), and every such row's host comes
   from those same owners (`liveness.ts:1556-1563`).
2. **Pipeline references, read-only.** The references must equal what
   `historyPipelineRef` (`historyProjection.ts:417-423`) would return after a
   complete drain, and nothing may be written. One way is a single read
   transaction. It reads the history tables, takes the identities pending in
   `history_pending` in that same snapshot, recomputes those rows with the
   projection query in memory, and overlays them (M2: under 5 ms a row). The
   flow projection gets the same treatment.
3. **Budget.** The Viewer's 800 ms answer budget and 650 ms catalog budget are
   untouched. The census process has no answer budget of its own. Its evidence
   deadline comes from the procedure's existing 30 s capture bound
   (`deploy-checkout.py:796`), and the procedure kills its owned child at that
   bound. A tail not read by then is reported as `projection`, so the capture
   is refused and retried within the same bound, as today.

The census prints a bounded JSON answer with only the fields the procedure
consumes: `conversations[]` with `conversationId`, `host {state, kind, pid}`,
`turnState`, `pipeline {pipelineId, stageId, attempt}` and `evidenceSource`;
`selection {matched, selected, recoveryPending, recoveryTruncated,
cacheStatus, projected, unreadable}`; `unselectedCount`; and `observedAt`, the
target revision and the registry revision. Every number describes the census's
own enumeration. When generations fold into one row
(`liveness.ts:1485-1496`), no live owner may disappear: either every live
owner appears in the answer, or the answer reports itself incomplete.
`capture()` (`:793-796`) and `generation()` (`:979`) call the census and pass
its answer to the unchanged `complete_activity()`.

What it preserves:

- **P-capture**: the same host rule, turn state and pipeline matching as
  `agent_activity`, from the same registry. The census runs at the same two
  moments as today: in preflight, and immediately before the stop. The guard
  is unchanged and refuses on every incompleteness flag.
- **P-own**: `fence()`, `leftovers()`, `launcher_ancestors()`,
  `generation()`'s capture and `proof()` are unchanged. Only the source of
  `self.agents` changes.
- **P-start**: `run_switch`, `relocate`, `start` and `recover_start` are
  unchanged (`:65-111`, `:1133-1238`).
- **P-post**: every serving sample keeps the strict MCP check against the
  switched Viewer (`:1312`). Stage reconciliation still uses targeted
  `agent_activity` through `complete_activity()` (`:1240-1258`), and the
  interruption inventory is unchanged (`:316-367`).

Forbidden moves, checked one by one:

- No stale or partial inventory: there is no catalog, no cap without refusal,
  and the guard is unchanged.
- No ping: the capture uses no MCP at all.
- No copied capability or identity: the census reads local state as the
  installation's own user, and its environment carries no credential.
- No hotpatch: it runs code from the reviewed, verified target directory, and
  no release file changes.
- No raised production timeouts: no Viewer or procedure constant moves.
- No weaker `complete_activity()`: unchanged.

Risks:

1. Target code reads state the baseline writes. It must fail closed on any
   store open, migration or schema refusal, and it must never write.
   `stateOwnership` already refuses startup mutations to any process other
   than the Viewer and the runtime host. The census gets its directory only
   through the plan's `LLV_STATE_DIR` and claims no owner token (AGENTS.md,
   "Only a declared owner resolves the operator's state directory").
2. Cost under load: about 100 tails of at most 128 KiB each
   (`liveness.ts:284`) at concurrency 4, plus one registry snapshot and the
   overlay. This needs a measurement on a copy before the first live run
   (B-8).
3. Divergence: a census that reimplemented the rules would drift. The design
   allows only source injection, and B-1 pins equivalence with a test.
4. The deploy path is high-risk code under AGENTS.md: three review rounds.

### B2. The baseline MCP health read

B removes MCP from the capture, but preflight first requires the baseline to
pass `agent_activity {liveOnly:true, limit:1}` (`:789-792`, `:1312`). That read
only needs `ok:true` (`:651`), so completeness does not matter. It fails only
when a pipeline row is pending at the moment its spent budget reaches the
projection (steps 4 and 5).

- **B2-a, unchanged gate (recommended).** The Deployer repeats the read-only
  preflight. M10 models 36 to 80% per preflight, depending on load. `--start`
  needs the check to pass twice, in `:1396` and in the worker at `:115`, a few
  seconds apart. Nothing about the gate changes.
- **B2-b, narrowly classified (deferred).** In preflight's baseline readiness
  only, and only when the plan names the class, the exact refusal "history
  projection preparation exceeded its deadline" would be accepted if a
  different non-mutating tool read through the same child answers `ok:true`.
  Full specification under "Deferred". It narrows a pre-switch gate, and a
  reviewer could read it against the "ping substitution" fence. Build it only
  if B2-a's bound is exhausted on exactly that refusal.

### C. Two-step rollout: ship the projection fix first

The only path that runs new Viewer code before the native procedure is the
seat's own `deploy_exact_sha`. It uses the launcher's self-update
(`src/lib/selfUpdate/service.ts:1894-1903`, `:1587-1594`). The 40 newest
deployment records on this installation, 2026-10-22 to 2026-11-03, all came
through it (`deployment_status`, read about 19:11Z). 36 succeeded, including
13:40 to 13:48Z today. Two failed, and two rolled back when the runtime host
did not create its socket within 15 s. It keeps its own guards: target on the
tracked branch, green checks (`:1868-1878`), launcher identity, release
readiness and rollback. It never stops the unit, so P-own and P-start do not
arise, but it has no `complete_activity()` capture.

Its tool description admits only the designated seat
(`src/lib/mcp/server.ts:3869`). The operator routed this deploy to a separate
Deployer through the native procedure, and the seat declined to substitute
`deploy_exact_sha` without the operator's word (its report at 18:06Z). Every
SHA that contains the fix also contains 682bbbdc, so step one would ship the
ticker fix through the seat path and leave step two nothing to switch. After
C, the native procedure would still fail on M3's conditions for every later
deploy, unless the product fix also makes the capture complete; nothing shows
that yet.

Preserves P-post through its own verification; P-capture is absent. **Not
recommended:** it needs the operator's decision and leaves the procedure
broken.

### D. Other candidates considered

- **Full-inventory read** (`liveOnly:false, compact:false`; 8 s, prepared
  registry; `bindings.ts:7169-7191`). It selects from the whole corpus, so
  `matched` far exceeds 200 and `unselectedCount > 0`. The guard refuses it.
- **Targeted reads per conversation, enumerated from open pipelines.** These
  also reach the projection at `liveness.ts:1534` under 800 ms. Pipelines do
  not list the seats and workers whose pids the cgroup fence needs, so the
  inventory would be partial. Forbidden.
- **A draining read first, then the capture.** This relies on an internal side
  effect, it is brittle, and M3's conditions still fail. Rejected.
- **The candidate's local MCP service through health-probe admission**
  (`server.ts:5254-5259`, `src/runtime-host/bootstrapMcpHealthProbeAdmission.ts`).
  It keeps the 800 ms budget, starts with an empty catalog (`pending`), and
  would write the live projection from a second process. Rejected.
- **Reimplementing the host rule in Python.** That would put a second process
  rule beside the product's (`liveness.ts:1556-1563`), and it would drift.
  Rejected in favour of B's source injection.

## Recommendation

Do B with B2-a. Ship B in one build lane on `main`. The existing Deployer then
deploys an exact SHA that contains 682bbbdc, the projection fix of lane
a3384376, and B.

Each slice walked on its own end state:

- **After slice 1 merges, before slice 2:** nothing on the installation
  changes. The procedure runs only when a Deployer invokes it, and the serving
  Viewer is untouched.
- **After slice 2:** the target serves. The census captured before the switch
  and refreshed before the stop. Serving samples checked the target's MCP
  strictly, protected outcomes were reconciled, and the automatic seat wake was
  observed.

No slice removes a signal without its replacement: the census replaces the MCP
capture in the same change, and the health read is unchanged.

### Slice 1 — build lane

- New `scripts/protected-host-census.ts`, run with the plan's `bun` from
  `releaseDir`.
- In `scripts/deploy-checkout.py`: a `census()` adapter method that tests can
  inject, used by `capture` and `generation`, and failed-check names in the
  preflight refusal.
- Tests in `scripts/deploy-checkout.test.ts`, `scripts/deploy_checkout_test.py`
  and a census test file.
- `docs/deploy-checkout.md`.

Do not touch lane a3384376's files.

### Slice 2 — the existing Deployer

1. Build the new exact SHA and run both rehearsals.
2. Run `--preflight`, read-only, at most 5 times, at least 2 minutes apart.
3. After the first pass, run `--start --approved` at most 3 times. A worker
   refusal before the switch publishes nothing (`:1417-1428`).
4. Read the verdict and observe the seat's automatic wake.

Codex stays 0.166.0. If the bounds run out and the printed failing check is
`mcp` every time, the seat reports that exact blocker. It then chooses between
building B2-b through review and asking the operator about C.

### Acceptance criteria

Slice 1, verifiable by the build lane and the reviewer:

- **B-1 Equivalence.** A fixture state has these owners: a live structured
  host, a live tmux host, a live receipt-only launch, a dead host, a host whose
  identity cannot be read, and a headless round. It has open and archived
  pipelines with historical attempts and several runs, and busy, idle and
  unreadable transcripts. On it, the census rows equal what
  `agentLivenessSnapshot` returns with production sources, a completed catalog,
  no budget and a fully drained projection, over every row with
  `host.state == "alive"`. The compared fields are `(conversationId,
  host.state, host.kind, host.pid, turnState, pipeline.{pipelineId, stageId,
  attempt})`. Removing any one owner kind from the census enumeration turns
  the test red.
- **B-2 Read-only.** Run the census against a copy of a state directory that
  has at least one pending pipeline row. Afterwards the SHA-256 of
  `state.sqlite` and `state.sqlite-wal` is unchanged and so are the
  `history_pending` rows. No file is created other than SQLite's `-shm`. The
  census claims no owner token. Under an operator-shaped home without
  `LLV_STATE_DIR` it refuses, as `stateOwnership.entryPoints.test.ts` shows for
  other entries.
- **B-3 Fails closed.** A store open, schema or migration refusal, a registry
  read error or malformed output each give a non-zero census exit and no rows.
  Preflight then refuses with exit 2 and publishes nothing.
- **B-4 Completeness is truthful.** Each condition at
  `deploy-checkout.py:549-559` has a census case that sets it: an unreadable
  tail; a tail not read before the deadline; an undescribed hosted path; more
  than 200 live owners; and two live owners of one folded conversation (both
  reported, or the answer is incomplete). In each case preflight refuses. The
  green fixture passes.
- **B-5 No Viewer dependency.** Capture and generation pass with
  `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1` and a fake MCP that raises on
  `agent_activity`. The census environment carries no `DELEGATUS_TOKEN`,
  `LLV_TOKEN` or spawn variables under either prefix.
- **B-6 Bounds unchanged.** The diff changes none of these: the constants at
  `bindings.ts:7062-7069`, `deploy-checkout.py:617` and `:796`, the 21 samples
  of 15 s, the 180 s read bound. The census child is a `Popen` the procedure
  owns and kills at the remaining capture bound, and its stdout is capped at
  4 MiB. A test with a census that hangs shows the kill and the refusal.
- **B-7 The rest is unchanged.** The fence, leftovers, launcher ancestry,
  relocation, the start obligation and post-switch sampling keep their tests.
  Those tests pass, modified only where they inject the capture source.
- **B-8 Measured cost.** Run the census from a scratch export of the slice's
  head, read-only, against a `VACUUM INTO` copy of the live `state.sqlite`,
  the live registry and the live transcript roots. Report wall time, bytes
  read from `/proc/self/io`, peak RSS, the owner count and the number of folded
  conversations with two live owners, with the load average beside each, over
  three runs. The slowest run fits within 30 s with at least a 2x margin;
  otherwise the lane reports the gap and raises no bound.
- **B-9 Readable refusal.** When baseline readiness refuses, standard error
  names the failing checks (`http`, `runtimeSocket`, `mcp`, `service`) and
  nothing else. No exception text and no arguments are printed.
- **Docs.** `docs/deploy-checkout.md` leads with the caller steps. It states the
  census source, its bound, that it is read-only, and that it gets no
  credential.

Slice 2, verifiable by the seat:

- Real `--preflight` exits 0 on the installation, with the census from the
  target.
- The detached run's `verdict.json` is `pass`. All three processes report the
  full target SHA. `checks.mcp` is true in the final sample. Protected work is
  preserved or recovered, and placement is `placed`.
- An automatic seat-tick wake reaches the current seat after the switch,
  observed in its transcript.

## Validation against the requirement

The operator asked for the exact reviewed target to be built, rehearsed,
preflighted and executed through the native procedure by a separate Deployer,
with the autonomous ticker wake proven afterwards. B keeps that route: the same
Deployer, plan, approval, preflight, start and verdict. It fills the gap the
constraint names with a separately reviewed change that preserves P-capture,
P-own, P-start and P-post, without any of the forbidden moves. The baseline
health read stays exactly as the procedure has it today. C would change the
route and needs the operator's word, and A does not work for the capture.

## Deferred — not currently justified

- **B2-b, a narrowly classified baseline health read.** Specification, kept
  for the trigger in slice 2:
  - It applies only in preflight's baseline readiness (`:790`,
    `placement=False`) and only when the private plan names the class.
  - The procedure still makes the `agent_activity` read. Only `tool_failed`
    with the error "history projection preparation exceeded its deadline" is
    accepted.
  - A different non-mutating tool read through the same child, such as
    `deployment_status {compact:true, limit:1}`, must answer `ok:true`. That
    proves the wrapper, the credential, the Viewer route and the binding layer.
    The outcome is recorded as `mcp: "baseline-known-refusal"`.
  - Any other class fails. Every post-publication sample keeps the strict
    check.
  - An MCP `ping` never reaches the Viewer, and the wrapper's own liveness
    probe relies on that (`bin/mcp-server.mjs:279-287`). In the deployer's
    diagnosis a ping answered in 29 ms while tool reads failed. B2-b is a full
    tool call instead.

  Tests would show that a different class, a missing opt-in, a failing
  alternative read and a post-publication sample all fail.
- Making `agent_activity` return complete live-only inventories under load, so
  the procedure could go back to MCP. That is product work beyond lane
  a3384376, and nothing requires it once B exists.
- Dropping the stop and start. M7 shows the unit already sits in its slice, so
  the relocation reason of 2026-10-11 no longer applies here. Changing the
  switch mechanics is outside this requirement.
- Explaining the first `outcome_unknown` of a fresh operator-token MCP child.
  The deployer's diagnosis and lane a3384376 both record it as unexplained.
  After B, it can affect only the baseline health read (B2-a).

## Notes and unknowns

- The two paused lanes re-entered `history_pending` 41 and 43 times in M9's
  480 s, about every 11 s; the two completed lanes did so 4 times each.
  Something rewrites these rows while the lanes do not run. The cause was not
  investigated here. It feeds the queue that the baseline health read and
  every other history reader must drain.
- The cause of `unselectedCount: 1` in M3. B-4 and B-8 cover it either way.
- Whether lane a3384376's fix makes the post-switch health read pass under
  load. P-post needs it, because the final sample requires `checks.mcp`. That
  lane's acceptance requires it; slice 2 observes it.
- The census's cost on live data (B-8) is unmeasured, because the census does
  not exist yet.

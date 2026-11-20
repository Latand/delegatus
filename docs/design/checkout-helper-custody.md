# Checkout switch: live agent hosts and their helpers keep running

Status: design, revision 2, 2026-11-20. Read-only design stage of a high-risk
lane (release switching and agent host lifecycle; three review rounds).
Revision 1 (#4169) designed the helper custody proof, and that proof is kept
here in §6. This revision changes how the switch itself happens and corrects
revision 1's assumption about stopping the scopes (§2).

Every code claim was checked against `main` at `5bbb7d56`. Live-shape claims
come from read-only `/proc`, cgroup, `systemctl --user show` and state-file
reads on the operator's installation at 2026-11-20 03:15–03:30 UTC. One owned
probe used private transient units on the same user manager (§3.2). Nothing
belonging to the installation was signalled, stopped, moved or written.

## 0. Originating requirement

**Operator, 2026-11-18, about 02:20 UTC**, to the project seat in chat, in
Ukrainian. Paraphrased for publication:

> The official checkout preflight refused because of 120 processes in the
> service: 20 groups of a native wait owner and its stderr drain, each owning
> a live Codex host outside the service cgroup. They are not candidates for a
> manual kill. Fix this by migrating or by counting the real custody, keeping
> every host, receipt and cgroup fence. Do not weaken preflight and do not
> touch the live hosts.

**Pinned specification of this lane, 2026-11-20**, paraphrased. It continues
criterion 2 of the earlier lane (#4169): no live host and no helper is
signalled. On the 19 November switch, the verifier matched eight native
SIGKILL exits to the user manager's scope stop jobs and their timeout kills.
The checkout procedure's empty direct-signal list was accurate. That record
alone does not pass the criterion. The lane must:

- deliver a supported release switch with protected hosts and helpers still
  running;
- verify the original process and work identities, the continuity of the
  current turn and of its receipt writer, and zero direct or indirect
  switch-initiated signals through the whole transaction, including the
  manager's dependency propagation and timeout escalation;
- cover Claude and Codex where they share the lifecycle;
- keep explicit stop, real-service shutdown, cleanup and ownership
  guarantees;
- keep the clean release cgroup, correct replacement placement, the release
  fence and fail-closed handling of unproven processes;
- handle older installed scope layouts and mixed or uncertain evidence, and
  state the compatibility limits and the supported transition.

A blanket wait for all workers to drain does not meet acceptance. If no
supported option fits, the lane parks with the concrete trade-off.

Acceptance also needs an owned, isolated rehearsal of the real dependency
transaction, with a negative control on the old path. It must show the same
protected identities and receipt owners before and after, and that an
unrelated explicit stop still works. The lane takes no production stop,
switch or service reconfiguration, and installed acceptance belongs to the
seat.

## 1. Decision in one page

| # | Decision | Why |
|---|---|---|
| D1 | **A service already in its slice switches through the launcher's own in-place relaunch.** The procedure publishes the pointer, files one operator-shaped `relaunch` request and reads the launcher's result. It issues no `systemctl stop`, `start` or `restart`. | The unit never leaves `active`, so `BindsTo=` never fires. No scope gets a stop job, no SIGTERM and no 90-second SIGKILL escalation (§3.2). This is the same transition the product's own checkout update uses, and this installation's launcher supports it (§3.1). |
| D2 | **Agent scopes keep `BindsTo=` and `After=` the service, and every other scope property.** | Explicit stop and real shutdown rely on this binding to end agents. Live scopes need no transition, because nothing about them changes. |
| D3 | **The stop and start relocation stays only for a service outside its slice, and it refuses while any agent scope is bound to the unit.** | A unit stop always stops bound scopes. So does an automatic restart (§3.2). The installation finished its one relocation on 2026-10-11, and every switch since has started and ended in the expected path. |
| D4 | **A relaunch that rolls back, falls back or stays unsettled is never followed by a stop, start or withdrawal in the same run.** | The launcher rolls back in place and retries a request it could not yet take. A fallback stop would recreate the defect. An unsettled request stays unknown, and the seat decides. |
| D5 | **The procedure proves the absence of indirect signals from unit and scope facts.** Every poll reads the unit's `ActiveState`, its jobs, `MainPID` identity, `NRestarts`, `InvocationID` and `InactiveEnterTimestampMonotonic`. Each pre-switch scope's `InvocationID` is compared afterwards. Any change fails the verdict and names it. | The manager signals scope members only from a stop or restart job on the scope or on the unit it is bound to. If no such job happened, it sent no such signal. |
| D6 | **The custody proof is unchanged** (§6). Proven helpers now stay with their running hosts. | Revision 1's bidirectional proof still holds in code. Only their fate across the switch changes. |
| D7 | **Claude, and any other engine on Viewer-owned stdio, is covered where the lifecycle is shared.** The switch sends it no signal and never stops its scope. Its original waiter writes its receipt. It still ends by end of file when the Viewer that owns its pipes is replaced. | That transport limit applies to every Viewer replacement today. Keeping the engine connected needs transport custody independent of the Viewer, which is deferred (`docs/design/structured-host-recovery.md`). |

No ADR. The change selects a transition inside one script, and reverting it
restores the stop and start.

## 2. What revision 1 got wrong about the scope stop

Revision 1 §2.5 said the unit stop "ends every bound host before the unit
itself stops". It took that ending as the defined, safe fate that made the
helpers admissible. Revision 1 §12 then read "do not touch the live hosts" as
"the procedure sends no direct signal". Both are corrected here.

1. **The stop signals every bound host, through the manager.** A stop job on
   the service pulls a stop job for every scope that has `BindsTo=` on it.
   `After=` orders those scope stops first. Each scope stop sends SIGTERM to
   every member (scopes use `KillMode=control-group`). A member still running
   at the scope's `TimeoutStopSec` (90 s here) gets SIGKILL. Only then does
   the service stop continue.
   - On 19 November the scope stop jobs began at 12:44:43 UTC and the
     manager logged `Stopping timed out. Killing.` at 12:46:13. That is 90 s
     later. Eight hosts exited on SIGKILL and three with code 143.
   - The procedure's own `signalled` list was empty, which was accurate. The
     signals came from the manager, one transaction away (verifier record,
     private).
   - The owned probe in §3.2 reproduces the same sequence on private units.
2. **`KillMode=process` preserves only the service cgroup's own members.**
   Preflight names it the "agent preservation" fence
   (`scripts/deploy-checkout.py:968`). It spares the wait owners and drains,
   which live in the service cgroup. It has no effect on the scopes, which
   are separate units.
3. **The stop also breaks launches.** While the service's stop job is
   queued, a new agent scope is refused because its transaction "is
   destructive (delegatus.service has 'stop' job queued…)". This was seen on
   another lane during a switch.
4. **The stop bought nothing for placement.** Each of the four switches of
   19–20 November recorded the old and the new cgroup as the same expected
   path, `delegatus.slice/delegatus.service`, with outcome
   `unproven-survivors`.
   - Their protected stages ended `completed`, `fresh attempt started` or
     `recovered`, and none `preserved`.
   - The six recorded switches of 6–11 October were the same.

What stays valid from revision 1:

- the launch, cgroup and succession facts of its §2.1–2.4 and §2.6;
- the custody proof W1–W8 and F1–F6, its census fields, output lines and
  reasons (§6 here);
- the receipt and marker fences.

## 3. The current release architecture, traced

### 3.1 Release modes of a Linux checkout installation

| Mode | Trigger | What the unit sees | Bound scopes | Code |
|---|---|---|---|---|
| In-product update, relaunch-capable launcher | The Viewer's apply files a `relaunch` request after its build | No job. The release launcher calls `execve` with the same PID and start identity. `MainPID` is the checkout bootstrap and does not change. | untouched | `src/lib/selfUpdate/apply.ts:70-88`, `bin/cli.mjs:1591`, `bin/launcher-relaunch.mjs:639-748` |
| In-product update, older launcher | `systemctl --user restart` through a `delegatus-apply-*` unit | stop and start jobs | stopped | `src/lib/selfUpdate/actions.ts:68,226` |
| Web or runtime host restart request | role `web` or `runtime-host` | No job. The launcher restarts one child. | untouched | `bin/cli.mjs:1602-1605` |
| Checkout procedure today | `deploy-checkout.py --start` | stop job, then start job | stopped, with SIGKILL at the timeout | `scripts/deploy-checkout.py:1713-1767` |
| Explicit stop | `systemctl --user stop`, `delegatus stop --all`, logout or shutdown | stop job, or recorded processes stopped by identity | stopped, by design | `bin/stop-all.mjs:1-30` |
| Managed (Docker) | runtime host deployments | container | no agent scopes in Docker (`probeAgentScopes` returns null) | out of scope |

On this installation the launcher record carries `relaunch: 1` and the
protocol `delegatus-launcher-relaunch-v1`. Its update history records 212
completed in-product applies. Around the last six of them (17–18 November,
±3 minutes), every signalled host exit carries a product stop receipt
(`pipeline-stage-stop`), and none is a manager kill. The in-product apply's
build step timed out twice on 18 November in its ready phase. That is why the
checkout procedure was used. The procedure builds and verifies its own
release, so it never runs that step.

The repository already drives the relaunch protocol from outside the Viewer.
`bin/cli.selfUpdate.integration.test.ts:22` writes the pointer and
`{requestId, role: "relaunch", target}` into the launcher's request file. It
asserts that the launcher, Viewer and runtime host are replaced "under the
same supervisor PID". The request file is the launcher's public control
interface: "the two sides agree on the JSON shape alone"
(`src/lib/selfUpdate/launcher.ts:1-6`).

### 3.2 Service and scope lifetime

- **Unit.** The product's unit file has `Type=simple`, `Restart=on-failure`,
  `RestartSec=5`, `KillMode=process` and `TimeoutStopSec=120`
  (`bin/login-service.mjs:57`). The installed unit reads the same.
  - `MainPID` is the checkout bootstrap (`bin/cli.mjs` from the install
    checkout). It spawns the release launcher (`handOffLauncher`,
    `bin/cli.mjs:1702-1770`), which starts the Viewer and the runtime host.
  - If the release launcher exits after it has settled, the bootstrap exits
    with the same status (`bin/cli.mjs:1768`).
- **Scopes.** Each agent runs in
  `delegatus-agent-<engine>-<hex>.scope` in `delegatus-agents.slice`, with
  `BindsTo=` and `After=` the Viewer's unit (`agentMemory.ts:89`).
  - Scope properties: `KillMode=control-group`, `SendSIGKILL=yes`, a
    `TimeoutStopUSec` of 90 s and `CollectMode=inactive-or-failed`.
  - At 03:18 UTC the service's `BoundBy` listed 34 agent scopes.
  - Its cgroup held 31 wait owners, all children of the current Viewer. 25
    owned Codex socket hosts and 6 owned Claude stdio hosts, each in a bound
    scope.

The probe ran at 2026-11-20 03:27 UTC on systemd 255. It used private
transient units: a service with the product's `KillMode=process` and
`Restart=on-failure`, and two scopes bound to it. Each scope ran a host that
logs SIGTERM and ignores it, and each host had a waiter in the service
cgroup. The scope timeout was 3 s. All units were stopped and reset by name
afterwards.

| Case | Unit | Scopes | Hosts | Waiters |
|---|---|---|---|---|
| `MainPID` calls `exec` on itself in place | `active`. Same `MainPID` and `InvocationID`, `NRestarts=0`, `InactiveEnterTimestampMonotonic=0`. | `active`, same `InvocationID` | no signal logged | alive |
| `systemctl --user stop` on the service | stop returned after 3.0 s | stopped first; manager logged `Stopping timed out. Killing.` and SIGKILL per member | SIGTERM at +0 s, SIGKILL at +3 s | survived (`KillMode=process`) and recorded exit 137 |
| `MainPID` exits 1 with `Restart=on-failure` | restarted, `NRestarts=1`, new `InvocationID` | stopped, and the restart waited for their timeout | SIGTERM, then SIGKILL | recorded 137 |

The third row matters for D3 and §9. An automatic restart is no protection,
so anything that ends `MainPID` ends every bound host.

### 3.3 Receipt ownership

- The waiter writes `native-exit.json`, the bound `host-exits/*.exit.json`
  slot and removes the writer slot (`nativeWaitOwner.ts:42-57`). It leads
  its own session in the service cgroup.
- A relaunch retires only the old Viewer's process group and the helpers
  recorded for it (`bin/viewer-helpers-retire.mjs:1-24,228-265`). Waiters and
  drains lead their own sessions, so they survive. Their parent exits and
  the user manager adopts them, exactly as after every in-product update.
- No receipt is substituted. The writer slot still names the original
  waiter, and the original waiter is still the one that writes.
- A Codex socket host is reattached by the new Viewer through
  `CodexSocketTransport.reconnect`. That resumes the thread and reconciles an
  active turn (`codexAppServerHost.ts:1704,1826-1870`). Existing coverage:
  - `codexSocketTransport.native.test.ts:13`: a replacement Viewer receives
    the native exit evidence after the launching Viewer exited;
  - `:247`: a real Codex binary replays a pending approval on reconnect.
- A Claude host inherits the waiter's stdio, which are pipes to the Viewer.
  When that Viewer exits, the host reads end of file and ends. The
  installation's 11,000 recorded host exits contain no SIGPIPE: they are
  9,446 with code 0, 1,240 with code 143, 255 SIGKILL and 46 with code 1.

### 3.4 What the replacement Viewer does at startup

Startup adoption keeps every surviving host whose conversation turn is not
terminal, and every current seat. It releases the rest with a stop receipt on
the path `startup-retained-host-release` (`src/lib/runtime/startup.ts:243,268`).
Release sends SIGTERM and then SIGKILL (`codexAppServerHost.ts:3909-3955`).
This is the existing cleanup policy. The idle retirement sweep applies the
same policy every five minutes. The pinned specification keeps it.

In this design, a **protected host** is a live host whose conversation is not
terminal: every busy stage the census lists, and every live seat. A terminal
host follows the cleanup policy unchanged, and every such stop leaves a
receipt that names its path.

### 3.5 Older installed scope layouts

| Layout | Since | Relaunch switch | Relocation switch |
|---|---|---|---|
| Bound scope (`BindsTo=`/`After=` the service), memory or CPU-only | 2026-10-02 (#2418) | untouched | refused while any is active (D3) |
| Unbound scope (Viewer started from a terminal) | 2026-10-02 | untouched; its helpers fail custody W6, so preflight refuses as today | the same refusal |
| No scope (watchdog mechanism, memory `off`): the host lives in the service cgroup in its own process group | before 2026-10-02 | untouched; it passes the fence as an agent | survives the stop and pins the old path (today's `unproven-survivors`) |
| Signal-sandbox scope `delegatus-signal-*.scope` (unbound) | 2026-10-21 | untouched; its socket helpers stay refused (revision 1 §10) | the same |

Scope properties cannot be changed in place. `set-property` does not accept
dependencies, and editing transient unit files behind the manager is
unsupported. So the only switch that keeps a bound host running is one in
which the unit never stops. D1 needs no scope transition at all.

### 3.6 Related open work, read 2026-11-20

| Change | Touches | Dependency |
|---|---|---|
| #4258 (standalone merger recovery after a checkout handover) | `deploy-checkout.py` census and capture, startup recovery | Textual overlap in `generation()` and `docs/deploy-checkout.md`. Whichever merges second rebases. Its recovery stays useful for relocation and for stdio hosts. It does not block this lane. |
| #4193 (bounded evidence sampling) | `observe_switch`, sampling | Overlaps the verdict edit in §5.6. Rebase on whichever merges first. It does not block. |
| #4225 (publication checks outside the Viewer service) | scope for publication clients | The 12 survivors of 19 November. In relaunch mode they pin nothing, but a later preflight would still name them. It does not block. |
| #4256, #4229 (host retirement accounting) | retirement sweeps | Their stops carry receipts, which §10.4 reads. Notes only. |
| #4168 (ready fingerprint off the server loop), closed | the in-product build | Not needed by this path. |

## 4. Options

**A. Relaunch-based checkout switch (chosen).** Covered in §5. It changes one
script and its tests and docs. It moves no process and changes no scope.

**B. Drop `BindsTo=` from new scopes and end agents explicitly at stop.**
Rejected. It changes explicit shutdown for every installation and every
agent launch. Live scopes keep their binding until they end, so for weeks
the switch would still kill legacy-bound hosts. It also needs a replacement
path for "stop the service ends agents" on logout and shutdown.

**C. Rebind or move live scopes.** Rejected. There is no supported runtime
change of dependencies. Adopting PIDs into new units mutates live processes,
which revision 1 option A already rejected.

**D. Wait for a quiet window, then stop and start.** Rejected by the pinned
specification.

**E. Use the in-product update for the whole switch.** It keeps hosts. It
also drops the procedure's exact build, the rehearsal record, the census,
the fences and the verdict, and its build step timed out on 18 November.
Option A reuses only its switch step.

**F. Shorter scope timeouts or a graceful engine stop.** Rejected. The hosts
still end.

## 5. The repaired switch

### 5.1 Mode selection, in preflight

After the existing fences, preflight reads `placement()`. Today the baseline
is exempt from placement in preflight.

- `actual == expected` → **relaunch mode**. Placement stays a sampled check
  afterwards, as today.
- Otherwise → **relocation mode**, which is today's code path. It is
  admitted only when `systemctl --user show <unit> -p BoundBy` lists no unit
  whose `ActiveState` is `active` or `deactivating`. Otherwise it refuses
  with the fixed reason `relocation would stop <n> bound units`.
  The refusal publishes nothing, issues no service command and sends no
  signal.

Each mode prints one line before the pass line:
`Switch mode: relaunch in place` or `Switch mode: relocation (stop and start)`.

### 5.2 Relaunch preconditions (new refusals, fixed reasons)

| Check | Reason on failure |
|---|---|
| The launcher record has `launcher.relaunch == 1` and `launcher.protocol == "delegatus-launcher-relaunch-v1"` | `launcher cannot relaunch in place` |
| The target release's `bin/launcher-relaunch.mjs` contains that protocol string and its `bin/cli.mjs` contains the bootstrap handoff protocol (the checks of `actions.ts:44-46` and `bin/cli.mjs:1697`) | `target release cannot take a relaunch` |
| `record.requestFile` resolves to `<state>/self-update/request-<installId>.json` | the existing `checkout launcher topology differs from plan` |
| No request file, no `trial-<installId>.json`, `apply.json` not in `building`, `ready` or `switching`, and no unexpired `auto-admission.json` | `launcher request or update already pending` |
| `record.launcher.state == "healthy"` | `launcher not idle` |
| The target differs from the serving release's SHA and directory (`begin` refuses a relaunch to the installed release) | `target already serving` |

The last fence, the leftover inventory (§6), still runs last and unchanged.

### 5.3 Transaction, in order

1. **Capture.** `generation()` runs as today, immediately before the
   request. It refreshes the census, the custody set and the captured
   serving generation. It also records:
   - `unitBefore`: `ActiveState`, `MainPID` with its start identity,
     `NRestarts`, `InvocationID` and `InactiveEnterTimestampMonotonic`;
   - `scopesBefore`: for each live host in the census, its scope unit (read
     from `/proc/<host>/cgroup`, as custody W5 does) and that scope's
     `InvocationID` and `ActiveState`, in one batched
     `systemctl --user show`.
2. **Publish.** `publish()` runs unchanged, with the same fences and the
   same atomic pointer write.
3. **Request.** Write a private temporary file, then `os.link` it to
   `record.requestFile`. That is the same exclusive create as
   `publishLauncherRequest`. The body is
   `{"requestId", "role": "relaunch", "target", "rollbackPointer", "requestedAt"}`.
   - `rollbackPointer` is the exact text of the baseline pointer file that
     preflight compared.
   - There is no `autoGateId`, so the launcher treats the request as the
     operator's own.
   - An existing file (`EEXIST`) ends the attempt as `request-refused`. The
     pointer stays published, and nothing is stopped.
4. **Await the launcher.** Poll once per second. On each poll, read the unit
   facts of §5.4. Stop at the first terminal evidence for this
   `requestId`:
   - `done`: `<requestFile>.result.json` names this request with state
     `done`, the plan's target, `revision == target`, and the launcher PID
     and start identity from `unitBefore`.
   - `rolled-back`: the result file names this request with state
     `rolled-back`.
   - `fell-back`: the launcher's load check failed. The launcher record
     names this request with error kind `fell-back`, the request and trial
     files are gone, and the pointer equals the baseline again
     (`launcher-relaunch.mjs:696-704`).
   - `refused`: the launcher record names this request with an error of
     kind `message`, written when `begin` throws (`bin/cli.mjs:1591-1600`).

   The bound comes from the launcher's own deadlines. If a trial for this
   request appears, wait until its `switchDeadlineAt`, plus
   `ROLLBACK_TIMEOUT_MS` once its state is `rolled-back`, plus 60 s. If no
   trial appears, wait 120 s. Anything else at the bound is `unsettled`. The
   request stays as it is, because the launcher retries a request it could
   not take yet (`self-update-supervisor.mjs:365-374`).
5. **Generation release.** For up to the existing `RELEASE_WAIT` (30 s),
   wait until every captured member of the old generation has gone. The
   captured generation is the old Viewer, the runtime host and the
   Viewer-group helpers. The launcher identity, which survives `execve`, and
   its verified ancestors are excluded. A member still running is reported
   with today's survivor shape as a `generation survivor`. Nothing is
   signalled, because the procedure has no retirement step in this mode.
6. **Observation.** The 21 samples run as today. Each sample also appends one
   poll of the unit facts.

The pointer write and the request write run inside one
`deferred_termination()` section, so a signal to the worker cannot separate
them. A crash between them leaves the target pointer published with no
request. The next preflight then refuses with `baseline pointer changed`,
and nothing is signalled. After the request, the worker owes no start. If
the worker stops while it waits, its status stays unfinished and the
launcher's result file remains the record.

No step submits a unit job. A test asserts that the only service-manager
commands in this mode are `show` and `list-jobs`.

### 5.4 Proof that nothing was signalled indirectly

- **Unit fence.** The fence holds when every poll from the request to the
  last sample reads all of the following:
  - `ActiveState=active` and no job for the unit;
  - the same `MainPID` and start identity, `NRestarts`, `InvocationID` and
    `InactiveEnterTimestampMonotonic` as `unitBefore`.

  Comparing the timestamp and `InvocationID` also catches a stop and start
  that happened between two polls. Any difference sets `unitLeftActive` and
  records the first differing poll. An unreadable poll sets
  `unitUnknown`.
- **Scope continuity.** After the samples, the procedure re-reads every
  scope in `scopesBefore`.
  - A scope still loaded must keep its `InvocationID` and stay `active` while
    its host identity is alive.
  - A scope that is gone must belong to a host that has exited. That host's
    exit slot and any stop receipt are recorded as `{code, signal,
    stopPath}`.
  - A scope that changed `InvocationID` or left `active` while its host
    lived sets `scopeStopped`.
- **Direct signals.** `signalled` is always `[]` in relaunch mode, and
  `retire()` is unreachable.

### 5.5 Protected outcomes

The existing samples already report `preserved` for a protected host whose
PID and start identity are still alive (`deploy-checkout.py:247-253`).
Relaunch mode adds, per protected host:

- the custody identities (waiter and drain members) before and after;
- the writer slot's waiter identity after the switch, which must be the
  same waiter.

A protected host that is gone after the switch keeps today's reconciliation:
`recovered`, `fresh attempt started`, `completed`, `lost` or `unknown`. Its
exit record is added. Claude stdio hosts land here, by end of file (D7).

### 5.6 Verdict

`relocation_ready` (`deploy-checkout.py:292-294`) becomes `switch_ready`.

- In relocation mode it is unchanged.
- In relaunch mode it holds when all of these hold:
  - the result is `done`;
  - there is no `unitLeftActive`, `unitUnknown` or `scopeStopped`;
  - there is no generation survivor;
  - placement is `placed`.

Verdict mapping:

- `rolled-back`, `fell-back`, `refused`, `request-refused`,
  `unitLeftActive` or `scopeStopped` → `fail`.
- `unsettled` or `unitUnknown` → `needs_decision`.
- Health and protected outcomes are judged as today.

`verdict.json` gains `relaunch`, with these fields: `requestId`, `result`,
`unitBefore`, `unitAfter`, `unitLeftActive`, `unitUnknown`, `polls`,
`scopes`, `generationSurvivors` and `signalled`. In relaunch mode
`relocation` is null, and the `Verdict:` line names the relaunch result.

### 5.7 What does not change

- Preflight's existing fences and their order: heads, the clean exact build,
  both rehearsal verdicts, the baseline pointer, launcher topology,
  `KillMode=process`, `active` with no job, baseline readiness, census
  completeness, and the service cgroup fence with custody last.
- Relocation code, signals and outcomes, when relocation is admitted.
- Scope properties, the waiter and drain programs, the launcher, the
  Viewer, the runtime host and the census script.

## 6. The custody proof (from revision 1, unchanged in code)

`leftovers` runs the existing classification. Only members it would report
go to this proof. Identities use `pid:startTicks`. The boot epoch is
`linux:<boot_id>:pidns:<namespace>`. The first failed link becomes the
refusal reason.

| Step | Wait owner `W` | Reason on failure |
|---|---|---|
| W1 | argv has the waiter shape: `-e`, a source, `--`, and a final JSON whose `command` (or legacy array) starts with an absolute directory `D` | generic |
| W2 | exactly one census row's `exitWriter.process` names `W` with its current identity and boot | `wait owner: no registry writer record names it` |
| W3 | that row's `host.process` matches `/proc/<host>/stat` now | `wait owner: host identity differs from registry` |
| W4 | the host's parent is `W` | `wait owner: host is not its child` |
| W5 | the host's cgroup is outside the service and ends in `/<unit>.scope[/agent]` | `wait owner: host not in an agent scope outside the service` |
| W6 | the scope has `BindsTo=` and `After=` the unit, is `active`, and its `ControlGroup` contains the host's cgroup | `wait owner: host scope not bound to the unit` |
| W7 | `D` is a private real directory, and `D/host-exit.json` names the same exit slot under `<stateDir>/host-exits` | `wait owner: launch directory does not name the host's exit record` |
| W8 | a second read gives the same identities | existing moving-member refusal |

| Step | Drain group on `W`'s FIFO inode `F` | Reason on failure |
|---|---|---|
| F1 | one leader `L` with `pgid == sid == pid`, the drain argv, and FIFO and sink inside `D` | `stderr drain: no single leader for the owner's FIFO` |
| F2 | every other holder is in `L`'s group and session | `stderr drain: process group differs from its leader` |
| F3 | parent links stay inside the group, with at most one subshell | `stderr drain: parent link outside the group` |
| F4 | the programs are `dd`, `tee`, `wc` or `cat` | `stderr drain: unexpected program` |
| F5 | no holder of a second admitted waiter's FIFO | `stderr drain: ambiguous FIFO` |
| F6 | stable identities | existing moving-member path |

W6 stays as written. In relaunch mode it no longer proves a fate at stop. It
still proves that the host is an agent the unit's explicit stop will end, and
the pinned specification forbids weakening preflight.

**Fate, as corrected.**

- *Relaunch mode:* custody members are never captured and never signalled.
  They keep running with their hosts. The procedure records their identities
  before and after (§5.5).
- *Relocation mode:* admitted only with no bound scope active (D3), so there
  are no live scoped hosts and no custody to carry. A custody member found
  after a relocation stop keeps revision 1's `unproven-survivors` handling.

## 7. Processes that can write state during the transaction

| Process | Writes | Proof it ended, or that it continues |
|---|---|---|
| Old Viewer | registry, journals, transcripts index, its own helpers | Launcher retirement, then §5.3 step 5: the captured identity is gone from `/proc` |
| Old runtime host | runtime journal, fence | The same |
| Viewer-group and recorded helpers | their own outputs | `retireViewerGroup` and `retireViewerHelpers`, then step 5 |
| Release launcher (same PID across `execve`) | record, trial, result, pointer on rollback | Continues. Its result file is read in step 4 |
| Checkout bootstrap (`MainPID`) | nothing | Continues. Unit fence |
| Wait owners | native exit, bound exit slot, writer slot removal, `D` cleanup | Continue. Same identity after (§5.5), and they write only when their host ends |
| Drains | the unlinked `startup.stderr` | Continue. Same identities |
| Agent hosts | transcripts, `rpc.sock`, their tools' files | Continue (Codex socket). A stdio host ends by end of file and its waiter writes its receipt |
| New Viewer and runtime host | registry, adoption, cut obligations | Start after the old ones exit (launcher order). Serving samples |
| Checkout worker | pointer, request file, run directory | Its own unit and the installation lock |

## 8. Fences kept

1. Plan, release and publication fences (`deploy-checkout.py:950-997,1465-1472`).
2. Baseline readiness, with the four checks.
3. Protected-host capture completeness (200 owners, transcript evidence,
   bounded census child).
4. The service cgroup fence and the custody proof, unchanged and last.
5. Relocation fences, in relocation mode: capture, release wait, survivor
   proof, pidfd signalling, no signal while any survivor is unproven, start
   always submitted, placement.
6. The clean release cgroup. In relocation mode this is the release wait. In
   relaunch mode it is the generation release of §5.3 step 5. The unit
   cgroup is never vacated, so no stale path can be reused.
7. Correct replacement placement: the same per-sample check of slice,
   `ControlGroup` and both weights.
8. Release fences: the launcher's startup lock and trial custody, the
   runtime host's singleton fence and the startup release fence all run as
   in every in-product update.
9. Receipt and marker fences: the procedure writes no exit slot, no
   `D/host-exit.json`, no `start.json`, `attached` or `native.json`, and no
   registry row.
10. Fail-closed handling of unproven processes: the procedure never signals
    in relaunch mode, and in relocation mode it keeps today's rules.
11. Explicit stop and real shutdown: unchanged (D2). The rehearsal's control
    case proves it (§10.2, R3).

## 9. Compatibility limits and supported transition

- **Transition.** The first switch whose procedure entry is a release with
  this change selects relaunch mode on this installation, because the unit
  is placed and the launcher supports relaunch. Live scopes and helpers need
  nothing; their binding stays as it is. There is no data migration.
- **Older launcher** (no `relaunch: 1`): relaunch is refused. Relocation is
  possible only with no bound scope active. The in-product update for such a
  launcher uses `systemctl restart`, which also stops bound scopes.
- **Misplaced unit with live bound agents:** refused (D3). Moving the unit
  needs it to stop, and a stop ends bound scopes.
- **Launcher exit.** A relaunch whose in-place rollback also fails ends the
  release launcher with status 75. The bootstrap then exits, and the unit's
  automatic restart stops every bound scope (§3.2, third row). The unit
  fence reports this as `unitLeftActive` and the verdict fails. This is
  today's behaviour for any launcher crash.
- **Claude and other stdio engines:** the switch sends them no signal and
  never stops their scope. They still end by end of file at the Viewer
  replacement. The existing
  next-message recovery continues their work (D7).
- **Hosts launched during the relaunch window:** they run in bound scopes and
  are untouched. A launch cut by the old Viewer's exit is handled by
  structured setup custody, as for any Viewer replacement.
- **Mixed or uncertain evidence.** Each case below leaves the result
  `unknown` or `needs_decision`, and none of them can pass:
  - an unreadable poll;
  - a scope that cannot be read;
  - a host whose identity cannot be read;
  - a protected host that is gone and has no exit slot;
  - an `unsettled` request.

  A custody link that fails stays a `LeftoverProcesses` refusal.

## 10. Verification plan

### 10.1 Fixture tests, `scripts/deploy_checkout_test.py`

The `CheckoutIntegration` fixture's default service group is placed
(`deploy_checkout_test.py:719-720`). So every default `run_switch` test there
enters relaunch mode once relaunch becomes the default. Relocation stays
reachable through `relocating()` (`:1688`, 21 callers) with an empty
`BoundBy`.

Tests that use the placed default and assert stop and start must choose a
mode explicitly:

- `test_custody_switch_releases_without_signals_and_is_never_captured`;
- `test_lingering_custody_refuses_retirement_but_always_starts`;
- `test_new_agent_and_child_after_preflight_are_never_signalled`;
- `test_agent_admitted_*`;
- `test_correct_placement_passes`;
- the start and stop retry tests.

The fixture gains:

- a launcher responder that answers a request with each terminal state;
- `BoundBy` and scope `InvocationID` answers;
- unit-fact answers per poll.

New cases:

1. Mode selection: placed → relaunch. Misplaced with empty `BoundBy` →
   relocation, today's results. Misplaced with an active bound scope →
   `relocation would stop 1 bound units`, with no publication, no service
   command and no signal.
2. Each refusal of §5.2, with no publication and no service command.
3. Relaunch `done` gives `pass`, `relocation: null`, `signalled == []`,
   `service_commands() == []`, and a request body whose `rollbackPointer`
   equals the baseline file's bytes.
4. `rolled-back` and `fell-back` give `fail`. `request-refused` (`EEXIST`)
   gives `fail` with the pointer published and no stop. `unsettled` gives
   `needs_decision` with the request left in place.
5. The unit fence: each of `ActiveState`, job, `MainPID` identity,
   `NRestarts`, `InvocationID` and `InactiveEnterTimestampMonotonic`
   changing in one poll fails. An unreadable poll gives `needs_decision`.
6. Scope continuity: a changed `InvocationID` while the host lives fails. A
   gone scope with a natural exit slot passes. A gone protected host without
   a slot gives `unknown`.
7. A generation survivor is named and never signalled, and the verdict
   fails.
8. Custody in relaunch mode: identities are recorded before and after, they
   are disjoint from the capture, and nothing is signalled.
9. The existing custody, leftover and survivor cases keep their members,
   reasons and outcomes.
10. Interruption: the worker stops after the pointer write and before the
    request. Reconcile from durable state: no request exists, the next
    preflight refuses with `baseline pointer changed`, and no command or
    signal is issued. A second case stops it after the request: the
    launcher result alone settles the transition.
11. `refused` and `target already serving` each fail without a unit job.

### 10.2 Owned systemd rehearsal (new lifecycle test file)

Run it as `bun test scripts/deploy-checkout.switch.lifecycle.test.ts`. It is
gated by `LLV_SWITCH_REHEARSAL=1`, Linux and a reachable user manager, as
`src/lib/runtime/cpuPlacement.scope.test.ts` is. It runs in its own owned
runner with `LLV_GATE_RUNNER=off`, so it measures this machine's systemd,
which matches the installation.

**Isolation.**

- Private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`, and
  `LLV_VIEWER_CONTROL_URL` on a closed port, all under the test's
  temporary root. The launcher listens on a port chosen through port 0.
- Every unit and slice name starts with `llvswitchtest<pid>x<random>`. The
  agents slice is private.
- The test records each unit name and `InvocationID` it creates, and its
  teardown stops and resets only those names. It never names
  `delegatus.service`, `delegatus.slice` or a live agent slice.

**Real parts.**

- The real launcher: `bin/__fixtures__/cli-self-update.ts`, with stub Next
  and runtime host, releases A and B, running under a transient user
  service with the product unit's properties (§3.2).
- The procedure's real `Checkout` class with a test plan for that unit. Only
  its HTTP, MCP and census adapters are stubbed.
- Hosts started from inside the Viewer generation through the product's own
  launch primitives:
  - `wrapAgentCommand`, with `viewerUnit` set to the test unit;
  - `CodexSocketTransport.launch`, which provides the real waiter and FIFO
    drain;
  - `spawnNativeWaitOwner`.
- Their engines are Bun scripts, so their SIGPIPE disposition matches a
  Bun-built engine. Each engine:
  - appends every catchable signal with a timestamp to a log;
  - writes a heartbeat every 100 ms;
  - in the socket case, answers on `rpc.sock`.

  One socket engine ignores SIGTERM, as the eight killed hosts did.
- Scopes keep the default 90 s timeout. That is the real escalation.
- The serving launcher in production is older than the procedure. R2 runs
  once more with release A's `bin/` taken from the installation's serving
  revision, so the new procedure drives an older launcher. If the fixture
  cannot host that copy, the build names the gap, and installed acceptance
  covers it.

**Cases and pass conditions.**

| Case | Drives | Must observe |
|---|---|---|
| R1, negative control, old path | `Checkout.relocate()` (today's code) | Every bound scope gets a stop job. Each socket engine logs SIGTERM. The engine that ignores SIGTERM exits on SIGKILL at about 90 s, with exit slot signal `SIGKILL` and the manager journal showing `Stopping timed out. Killing.` for its scope. The unit's `InvocationID` changes. The procedure's `signalled == []`. This is the 19 November defect, reproduced. |
| R2, repaired path | `Checkout.relaunch()` to B | No signal logged by any engine. No exit slot. The same PID and start identity for every host, waiter and drain member. Scope `InvocationID`s unchanged and `active`. The unit fence holds on every poll. No `Stopping` or `Killing` journal line for the test unit or scopes in the window. The launcher has the same identity, and the Viewer and runtime host are replaced and serve B. Stub Viewer B reattaches through `CodexSocketTransport.reconnect` and receives the next heartbeat event from the same socket host. Writer slots name the same waiters. The stdio host ends by end of file with a code and no signal, and its original waiter writes its exit slot. Verdict `pass`. |
| R3, explicit stop control, after R2 | `systemctl --user stop <test unit>` | Bound scopes are stopped. Engines log SIGTERM. The engine that ignores SIGTERM is killed at the timeout. Waiters record receipts. Shutdown through the binding still works. |
| R4, refusal control | A pending request is present at preflight; a second run has a stale target in the request | Refusal, or `unsettled`. No unit job, no signal, and the baseline still serves. |
| R5, rollback control | B's stub Next fails readiness | The launcher rolls back in place. The unit fence holds, nothing is signalled, A serves, and the verdict fails with `rolled-back`. |
| R6, limit detection | During a relaunch, stop the test-owned release launcher by its recorded PID and identity, so its bootstrap exits | The unit restarts and its scopes are stopped. The procedure reports `unitLeftActive` and `scopeStopped`, and the verdict fails. This proves the fence detects indirect signals. |

R1 needs about 95 s and R3 about 90 s. Each case sets its own per-test
timeout (240 s for R1 and R3, 120 s for the others), because a per-test
timeout overrides the runner's. The whole file needs about 6–8 minutes, so
it runs under `gate-slot.sh --record` with a fresh log path and a deadline
that covers every case plus teardown. The
test signals only processes it started, and only by their recorded identity.

### 10.3 Checks the build owes

- `scripts/deploy-checkout.test.ts`, which runs the Python file. Run it on
  the branch and on the merge base, each in fresh state roots, one file per
  command through `scripts/gate-slot.sh`.
- The rehearsal file of §10.2, with its log, exit status and per-case
  timings retained under `LLV_EVIDENCE_DIR`.
- `bin/cli.selfUpdate.integration.test.ts` once, unchanged, because its
  fixture is reused.
- Full typecheck (`bun scripts/local-gate.ts check-step types`), the
  touched-test pre-push, the privacy gate with known values, and the
  required CI.
- `scripts/verify-runtime-host.ts` only if the build touches `bin/**`,
  `src/runtime-host/**` or the `Dockerfile`. This design needs none of them.
  New rehearsal helpers belong in the test file, outside
  `bin/__fixtures__`.
- No preflight, switch or stop against the installation.

### 10.4 Installed acceptance (the seat's, on an authorized rollout)

Pair the procedure's `relaunch` record with a read-only census taken just
before the request and one taken after the last sample. Join each live host,
each waiter and each drain member by PID, start identity and boot.

For the switch window (request to last sample), read the manager journal.
It must have no stop job, no `Killing` line and no `Stopping timed out` line
for `delegatus.service` or any scope in `scopesBefore`.

Every host exit in the window must be one of:

- a natural exit;
- a product stop receipt on an existing cleanup path, for a host that was
  terminal before the switch;
- end of file of a stdio host.

A signal other than end of file, or a signal-shaped exit code (`128 + N`),
cannot pass when the captured turn was busy; it fails criterion 2. If the
captured turn was unknown, the same evidence requires a decision because the
procedure cannot prove the host was terminal. A clean exit and stdio end of
file remain admissible.

## 11. Files to touch, and what must not change

Touch:

- `scripts/deploy-checkout.py`: mode selection, relaunch preconditions,
  `relaunch()`, unit and scope reads, `switch_ready`, verdict fields;
- `scripts/deploy_checkout_test.py`;
- the new `scripts/deploy-checkout.switch.lifecycle.test.ts`;
- `docs/deploy-checkout.md`: its first paragraph, the switch order, the new
  refusals and outputs, and the relocation refusal.

`scripts/deploy-checkout.test.ts` changes only if the Python runner needs a
new case filter.

Must not change:

- agent scope properties and the launch wrapper;
- the waiter and drain programs;
- the launcher and its relaunch protocol;
- the Viewer and runtime host startup;
- the census output;
- the custody proof and its reasons;
- relocation behaviour once it is admitted;
- explicit stop.

## 12. Deferred — not currently justified

From revision 1:

- **Migrating helpers into another cgroup.** Still rejected (revision 1 §3).
- **Keeping live Codex hosts alive across a checkout switch.** Promoted into
  scope by the 2026-11-20 specification. This revision delivers it (D1).
- **Waiter and drain in their own unit outside the service.** Not needed:
  relaunch never vacates the service cgroup.
- **Namespace-launcher socket hosts.** Still refused by custody.
- **Registry identity for the existing agent owner map.** Still a
  pre-existing PID-reuse window.
- **Agents without a scope inside the service cgroup.** They pass as
  agents. In relocation they still pin the old path.
- **A longer wait for lingering custody members.** Relocation only, and not
  justified.
- **The ready fingerprint off the main loop.** It concerns the in-product
  build (#4168, closed). This path does not use it.

New:

- **Transport custody for stdio engines (Claude, Copilot).** It would keep
  them connected across a Viewer replacement. It is a product transport
  feature (`docs/design/structured-host-recovery.md`), and the pinned
  specification covers Claude only where the lifecycle is shared.
- **A launch hold during the relaunch window.** The in-product apply writes
  one. The stop and start this replaces had none. Structured setup custody
  covers a launch cut by the Viewer's exit.
- **Relocating a misplaced unit while bound agents live.** No installation
  needs it today. It would require dropping or replacing `BindsTo=`.
- **Changing scope binding for new launches.** Not needed once the switch
  keeps the unit active.
- **Withdrawing an unsettled relaunch request automatically.** It races the
  launcher's own retry and trial custody. The seat decides instead.
- **Journal attribution inside the procedure.** The unit and scope facts
  decide the verdict. The journal read stays in installed acceptance
  (§10.4).

## 13. Validation against the requirement

| Requirement | Where it holds |
|---|---|
| A supported switch with protected hosts and helpers running | D1, §5.3. The product's own relaunch protocol, already driven this way by `bin/cli.selfUpdate.integration.test.ts:22`. |
| Original process and work identities | §5.5. Rehearsal R2 checks identities and heartbeats. |
| Continuity of the current turn and of its receipt writer | §3.3 (Codex reattach and turn reconciliation), §5.5 (same writer slot and waiter), R2 |
| Zero direct or indirect signals, including dependency propagation and timeout escalation | §5.4 (unit and scope facts), R2 (signal logs and journal), R1 (negative control), R6 (detection) |
| Claude and Codex where the lifecycle is shared | D7, §9. The scope, waiter and receipt are covered for both. The stdio transport is deferred. |
| Explicit stop, real shutdown, cleanup and ownership | D2, §3.4, R3 |
| Clean release cgroup, placement, release fence, fail-closed handling of unproven processes | §8 items 5–10 |
| Older scope layouts, mixed or uncertain evidence, compatibility limits, supported transition | §3.5, §9 |
| No blanket drain | Relaunch needs none. D3 applies only to the relocation of a misplaced unit, which this installation does not need. |
| Owned isolated rehearsal with a negative control and an explicit stop control | §10.2 |
| No production action from the lane | §10.3 |

## 14. Note for the seat's rollout

The next WORK rollout selects relaunch mode when its procedure entry
contains this change. It needs no quiet window and no drain. Claude stages
that are busy at that moment end at the Viewer replacement and recover
through the next message, as after any in-product update. A moment with few
busy Claude stages reduces that recovery. Installed acceptance follows
§10.4.

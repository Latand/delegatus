# Checkout preflight: custody of native wait owners and their stderr drains

Status: design, 2026-11-18, read-only design stage of a high-risk lane (the
production deploy path and live agent hosts; review budget 3). Every code claim
was checked against `main` at `c943a605` (the worktree's starting commit). The
live-shape claims come from read-only `/proc`, cgroup and `systemctl show` reads
on the operator's installation at 2026-11-18 02:40–02:45 UTC; nothing was
signalled, moved or written there.

## 0. Originating requirement

Operator, 2026-11-18 about 02:20 UTC, to the project seat in chat, in
Ukrainian; pinned on this lane's task. Paraphrased for publication:

> The official `scripts/deploy-checkout.py --preflight` refused with 120
> processes in `delegatus.service`. Matched by PID and start identity, they
> form 20 groups of six: a Bun native wait owner, two `sh`, `dd`, `tee` and
> `wc`. Every wait owner has a live Codex child outside the installation's
> cgroup whose PID and start identity match the registry (18 idle, 2 busy).
> They are not candidates for a manual kill. The binding of all 120 is
> unambiguous through the socket startup directory and FIFO, the parent PID
> and the process group. Preflight refuses because it follows only parent
> chains and guarantees the systemd slice. Fix it by migrating or by counting
> the real custody, keeping every host, receipt and cgroup fence. Do not
> weaken preflight and do not touch the live hosts.

The seat's acceptance (pinned specification): preflight proves the binding in
both directions and anything unproven stays a `LeftoverProcesses` refusal; a
defined fate for proven helpers across the switch with the slice guarantee and
every fence kept, and no live host or helper signalled; no receipt
substitution, marker change or moving of unverified processes; fixture tests
for the pass and for the named refusals; full typecheck, touched tests and the
privacy gate; no deploy, production preflight or process action from the lane.

## 1. Decision in one page

| # | Decision | Why |
|---|---|---|
| D1 | **Count proven helpers as protected custody; do not migrate them.** | They already have a defined fate: each ends by itself once its host ends, and the unit stop ends every bound host before the unit itself stops (§2.5). Migration would be a live-process mutation with no gain and would break the receipt design (§3). |
| D2 | **The proof is identity-based and runs only on members the existing fence leaves unowned.** A wait owner is admitted through the registry's own durable writer record (host identity → waiter identity), the kernel parent link (host's parent is the waiter), the host's agent scope bound to the unit, and the waiter's launch directory naming the host's exit record. A drain member is admitted through the waiter's FIFO inode, one process group led by the drain leader, parent links inside that group and the leader's FIFO argument inside the waiter's directory. | Each link is a kernel fact or a record the launching Viewer wrote; none depends on parentage surviving a Viewer generation change. |
| D3 | **Anything that fails one link stays a `LeftoverProcesses` refusal**, named with the failed link. | Unknown stays unknown; the refusal becomes diagnosable. |
| D4 | **The census adds two read-only fields per live host**: the registry-recorded process identity and the exit-writer record read through the product's own reader. | The preflight needs the registry identity to prove "matches the registry"; the slot key derivation stays in one place (`src/lib/runtime/hostExit.ts`). |
| D5 | **At the switch nothing new is signalled.** Custody helpers are never captured, never retired; a helper still present after the release wait is reported as a custody survivor and the existing `unproven-survivors` outcome applies. | Keeps the requirement's "no live host and no helper is signalled" and every relocation fence unchanged. |

No ADR: the change adds one classification to a read-only fence and two fields
to a private census answer; reverting it restores today's refusal.

## 2. What exists today, verified in code

### 2.1 How a Codex socket host is launched

`CodexAppServerHost` starts a persistent-callback Codex host with
`spawnOptions = { cwd, env, detached: true }` and hands
`CodexSocketTransport.launch` a launch adapter that runs `spawnManagedEngine`
(`src/lib/runtime/codexAppServerHost.ts:1701-1707`,
`src/lib/runtime/agentSignalSandbox.ts:55-80`). `launch`
(`src/lib/runtime/codexSocketTransport.ts:167-404`) then:

1. Creates a private directory `D = $HOME/.cache/delegatus/s/dlg-codex-XXXXXX`
   (mode 0700) holding `rpc.sock`, `startup.stderr` and `startup.fifo`
   (`:172-179`).
2. Starts the **stderr drain** (`startStderrDrain`, `:68-110`): `mkfifo`, opens
   one write end `O_RDWR` in the Viewer, and spawns
   `sh -c <script> sh D/startup.fifo D/startup.stderr 16384` with
   `detached: true`. The script opens the FIFO on fd 3 and the sink on fd 4 and
   loops `copied=$(dd bs=N count=1 <&3 | tee -a /dev/fd/4 | wc -c)` until the
   cap or end of file, then `cat <&3 >/dev/null`. So the drain is a session and
   process-group leader `sh`, a command-substitution subshell `sh`, and `dd`,
   `tee`, `wc` (or `cat` after the loop). Then the FIFO name is unlinked
   (`:185`), and `startup.stderr` is unlinked once launch settles (`:211-217`).
3. Spawns the **native wait owner**: the serving Bun runs
   `nativeWaitOwnerSource` with argv `[bun, --no-env-file, -e, <source>, --,
   {"command":[D, binary, ...argv], ...}]`, stdio `[ignore, ignore, FIFO
   writer]`, detached (`:234-246`). The Viewer's own copy of the writer closes
   right after the spawn (`:243-245`).
4. The memory cell wraps the command (`src/lib/runtime/agentMemory.ts:81-91`):
   `binary` is `systemd-run --user --scope --unit=delegatus-agent-<engine>-<hex>.scope
   --slice=delegatus-agents.slice -p Delegate=yes … -p BindsTo=<Viewer unit>
   -p After=<Viewer unit> -- /bin/sh -c '…; exec "$@"' codex app-server
   --listen unix://D/rpc.sock`. The waiter spawns it with `detached: true`
   (`src/lib/runtime/nativeWaitOwner.ts:40`); `systemd-run` moves itself into
   the new scope and execs, so the waiter's direct child **is** the Codex host.
5. Once the waiter reports the child's PID (`native.json`), the Viewer records
   `bindHostExitWriter(D, host, waiter)` (`codexSocketTransport.ts:267`,
   `src/lib/runtime/hostExit.ts:34-37`): the durable slot
   `<state>/host-exits/<sha256([hostPid, hostStartIdentity, bootEpoch])>.writer.json`
   names the waiter's identity, and `D/host-exit.json` names the matching
   `.exit.json` slot. The registry's structured host row records the same host
   identity and the endpoint `codex-unix:D/rpc.sock`.

The stdio engine path uses the same waiter program through
`spawnNativeWaitOwner` (`nativeWaitOwner.ts:76-194`) with
`D = <state>/host-exit-waits/wait-XXXXXX`, pipes instead of a FIFO, no drain,
and the same `bindHostExitWriter` through `retainExit(true)` (`:131-140`).

### 2.2 Why the Codex child runs outside the service cgroup and the waiter inside

The scope wrapper applies only at the final exec, so the agent's memory and CPU
containment surround the engine and its tools. The waiter is deliberately left
outside that tree: "Wait ownership stays outside that group, so signals leave
its durable writer alive" (`nativeWaitOwner.ts:74-75`) and "Keep that waiter
outside the host's memory tree" (`agentMemory.ts:366-368`). An OOM kill or a
scope stop of the host therefore cannot take the process that writes the host's
exit receipt. The waiter and the drain inherit the cgroup of the process that
spawned them, which is `delegatus.service`.

### 2.3 What a release succession does to them

The serving Viewer runs under the launcher. When a release succession
replaces it, the launcher retires the old Viewer's process group and recorded
helpers (`docs/deploy-checkout.md`, "Whenever a Viewer exits"). The waiter and
the drain lead sessions of their own, so they are outside that group by design;
the reconnecting successor reattaches the host through `D/rpc.sock`
(`CodexSocketTransport.reconnect`). Their parent exits and the user manager
adopts them. They keep running in `delegatus.service` with a live child in an
agent scope, which is exactly the population the operator's preflight listed.

### 2.4 What the preflight fence does, and why it refuses them

`Checkout.fence` (`scripts/deploy-checkout.py:1095-1102`) runs `leftovers`
(`:1058-1093`) over every PID of the service's kernel cgroup subtree
(`members`, `:975-989`). A member passes as a verified launcher ancestor
(`launcher_ancestors`, `:1004-1039`) or when `owner` (`:991-1002`) walks its
parents to the recorded launcher, Viewer or runtime host, or to a live agent
host from the census, each by start identity; an "older release" child of the
serving generation still refuses (`:1041-1056`, `:1071-1072`). The walk only
goes up. A waiter's parent is the user manager, and its host is its **child**,
so the walk reaches no owner; the drain's chain ends at the same user manager.
All six members of each group therefore carry "no current serving or agent
owner" and the procedure stops with `LeftoverProcesses` (`:614-622`). The
groups whose waiter is still a child of the current Viewer pass today through
the "current" owner.

### 2.5 What the switch's stop does to hosts and helpers today

Every agent scope carries `BindsTo=` and `After=` the Viewer's unit
(`agentMemory.ts:89`; rationale in `docs/design/agent-memory-isolation.md`
§3.2: "stopping or restarting the service stops every agent scope first").
`systemctl --user stop delegatus.service` therefore also stops every bound
scope, and because the scopes are ordered `After=` the unit, systemd stops them
**before** the unit itself. `relocate` (`deploy-checkout.py:1330-1384`) waits
for "no job pending and inactive" (`:1348-1351`), so by then every bound host
has ended. Each waiter sees its child exit, writes `native-exit.json` and the
bound exit slot, and exits (`nativeWaitOwner.ts:42-57`); with the waiter and
the host gone the FIFO has no writer, so `dd` reads end of file, the loop
breaks, `cat` ends and the drain exits. `await_release` then sees the old
cgroup empty and released (`:1161-1190`) and the start places the unit in
`delegatus.slice`. Nothing in the product unbinds scopes before a stop
(searched `src`, `bin`, `scripts` for `BindsTo`, `set-property`).

This is the behaviour every recorded checkout switch has had: in the six
switches recorded in the installation's deploy verdicts (2026-10-06 to
2026-10-11), every protected stage came back as `recovered`, `fresh attempt
started` or `completed`, and none as `preserved`. The procedure's protected
stage tracking and the restart-cut obligations
(`docs/design/restart-cut-recognition.md`) exist for that cut.

### 2.6 Observed shape on the installation (read-only)

Read at 02:40–02:45 UTC with Python over `/proc`, the unit's `cgroup.procs`
and `systemctl --user show` (systemd 255):

- The service cgroup held 223 processes, among them 38 waiters: 33 socket-host
  waiters, each with one drain group, and 5 stdio-engine waiters without a
  FIFO. 19 waiters were children of the user manager and 19 of the current
  Viewer; every waiter leads its own session and process group.
- Every waiter had exactly one child, in a `delegatus-agent-*.scope/agent`
  cgroup outside the service cgroup. All 37 scopes still live at the second
  read had `BindsTo=delegatus.service`, `After=delegatus.service`,
  `ActiveState=active` and a `ControlGroup` that prefixes the host's cgroup.
- For all 38 waiters, the writer slot keyed by the child's identity
  (`pid:startTicks`, `linux:<boot id>:pidns:<namespace>`) named exactly that
  waiter's PID and start identity, and `D/host-exit.json` named the matching
  exit slot.
- For all 33 drains, the processes holding the waiter's fd-2 FIFO inode were
  exactly `sh sh dd tee wc`, all in one process group led by the drain `sh`,
  whose FIFO argument lies in the waiter's `D`. The FIFO name itself is
  unlinked, as §2.1 expects.

The operator's evidence for the refusal describes the same shape: 120 members
in 20 groups of six, 0 % CPU over ten seconds and about 58 MiB PSS in total.

### 2.7 Prior work searched

Transcript and memory searches (project-scoped, then unscoped) for the
refusal, wait owners and the service cgroup found: the 2026-10-10/11 work that
introduced the fence and the relocation (`e5cd0ff3`, `36accb1b`, `a5d32489`),
where non-agent helpers got a lifetime bound to their Viewer
(`bin/helper-lease.mjs`); the census rework (`4e8bc62d`,
`docs/verification/protected-host-census.md`); and the seat's launch note for
this lane. None addressed detached helpers whose owner is a child process. No
learned memory covers this.

## 3. Options

### Option A: migrate proven helpers into another cgroup (rejected)

There is no existing correct home for them, so one of these would be needed:

- **The host's own scope.** A scope stop sends SIGTERM to every member at once,
  so the waiter would die with its host and could lose the exit receipt it
  exists to write; the scope's `MemoryMax` would also make it an OOM candidate.
  This reverses the design in §2.2.
- **A new transient unit per group.** `systemd-run` cannot adopt existing PIDs,
  so the procedure would need `StartTransientUnit` over D-Bus with PIDs or
  pidfds, a new unit kind nobody owns, and a decision about its binding: bound
  to the service, systemd would signal the waiter at the stop (receipt loss
  again); unbound, it outlives the service as an orphan unit.
- **Writing `cgroup.procs` directly.** Moving processes between units behind
  systemd's back is outside systemd's delegation contract
  (`delegatus.service` is not `Delegate=yes`), and the drain forks a new
  `dd | tee | wc` trio on every block, so a move needs a loop until the group
  is stable.

Every variant mutates live processes from a procedure whose preflight is
read-only by contract, would happen even if the switch is later refused, and
buys nothing: §2.5 shows the helpers already leave the old cgroup before the
start.

### Option B: count proven helpers as protected custody (chosen)

The preflight proves each group belongs to a live host whose scope the stop
will end, and admits it. The relocation is unchanged: helpers leave by
themselves inside the existing release wait, and the replacement starts in a
clean path under `delegatus.slice`. If one does not leave, nothing is
signalled, the start still runs, and the verdict names the custody survivor.

Option B depends on the binding of §2.5, so the proof checks it per host
(§4.2 W6–W7). A host that the stop would not end (unbound scope, no scope,
host inside the service cgroup) leaves its helpers unproven and the refusal
stands.

## 4. The custody proof

### 4.1 Census additions (`scripts/protected-host-census.ts`)

Each output row's `host` gains, for `state: "alive"` rows:

- `process`: the registry-recorded identity `{pid, startIdentity, bootEpoch}`
  of `host.pid`, taken from the capture owners the census already builds
  (`recorded.identities` for registry owners, the receipt's process evidence
  for receipt owners, `:185-203`). Exactly one distinct identity with that PID
  is emitted; none or several give `null`.
- `exitWriter`: `{process: {pid, startIdentity, bootEpoch}, exitFile}` from a
  new pure reader `readHostExitWriterBinding(process)` exported by
  `src/lib/runtime/hostExit.ts` (existing `slot` and bounded `read`, 4096
  bytes; it validates the identity shape and returns `null` on absence, a
  malformed or oversized slot, or any read error). `null` otherwise.

The census stays read-only and ownerless: `statePath` only joins paths, and the
reader opens one file per live host (at most 200). A `null` field makes that
host's helpers unprovable; it never fails the whole census.

`protected_host_census` (`deploy-checkout.py:55-119`) validates the new fields
when present: `process.pid == host.pid`, non-empty string `startIdentity`,
string or null `bootEpoch`; `exitWriter.process` the same shape with a
positive integer PID; `exitFile` an absolute string. A malformed field refuses
with `census row malformed`. An absent field reads as `null`, so a target
release without this change keeps today's refusal.

### 4.2 Wait owner proof

`leftovers` runs the existing classification unchanged. Only members it would
report go to the custody proof; the proof never reclassifies a member the
existing rules refuse as "older release". Identities use the product format
`pid:startTicks`; the boot epoch is `linux:<boot_id>:pidns:<readlink
/proc/self/ns/pid>`, read once per adapter and injectable in tests. For each
candidate `W`, every step must hold, in this order; the first failure becomes
its refusal reason:

| Step | Check | Reason on failure |
|---|---|---|
| W1 | `W`'s argv has the waiter shape: `-e`, a source argument, `--`, and a final JSON argument whose `command` (or legacy array) starts with an absolute directory `D`. | unchanged generic reason |
| W2 | Exactly one census row's `exitWriter.process` names `W` with `W`'s current start identity and the current boot epoch. | `wait owner: no registry writer record names it` |
| W3 | That row's `host.process` matches `/proc/<host>/stat` now (start identity) and the current boot epoch. | `wait owner: host identity differs from registry` |
| W4 | The host's parent PID is `W`. | `wait owner: host is not its child` |
| W5 | The host's kernel cgroup lies outside the service subtree and ends in `/<unit>.scope` or `/<unit>.scope/agent`. | `wait owner: host not in an agent scope outside the service` |
| W6 | One batched `systemctl --user show <scopes…> -p Id -p BindsTo -p After -p ControlGroup -p ActiveState`: for that scope, `BindsTo` and `After` both list the plan's unit, `ActiveState=active`, and `ControlGroup` equals the host's cgroup up to the scope. | `wait owner: host scope not bound to the unit` |
| W7 | `D` is a real directory (no symlink) owned by this user with no group or other permission bits; `D/host-exit.json` is a regular file of at most 4096 bytes holding `{"file": …}` without `discard`, whose basename equals the basename of `exitWriter.exitFile` and whose directory resolves to `<plan stateDir>/host-exits`. | `wait owner: launch directory does not name the host's exit record` |
| W8 | A second `stat` read of `W` and of the host gives the same start identities. | raises "service cgroup member changed while it was read" (existing path) |

W2 and W4 prove the two directions between owner and host: the durable record
the launching Viewer wrote names this exact waiter for this exact host
identity, and the kernel says the host is this waiter's child. W3 is the
registry identity check the requirement names. W5 and W6 prove the fate of §2.5.
W7 ties the waiter's launch directory to the same exit record, which is also
the receipt the waiter will write.

### 4.3 Drain group proof

Only for an admitted `W` whose fd 2 is a FIFO. `F` is `(st_dev, st_ino)` of
`stat("/proc/W/fd/2")`. A new `proc_field(pid, "fds")` returns
`(fd, st_dev, st_ino, is_fifo)` for each descriptor, refusing a table larger
than 64 entries. The candidates are the remaining unowned service members that
hold `F` on any descriptor.

| Step | Check | Reason on failure |
|---|---|---|
| F1 | Exactly one candidate `L` has `pgid == sid == pid`, and its argv is `[sh, -c, <script>, sh, <fifo>, <sink>, <bytes>]` with basenames `startup.fifo` and `startup.stderr` and both directories equal to `D`. | `stderr drain: no single leader for the owner's FIFO` |
| F2 | Every other candidate has `pgid == sid == L`. | `stderr drain: process group differs from its leader` |
| F3 | Every other candidate's parent is `L`, or a candidate whose parent is `L` and whose argv equals `L`'s (the subshell); at most one such subshell. | `stderr drain: parent link outside the group` |
| F4 | Every non-leader, non-subshell candidate's `argv[0]` base name is `dd`, `tee`, `wc` or `cat`. | `stderr drain: unexpected program` |
| F5 | No candidate holds the FIFO of a second admitted waiter. | `stderr drain: ambiguous FIFO` |
| F6 | A second `stat` read gives the same start identity for every admitted member. | existing moving-member path |

The script text is not compared: the inode, process group, parent links and
directory prove membership whichever release wrote the script. A leader alone
(between two blocks) or a leader with `cat` (after the loop) passes. A process
in the leader's group that does not hold `F` gets no custody and stays a
leftover. A drain whose waiter is gone or unproven gets none either, even
though its host still holds the FIFO: without the waiter the receipt writer is
missing, and that state stays unknown.

The `cwd` of drain members is the release the launching Viewer served from,
so it is often an older release directory. The older-release rule targets
descendants of the serving generation and is not applied to custody members;
their admission rests on the bindings above.

### 4.4 Output and reasons

- A refused candidate keeps the existing line format of `leftover_lines`, with
  the failed link as `reason`. Reasons are fixed strings with no paths or
  arguments.
- Preflight that passes with custody prints one extra standard-output line
  before the existing pass line:
  `Protected helper custody: <n> wait owners and <m> helpers of live agent hosts`.
- In worker mode, a `custody` event in `switch.log` lists `{pid,
  startIdentity, role, hostPid, hostStartIdentity}` for each admitted member
  (private run directory only, as today's leftovers event).

### 4.5 Across the switch

- `generation` (`deploy-checkout.py:1116-1159`) already refreshes the census
  immediately before the stop. It also runs the custody proof over the members
  it does not capture and keeps the result as `helper_custody`
  (`pid → startIdentity, role, host identity`). Custody members are never
  captured and never become retirement roots; a test asserts the two sets are
  disjoint.
- `survivors` (`:1192-1221`) reports a member found in `helper_custody` with
  the same start identity as `proven: false`, reason
  `protected helper custody; host ended` or `…; host alive` (the host's
  identity read once), without calling `proof`. `retire` runs only when every
  survivor is proven (`:1357-1368`), so a lingering custody member keeps the
  existing `unproven-survivors` outcome: no signal, start still submitted,
  placement fails, verdict `fail`, and the verdict names it.
- No new wait or bound: the 30-second release wait already covers the
  milliseconds a waiter needs after its host ends.

## 5. Fences kept

Each of these runs unchanged, in the same order:

1. **Plan and release fences**: checkout and target heads, clean exact build
   with `BUILD_ID`, both isolated rehearsal verdicts for the target, baseline
   pointer equality, launcher record topology, `KillMode=process`,
   `ActiveState=active` and no pending job (`:913-932`).
2. **Baseline readiness**: HTTP, runtime socket, MCP and service checks, with
   placement exempt for the baseline only (`:933-937`).
3. **Protected-host capture completeness**: `complete_activity` (`:685-700`)
   with no unselected, projected, unreadable, pending or undescribed owner,
   transcript evidence only, at most 200 owners, bounded census child
   (`:55-119`).
4. **Service cgroup fence**: whole-subtree read, verified launcher ancestors to
   `MainPID`, parent walk by start identity, older-release refusal, identity
   stability during the read, launcher record unchanged across the inventory
   (`:975-1102`). Custody adds a class only for members this fence leaves
   unowned and only after every link of §4.2–4.3 holds.
5. **Publication fences**: pointer and heads rechecked before the atomic write
   (`:1104-1111`).
6. **Relocation fences**: capture of the serving generation by identity, stop,
   release wait, survivor proof by captured identity, pidfd signal with
   identity and cgroup rechecked (`pidfd_signal`, `:562-582`), no signal at all
   while any survivor is unproven, start always submitted, placement check of
   slice, control group and `cpu.weight` (`:1330-1384`, `:1466-1484`).
7. **Receipt fences**: the procedure and the census read host-exit slots and
   `D/host-exit.json` and write none of them; no waiter is signalled, so each
   writes its own exit receipt; interruption obligations are read as today.
8. **Marker fences**: no change to `D/start.json`, `D/attached`,
   `D/native.json`, the sealed cut-source marker or any registry row.
9. **Host fences**: no live host or helper is signalled by the procedure;
   protected-stage outcomes (`preserved`, `recovered`, `fresh attempt
   started`, `completed`, `lost`, `unknown`) are sampled as today.

## 6. Processes that can still write state after the stop

| Process | What it writes | What proves it ended |
|---|---|---|
| Codex host (agent scope) | transcript, `rpc.sock` | the bound scope's stop job completes before the unit's (`After=`); the protected-stage samples read the outcome |
| Wait owner | `D/native-exit.json`, the bound `<state>/host-exits/*.exit.json`, removal of the writer slot and of `D` | absent from the old cgroup's `cgroup.procs` and the cgroup released (`await_release`) |
| Drain (`sh`, `dd`, `tee`, `wc`, `cat`) | the already-unlinked `startup.stderr` | same kernel cgroup read |
| Launcher, Viewer, runtime host | release records, cut obligations | existing generation capture and release wait |

## 7. Tests

All run through `scripts/gate-slot.sh` with isolated `HOME`, `XDG_CONFIG_HOME`,
`TMPDIR`, `LLV_STATE_DIR` and `LLV_VIEWER_CONTROL_URL` on a closed port, one
file per command. No test reads the live installation, calls systemd or
signals a process it did not start.

### 7.1 `scripts/deploy_checkout_test.py` (run by `scripts/deploy-checkout.test.ts`)

Extend the `CheckoutIntegration` fixture: `process_read` answers a new `fds`
field from a per-PID table; host PIDs live in
`…/delegatus-agents.slice/delegatus-agent-codex-<hex>.scope/agent`; `execute`
answers the batched scope `show`; each waiter gets a temporary `D` with
`host-exit.json`; census rows carry `process` and `exitWriter`; the boot epoch
is injected. A builder `helper_groups(n, busy, parent)` creates `n` groups of
waiter, leader `sh`, subshell `sh`, `dd`, `tee`, `wc`.

Pass:

1. 20 groups of six parented to the user manager, 18 idle and 2 busy hosts
   outside the service cgroup in bound scopes: preflight passes with
   `leftovers_found == []`, prints `20 wait owners and 100 helpers`, writes no
   pointer and issues no service command.
2. Mixed: half the groups parented to the current Viewer, half to the user
   manager: passes; the count covers only custody-admitted members.
3. Drain states: leader only, and leader with `cat`: passes.
4. Switch fate: after that preflight, the fixture's stop ends the hosts and
   the helpers leave within the release wait (`leave_at`): verdict `pass`,
   outcome `released`, placement `placed`, `survivors == []`, `signals == []`.

Refuse (each asserts `LeftoverProcesses`, the named members and reason, an
unchanged pointer, no service command and no signal):

5. Unbound helper: an `sh` holding a FIFO no admitted waiter holds; a waiter
   with `exitWriter: null`; a waiter whose host is absent from the census.
6. PID reuse: the host's `/proc` start identity differs from `host.process`;
   the waiter's differs from `exitWriter.process`; the boot epoch differs.
   The whole group of six is refused.
7. Broken FIFO link: the leader holds another inode, so the leader and its
   four members are refused while the waiter passes.
8. Broken PGID or parent link: one `dd` in another process group; one `wc`
   parented to the user manager; two leaders on one FIFO; an unexpected
   program holding the FIFO.
9. Fate fences: host inside the service cgroup; scope without `BindsTo` or
   without `After`; scope inactive; scope `ControlGroup` not prefixing the
   host's cgroup.
10. Directory binding: `D/host-exit.json` missing, `discard`, naming another
    slot, a symlink, or larger than 4096 bytes; `D` a symlink; the leader's
    FIFO argument outside `D`.
11. A member whose identity changes during the proof refuses through the
    existing moving-member path.

Relocation:

12. A waiter that lingers past the release wait: outcome
    `unproven-survivors`, its reason `protected helper custody; host ended`,
    `signals == []`, start submitted, placement `failed`, verdict `fail`.
13. Custody PIDs and the generation capture are disjoint.

No weakening:

14. The existing `leftover_members` and survivor cases keep their exact
    members, reasons and outcomes. Their members do enter the custody proof
    (it runs on every unowned member), but none has the waiter argv shape or a
    census writer record, so W1 or W2 leaves each one where it is today.
15. Census adapter: malformed `process` or `exitWriter` (PID mismatch, wrong
    types, relative `exitFile`) refuses with `census row malformed`; absent
    fields read as `null` and keep the refusal of case 5.
16. Real `proc_field(pid, "fds")`: a FIFO opened by the test process reports
    the same `(st_dev, st_ino)` as `os.fstat`, and a table above 64 entries
    refuses.

### 7.2 `scripts/protected-host-census.test.ts`

17. A live structured host with a writer slot in the fixture state: its row
    carries `host.process` equal to the registry identity and `exitWriter`
    naming the waiter and the exit slot; the hashes of every state file are
    unchanged after the run.
18. No slot, a malformed slot and an oversized slot each give
    `exitWriter: null` and a complete census.
19. Receipt-owned and headless owners emit their recorded identity or `null`;
    two disagreeing identities for one PID give `null`.

### 7.3 `src/lib/runtime/hostExit.test.ts`

20. `readHostExitWriterBinding` returns the writer identity and exit file after
    `bindHostExitWriter`, `null` for an unbound host, a malformed slot and a
    slot above 4096 bytes, and leaves the slot directory unchanged.

The fixtures reproduce the observed shape of §2.6 with synthetic PIDs and
paths; no evidence value is copied into them.

## 8. Checks the build owes

- The three test files above, branch and merge base, in fresh state roots.
- Full project typecheck (`bunx tsc --noEmit` through the gate wrapper).
- The pre-push touched-tests selection on the committed tree with zero new
  failures against `main`, and the privacy gate with known values.
- `scripts/verify-runtime-host.ts` is not required: nothing under
  `src/runtime-host/**`, `bin/**` or the `Dockerfile` changes, and the
  `hostExit.ts` change only adds a read function no runtime path calls.
- No preflight, deploy or process action against the installation. A
  read-only `/proc` confirmation of the shape is allowed and should be
  reported with its time.

## 9. Files to touch, and what must not change

Touch: `scripts/deploy-checkout.py`, `scripts/deploy_checkout_test.py`,
`scripts/protected-host-census.ts`, `scripts/protected-host-census.test.ts`,
`src/lib/runtime/hostExit.ts` (one exported reader),
`src/lib/runtime/hostExit.test.ts`, `docs/deploy-checkout.md` (the
classification paragraph, relocation step 4 and the output lines).

Must not change: the waiter program and its launch, the drain script, scope
properties, the existing fence rules and reasons, relocation bounds, retirement
and signalling, the census completeness guard, and every file the waiter or
the Viewer writes.

## 10. Deferred — not currently justified

- **Migrating helpers (option A).** Rejected in §3. It would return only if
  hosts had to survive a checkout switch, because then their helpers would
  survive too and pin the old path.
- **Keeping live Codex hosts alive across a checkout switch.** Today the stop
  ends every bound scope (§2.5) and stages continue through recovery. Changing
  that means dropping `BindsTo=` for reconnectable socket hosts, a product
  decision with its own risks (old CLIs serving a new Viewer); the requirement
  does not ask for it.
- **Launching waiter and drain in their own unit outside the service.** This
  would stop new groups from entering `delegatus.service` at all, at the cost
  of one more unit per host launch on every platform path. The existing groups
  would still need this proof, so it is a follow-up at most.
- **Namespace-launcher socket hosts** (signal sandbox), whose outer waiter's
  writer record is discarded (`codexSocketTransport.ts:328-333`). They stay
  refused; none run on the installation.
- **Registry identity for the existing agent owner map.** `preflight` records
  the `/proc` identity of each census PID at read time (`:946-950`); comparing
  it with the new `host.process` would close a PID-reuse window that predates
  this lane.
- **Agents without a scope inside the service cgroup** (the watchdog
  mechanism) pass the fence as agents yet pin the old path at the switch.
  This also predates the lane; their helpers now refuse through W5.
- **A longer wait for lingering custody members before the start.** The
  release wait already covers the expected exit; extending downtime for an
  abnormal waiter is not justified.
- **The release readiness fingerprint off the main loop.** That belongs to the
  separate readiness lane named in the seat's rollout plan.

## 11. Validation against the requirement

| Requirement | Where it holds |
|---|---|
| Waiter and its `sh`, `dd`, `tee`, `wc` attributed to the live host they serve, both directions | §4.2 W2–W4 (owner ↔ host by durable record and kernel parentage, registry identity), §4.3 F1–F4 (helper → owner by FIFO inode, PGID, PPid, launch directory) |
| Unproven stays a `LeftoverProcesses` refusal | §4.2–4.3 reasons; tests 5–11, 14 |
| Defined fate across the switch, slice guarantee kept, nothing signalled | §2.5, §4.5; tests 4, 12, 13 |
| No receipt substitution, marker change or moving of unverified processes | §5 items 7–8; nothing is moved at all |
| Fixture tests: 20×6 pass; unbound, PID reuse, broken FIFO or PGID refuse | §7 tests 1, 5–8 |
| Typecheck, touched tests, privacy gate; no production action | §8 |

## 12. Note for the operator (does not block this lane)

A checkout switch ends every agent scope bound to the service, and today that
is all of them (§2.6: 37 of 37 live hosts). This design keeps that behaviour:
the helpers are safe to admit because their hosts end first. "Do not touch the
live hosts" is read here as "this fix sends no signal to any host or helper and
moves nothing", which holds. If the intent was also that a checkout switch must
leave the live Codex hosts running, that is the deferred item of §10, and it
would bring migration back into scope. The recommendation is to keep the
current behaviour for the next rollout and plan the switch for a moment with
few busy stages.

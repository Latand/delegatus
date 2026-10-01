# One runaway agent process never takes Delegatus down

Design for pipeline `edf33bf1` (architect stage), 2026-10-01, read on `main` at `4c289164e`. In this document GB means GiB (2^30 bytes), which is how systemd reads `MemoryMax=16G`.

## The requirement

The operator, 2026-10-01 20:38, in the orchestrator conversation, verbatim:

> «фікси, похоже що скрйозноий баг.»

("Fix it, looks like a serious bug.") The incident and the outcome, as the pinned specification of this pipeline carries them:

> Incident (2026-10-01): the kernel log at 23:05:34 EEST reads "thermald invoked oom-killer … global_oom, task_memcg=/user.slice/user-1000.slice/user@1000.service/app.slice/delegatus.service, task=bun, pid=494783 … Killed process 494783 (bun) total-vm 249 GB, anon-rss 125 GB, oom_score_adj 200". The machine has ~125 GiB RAM. The runaway was most likely an agent's benchmark child (a search benchmark started at 20:05:19). Every agent's tool processes (tsc, bun test, browsers, benchmarks) live inside the delegatus.service cgroup, together with the Viewer server and the runtime host. systemd then logged "delegatus.service: Failed with result 'oom-kill'": the unit's OOMPolicy is stop, so one kill stopped the whole service and every hosted agent died mid-turn (about 6 stages across projects; stages report "completed without a valid final JSON verdict"). The unit (user service, ExecStart `bun ~/.agents/tools/delegatus/bin/cli.mjs --no-open --port 8898 …`) sets no OOM or memory options of its own; oom_score_adj 200 is inherited. The service restarted by itself 8 s later.
>
> Outcome:
> 1. A runaway agent process dies alone. Each agent's tool processes (or each stage) run in their own cgroup with a memory ceiling, e.g. a transient systemd scope or sub-cgroup with MemoryMax/MemoryHigh, sized from machine RAM and the number of running stages and configurable. When cgroups are unavailable (Docker install, non-systemd), there is a documented fallback (for example prlimit/RLIMIT_AS, or a watchdog on RSS).
> 2. The Viewer server and the runtime host survive an OOM kill anywhere else: lower oom_score_adj for them than for agent processes, and the service no longer stops on one kill (OOMPolicy=continue or equivalent, set where the unit is created or documented for the operator). Check every install path: bin/cli.mjs, any unit writer, the Dockerfile.
> 3. A stage whose process was OOM-killed is reported as "killed: out of memory (limit N GB)". The stage is not reported as "no valid verdict". It is retried once automatically after memory recovers, keeping its worktree.
> 4. The operator sees memory pressure: an attention item when an agent hits its ceiling, naming the stage.
> 5. Tests for 1-3 that do not need root: a fake cgroup/scope runner, an injected OOM exit (SIGKILL with an oom marker), and classification of the stage outcome.

## 1. What runs where today

All of the following was read on the operator's machine on 2026-10-01, read-only.

- **Process tree.**
  - The user manager starts `delegatus.service`, a hand-written user unit at `$HOME/.config/systemd/user/delegatus.service`.
  - That unit runs `bun bin/cli.mjs` (the launcher). The launcher starts two children: the Viewer (`next start`, `LLV_STATE_OWNER=viewer`) and the runtime host (`bun --bun src/runtime-host/main.ts`).
  - The Viewer spawns every agent CLI. Each call uses `detached: true` and goes through one `spawnProcess` option:
    - `claude -p …` at `claudeStreamBrokerHost.ts:793-801`
    - `codex app-server` at `codexAppServerHost.ts:1402-1441`
    - `copilot` at `copilotAcpHost.ts:426-433`
  - The option is chosen in `defaultStartHost` (`structuredSpawn.ts:1681`).
  - Headless runs (flows, the external relay runner, the handoff digest) spawn at `src/lib/agent/headless.ts:383`.
  - The runtime host spawns no agents.
- **What shares the cgroup.** Each agent CLI's MCP servers and tool processes are its descendants. At the time of reading, the service cgroup held 82 processes, all at `oom_score_adj` 200: the launcher, the Viewer, the runtime host, workers, 3 Claude CLIs, 6 Codex app-servers and their MCP servers.
- **Host capabilities.** cgroup v2 is unified. `user@1000.service` has `Delegate=yes` and `DelegateControllers=cpu memory pids`. systemd is 255. `systemd-run`, `prlimit` and `choom` are installed. Lingering is on, and the user bus is at `$XDG_RUNTIME_DIR/bus`. The host env allowlists already pass `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` to agents (`claudeStreamBrokerHost.ts:256`, `codexAppServerHost.ts:269`, `copilotAcpHost.ts:148`).
- **The unit's settings.**
  - `OOMPolicy=stop` and `MemoryMax=infinity`. `memory.oom.group` is 0.
  - `OOMScoreAdjust=200`, which is the user manager's `DefaultOOMScoreAdjust`; the manager itself runs at 100.
  - `KillMode=control-group` and `Restart=on-failure`.
  - Since the 23:05 restart the unit's `memory.peak` has already reached 56 GB.
- **The service journal.**
  - 23:05:33: "A process of this unit has been killed by the OOM killer".
  - 23:05:37: "Failed with result 'oom-kill'".
  - 23:05:42: restart.
  - For about 30 s before the kill the Viewer logged runtime-host RPC timeouts of up to 9.4 s, meaning the machine was already thrashing.
- **Install paths.**
  - The repository writes no systemd unit. `bin/legacySystemd.mjs` only detects the retired `agent-log-viewer*.service` units and prints how to remove them.
  - README and `docs/docker.md` call Docker the only supported install, yet the operator's machine and the stage box run `bin/cli.mjs` under a hand-written user unit.
  - Docker compose (`docker-compose.yml`) runs `privileged` with `pid: host`. Agent CLIs reach the host through nsenter shims (`Dockerfile:89-113`) and stay in the container's cgroup.
- **The launcher's exit.** In `bin/cli.mjs:494-520`, when the Viewer child dies by any signal while the launcher is not stopping, the launcher exits **0**, and `Restart=on-failure` does not restart after exit 0. Today `OOMPolicy=stop` hides this by marking the unit failed first. With `OOMPolicy=continue` and no other change, an OOM kill of the Viewer becomes a permanent outage.
- **How a stage ends today when its host dies.**
  - The host's child `close` handler reduces every death to "Claude child exited" (`claudeStreamBrokerHost.ts:682-691`) and emits `session-status: dead` with no cause.
  - The engine reads the conversation's host as unavailable (`engine.ts:1264`) and waits `DEAD_RUNNING_ATTEMPT_GRACE_MS`, 3 minutes (`engine.ts:1479`).
  - It then reruns a read-only stage up to twice (`engine.ts:3124-3154`). Any other stage fails with `historical attempt completed without a valid final JSON verdict` (`engine.ts:4130-4135`).
  - Nothing records why the host died.

**Prior work.** I ran `search_transcripts` project-scoped and unscoped in five phrasings: OOMPolicy/MemoryMax/systemd-run scope; oom-kill delegatus.service; oom_score_adj; cgroup memory limit agent processes; prlimit RLIMIT watchdog RSS. The only hit was the orchestrator conversation of 2026-10-01, which holds the kernel log the operator pasted and traces the runaway to the #2397 benchmark. No earlier design or implementation of memory isolation exists. This design reuses these precedents:
- #2215: `pendingPermissions` flows from `HostState` to the registry columns, then to `FileEntry`, then to a Needs-you reason.
- #2170: the `launch` reason outlives its host.
- #1678 and #1692: `PipelineBoundedWait` and `nextBoundedWait`, plus a purpose-specific wait kept apart from `controllerWait`.
- `renderDecisionInput`: an attempt's persisted input carries a note.

## 2. The design at a glance

| Outcome | Mechanism |
|---|---|
| 1 | Every agent CLI the Viewer launches runs in its own transient scope `delegatus-agent-*.scope`, with `MemoryMax` set to its ceiling, `MemorySwapMax=0` and `OOMPolicy=continue`. The scopes sit inside `delegatus-agents.slice`, whose `MemoryMax` caps all agents together. Where scopes are unavailable, an RSS watchdog over each agent's process tree enforces the same ceilings. |
| 2 | Agents run at `oom_score_adj = max(500, Viewer's + 300)`. `OOMPolicy=continue` ships as a documented drop-in, and the launcher announces it when missing. The launcher exits non-zero when its Viewer is SIGKILLed or crashes, so the unit restarts it. |
| 3 | The scope's `memory.events` is the evidence, and the host records an out-of-memory death on its registry row. The engine fails the attempt as `killed: out of memory (limit N GB)` without the 3-minute grace. It then retries the stage once in the same worktree after memory recovers, and parks the lane if the retry dies the same way. |
| 4 | A new Needs-you reason, `memory`, names the stage and the limit. A second OOM, or memory that never recovers, parks the lane. |
| 5 | Pure tests with a fake cgroup directory, a fake scope runner and injected SIGKILL exits; engine classification tests; one gated smoke test against a real scope. |

## 3. Outcome 1: each agent runs in its own memory cell

### 3.1 One seam for every launch

Every structured launch passes through `defaultStartHost` (`structuredSpawn.ts:1681`): fresh and resumed, for all three engines. It already hands each host a `spawnProcess` option. It gains a plan and a cell:

```ts
const plan = planAgentMemory({ engine: input.engine, sessionKey, liveAgents: liveStructuredHosts(input.registry) + 1 });
const cell = plan ? new AgentMemoryCell(plan) : null;
// wraps whatever spawnProcess is in effect, so the tests' fakeSpawn captures the wrapped argv
options.spawnProcess = cell ? cell.wrapSpawn(options.spawnProcess ?? defaultSpawn) : options.spawnProcess;
options.memoryCell = cell;
```

Headless runs (`headless.ts:383`) wrap their command through the same `wrapAgentCommand(plan, command, args)`. They get a scope, a ceiling and a raised score, but no observation, because they have no host row and are not stages.

### 3.2 The scope

```
systemd-run --user --scope --quiet --collect --expand-environment=no \
  --unit=delegatus-agent-<engine>-<12 hex>.scope \
  --slice=delegatus-agents.slice \
  --description="Delegatus agent <engine> <session id prefix>" \
  -p MemoryMax=<ceiling bytes> -p MemorySwapMax=0 -p OOMPolicy=continue \
  [-p BindsTo=<Viewer's unit> -p After=<Viewer's unit>] \
  -- /bin/sh -c 'echo <score> >/proc/self/oom_score_adj 2>/dev/null; exec "$@"' delegatus-agent <binary> <args…>
```

- **`--scope`.** systemd-run moves its own PID into the new scope and then executes the command itself. In the words of `man systemd-run`, it is "executed by systemd-run itself as parent process and will thus inherit the execution environment of the caller". The agent keeps:
  - its PID and its parent (the Viewer);
  - its stdio pipes and the process group `detached: true` gave it;
  - its cwd and env.

  Process identity is `pid:starttime` (`src/lib/proc/linux.ts:59`), and `exec` does not change it. So every identity fence, the reaper and the kill route keep working.
- **`--quiet`** keeps "Running scope as unit …" out of the agent's stderr, which the hosts scan for terminal exit signatures (`claudeStreamBrokerHost.ts:670-676`).
- **`--collect`** unloads a scope even if it ends failed, so none pile up in the user manager.
- **`--expand-environment=no`.** The systemd 255 NEWS announces that a later release turns on `${VAR}` expansion for `--scope` by default, and agent arguments carry system prompts. Pass it from systemd 254 on, where it exists.
- **Unit name.** Each launch gets a unique name: sha256 of the session key id plus a random launch nonce, so a resume never collides with a scope still draining. The operator can list them with `systemctl --user list-units 'delegatus-agent-*'`.
- **`MemoryMax`** is the ceiling (§3.4). At the ceiling the kernel reclaims, and when reclaim fails it OOM-kills the process in this scope with the highest badness, which is the runaway.
- **`MemorySwapMax=0`.** Without it, the 15 GiB swap absorbs the runaway first and the whole machine pays in swap I/O before the kill. With it, N GB means N GB of RAM. The trade-off: under machine-wide pressure, agents' idle pages cannot be swapped out. §3.3 keeps agents from causing that pressure.
- **`OOMPolicy=continue`.** A scope's default is `DefaultOOMPolicy=stop`, which would stop the whole scope, agent CLI included, on any kill. With `continue`, only the victim dies, the agent reads exit 137 in its tool result and can adapt. Scopes have supported `OOMPolicy=` since systemd 253 (NEWS; `man systemd.scope` lists it).
- **`BindsTo=`/`After=` the Viewer's unit.**
  - Moving agents out of `delegatus.service` also takes them out of its `KillMode=control-group`. Without a binding, `systemctl --user restart delegatus` would leave the old CLIs running while the new Viewer resumes the same sessions.
  - Binding restores today's behaviour: stopping or restarting the service stops every agent scope first. The installed `TRANSIENT-SETTINGS.md` marks `BindsTo=` and `After=` as supported on transient units.
  - The Viewer's unit is the last segment of `/proc/self/cgroup`, when that segment ends in `.service` and the path runs through `user@<uid>.service`. Otherwise (a terminal run) nothing is bound, which matches today's terminal behaviour: agents end on stdin EOF.
- **`/bin/sh -c 'echo …; exec "$@"'`** sets the score (§4.1) before the agent binary runs, so every tool process inherits it. If the write fails, the `exec` still happens. `sh` is present on every Linux; `choom` is not guaranteed.

Each launch costs one more D-Bus round trip, tens of milliseconds.

### 3.3 The shared slice

`delegatus-agents.slice` gets `MemoryMax = B` (§3.4). The Viewer process sets it once, before its first scope:

```
systemctl --user set-property --runtime delegatus-agents.slice MemoryMax=<B>
```

- It changes only runtime state under `$XDG_RUNTIME_DIR`, so nothing in the operator's `~/.config` moves. The Viewer re-applies it on each start.
- The slice bounds all agents together. When their sum reaches B, the kernel kills inside the slice (the largest agent process) before the Viewer, the runtime host or the operator's own programs feel any pressure. That prevents the machine-wide thrashing seen at 23:05:07–23:05:33.
- If `set-property` fails, the Viewer logs it once and the per-scope ceilings still apply.
- The slice name implies a parent `delegatus.slice`, which carries no limits. Two installs under one user share the slice and its budget.

### 3.4 Ceilings and how they are computed

| Symbol | Meaning |
|---|---|
| T | `MemTotal` (`procBackend.systemMemory().ramTotal`) |
| R | Reserve for the OS, the Viewer, the runtime host and the operator's other programs: `max(4 GB, 15% of T rounded up to whole GB)`. Override: `LLV_AGENT_MEMORY_RESERVE`. |
| B | Agent budget, `max(1 GB, T − R)`. This is the slice's `MemoryMax`. |
| N | Live structured hosts in the registry snapshot (status neither `dead` nor `unhosted`), plus the one being launched. Stages, spawned agents and orchestrator seats all count, because they share B. |
| C | This agent's ceiling: `clamp(floor_to_0.5GB(2B / N), lo = min(4 GB, B), hi = max(B / 2, lo))`. Override: `LLV_AGENT_MEMORY_MAX`, which replaces `2B/N` and is still capped at B. |

- **Why `2B/N`.** Agents rarely peak together, and the slice holds the sum. The factor of 2 gives each agent room for a real build or benchmark, while one runaway still dies at C before it squeezes the others.
- **Why `B/2` as the top.** One agent alone on the machine can never take the whole agent budget.
- **Fixed at launch.** C never shrinks under a running agent, since lowering `memory.max` below current usage kills on the spot. A resume computes a fresh C.

On this machine (T = 125 GB, so R = 19 GB and B = 106 GB):

| N | 1–4 | 5 | 8 | 11 | 14 | 20 | 30 | ≥ 53 |
|---|---|---|---|---|---|---|---|---|
| C (GB) | 53 | 42 | 26.5 | 19 | 15 | 10.5 | 7 | 4 |

On a 16 GB laptop (R = 4 GB, B = 12 GB), C is 6 GB for up to 4 agents and 4 GB from 6 agents on.

**Configuration**, set in `service.env`. The `DELEGATUS_` spelling folds into `LLV_` through `bin/envAlias.mjs`.

| Variable | Values | Default |
|---|---|---|
| `LLV_AGENT_MEMORY` | `auto`, `scope`, `watchdog`, `off` | `auto` |
| `LLV_AGENT_MEMORY_MAX` | size with a binary suffix, e.g. `24G` | the formula |
| `LLV_AGENT_MEMORY_RESERVE` | size, e.g. `24G` | `max(4G, 15%)` |

- `off` removes the wrapper entirely; it is the escape hatch.
- A forced `scope` that cannot start a scope fails the launch with systemd-run's error, because the operator asked for scopes.
- An unparseable value is ignored, with one startup diagnostic.

### 3.5 Picking the mechanism, and the fallbacks

With `auto`, the Viewer decides once per process. It uses **scope** when all of these hold:
1. The platform is Linux, and `/sys/fs/cgroup/cgroup.controllers` exists (cgroup v2).
2. The user manager delegates `memory`: `/sys/fs/cgroup/user.slice/user-<uid>.slice/user@<uid>.service/cgroup.controllers` contains `memory`.
3. `systemd-run --version` reports 253 or later.
4. A probe scope runs `true` with exactly the launch flags and exits 0:

   ```
   systemd-run --user --scope --quiet --collect [--expand-environment=no] \
     --slice=delegatus-agents.slice -p MemoryMax=64M -p MemorySwapMax=0 -p OOMPolicy=continue -- true
   ```

Otherwise it uses **watchdog** on Linux and macOS, and **off** on Windows.

If a launch's systemd-run fails before exec (its child exits during the handshake with systemd-run's "Failed to …" line), the launch fails as a retryable spawn error. The cached decision is then cleared, so the next launch probes again and falls back if scopes are gone.

Which install gets which mechanism:

| Install | Agents run in | Ceiling | Agent vs core score | Can one kill stop everything? |
|---|---|---|---|---|
| systemd user unit running `bin/cli.mjs` (the operator's machine, the stage box) | scopes in `delegatus-agents.slice`, bound to the unit | kernel: per agent, plus the slice | 500 vs 200 (100 with the drop-in) | No. Agents are outside the unit; kills inside it are covered by §4.2 and §4.3. |
| `bin/cli.mjs` in a terminal | scopes. The user manager migrates PIDs from a login session through `AttachProcessesToUnit` (systemd NEWS); nothing is bound. | kernel | 500 vs 0 | There is no unit to stop. |
| Docker compose | the container's cgroup, where the nsenter shims keep them | watchdog | 500 vs 0 | Docker has no OOMPolicy. `restart: unless-stopped` restarts a dead container. |
| macOS | own process tree | watchdog (`ps`) | n/a | n/a |
| Windows | own process tree | off | n/a | n/a |

### 3.6 The watchdog fallback

- **Timer.** One shared, `unref`'d 2-second timer. It starts with the first watchdog cell and stops with the last.
- **Each tick**, for each cell:
  - It sums the RSS of the agent's process tree, rooted at the spawned PID.
  - On Linux it walks `/proc/<pid>/task/<tid>/children`, falling back to `procBackend.ppidMap()` when that file is absent. It reads RSS through `procBackend.processMemory()`.
  - On macOS it runs one `ps -axo pid=,ppid=,rss=` per tick for all cells, parsed with the existing `parsePsMemory` and `descendantPids` (`src/lib/proc/memory.ts`).
- **Per-agent limit.** When a tree's sum exceeds C, the watchdog SIGKILLs the tree's largest process, after checking its start identity from the same tick. It records the kill before sending the signal: limit `agent`, the victim's name, and `fatal` when the victim is the spawned PID.
- **Shared limit.** When the sum across all cells exceeds B, it does the same to the largest process among all cells, with limit `shared`. This is the slice's analogue.
- **Known gaps** (documented):
  - A process can overshoot by one interval of growth.
  - A process that double-forks out of the tree escapes.
  - A kernel OOM kill of an agent is not attributed, so that stage takes today's host-lost path.
  - Swap is not limited.

**RLIMIT_AS is not the fallback (§9).** On this machine the Viewer's `bun` holds 10.7 GB of address space for 0.65 GB RSS, a Claude CLI 5.6 GB for 0.29 GB, and the runaway held 249 GB for 125 GB.

## 4. Outcome 2: the Viewer and the runtime host outlive any kill elsewhere

### 4.1 Score ordering

- **The rule.** Agent score `S = min(1000, max(500, V + 300))`, where V is the Viewer's own `/proc/self/oom_score_adj`. Under the operator's unit V = 200, so S = 500. In Docker V = 0, so S = 500.
- **Why that is enough.** The kernel's badness is roughly a process's share of RAM × 1000 plus its score. An idle agent at 500 therefore ranks above a Viewer at 200 until the Viewer holds about 30% of RAM, about 37 GB here.
- **Why raise agents.** Raising a score needs no privilege. Lowering one below the floor a privileged manager set (100 for this user manager) does. So the ordering comes from raising agents, and the Viewer and runtime host keep their own score.

### 4.2 OOMPolicy on the operator's unit

The documented drop-in:

```ini
# $HOME/.config/systemd/user/delegatus.service.d/oom.conf
[Service]
OOMPolicy=continue
OOMScoreAdjust=100
```

followed by `systemctl --user daemon-reload` and a restart at a quiet moment. 100 is the lowest score the user manager may assign, since it runs at 100 itself.

**Why `continue` still matters once agents have left the service.** The service cgroup still holds the launcher, the Viewer, the runtime host, the workers, the Telegram bridge and self-update builds. It also holds every agent whenever scope mode is unavailable. Under `stop`, a kill of any of those restarts everything. Under `continue`, the launcher restarts only what died: the runtime host through its supervisor (`cli.mjs:657-666`), the Viewer through §4.3.

**The launcher announces a missing drop-in.** At the existing notice site (`cli.mjs:1018`) it checks two things:
- `/proc/self/cgroup` places it in `<name>.service` under `user@<uid>.service`;
- `systemctl --user show -p OOMPolicy --value <name>.service` (2-second bound, best effort) answers `stop` or `kill`.

When both hold, it prints the drop-in once per start, in en and uk. It writes nothing to disk, the same stance as `bin/legacySystemd.mjs`. The unit's `OOMPolicy` cannot be changed at runtime: `systemctl set-property` covers resource-control settings only.

### 4.3 The launcher must exit non-zero when its Viewer is killed

`cli.mjs:515` changes to `process.exit(viewerExitStatus(code, signal))`. The new pure function lives in `bin/server-runtime.mjs`:

| The Viewer ended by | Launcher exit status |
|---|---|
| SIGINT, SIGTERM or SIGHUP (the operator's own stop, or the terminal) | 0, as today |
| any other signal | 128 + the signal number (SIGKILL → 137, SIGSEGV → 139) |
| exit code | that code, or 1 when absent |

An OOM kill or a crash of the Viewer now ends the launcher non-zero, and `Restart=on-failure` brings Delegatus back, which until now only happened by accident through `OOMPolicy=stop`. The runtime host needs no change.

## 5. Outcome 3: an OOM-killed stage says so, and runs once more

### 5.1 Evidence

**Scope mode.**
- The cell resolves the scope's cgroup directory from `/proc/<pid>/cgroup` when it attaches. Attaching happens after the host handshake, by which time systemd-run has moved itself and exec'd.
- The directory's `memory.events` carries two counters, both starting at 0 in a fresh scope:
  - `oom`: this cgroup hit its own limit (hierarchical);
  - `oom_kill`: a process of this cgroup was killed by any OOM killer, whether its own, the slice's or the system's.
- The kernel raises a file-modified event on every change (cgroup v2 documentation). The cell watches the file with `fs.watch`, reads it on each event, and falls back to a 1-second poll when `fs.watch` throws. It reads the file once more when the host child closes.

Each rise in `oom_kill` is one kill, with its limit attributed as follows:

| Condition | Limit | limitBytes |
|---|---|---|
| the scope's `oom` also rose | `agent` | C |
| the slice's `oom` rose since the last read | `shared` | B |
| neither | `system` | T |

**Why the watch is needed.** Once the last process of a scope exits, systemd stops the scope and removes its cgroup, `memory.events` included. When the agent CLI is itself the victim, only its MCP servers and tools keep the directory alive, for milliseconds. A read at child exit alone loses that race. The kernel's notification arrives at kill time.

**Watchdog mode.** The watchdog's own kills, recorded before the signal, are the evidence.

### 5.2 The fatal rule

When the host child closes and the host was not releasing it, the death is **fatal** if the cell recorded a kill at or within 10 s before the close. That covers both cases:
- the agent CLI is the victim and dies by SIGKILL;
- the Codex Node wrapper exits after its native child was killed.

A release (`host.releasing`) is never fatal. Misattribution needs an unrelated crash within 10 s of an OOM kill in the same agent.

### 5.3 From host to registry

- **The new type.**

  ```ts
  type AgentMemoryKill = { at: string; limitBytes: number; limit: "agent" | "shared" | "system"; fatal: boolean; process: string | null };
  type HostMemoryState = { mechanism: "scope" | "watchdog"; limitBytes: number; unit: string | null; kills: number; lastKill: AgentMemoryKill | null };
  ```

- **`HostState.memory?`** (`engineHost.ts:104`). Each of the three hosts:
  - includes `memory: cell.snapshot()` in its state;
  - subscribes `cell.onChange(() => notifyStateListeners())`;
  - calls `cell.settleExit({ expected: releasing })` in its child `close` handler, before `fail(...)`, at `claudeStreamBrokerHost.ts:682`, `codexAppServerHost.ts:1376` and `copilotAcpHost.ts:373`.
- **`sameMaterialHostState`** treats a change in `memory.kills` as material, so a kill persists at once and is not debounced.
- **`StructuredHostColumns.memory?`** (`src/lib/agent/registry.ts:115`) is filled by `claudeHostColumns`, `codexHostColumns` and the Copilot equivalent (`src/lib/runtime/registry.ts:51-79`). `normalizeStructuredHost` (`agent/registry.ts:1996`) keeps well-formed values and drops anything else. Like #2215's `providerRetry`, this is JSON inside the existing row and needs no schema migration.
- **Runtime host verification.** The runtime host loads `@/lib/agent/registry` (`src/runtime-host/main.ts:17`), so this change requires `verify-runtime-host`.

### 5.4 Classification in the engine

- **New port.** `conversationOutOfMemory(conversationId)` returns the latest generation's `structuredHost.memory.lastKill` when the entry is `dead` or `unhosted` and the kill is `fatal`. The caller also requires `lastKill.at >= attempt.startedAt`. Production implements it beside `conversationHostUnavailableSince` (`engine.ts:1264`).
- **In the running-attempt reconcile** (`engine.ts:4005-4024`), the engine computes `oomDeath` after `unavailableAt`. An OOM death makes `hostUnavailablePastGrace` true at once: the 3-minute grace exists for an unavailable host whose cause is unknown, and this cause is known and terminal. The deploy-cut hold still takes precedence.
- **Positive evidence still wins.** Every settlement from durable evidence above the host-lost block (a terminal verdict, a `stage_report`, a usage limit) runs first, unchanged.
- **In the host-lost block** (`engine.ts:4108-4135`), once `stopStageAgent` has resolved, `if (oomDeath) { retryOutOfMemoryStage(...); return; }` runs ahead of `rerunHostLostReadOnlyStage` and the `HISTORICAL_MISSING_STAGE_VERDICT` failure.
- **The recorded text.**
  - `attempt.error` becomes `killed: out of memory (limit 15 GB)`.
  - For a `system` kill it reads `killed: out of memory (system memory exhausted, 125 GB RAM)`.
  - N shows one decimal below 10 (`4.5`) and a whole number from 10 up.
  - `attempt.outOfMemory = { at, limitBytes, limit }` is the record.
  - Neither "no valid final JSON verdict" text is ever written for such an attempt.

### 5.5 The retry rule

- **Once.** If the attempt immediately before this one in the same stage also carries `outOfMemory`, the engine calls `park(pipeline, "<error>; the automatic retry was killed the same way", attempt)` and the lane goes to `needs_decision`.
- **Otherwise it retries.**
  - The pipeline goes to `running`, with `stateDetail` = `<error>; retrying once memory recovers`. The cursor goes to `pending`.
  - `newAttempt` creates the retry.
  - `retry.input = renderOutOfMemoryRetryInput(attempt.input, attempt.n, oom)` (`prompts.ts`, beside `renderDecisionInput`) appends: "The previous attempt of this stage (attempt N) was killed: out of memory (limit 15 GB). Its changes are still in this worktree; continue from them. Keep memory-heavy commands (benchmarks, browsers, large test runs) within the limit: smaller inputs, or one at a time."
  - `retry.memoryWait = { startedAt: now, rounds: 0, retryAfter: now + 60 s, budgetMs: 30 min, retryMaxMs: 5 min }`. It is a new `PipelineBoundedWait` field kept apart from `controllerWait`, as `remoteHeadWait` is.
- **When memory counts as recovered.** At activation (`engine.ts:3786`), once `retryAfter` has passed, memory has recovered when headroom ≥ min(the killed attempt's `limitBytes`, the ceiling the retry would get now).

  | Mode | Headroom |
  |---|---|
  | scope | min(B − the slice's `memory.current`, `MemAvailable`) |
  | watchdog | `MemAvailable` − R |
  | unknown | counts as recovered |

  - While memory is short, the engine calls `nextBoundedWait` (base 60 s, cap 5 min, budget 30 min) and sets `stateDetail` to `<error>; waiting for memory: X of Y GB free`.
  - When the budget runs out, it parks with `<error>; memory did not recover within 30 minutes`.
  - `stageActivationIsWaiting` (`engine.ts:5561`) also reads `memoryWait.retryAfter`, so the controller does not spin (#1191).
- **The worktree is kept.** Nothing reprovisions or resets it; the retry runs in the worktree the killed attempt used, and its input says so.
- **Read-only stages** follow the same rule. Their OOM attempts do not count toward `HOST_LOST_READ_ONLY_RERUNS`.

### 5.6 What the dead agent left behind

On a fatal exit the cell kills what remains of its agent:
- in scope mode, `systemctl --user kill --signal=SIGKILL <unit>`;
- in watchdog mode, the PIDs from its last sample, each checked against its start identity.

**Why.** The retry runs in the same worktree. A surviving test runner or benchmark from the dead attempt would race it, and its memory would keep the headroom check from passing. Today's `stopStageAgent` cannot do this: once the group leader is dead it treats the target as gone and signals nothing (`structuredSpawn.ts:343-347`).

## 6. Outcome 4: the operator sees it

- **Projection.** `FileEntry.memoryKill?: { at, limitBytes, limit, fatal }` (`src/lib/types.ts`) is projected in `src/app/api/files/response.ts:445-455`, beside #2215's `pendingPermission`. It comes from `registryEntry.structuredHost.memory.lastKill` for the latest generation, alive or dead, unless the conversation is superseded.
- **The reason.** `undismissedReason` (`src/components/attention.ts`) gains a `memory` reason after `launch` and before `ask`, live for 24 hours after the kill:

  ```ts
  { kind: "memory", id: `${path}:memory:${at}`, since: at, raisedAt: at, clocked: true, header, dismissal: null }
  ```

- **Naming the stage.** `header` is the stage id from `file.durableLineage.memberships` (the `pipeline` membership's `stageId`), falling back to the role, followed by the limit.
- **Labels.** They go in `decision.ts` and the shared `needLabel`. The meaning: en "Out of memory · limit 15 GB"; uk "Нестача пам'яті · ліміт 15 ГБ". A fatal kill reads as "killed"; a tool-only kill reads as "a process was killed". Final wording goes through the UI critique.
- **Validation.** `ConversationReasonKind` (`src/lib/attention/dismissalTypes.ts:19`) and `REASON_KINDS` (`src/lib/attention/dismissals.ts:86`) gain `memory`. `src/lib/mcp/bindings.ts` enumerates no kinds, so the #2406 fence is untouched.
- **Dismissal and push.**
  - The existing one-click Dismiss and the MCP `dismiss_attention` cover the reason by its id, and a new kill brings it back with a new id.
  - Push already keys on `attentionId` (`src/lib/push.ts:192`), so the phone is notified too.
- **On the lane.** A stage that dies shows the retry wait in its `stateDetail`. A second OOM, or memory that never recovers, parks the lane, and the existing lane-decision reason names the stage.

## 7. Outcome 5: tests, and the checks to run

None of the tests below needs root.

- **`src/lib/runtime/agentMemory.test.ts` (new).**
  - Ceilings: the §3.4 table, a 16 GB host, each env override, invalid values.
  - Argv: per mode and systemd version (253 vs 254); parsing the Viewer's unit from `/proc/self/cgroup`; the score rule.
  - Probe decisions through a fake runner: exit 0, exit 1, ENOENT, `memory` not delegated.
  - A cell over a fake cgroup directory under a temp dir, with a fake watch:
    - writing `oom_kill 1` records a kill;
    - `agent`, `shared` and `system` attribution;
    - an injected SIGKILL exit within the window is fatal;
    - an expected (release) exit is never fatal;
    - an exit with no kill is not fatal;
    - the exit-time read catches a counter the watch missed;
    - when the cgroup directory is already gone, the last recorded kill decides;
    - a fatal exit reaps the unit through the fake runner.
  - The watchdog over a fake process tree: an agent over its limit loses its largest PID; a root victim is fatal; the shared-budget kill; the identity-fenced reap.
- **Host tests.** In `claudeStreamBrokerHost.test.ts`, `codexAppServerHost.test.ts` and `copilotAcpHost.test.ts`:
  - `fakeSpawn` (`claudeStreamBrokerHost.test.ts:153`, `codexAppServerHost.test.ts:489`) captures the wrapped argv;
  - `FakeClaude`/`FakeAppServer` emits `close` with `SIGKILL` after the fake cgroup records `oom_kill`, and the host state reads dead with `memory.lastKill.fatal`;
  - a close during release is not classified.
- **`src/lib/runtime/registryPersistence.test.ts`.** Memory columns persist on a terminal dead state and normalize from stored rows; malformed shapes are dropped.
- **`src/lib/pipelines/engine.test.ts`.**
  - An OOM death fails the attempt with `killed: out of memory (limit 15 GB)` without the 3-minute grace, and never with either missing-verdict text.
  - The retry waits while headroom is short, launches once it recovers, in the same worktree (no reprovision call) with the note in its input.
  - A second consecutive OOM parks.
  - A verdict settled before the kill stays settled.
  - A read-only stage takes the OOM rule and spends no host-lost rerun.
  - Memory that never recovers parks after the budget.
- **Attention tests.** `src/components/attention.test.ts` covers the `memory` reason's id, precedence, 24-hour bound, dismissal and its return on a new kill. `src/components/attention/decision.test.ts` covers the en and uk labels.
- **Launcher tests.** `bin/server-runtime.test.ts` covers the `viewerExitStatus` table; `bin/oomPolicy.test.ts` (new) covers the notice and the unit parsing.
- **Gated smoke test against a real scope**, `src/lib/runtime/agentMemory.scope.test.ts`, run with `LLV_AGENT_MEMORY_SCOPE_TEST=1`:
  - It uses a private slice, `delegatus-agents-test-<pid>.slice`, sets its `MemoryMax` through `set-property --runtime` and reads it back from `memory.max`.
  - It runs `bun -e` allocating 256 MB under the production wrapper with `MemoryMax=64M`.
  - It asserts that the spawned PID's `/proc/<pid>/exe` is `bun` after exec (PID preserved), that the cell records an `agent` kill, that the root victim is classified fatal, and that the unit is gone afterwards.
  - It never touches `delegatus-agents.slice` or the live service. This is what proves inotify on cgroupfs under Bun, and it would catch a future systemd that forks in scope mode.
- **Rendered evidence** through the existing drivers, with no new driver:
  - a `describe` case in `src/components/kanban/kanbanBoard.browser.test.tsx` (desktop);
  - one in `src/components/mobile/issue1671Evidence.browser.test.tsx` (390 px);
  - both in en and uk, followed by screenshots and a critique (the operator's standing rule for UI changes).

**Checks.**
- Each touched test file by path, each with its own `LLV_STATE_DIR`. Never a sweep of `src/lib/agent/` or `src/app/api/runtime/`.
- `bunx tsc --noEmit`, and eslint on the changed files.
- `bun scripts/privacy-publication-gate.ts --base <merge-base> --check-commits`.
- `bun scripts/verify-runtime-host.ts --runtime "$(command -v bun)"`.
- Heavy gates under `flock /var/tmp/llv-heavy-gate.lock`.

## 8. Files to change

| File | Change |
|---|---|
| `src/lib/runtime/agentMemory.ts` (new) | config, ceilings, probe, `wrapAgentCommand`, `AgentMemoryCell` (watch, `settleExit`, reap), watchdog, headroom |
| `src/lib/runtime/structuredSpawn.ts` | plan and wrap in `defaultStartHost`; count live hosts |
| `src/lib/runtime/engineHost.ts` | `HostState.memory` |
| `src/lib/runtime/claudeStreamBrokerHost.ts`, `codexAppServerHost.ts`, `copilotAcpHost.ts` | `memoryCell` option, memory in state, `settleExit` in `close`, close the cell on release |
| `src/lib/runtime/registry.ts` | memory in host columns; `sameMaterialHostState` |
| `src/lib/agent/registry.ts` | `StructuredHostColumns.memory`, normalization (runtime host bundle) |
| `src/lib/agent/headless.ts` | wrap the command (one call site; check #2400 first) |
| `src/lib/pipelines/types.ts` | `attempt.outOfMemory`, `attempt.memoryWait` |
| `src/lib/pipelines/engine.ts` | ports, OOM branch, `retryOutOfMemoryStage`, memory wait at activation, `stageActivationIsWaiting`, constants beside `engine.ts:1479-1490` |
| `src/lib/pipelines/prompts.ts` | `renderOutOfMemoryRetryInput` |
| `src/lib/types.ts`, `src/app/api/files/response.ts` | `FileEntry.memoryKill` and its projection |
| `src/components/attention.ts`, `src/components/attention/decision.ts`, `src/lib/attention/dismissalTypes.ts`, `src/lib/attention/dismissals.ts`, `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts` | the `memory` reason and its labels |
| `bin/server-runtime.mjs`, `bin/cli.mjs`, `bin/oomPolicy.mjs` (new) | exit status; OOMPolicy notice |
| `README.md` (Configuration → Environment variables, plus a short "Agent memory" part with the drop-in), `docs/docker.md` (Docker uses the watchdog), `docs/pipelines.md` (the OOM retry rule), `docs/design/agent-memory-isolation.md` | documentation |

Fences respected: no change to `src/lib/mcp/server.ts`, `src/lib/mcp/bindings.ts`, `src/lib/pipelines/git.ts`, state leases, the seat tick, `src/lib/search/*`, `landing/`, the relay code or `scripts/privacy-*`. Delivery: one pull request in three commits, in this order: cells and the core; classification and retry; the Needs-you reason with its rendered evidence. The last commit needs a ui-check stage.

## 9. Rejected alternatives

1. **`prlimit`/RLIMIT_AS, as the ceiling or as the fallback.**
   - It caps address space, which JS runtimes and browsers reserve far beyond what they use: on this machine 10.7 GB for a 0.65 GB Viewer, 249 GB for the 125 GB runaway.
   - A low cap breaks Bun, Node and Chrome at start; a high one caps nothing.
   - It applies per process, so a tree is unbounded.
   - It fails as an allocation error, so there is no kill to recognize.
2. **`Delegate=yes` on `delegatus.service`, with Delegatus writing its own sub-cgroups.** Nothing works until the operator edits the unit. The Viewer itself must first move into a leaf (cgroup v2's no-internal-processes rule). It re-implements what `systemd-run --scope` does, and terminal runs get nothing.
3. **A transient service per agent (`systemd-run --user` without `--scope`).** The agent would become a child of the user manager, so the Viewer would lose its stdio pipes and its PID fences, and the host transport would need rewriting.
4. **`OOMPolicy=stop` or `kill` on agent scopes.** Every tool OOM would end the agent with it, which contradicts "dies alone" and takes away the agent's chance to adapt.
5. **`MemoryHigh`.** Without swap headroom, a runaway above `MemoryHigh` is throttled to a crawl and the stage hangs silently for a long time. A hard `MemoryMax` gives a prompt, attributable kill.
6. **systemd-oomd (`ManagedOOMMemoryPressure=`).** It depends on host configuration that differs per distribution, it kills whole cgroups on pressure, and its kills are harder to attribute.
7. **A separate store for OOM deaths.** It would give the registry row a second writer outside the host's writer claim. The `HostState` path that #2215 established keeps one writer.
8. **Resuming the killed conversation as the retry.** It reloads the context that may itself be what blew up. It also needs engine-specific resume and continuation delivery. A fresh attempt in the same worktree, carrying a note, uses the engine's existing retry primitive.
9. **Equal shares, `B/N`.** With 14 agents that gives 7.5 GB each, too small for a real build or benchmark, while the slice already bounds the sum.
10. **Lowering the core's score in code.** Going below 100 needs `CAP_SYS_RESOURCE`. Raising agents produces the same ordering with no privilege on every install.

## 10. Deferred — not currently justified

- Stopping an agent's scope on every release, to clean up the background processes it leaves. This design reaps only after a fatal OOM, which the retry needs.
- Naming the victim process in scope mode. That needs the kernel log, which this account cannot read.
- A settings page for the memory variables. Environment variables are enough for "configurable".
- A lifecycle-journal event `agent_out_of_memory`, and a seat-tick wake item (the seat tick is fenced by #2410).
- Scopes in the Docker install through the host's user manager via the nsenter shims. Whether the system manager admits migrating a process from a docker scope is unverified.
- A Windows watchdog; legacy tmux pane agents; OOM retry for reviewer rounds of review-loop stages, which keep their flow machinery.
- Early warning from `memory.pressure` (PSI) before an agent reaches its ceiling.
- Resizing the ceilings of running agents as N changes.
- Telling agents their ceiling through an environment variable, which would need entries in three host env allowlists.

## 11. Checked against the requirement

- **«фікси»: one runaway can no longer take Delegatus down.**
  - In scope mode the runaway dies at its ceiling, inside its own scope, outside the service.
  - The slice keeps all agents together from pressing on the core.
  - In every mode, agents rank first for the kernel's own OOM killer.
  - A kill inside the service no longer stops it once the drop-in is in, and the Viewer comes back on its own after §4.3.
- **Outcome 1.** Per-agent cgroups with `MemoryMax`, sized from RAM and live hosts, configurable. The fallback is a watchdog on RSS, documented, with its gaps.
- **Outcome 2.** The score ordering holds on every install. `OOMPolicy=continue` is documented and announced. All install paths are covered: `bin/cli.mjs`, no unit writer exists in the repository, and the Dockerfile and compose path are in §3.5.
- **Outcome 3.** The exact text "killed: out of memory (limit N GB)". Never "no valid verdict". One automatic retry after memory recovers, in the same worktree.
- **Outcome 4.** An attention item naming the stage and the limit.
- **Outcome 5.** Fake runner, fake cgroup, injected SIGKILL and engine classification tests, none needing root.

## Notes

- **The unit's 9.3G summary.** systemd's "9.3G memory peak" line for the unit cannot be squared with the kernel's 125 GB anon-rss charged to the same memcg. The kernel log was not readable from this account. The design reads each scope's own `memory.events` and never that summary.
- **Agents that run `systemd-run --user --scope` themselves** (as agents were told to do for benchmarks on 2026-10-01) leave their agent's scope and the slice's budget for a sibling scope under the user manager. Their own `MemoryMax` then applies.
- **systemd's exec-in-place behaviour in scope mode** is pinned by the gated smoke test, so a future systemd that forks in scope mode is caught before release.
> Outcome: first a design grounded in current spawn policy (structured hosts, withAgentConfigSandbox, systemd scopes/cgroups, PID namespaces, seccomp or a signal broker — pick from measurement on this kernel and Bun, without sudo), then an implementation where an agent's kill/pkill/fuser/killall against a process outside its own tree fails, while recorded-PID cleanup of its own children still works and nothing the operator runs is affected. Real tests: an agent-side kill of a foreign process is refused; own children still stoppable; Codex and Claude both covered. If the only viable mechanism needs privileges the service lacks, stop and say so with options (needs_decision).

Source: operator's pinned requirement, 2026-10-15, “Agents can only signal their own processes: second-layer OS signal sandbox,” continuing issue #1794. This stage delivers the design and feasibility experiments; implementation follows separately.

# Agent signal sandbox

## Decision

Use one unprivileged **user, PID and mount namespace per managed agent invocation**, assembled with Bubblewrap. Give it a private `/proc`, a working private `/dev`, the original unprivileged UID/GID, no capabilities and `no_new_privs`. Keep the existing launch hooks. Enforce the namespace before either native engine can execute a tool.

The mechanism works on the measured machine without privilege escalation or a kernel change. It denied a direct signal to a harmless external fixture and allowed recorded-PID cleanup of ordinary and detached children. Bun 1.4.0 runs with the complete mount profile. A delegated cgroup also worked inside the namespace, with enforced CPU and memory settings.

**The implementation includes adapting the heavy-command gate.** Today's gate starts a systemd service outside its caller's namespace. Simply wrapping the native CLI would break this gate or leave its work outside the signal boundary. Preserve admission, deadlines and kernel resource limits while making gate workers children of the sandboxed invocation.

This is a reversible launch-policy change, so a separate ADR is unnecessary. The design is ready for implementation; successful primitive probes do not constitute engine integration tests.

## Requirement, prior work and scope

Issue #1794, opened 2026-09-19, names two layers. Its second layer says:

> A sandbox that denies signalling outside the stage's own process group.

The current requirement says “own tree.” Use a namespace established at invocation birth as the ownership domain: its native engine, tools, MCP subprocesses and descendants remain members across `setsid`, process-group changes, reparenting and further nested namespaces. Separately launched stages and sibling agents have separate domains. Native subagents created by one CLI belong to that CLI's domain. A mutable process-group number cannot express this ownership safely.

PR #2729 merged on 2026-10-11 at `20a2d09641ee9ff54cf2deab0ce18836f92b597b`. It injects the cleanup policy into Claude's tool hook and Codex's native hook, covers fresh/resumed and headless launches, and explicitly excludes the OS layer. Its string classification remains useful feedback; raw syscalls can bypass that layer today.

Project-scoped and cross-project transcript/memory searches covered “1794 signal sandbox,” “PID namespace seccomp,” “signal sandbox,” “kill pkill sandbox” and “process cleanup.” Opened prior discussions confirmed the September finding that scaffold prose provides no technical enforcement, and the October PR author's explicit separation of the OS work. No completed agent signal sandbox was found. The existing resource collector does use namespaces; its code was checked before reusing the idea. Its host-process observation profile must not be copied unchanged into an agent.

The guarantee is kernel signal confinement for managed local execution. `kill`, `tgkill`, queued signals, process-group signalling and pidfd signalling must not reach a process in an ancestor or sibling domain. A host PID supplied inside a namespace is interpreted in that namespace; a numerical collision can only designate a local process. Process-list utilities see the private `/proc`.

This is not a complete hostile-code isolation policy. Existing filesystem permissions, credentials, network access and explicitly authorized external control services retain their authority. Asking a remote service to perform an operation is a separate authorization boundary. In particular, do not introduce a generic host-command escape for gates. The normal gate execution path is part of this design and must remain confined. The Viewer, runtime host, shared tmux server, operator shells and manually launched agents receive no new restrictions.

## Source baseline and spawn map

The checkout was inspected at `77fc690eac3880cce9507d365d47e5bc0e152354`. Remote main advanced to `0ce86fd1a182be224828562ae4650da295e235b8` during research. Its only intervening commit was #2906. The relevant changes in `structuredSpawn.ts` and `structuredRecovery.ts` were read: recovery now transfers admission to the successor writer claim. They leave the engine exec boundaries below intact. Preserve that claim transfer. Line anchors below refer to the inspected checkout; use the named functions when applying this design to the later main.

| Surface | Current launch and policy | Required insertion |
| --- | --- | --- |
| Routing | `src/lib/agent/spawnCommand.ts`, `executeSpawnRequest`; `src/lib/runtime/spawnTransport.ts:16`: structured transport is the normal enabled-host path, with explicit transport selection and a legacy tmux path. | One shared signal-domain contract across transports. |
| Structured dispatch | `src/lib/runtime/structuredSpawn.ts:1840`, `structuredHostCell` / `defaultStartHost`; `spawnStructuredConversation` at 2348: account, repository sandbox, workload memberships, resource plan and registry claim precede host start/adoption. | Allocate the domain for a fresh native process after admission and before execution; adoption verifies its recorded domain. |
| Codex | `src/lib/runtime/codexAppServerHost.ts:500` builds the sandboxed environment; 1450 chooses the resource wrapper; 1474 builds `codex app-server` plus hooks; 1508 spawns detached with protocol pipes. `HostState.pid` is populated near 2988. | Wrap the native app-server process and all tools it creates. Keep the protocol pipes clean and retain the actual engine's host PID separately from wrapper PIDs. |
| Claude | `src/lib/runtime/claudeStreamBrokerHost.ts:456` builds the environment; 816 builds stream-json, session/resume and hook/MCP settings; 921 applies the resource wrapper and starts the detached CLI. Ownership/state is recorded near 1256 and 1277. | Wrap the stream broker's native CLI. Its fixed authentication probe at 497 does not execute model-supplied tools. |
| Other structured engine | `src/lib/runtime/copilotAcpHost.ts:172,438` has the same environment/resource-wrapper pattern. | Use the shared primitive here too, with synthetic launch coverage. Avoid a raw-spawn hole in the shared contract. Paid/native Copilot qualification is outside this task. |
| Headless | `src/lib/agent/headless.ts:71,320,409`: reviewer environment, per-engine command/hooks, detached resource-wrapped launch with file-backed input/output. Flows call this through `src/lib/flows/exec.ts:58`. | Cover both engines' one-shot review/flow/relay callers. Preserve survival across Viewer restarts. This environment builder currently differs from `withAgentConfigSandbox`; signal enforcement cannot depend on that helper being used. |
| tmux | `src/lib/agent/cli.ts:346,555` produces fresh/resume commands; `src/lib/tmux.ts:1293` creates a pane, places its shell in a scope, then types the command; scope placement is at 1489. | Wrap the engine command inside the pane. Leave the operator's tmux server and interactive shell outside. An already running unsandboxed CLI cannot be retrofitted by changing a resume string. |
| Docker-to-host CLI | `Dockerfile:76` installs the host namespace shims; `docs/docker.md` describes their host PID arrangement. The shim enters the host and drops to the operator UID before executing the host binary. | Apply the sandbox after that transition and UID drop. Applying `no_new_privs` before a setuid shim prevents the shim from working. The launch adapter and Bubblewrap must be available on the host side. First-party in-image services still use `bun-container`. |

`src/lib/runtime/agentConfigSandbox.ts:84` redirects agent config/state under a temporary per-account root, strips owner declarations and preserves intended account/transcript/GitHub/MCP access. It prevents accidental use of live state by repository commands. It installs no kernel signal policy. Repository read-only/restricted/full tool profiles in `structuredSpawn.ts:138` are also independent; every profile needs the signal boundary.

`src/lib/runtime/cpuPlacement.ts:25,230` assigns operator/work slices and wraps commands with `systemd-run --user --scope`. Work defaults include weight 100 and a 300% per-scope quota; the aggregate work slice uses 75% of online CPUs. `agentMemory.ts:59,292` adds memory limits/OOM policy and owns its unit cleanup. Resource placement can be absent or use a fallback mode. Signal isolation must remain active in those modes.

Existing ownership is stronger than a bare PID: `processIdentity.ts` carries start identity and boot epoch. `runtime/registry.ts:55` explicitly maps host fields, and `agent/registry.ts:2132`, `normalizeStructuredHost`, explicitly selects fields. Adding metadata only to a TypeScript type would lose it on normalization. `resources.ts:495` also identifies engines from process records/argv; wrapper PIDs must not be mistaken for native engines.

`resources.ts:769,1460` already creates an owned user/PID namespace for collection. It deliberately retains host `/proc` visibility and maps its user to root. Agent execution instead needs a private normal `/proc` and the original non-root UID. Reuse the identity/ownership lessons, with a separate launch profile.

## Measured feasibility

Measurements were taken on 2026-10-15 as the service's unprivileged user. No sudo, pkexec, sysctl changes, service restarts or live-registry tests were used. Probe programs and results were placed in the stage's scratch directory. Each command ran through the prescribed installed `gate-slot.sh` with isolated `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`. Queue time was excluded from process timing.

| Property | Observation |
| --- | --- |
| Kernel / architecture | Linux 6.8.0-139-generic, x86_64 |
| Runtime / tools | Bun 1.4.0; systemd 255; Bubblewrap 0.9.0; util-linux `script` 2.39.3; `unshare`, `nsenter`, `setpriv`, Python and C compiler available |
| Initial process restrictions | Non-root, effective capabilities zero, `NoNewPrivs=0`, `Seccomp=0`; AppArmor label `unconfined` |
| User namespaces | `kernel.unprivileged_userns_clone=1`; AppArmor unprivileged-userns restriction 0; namespace allowance 513821 |
| Installed wrappers | Host `bwrap`, `unshare` and `nsenter` were ordinary mode-755 executables, without setuid |
| Landlock | Reported ABI 4; signal-scoping rules require ABI 6 |

### Results, including failed candidates

| Experiment | Observed result | Consequence |
| --- | --- | --- |
| Same-user foreign fixture, outside any new namespace | Signal 0 succeeded. The fixture was created and owned by the harness. | Positive control: Unix UID checks alone allow access. |
| PID namespace alone | `unshare --pid --fork` failed with EPERM. | User namespace setup is required for this unprivileged service. |
| User + mount + PID namespaces, current-user mapping and fresh `/proc` | Foreign `kill` and `tgkill` returned ESRCH (3); foreign `pidfd_open` returned ESRCH. Own sleep child terminated with SIGTERM. | Direct kernel signal isolation works. |
| Same profile under Bun | Foreign `process.kill` returned ESRCH; Bun's own spawned child exited on SIGTERM. | The primitive works with the pinned runtime's process API. |
| Negative process-group signal, detached own child | Foreign group returned ESRCH; `setsid` child remained stoppable by its recorded PID. | Ownership survives a session/group change. |
| Foreign pidfd inherited into the PID namespace | `pidfd_send_signal` returned EINVAL (22). | An already opened foreign pidfd did not bypass the namespace. |
| Inherited ancestor PID namespace descriptor | `setns` failed with EPERM. | The unprivileged child could not re-enter the ancestor namespace. |
| Existing-style user systemd scope | Foreign process remained reachable with signal 0. | Scopes/cgroups alone do not filter signals. |
| Nested `systemd-run --user --scope` | Exit 1, “Failed to connect to bus: No data available,” under both namespace wrappers. | The current gate cannot be assumed to work inside this boundary. |
| Unprivileged seccomp | `no_new_privs` plus a filter succeeded; a USER_NOTIF listener FD was created. A fixed `kill`-errno filter denied both own and foreign kills with EPERM. | Installation works; static filtering cannot implement the ownership predicate. This probe filtered only `kill`. |
| Landlock signal-scope attribute | ABI query returned 4; a ruleset carrying `scoped` returned E2BIG (7). | Current kernel cannot enforce Landlock signal scope. |
| Bubblewrap with private `/proc` | Python foreign signal failed with ESRCH; own cleanup succeeded; capabilities zero and `NoNewPrivs=1`. | Suitable packaged namespace/reaper primitive. |
| Bubblewrap without `--dev /dev` | Bun startup aborted with exit 134 in all five trials. | A bind-root-only profile is unusable here. |
| Bubblewrap with `--dev /dev` | Bun startup succeeded in all five trials. | Private device setup is part of the required profile. |
| Final Bun signal proof with the complete Bubblewrap profile | Bun stopped its ordinary and `setsid` children by recorded PID; foreign `process.kill` returned ESRCH and the foreign fixture survived. | The selected wrapper/runtime combination passes both sides of the signal contract. |
| Own transient scope with `Delegate=yes` | Enabled cpu/memory/pids controllers; created a child leaf; read back 64 MiB `memory.max` and `cpu.max=100000 100000`; moved and stopped an owned child. | Bounded gate sub-cgroups are available without service privileges. |
| Combined Bubblewrap + delegated subtree | Inner child PID 3 entered its bounded gate leaf and exited on SIGTERM; foreign host PID returned ESRCH; foreign fixture survived. | Resource containment and signal containment compose on this kernel. |
| Read-only auxiliary host `/proc` | Host self PID could be read; traversal through the foreign fixture's `root` to host cgroups returned EACCES (13). | Host identity observation can be separate from the normal private `/proc`. This does not prove arbitrary foreign FD access. |
| Controlling terminal | Opening `/dev/tty` in the new-session fixture failed with ENXIO (6). Running that fixture through in-namespace `script --quiet --return --command ... /dev/null` succeeded. | Interactive launches need a private PTY adapter. Native terminal behavior remains an integration test. |

The combined run recorded foreign fixture PID **3996241**, scope launcher **3996242**, Bubblewrap monitor **3996250**, and native sandbox process host PID **3996252** / inner PID **2**. Its own child was inner PID **3**. The child was stopped by that recorded PID and waited for; the harness verified the foreign fixture survived, then terminated and reaped its own foreign fixture by PID. The wrapper/scope exited and were reaped. A later `/proc` existence check found none of the 72 recorded experiment PIDs still present. These numbers are historical receipts, never cleanup targets for a replay.

The final Bun proof recorded foreign fixture **4140233**, monitor **4140234**, and namespace init **4140235** from Bubblewrap's info FD. Bun ran as inner PID **2**, created children **4** and **5**, and received SIGTERM exits for both. The foreign fixture survived until the harness stopped it by its recorded PID. Exit was 0, stderr was empty, and the three recorded host PIDs were absent after reap.

The terminal fixtures recorded wrapper PIDs **7698** (expected failure without a PTY) and **7702** (success with a PTY), and waited for both. These short fixtures used `--die-with-parent`. Searches for prior Bubblewrap terminal work found no relevant solved case; the probe established the adapter choice.

The auxiliary-proc prototype initially tried a mount destination that was unavailable and failed with permission denied. Creating the destination under the owned scratch directory resolved it. The combined probe mounted its delegated subtree at `/sys/fs/cgroup` for a minimal test; production should retain the original cgroup-relative path and overlay only that subtree writable, so existing path readers continue to agree with `/proc/self/cgroup`.

### Startup sample

Five sequential launches per profile ran `bun -e 'process.stdout.write("ok")'`. Times include spawn through reap and are a small feasibility sample, not a production throughput estimate.

| Profile | Successful trials | Median | Maximum |
| --- | --- | --- | --- |
| Plain Bun | 5/5 | 16.22 ms | 16.31 ms |
| `unshare`, complete namespace profile | 5/5 | 16.38 ms | 19.57 ms |
| Bubblewrap, private proc and dev | 5/5 | 22.53 ms | 28.76 ms |
| Bubblewrap without private dev | 0/5, exit 134 | 125.93 ms | 139.02 ms |

The working Bubblewrap sample added about 6.31 ms to the plain median. No per-signal broker round trip is introduced. Native engine startup, sustained builds, memory overhead and multi-agent load remain implementation measurements.

### Reproducing the core proof safely

Run the following Python body from a newly recorded scratch file through the prescribed gate wrapper. Set the four isolated roots first. The foreign process is a harmless child of this harness. The code never looks up processes by name, port or command pattern.

```python
import json, os, subprocess

inside = r'''
import json, os, subprocess, sys
p = subprocess.Popen(["/bin/sleep", "30"])
print(json.dumps({"own_pid": p.pid}), flush=True)
try:
    try:
        os.kill(int(sys.argv[1]), 15)
        raise AssertionError("foreign signal unexpectedly succeeded")
    except ProcessLookupError:
        pass
    os.kill(p.pid, 15)
    assert p.wait(timeout=3) == -15
finally:
    if p.poll() is None:
        p.kill()
        p.wait()
'''
foreign = subprocess.Popen(["/bin/sleep", "60"])
print(json.dumps({"foreign_pid": foreign.pid}), flush=True)
worker = None
try:
    worker = subprocess.Popen([
        "bwrap", "--unshare-user", "--unshare-pid",
        "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
        "--cap-drop", "ALL", "--new-session", "--die-with-parent", "--",
        "python3", "-c", inside, str(foreign.pid),
    ])
    print(json.dumps({"wrapper_pid": worker.pid}), flush=True)
    assert worker.wait(timeout=10) == 0
    assert foreign.poll() is None
finally:
    if worker is not None and worker.poll() is None:
        worker.kill()
        worker.wait()
    if foreign.poll() is None:
        foreign.terminate()
    foreign.wait()
```

This is the minimal signal proof. The reproducer adds `--die-with-parent` to tie its disposable fixture to the harness; the production headless lifetime contract below needs a different policy. The bounded-child experiment additionally creates a fresh user scope with `Delegate=yes`, proves its initial membership is exactly the recorded launcher, moves that launcher into an `agent` child, enables the three controllers on the emptied parent, and makes a separate gate leaf. It creates no delegated directories in any existing operator scope. The production test must also prove forced teardown of namespace init; the minimal snippet's normal-success path alone does not establish that lifecycle property.

## Options and trade-offs

| Option | Fit on this machine | Decision |
| --- | --- | --- |
| Hooks, shell wrappers or a PID allowlist in prose | Already shipped; raw syscalls bypass command matching. | Retain as the first layer. Cannot satisfy the OS requirement alone. |
| Process group / existing cgroup | Useful ownership and teardown information; same-user foreign signalling remains allowed. Groups also change with `setsid`. | Retain resource scopes and verified cleanup. No signal-security claim. |
| Separate host UID per agent | Kernel UID checks help, but provisioning UIDs and sharing the existing account homes require privileges and new credential/filesystem policy. | Reject for this unprivileged deployment. |
| Landlock signal scoping | ABI 6 scopes signals to a domain and descendants; current ABI is 4. Would preserve host PID numbering and simplify gate compatibility. | Strong future option after a separately approved kernel/platform upgrade. No upgrade required by this design. |
| Static seccomp | Unprivileged installation works. BPF sees syscall arguments, without a dynamic process-ancestry lookup. Blanket denial breaks own-child cleanup; numerical PID whitelists race reuse and miss future children. | Reject as the ownership mechanism. |
| Seccomp USER_NOTIF signal broker | Listener creation works. A trusted broker would need to cover all signal syscalls, groups, threads and pidfds, handle PID reuse, emulate operations safely, and stay alive across host succession. | Defer. Consider only if namespace integration proves incompatible. |
| `unshare` directly | Signal proof and Bun work. Production still needs init/reaping, setup ordering, identity reporting, mount/device handling and controlled teardown. | Useful experimental comparator. Prefer the installed packaged supervisor. |
| Bubblewrap user/PID/mount namespaces | Direct signal proof, Bun and delegated cgroup composition work unprivileged. Requires explicit PID identity, gate and deployment integration. | **Chosen.** |

Linux PID namespaces limit the visible PID set; the ancestor can still manage its descendants, and killing namespace init terminates that namespace's processes. See [PID namespace semantics](https://www.man7.org/linux/man-pages/man7/pid_namespaces.7.html). Even with a descriptor, `pidfd_send_signal` requires the caller to be in the target's PID namespace or an ancestor; the failed inherited-pidfd probe agrees with [the syscall contract](https://www.man7.org/linux/man-pages/man2/pidfd_send_signal.2.html).

The [Landlock ABI documentation](https://www.kernel.org/doc/html/v6.12/userspace-api/landlock.html) describes signal scoping in ABI 6. It would be simpler to adopt once it is a supported platform prerequisite. The current measurement rules it out here. For a notification broker, the [seccomp user-notification documentation](https://www.man7.org/linux/man-pages/man2/seccomp_unotify.2.html) warns about check/continue races; a process-tree check followed by continuing the original syscall is insufficient.

## Implementation contract

### Launch and immutable membership

Create a small shared launch adapter used by structured, headless and tmux command builders. Apply it independently of `memoryCell.wrapSpawn`, including CPU-off and memory fallback modes. Sequence:

```text
trusted launcher / host transition
  -> existing resource scope (delegate a bounded subtree when gates need it)
    -> sandbox adapter + Bubblewrap monitor
      -> private namespace init/reaper
        -> native Codex / Claude / other shared-engine entry
          -> tools, MCP subprocesses, gate workers and their descendants
```

Use mandatory `--unshare-user` and `--unshare-pid`, with private `/proc` and `/dev`, retained non-root UID/GID, dropped capabilities and a new session. Never use a `--*-try` fallback for enforcement. Keep the filesystem/network access selected by the existing agent profile. Mount `/sys` read-only and overlay only the owned delegated cgroup subtree writable at its original path. Do not delegate a shared parent slice to the agent.

Structured and headless engines retain their pipe/file transport. For an interactive tmux invocation, allocate a PTY inside the namespace using the installed util-linux `script` adapter, preserving the native exit code and disabling transcript-file output with `/dev/null`. Keep command construction in the existing quoted launcher rather than appending an unbounded prompt to a shell command. Verify raw mode, `/dev/tty`, resize, Ctrl-C and exit back to the pane. The pane's existing scoped shell stays outside; give the CLI its own delegated invocation scope before namespace entry, so the agent cannot write controls for the pane shell. Do not remove `--new-session` merely to regain the outer controlling terminal.

The adapter must prove readiness before delivering the first prompt: correct UID, distinct PID namespace, private normal proc mount, no capabilities, `no_new_privs`, and captured host identities. Close unintended inherited namespace FDs, sockets and pidfds. Preserve intentional native protocol descriptors. The native engine does not run as PID 1; use Bubblewrap's default reaper. Its [version 0.9.0 source](https://raw.githubusercontent.com/containers/bubblewrap/v0.9.0/bubblewrap.c) reports the namespace child PID through `--info-fd` / `--json-status-fd`; that PID must be distinguished from the engine process.

A missing binary, forbidden namespace creation or incomplete setup refuses the new managed launch with the specific capability failure. Never silently downgrade to hooks. Preflight must run in the actual deployed service context, including AppArmor/container settings, since the measured interactive host context may differ on another installation. Installation checks name `bwrap` as a host dependency and verify it before rollout.

### Identity, adoption and cleanup

Record three identities where applicable: outer monitor, namespace init, and native engine, each with host PID/start identity/boot epoch. Record the PID namespace inode, policy version and owned scope identity. Keep `HostState.pid` semantics as the native engine's host PID; keep the wrapper's process handle separately for pipes and exit status. Namespace-local PIDs belong only to inside commands.

Carry the metadata through `engineHost.ts`, both structured host implementations, the shared-engine seam, `runtime/registry.ts` mappings and `agent/registry.ts` normalization. Add round-trip tests through the actual normalizer. Resource scans and engine-version/argv checks must reach the native process. A side channel for readiness/identity must never write into Codex's app-server or Claude's stream-json stdout.

Adoption checks all recorded identities, the namespace relationship and the existing writer claim. Missing or contradictory proof gives an explicit unavailable/legacy result; it must never authorize signalling a guessed PID. Keep #2906's successor admission transfer and the account-switch lane's retirement rules intact. An account/runtime switch gets a new domain; the previous attempt's existing retirement/ownership fences still govern its cleanup and receipts.

For an authorized stop, send TERM to the recorded native engine using the existing identity checks, allow the current bounded grace interval, then stop the recorded namespace init if descendants survive. The kernel's namespace teardown includes detached children. Reap the monitor and confirm the recorded domain is gone. A new session means existing process-group-only cleanup is insufficient; adapt Codex's release paths around `codexAppServerHost.ts:3100` and Claude's captured-tree/release paths around `claudeStreamBrokerHost.ts:1658,1772` explicitly. Unknown identity remains a refusal.

Preserve each caller's existing lifetime contract. In particular, headless work is meant to survive a Viewer restart, so a blanket `--die-with-parent` policy would break it. Owner death, intentional detach, release handoff, cancellation and namespace-init death need distinct tests. Existing external OOM cleanup can stop its verified owned scope. Never locate a unit or process to stop by name pattern.

### Keep heavy commands confined and bounded

This is required work in the same implementation, before enabling enforcement:

1. Extend the outer per-agent scope to delegate only its own subtree. Move the launcher into an `agent` leaf before enabling cpu/memory/pids controllers. Preserve existing ancestor quotas and memory policy. The measured 64 MiB leaf is a probe setting, not a proposed production default.
2. Add a namespace-aware path to `scripts/gate-slot.sh` and `scripts/owned-runner.ts`. It starts the workload locally in a fresh bounded leaf, inside the invocation's existing user/PID namespaces. Prove membership and limits before releasing a blocked child to exec. Maintain queue waits, execution budget accounting, cancellation, owner-death monitoring and an independent deadline guardian. Use the owned leaf to account for detached descendants. Teardown can address only verified members of that newly created leaf/domain. Linux's portable, uncontained fallback remains forbidden.
3. Keep gate supervisors in the same user namespace as their workload. Further user-namespace entry is unnecessary for gate containment and complicates inherited leases. Never ask the user systemd manager to execute a workload outside the domain. The manager creates the outer resource scope before confinement only.
4. Preserve host PID/start/boot identities in the machine-wide admission queue. `scripts/cpu-admission.ts` and `cpuAdmission.ts:186` currently use process identities for stale-owner removal. Give this reader an explicit read-only original-proc mount under the owned launch scratch directory. Translate its own PID through that mount; keep normal process and signal readers on private `/proc`. Never globally switch `procBackend` to host proc, and never enqueue a namespace-local PID.
5. Preserve kernel proof of inherited slot ownership. `cpuAdmission.ts:27` currently checks the owner's FD 9, inode/device and FLOCK WRITE record. Inside one user namespace, adapt the PID addressing while retaining these checks. **Do not accept a lease from an ancestor user namespace merely because its PID/stat is readable.** Start ordinary agent domains before their first gate-slot acquisition. If a managed-engine launch is requested under a held external gate lease, refuse that unsupported cross-boundary nesting explicitly before engine execution; do not wait for another slot while retaining one. Integration fixtures use isolated lock/queue roots and exercise real nested gates after entry. Supporting a future cross-boundary lease handoff would require a separately proved descriptor-transfer design.
6. Exercise old unsandboxed and new sandboxed queue clients together against an isolated shared queue. A refused/unknown proc observation cannot delete another owner's ticket. Verify mutual exclusion and nested lease reuse, including CLI subprocesses that close extra FDs. Validate cgroup path readers with the production mount placement. Environment markers select an implementation path; kernel identity/mount checks establish containment.

The combined experiment proves namespace and delegated-limit primitives. It does not prove this complete gate integration. Treat its tests as release blockers; CPU-off, unbounded portable execution, machine-local PID collisions and manager-created workers are unacceptable shortcuts.

`src/lib/pipelines/testGuidance.ts` resolves the installed release's gate scripts and embeds their real path in the stage prompt. Enable protected launches only with namespace-aware installed tooling and update this capability check alongside the wrapper. A checkout-local edit alone cannot repair an older wrapper named in a prompt. Protected stages must never receive the current missing-tooling suggestion to execute heavy tests directly. Where agent resource limits are disabled, the signal boundary still applies; gate execution independently requires its bounded delegated subtree.

### Existing lanes and rollout

The open MCP-writer lane (identifier ending `d4d6f817`) changes `src/lib/mcp/largeReads.ts` and `server.ts`, including HTTP routing/deadlines and server lifetime work. Its actual diff was inspected. This design relies on ordinary child inheritance and must not replace that transport or duplicate its ownership policy. A private-proc agent still needs its intended Viewer MCP endpoint and account/transcript environment. Test both native child MCP lifetime and routed requests after that lane lands.

The account-switch lane (identifier ending `e38e0604`) touches retirement, delivery, recovery and pipeline receipts. Its guards and resolver changes were inspected. Keep those policies in that lane; add sandbox identities to the existing ownership handoff. No other open signal-sandbox implementation was found. #2906's overlapping recovery work subsequently merged and was rechecked as described above.

Roll out new domains for newly started native processes after synthetic and real-engine checks pass. Existing active hosts keep their recorded policy and may finish under an explicit legacy status. Do not restart the operator's conversations to retrofit namespaces or claim they are protected. Resume/adopt must distinguish a native session resumed in a new protected process from adoption of an already running legacy process. Rollback preserves running-domain ownership metadata or refuses adoption safely; an older normalizer must not silently discard the identities and leak the process tree.

Linux enforcement is the qualified target. Unsupported platforms must report their actual capability instead of claiming protection. Container-host bridging and the declared `bwrap` dependency are installation checks, not reasons to change machine privileges during this stage.

## Test and release plan

All automated tests use explicit files, isolated HOME/config/temp/state, and the prescribed gate wrapper. Kernel fixtures start harmless processes themselves, record their identities immediately and stop only those owned processes. No suite enumerates or acts on the live registry. Pattern-tool tests run only after the fixture proves the private namespace exists; a namespace setup failure aborts before a pattern command can execute.

| Test | Required evidence |
| --- | --- |
| Kernel denial and positive control | Outer harness starts a harmless same-UID foreign fixture. Unconfined signal 0 succeeds. Inside the production launch profile, TERM through `kill`, `tkill`/`tgkill`, queued-signal syscalls and pidfd paths fails for foreign targets. The fixture stays alive. Include inherited pidfds, negative PGID, signal 0 and namespace-reentry attempts. |
| Own-tree cleanup | Child and grandchild, separate process group/session, orphan/reparent, exec and nested namespace cases remain stoppable inside their domain by recorded PID. Repeat with Bun's process APIs. |
| Real command utilities | In a verified sterile namespace, direct `kill`, `pkill`, `killall` and `fuser` cannot affect the outer fixture; a port fixture binds port 0. Run raw-syscall negative cases separately so PR #2729's hook refusal cannot masquerade as OS enforcement. |
| Both native engines | Exercise Codex app-server and Claude stream-json through their real structured launch code, fresh and resumed. Each engine creates its positive child inside its own domain, stops it, and fails to signal an outer harness fixture. Retain per-engine receipts. Cover full/restricted/read-only profiles and hooks enabled. |
| Other launch paths | Headless Codex and Claude; fresh/resumed tmux commands; synthetic coverage of the shared Copilot seam; memory/CPU off and fallback modes. Wrapper setup failure must prevent native execution. |
| Identity and lifetime | Registry serialization/normalization, host-PID mapping, PID reuse, unknown identity, normal exit, cancellation, deadline, OOM, monitor crash and forced init death. Detached descendants vanish on owned teardown; unrelated fixtures survive. Viewer restart/headless survival and runtime-host succession preserve intended ownership. |
| Admission and gates | Old/new clients contend in an isolated shared FIFO/lock directory. No false stale deletion, duplicate slot or leaked lease. Nested gates reuse a proved same-domain lease; cross-boundary nesting refuses promptly. A hanging/ignoring/detaching worker is removed by the owned deadline. Read back effective CPU/memory values. |
| Integration fences | Account/runtime switch during active tools, MCP server exit/reparent, Viewer transport requests, captured cleanup after writer transfer, and container-to-host launch. No access to the operator's live stores. |
| Capability failures | Missing `bwrap`, disabled userns, denied mounts, unavailable delegation, unreadable identity, malformed metadata and incompatible rollback all produce named refusals with no unconfined engine left running. |
| Performance | At least 30 repeated launches for each native engine/profile, baseline versus protected median/p95, sustained representative build/test workload, idle helper memory and bounded parallel load. Proposed review threshold: investigate >50 ms median added launch cost or >5% sustained slowdown; never bypass protection to meet it. |

The existing `src/lib/agent/processCleanupPolicy.native.test.ts:17` starts its “own” stand-in in the harness, outside the native CLI. For this OS layer it becomes a **foreign** fixture. The positive fixture must be created by the sandboxed engine. Extend hook tests separately; their original policy contract stays intact.

Likely touched-test set includes `src/lib/runtime/{codexAppServerHost,claudeStreamBrokerHost}.integration.test.ts`, `structuredSpawn.integration.test.ts`, `structuredSpawn.memory.test.ts`, `structuredSpawn.cpuPlacement.test.ts`, `agentMemory.scope.test.ts`, `cpuPlacement.scope.test.ts`, `cpuAdmission.test.ts`, `agentConfigSandbox.test.ts`, `src/lib/agent/processCleanupPolicy.native.test.ts` and `scripts/owned-runner.integration.test.ts`. Resolve each to a single explicit path in an actual run; do not pass a directory or the brace notation above to the runner. Add focused signal-domain and registry round-trip tests beside the shared adapter.

Run local privacy with committed fingerprints, touched tests, types and changed-file lint as the implementation warrants. Runtime-host/bin changes require `bun scripts/verify-runtime-host.ts --runtime <pinned-bun>` in isolation. If deployment/image inputs change, verify the Viewer under the pin as well, then the container candidate rehearsal using `bun-container`. Main's protected checks were read from the forge during this stage: `privacy-publication`, `privacy-tracker-audit`, `runtime-gate` and `typecheck`, with strict up-to-date checking. The `bun-runtime` and native Codex jobs feed `runtime-gate`; applicable platform/supply-chain/image checks also remain in force. `.github/workflows/bun-runtime.yml` runs both Viewer and runtime-host verification; a Viewer-only health check is insufficient.

This design stage runs primitive experiments and document checks only. It neither changes runtime-host code nor claims those future native-engine or CI checks have passed.

Stage validation: the local privacy gate passed with committed known-value fingerprints and the declared document as its sole path. Whitespace and literal source-path checks passed. No product source or test files were changed, so there are no touched implementation tests to run for this document-only stage.

## Validation against the originating requirement

The design covers current structured hosts, state sandboxing, scopes and both requested engines; measurements select an unprivileged mechanism on the actual kernel and Bun. The owned experiments demonstrate foreign-signal refusal and own-child cleanup without touching operator processes. The implementation plan extends that proof to real engine commands and every managed launch seam, and preserves verified teardown across lifecycle changes. No operator-only privilege decision is needed for the measured Linux mechanism.

## Deferred — not currently justified

- Kernel upgrade solely to obtain Landlock ABI 6. Re-evaluate when the supported platform gains it independently; do not create two active enforcement backends now.
- A seccomp signal broker, per-agent host UIDs, privileged cgroup/LSM helpers or a new native supervisor library. The installed namespace primitive already supplies the core restriction.
- Cross-user-namespace gate-slot lease transfer. Current normal launch order can acquire gate slots after entry; unsupported nesting receives a clear refusal. Add transfer only for a demonstrated caller that needs it.
- A complete filesystem, credential, network and external-control-service sandbox. That requires a separate authority model and compatibility contract.
- Changes to MCP writer transport/lifetime or account-switch retirement policy owned by the named lanes.
- Non-Linux signal enforcement and paid qualification of additional native engines.
- Retrofitting or restarting live conversations, changing global CLI settings, or adding a new user-facing sandbox configuration system.

## Implementation, 2026-10-15

`src/lib/runtime/agentSignalSandbox.ts` is the shared managed launch adapter.
`bin/agent-signal-sandbox.py` enters the delegated invocation scope, moves its
supervisors into an `agent` leaf, installs the namespace mounts and proves
readiness before native execution. Structured hosts additionally verify the
reported identities before acknowledging exec. File-backed headless callers
keep their synchronous handle API: the trusted launcher proves readiness
before the engine can read its buffered prompt.

The receipt records the outer supervisor, Bubblewrap monitor, namespace init
and native process separately. Structured `HostState.pid` remains the native
host PID. Both registry writers and normalization retain the complete domain.
An orphan's existing authorized termination ladder also retains the verified
supervisors and init. Native exit, supervisor death and forced init death each
end the namespace's detached descendants. A missing domain on an older host
continues to identify a legacy process.

`scripts/gate-slot.sh` selects the local namespace runner using a marker that
`signalSandboxContext.ts` verifies against kernel mounts, PID/start identities,
ancestry and cgroup membership. Native tool sandboxes may create further
namespaces; their parent chain must still reach this invocation's recorded
init. Queue ownership uses host PIDs through the read-only original proc mount.
Normal process and signal readers continue to use private `/proc`.

Native filesystem sandboxes keep `/sys` read-only. The launch profile also
binds the invocation's cgroup subtree below its temporary directory; the
context verifier compares its device and inode with the original subtree.
Gate writes use this alias. The original cgroup-relative paths remain readable
at `/sys/fs/cgroup`. The exec barrier is a FIFO, avoiding the socket-backed
extra-stdio pipe that restricted Codex refused.

Each gate creates a bounded cgroup root with its workload in `work`. Nested
gates are descendants of that root, so outer cancellation includes every nested
workload. Supervisors and independent deadline guardians stay outside their
workload leaf. Open directory descriptors retain the cgroup identity through
renames. CPU/memory limits are read back before a blocked worker is released to
exec. Unverified or cross-user-namespace inherited leases refuse execution.

The tmux agent command uses an in-namespace PTY and forwards resize signals to
its PTY adapter. Its separate scope copies the pane scope's effective CPU,
memory and task limits and stays in the same slice. The outer pane shell
remains outside the writable invocation subtree. Generic command windows
retain their existing shell behavior. The npm package bundles the namespace-aware gate scripts under
`dist/gate`; source releases use `scripts`. Both use one installed-tooling
capability check. Incomplete tooling refuses stage composition and managed
launches. Linux is the qualified target; other platforms report managed
launches as unavailable.

The focused test files are `agentSignalSandbox.test.ts`,
`agentSignalSandbox.integration.test.ts`, `agentSignalSandbox.native.test.ts`,
`agentSignalSandbox.terminal.test.ts` and
`sandboxGateRunner.integration.test.ts`, beside the runtime adapter.
Kernel/delegation tests opt in with `LLV_SIGNAL_SANDBOX_KERNEL_TEST=1`; native
tests opt in with `LLV_SIGNAL_SANDBOX_NATIVE_TEST=1` and explicit
`LLV_CODEX_BINARY` / `LLV_CLAUDE_BINARY` paths. They copy the Codex credential
into an isolated home; Claude uses a loopback Messages API, including its
non-streaming classifier response. Native hooks remain enabled while raw
syscalls exercise the kernel signal boundary. The native file also runs both
engines through the file-backed headless launch path.

SQLite update/delete triggers preserve active domain metadata against older
normalizers. Current writers retain a retired record only after all four birth
identities are proven dead. Retired records may be replaced or removed. The
SQLite primary backend enforces the rollback guard; the deprecated JSON
backend retains fields in current writers and requires a current release for
protected-domain adoption. The guard does not make old JSON writers aware of
new fields.

### Implementation measurements

The recorded measurements are in `evidence/agent-signal-sandbox.json`.
Each native launch row contains 30 baseline and 30 protected samples, alternated
under the same 200% CPU and 2 GiB memory limits. Times include native startup
and protocol readiness; model responses use loopback providers.

| Engine / profile | Baseline median / p95, ms | Protected median / p95, ms | Added median, ms |
| --- | --- | --- | --- |
| Codex full | 533.9 / 888.7 | 653.0 / 787.2 | 119.1 |
| Codex restricted | 524.2 / 775.5 | 638.5 / 758.1 | 114.4 |
| Codex read-only | 487.7 / 741.8 | 611.8 / 1298.2 | 124.1 |
| Claude full | 891.0 / 1138.0 | 1023.2 / 1192.7 | 132.2 |
| Claude restricted | 852.9 / 1071.4 | 912.2 / 1201.1 | 59.3 |
| Claude read-only | 933.6 / 1185.7 | 1025.1 / 1298.8 | 91.5 |

The added launch medians exceed the proposed 50 ms investigation threshold.
Inspection of the protected startup path identifies two Python interpreter
starts, delegated-scope setup, Bubblewrap and the kernel readiness handshake.
These measurements include that complete path and do not isolate each cost.
Median idle helper RSS was 19,048–19,092 KiB across the six profiles.

The short representative workload (gate bundling plus CPU admission tests,
three samples per mode) took 607.9 ms baseline and 663.9 ms protected, a 9.2%
increase. A full TypeScript check under matching 200% CPU and 8 GiB limits took
138.8 s baseline and 133.6 s protected. This single sustained pair showed no
slowdown; it does not establish a speedup or a statistical performance bound.
Four parallel protected gates with two slots completed all four jobs and
observed exactly two active workloads at most. Protection remained enabled.

The rollback replay loaded the complete historical registry and SQLite store
from the inspected baseline against the same file written by the current
release. Its `setStructuredHost`, `upsert`, `claimStructuredHost`,
`terminateStructuredHost` and `markUnhosted` writes all refused to discard an
active domain. The current reader retained every identity and refused
retirement while its recorded supervisor was still alive.

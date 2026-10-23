# Remote gate runner: heavy checks on a separate server over SSH

## Originating requirement

Pinned task specification, 2026-10-22, verbatim. The operator's own words are
in private voice messages of that day and are not quoted here; the
specification paraphrases them.

> Operator requests 2026-10-22 (voice; paraphrased, agents only): evaluate
> whether a separate server for resource-heavy tests can unload the current
> server and prevent hangs, and how to set it up; determine and prepare the
> split of execution — development stays in the current environment or goes
> to the cloud, while gates and other tasks that load the system heavily run
> on a separate server where possible.
>
> 1. Which work goes where: development (agent turns) local or cloud; gates
>    (pre-push phases, touched tests, typecheck, builds, browser drivers, load
>    campaigns) and other heavy jobs on a gate server; what must stay local
>    (state-owning processes, the operator's credentials).
> 2. A remote gate runner: how a gate run ships the exact tree (git
>    bundle/rsync of the worktree at a commit, frozen dependency install cached
>    on the runner), executes under the same CPU admission and isolation rules,
>    streams logs back, returns the same verdict format the publication and the
>    hook consume, and fails closed (no verdict → no pass) with a clear reason;
>    how secrets and private data are kept off the runner; how many concurrent
>    runs a given server size holds.
> 3. Provisioning and lifecycle: one gate server (permanent dedicated vs
>    on-demand cloud with automatic deletion), its configuration as code,
>    health check, fallback to local when it is unreachable.
> 4. Measured or cited cost/benefit and the migration slices; 3–5 operator
>    decision questions with options and one recommendation.

Operator redirect of 2026-10-22, given by voice at 12:42Z and relayed by the
orchestrator seat at 13:03Z during this stage, verbatim from the relay:

> The temporary server is NOT a second Delegatus install and runs no agents.
> It is a test runner: the slowest checks (pre-push gate phases, touched
> tests, typecheck/build, browser tests) run there, with files and results
> moved over SSH, so development stays on this machine and testing moves to
> the server. A separate agent is already provisioning it now (16-core Hetzner
> server, user `gate`, pinned Bun, Node 22, Chromium, a mirror clone and a warm
> frozen install; reachable from this machine via an ssh alias). After your
> design and its critique, this same lane continues straight into a build
> stage that implements a v1 of the runner, so make the document end with a
> concrete v1 the builder can implement today: which steps of
> scripts/local-gate.ts and which browser drivers go remote, how the exact
> tree ships (git bundle of the commit), where the target is configured so
> that stage agents' gates (which run with a sandboxed XDG_CONFIG_HOME but the
> real HOME) pick it up, fail-closed verdict, automatic local fallback when the
> runner is unreachable, log streaming and exit codes, cleanup of remote work
> dirs, and the tests that prove it. Keep the rest (placement, lifecycle,
> cost) short.

Decisions this design keeps:

- The runner is the temporary server the redirect names. It holds no
  Delegatus install, no agent and no account login.
- The operator's decision form of 12:33Z set that server's life to the
  Codex reset this evening, and the seat's note of 13:16Z restated it. The
  design therefore targets any host reachable through the configured SSH
  alias that meets the runner contract (§8.5), and falls back to this
  machine when none answers. Q1 asks whether to keep the server 7 more days
  for the rollout measurement.
- The operator chose not to request a higher dedicated-core limit from the
  cloud provider (decision form, 12:33Z), so larger dedicated cloud servers
  are not offered.

Written against `main` at `e12215c01`. Every `file:line` below is on that
commit. At 13:02Z `origin/main` was `8851fb611`, and the files cited in §1.1
were identical there. This revision answers the critique of `a4000d2a6`;
its own reads ran between 13:20Z and 13:50Z. §7 records the commands behind
the measurements.

## Summary

| Question | Answer |
| --- | --- |
| Can a separate server unload this machine? | Yes. Gate commands are the largest CPU consumer here: 702 CPU-hours in the 84 hours from 2026-10-19 00:00Z, on average 8.4 of 24 CPUs and 55% of busy CPU. Without them the hourly busy series has a median of 6.5 CPUs and a P90 of 8.8 (§1.2). v1 moves between about half and 88% of that CPU: half ran in checkouts v1 accepts, a third ran through the installed wrapper from working directories the journal does not record, and 12% (measurement campaigns, git-less copies made by hand) stays here (§1.2). |
| Does it prevent hangs? | It removes the load the Viewer's stalls rise with: hours with at least 11 gate CPUs had 104.6 loop gaps of 1 s or more per hour, hours under 8 had 53.4 (§1.4). Some gaps occur at low gate load too. Production also still runs at default CPU weight until its next restart (§1.4). |
| What is built now? | v1 (§8). A top-level heavy command that reaches `scripts/gate-slot.sh` in a Delegatus git work tree or in a review export, in an eligible shape, runs on the runner: the pre-push admitted checks, test files, typecheck, the lint and comparator scripts, and three of the four browser drivers. |
| How does the tree ship? | As a git bundle of a commit whose tree is the exact working tree, built in a private temporary repository, so the checkout is never written. After checkout and install the runner hashes its working tree and starts nothing unless that id equals the local one. |
| Where is the target set? | In `~/.config/delegatus/gate-runner.json` under the home directory of the account's passwd entry, read with `getent`, which agents' changed `HOME` and `XDG_CONFIG_HOME` do not hide. `LLV_GATE_RUNNER` overrides it. |
| What comes back? | The command's output, line by line, and its exit code; for browser drivers, regular files from the declared output roots. A started run without the runner's end record exits 75 with `gate-runner: no verdict: …`, which the publication retries as an interruption, and gates run here for the next 30 minutes. If the runner is unreachable or fails before the command starts, the command runs here as today. |

## 1. Evidence

### 1.1 The gate code today

- `scripts/gate-slot.sh` is the wrapper every heavy command passes through:
  - `:7` allows 6 slots;
  - `:18-23` place work in `delegatus-agents-work.slice` with a quota of 75%
    of the CPUs and 300% per command;
  - `:88-143` admit by CPU pressure and `flock` slots, and `:94-96` let a
    nested call reuse its parent's slot;
  - `:68-84` hand the command to the owned runner.
- `scripts/owned-runner.ts:145-159` runs each command as a transient
  `delegatus-gate-<uuid>.service` with `MemoryMax=8G`. `:157` writes the
  caller's whole environment into the launch file, and `:164-176` stop the
  command only by its unit name.
- `scripts/local-gate.ts:48-123` plans the pre-push steps. In the hook,
  `:831-836` run privacy in-process beside one admitted call,
  `gate-slot.sh bun scripts/local-gate.ts pre-push --admitted`
  (`:833-834`), which runs every other step. `:767` reads the admitted base
  from the local `origin/main`. `:207-236` isolate a check's environment.
  `:351` and `:694-697` turn a missing verdict into exit 75.
- `scripts/local-gate-tests.ts:289` runs each test file in its own owned
  runner, and `:404-411` build the baseline from a `git clone --shared` of the
  checkout.
- The publication (`src/lib/pipelines/git.ts:2172`, `:2201-2203`) installs
  dependencies, then pushes. Its push environment carries the private known
  values, the forge credentials and the hook deadline.
  `src/lib/pipelines/publication.ts:16-31` decides which outputs are
  deadline-only and therefore retried.
- Stage briefs name the installed wrapper (`src/lib/pipelines/testGuidance.ts:13`,
  `src/lib/runtime/agentSignalSandbox.ts:330`), and the merger calls it too
  (`scripts/merge-batch.ts:344`).
- No remote path exists:
  `git grep -n -E "ssh |rsync|git bundle|gate-runner|GATE_RUNNER|remote gate" -- scripts src/lib/runtime src/lib/pipelines .githooks`
  prints nothing.

### 1.2 Where this machine's CPU went

Sources:

- systemd logs every transient unit's `Consumed … CPU time, … memory peak`
  when it stops, and every gate command is such a unit;
- the unit's `Started` line names the checkout it ran from;
- sysstat gives total busy CPU.

The window is 2026-10-19 00:00Z to 2026-10-22 12:00Z, 84 hours. The machine
has 24 threads and 125 GiB of RAM.

| Consumer | CPU-hours | Average CPUs |
| --- | ---: | ---: |
| Gate units | 702.1 | 8.36 |
| of which measurement campaigns of the pre-push gate | 56.7 | 0.68 |
| Agent scopes ended in the window (lower bound for agent turns) | 106.8 | 1.27 |
| Production service, averaged since its last start (11.02 days) | — | 3.32 |
| Whole machine busy | 1,273 | 15.16 |

| Per hour | Median | P90 | Max |
| --- | ---: | ---: | ---: |
| Machine busy CPUs | 16.3 | 19.1 | 20.6 |
| Gate CPUs | 8.8 | 12.1 | 13.8 |
| Busy CPUs minus gate and campaign padding | 6.5 | 8.8 | 12.3 |

The daily gate share of busy CPU was 61%, 61%, 43% and 59% (Oct 19–22).
Only 3 of the 84 hours had under 2 gate CPUs.

| Who started the gate CPU | CPU-hours | Share |
| --- | ---: | ---: |
| Agents' direct wrapper calls in scratch exports (test files, typecheck, builds) | 263.9 | 37.6% |
| Pre-push test files in pipeline worktrees (publications, and agents running the hook there) | 184.0 | 26.2% |
| Pre-push test files in scratch exports | 138.1 | 19.7% |
| Measurement campaigns | 56.7 | 8.1% |
| Other | 59.5 | 8.5% |

The switch therefore belongs in the wrapper. The pre-push hook alone carries
under a third of gate CPU.

**By checkout kind.** What v1 accepts depends on the kind of checkout a
command runs in (§8.1). Each unit's `Started` line names the `owned-runner.ts`
that ran it: either the checkout's own copy or the installed wrapper's. For
this split the journal was read again at 13:35Z, and it then began at
2026-10-19 08:56Z, because the system had trimmed the first nine hours. The
table therefore covers 75 hours and 662.3 gate CPU-hours, padding excluded.
Compare its shares with the tables above; its totals cover a shorter window.

| Checkout that ran the unit | CPU-hours | Share | v1 (§8.1) |
| --- | ---: | ---: | --- |
| Pipeline worktrees (git) | 213.0 | 32.2% | Runner |
| Other stage scratch checkouts that still hold `.git` | 75.4 | 11.4% | Runner |
| Review exports (`llv-review-export-*/checkout`, no `.git`) | 41.5 | 6.3% | Runner, through the export record |
| The installed wrapper | 218.8 | 33.0% | Depends on the caller's working directory, which the line does not name |
| Scratch checkouts removed since | 36.9 | 5.6% | Unknown |
| Measurement campaigns of the pre-push gate (`before-N`/`after-N` checkouts) | 73.4 | 11.1% | Here: a campaign measures this machine |
| Other scratch checkouts without `.git` | 2.8 | 0.4% | Here (§8.13) |
| Other | 0.5 | 0.1% | — |

So 49.9% ran in checkouts v1 accepts, 11.6% stays here and 38.6% is
unattributed. v1 therefore moves between 49.9% and 88.4% of gate CPU by
location, 4.2 to 7.4 of the 8.4 CPUs above. The journal does not record
shapes either: an agent's direct `bun run build` in an accepted checkout stays
here (§8.1). At 13:47Z the live stage scratch roots held 328 Delegatus
checkouts with `.git`, 83 review exports and 199 other git-less copies, so
part of the installed wrapper's third comes from copies v1 leaves here. The
decision log (§8.7) measures the split after rollout.

Per run: gate units from one pipeline worktree, split at 5 idle minutes, gave
477 runs. The median run took 455 CPU-seconds over 261 s (2.5 CPUs); the P90
run took 4,531 CPU-seconds over 1,316 s (4.3 CPUs). The heaviest shape is
an engine-family pre-push, about 10 threads and at most 15 GiB at its peak.
Memory per gate unit: comparator file runs peaked at 2.5 GiB; typecheck and
build reached the 8 GiB cap.

### 1.3 The runner as provisioned

These facts come from read-only probes over the configured SSH alias at
about 13:10Z and 13:45Z, and from the provisioning agent's results, which the
seat relayed at 13:16Z. The server is set to be deleted tonight (Q1).

- **Reach:** the configured SSH alias on this machine logs in as `gate` with a
  dedicated key, a pinned known-hosts file and connection sharing that
  persists 10 minutes.
- **Host:** a 16-vCPU shared cloud server with 30.6 GiB of RAM (`MemTotal`),
  16 GB of swap, 556 GB of free disk, Ubuntu 24.04.5 and systemd 255. Its
  account `gate` has lingering on, a reachable user manager and the
  controllers `cpu memory pids` delegated, as here.
  `kernel.yama.ptrace_scope` is 1.
- **Toolchain:** Bun 1.4.0 at `~/.bun/bin/bun` (the `Dockerfile` pin), which
  is not on the `PATH` of a non-interactive SSH command; Node 22.23.4; git;
  tar; `systemd-run`. The rehearsal added the Codex CLI the agents here run
  (0.162.1) beside Bun (§8.12).
- **Chromium:** playwright-core 1.62.1 from the lockfile, with its Chromium
  (Chrome for Testing 151) under `~/.cache/ms-playwright` and its system
  libraries.
- **Mirror:** a bare mirror at `~/mirror/delegatus.git`, refreshed by a user
  timer every 5 minutes (at `8851fb611` when read).
- **Warm install:** a frozen install in `~/warm` (796 MiB of `node_modules`),
  which keeps Bun's package cache warm.
- **Isolation script:** `~/bin/gate-env` runs a command under a fresh root in
  `/tmp`:
  - fresh `HOME`, `XDG_*`, `LLV_STATE_DIR`, `TMPDIR`, `CODEX_HOME`,
    `CLAUDE_CONFIG_DIR`, `LLV_CODEX_HOME` and `LLV_CLAUDE_HOME`;
  - the Viewer control URL on a closed port and `NODE_ENV=test`;
  - Chrome wrapped with a short `TMPDIR`;
  - the root removed afterwards.

  v1 does not depend on this script: `serve.ts` isolates on its own (§8.5).
- **Manual round trip by the provisioning agent:**
  - bundle of 75,582 bytes in 0.06 s and copy in 0.38 s;
  - shared clone, fetch, checkout and `bun install --frozen-lockfile` in
    1.68 s, of which the install took 0.57 s;
  - two comparator test files in 0.65 s, and one kanban browser case in
    13.3 s;
  - logs, evidence JSON and 16 frames back in 0.91 s;
  - same commit and tree id on both ends.
- **Typecheck and build**, measured in the rehearsal on one tree (§8.12
  step 3): `bunx tsc --noEmit` took 142 s and 209.7 CPU-seconds there,
  194 s and 252.3 here; `bun run build` took 250 s and 472.6 there, 258 s
  and 402.8 here.

**Concurrent runs.** The runner's slot count is the smaller of two bounds:

- **CPU:** ⌊0.75 × CPUs ÷ 6⌋, six work-slice CPUs per slot. This machine
  runs 6 slots (`gate-slot.sh:7`) over 18 work CPUs (`:21`), three per slot,
  but there most slots hold single test files. On the runner a slot usually
  holds an engine-family pre-push, which fans its touched tests out eight
  files at a time, and three of those on 12 work CPUs ran past their deadline
  in the rehearsal (§8.12 step 4). 16 vCPU gives 2.
- **Memory:** ⌊(RAM − 4 GiB) ÷ 12 GiB⌋. The divisor started at 8 GiB, the
  per-unit `MemoryMax` (`owned-runner.ts:145-159`) that a whole-project
  typecheck reaches: 7.5 GiB through the gate service
  (`docs/design/agent-signal-sandbox.md:628-629`), and one gate unit here sat
  at its 8,192 MiB cap at 13:38Z. The rehearsal's two concurrent
  engine-family pre-pushes took the host past 8 GiB of swap, so it became
  12 GiB by the rule of §8.12 step 4. The 4 GiB keeps sshd, the user manager,
  git and the mirror's page cache resident. 30.6 GiB gives 2.
- **Result:** 2 slots on today's server, where both bounds give 2. An AX102
  (32 threads, 128 GB) gets min(4, 10) = 4.

Slots do not bound one run's own fan-out. An engine-family pre-push holds one
slot and peaks at about 15 GiB across its parallel test files (§1.2), so two
at once can want about 30 GiB of a 30.6 GiB host. `provision.sh` therefore gives
the runner's work slice `MemoryHigh` = RAM − 4 GiB. Above that line the
kernel throttles the slice's processes and swaps their pages, while sshd and
the user manager outside the slice stay responsive. Within the 16 GB of
swap, nothing is killed beyond today's per-unit 8 GiB cap: such a
coincidence costs time, and a run that
outlasts its budget ends as a deadline, which the publication retries. A
two-minute sample here (13:38–13:40Z) held 8.4–14.9 GiB of gate memory at
3.7–15.3 busy work CPUs, about 1.5 GiB per busy work CPU; at the runner's 12
work CPUs that is about 18 GiB. One sample is no distribution, so the
rehearsal runs three of the heaviest pre-pushes at once (§8.12 step 4).

**Throughput.** The runner has 0.75 × 16 = 12 work-slice CPUs × *k*, where *k*
is how much faster or slower a runner thread is than a thread here. The
demand v1 moves averaged 4.2–7.4 CPUs (§1.2), and at most 10.6 in the P90
hour (88% of 12.1). The server covers the average if *k* ≥ 0.62 and that P90
hour if *k* ≥ 0.9. The rehearsal measured *k* = 1.32 over ten engine test
files (§8.12 step 2), with this machine at load 11 to 27, so the runner
does the work of about 16 CPUs here and covers that P90 hour. The same lane
pre-push used 3,994 gate CPU-seconds here and 2,085 there (step 1). A runner
short of capacity queues there, and this machine stays unloaded either way.

### 1.4 Stalls and production's CPU priority

The Viewer logs `[viewer loop-gap]` with `"role":"viewer"`. From
2026-10-19 05:00Z to 2026-10-22 12:00Z it logged 37,229 lines.

| Hours | Count | Viewer gaps ≥ 1 s per hour | Median worst gap |
| --- | ---: | ---: | ---: |
| Gate CPUs ≥ 11 | 19 | 104.6 | 4.2 s |
| Gate CPUs < 8 | 26 | 53.4 | 3.2 s |

Hourly correlation r = 0.37. Lane count raises both, so this is an
association, and §8.12 measures the change.

Production's unit names `delegatus.slice` with `CPUWeight=1000`
(`docs/design/cpu-placement.md`). The running cgroup is still
`app.slice/delegatus.service` at default weight, because the service has not
restarted since 2026-10-11 12:21Z. Its next restart applies the weight.

## 2. Placement

| Work | Where |
| --- | --- |
| Agent turns, seats, reviewers' reading and writing | This machine. They hold state, accounts and worktrees, and they used 1.27 CPUs or more, against 8.4 for gates. |
| Self-contained tasks a person launches by hand | Optionally cloud agents (`codex cloud exec --env <id>` in Codex 0.162.1, `claude --cloud` in Claude Code 2.1.302, both present here). They see no worktree, state or gate and spend the same subscriptions. |
| Pre-push admitted checks, test files, typecheck, lint and comparator scripts, browser drivers | Runner (v1, §8.1), from git work trees and review exports. Git-less copies made by hand stay here (§8.13). |
| Privacy gate, `git fetch`, planning, `git push`, pre-commit | This machine: they read the private known values or carry forge credentials, and pre-commit takes seconds. |
| Viewer, runtime host, launcher, MCP servers, deploys, self-update builds, Docker images | This machine: they own state, or their output runs here. |
| An agent's direct `bun run build`, load campaigns, other projects | This machine in v1 (§8.13, Q2). A campaign that measures this machine's gates sets `LLV_GATE_RUNNER=off`. |

No credential reaches the runner: account homes, forge tokens, App keys, the
cloud API token, relay and Telegram tokens, Delegatus access keys.

## 3. Lifecycle and cost

- **Now:** the temporary 16-vCPU server at €0.2083 per hour (€129.99 per
  month listed), set to be deleted tonight (Q1). When it is gone, the health
  check fails and every gate runs here as today. Any later host takes over by
  meeting the runner contract (§8.5) and being named by the configured SSH
  alias.
- **Permanent:** gate demand is continuous (3 of 84 hours under 2 CPUs), so
  creating a server per busy period would save little. Options with list
  prices from the provider's API and product pages on 2026-10-22, excl. VAT:
  - the same server type, €129.99 per month;
  - a dedicated AX102 (16 cores, 32 threads, 128 GB), €259 per month plus
    €129 setup, no minimum term, cancellable immediately. It covers the P90
    hour at *k* ≥ 0.5.
- **Configuration as code:** v1 commits `scripts/gate-runner/provision.sh`
  (§8.5), which turns a fresh Ubuntu 24.04 host into one that meets the
  contract. It is part of v1 because the next host has to be reproducible,
  whatever Q1 decides.
- **Benefit:** between about half and 88% of gate CPU, 4.2 to 7.4 of the 8.4
  CPUs gates used, leaves this machine (§1.2). The decision log measures
  where the rest runs (§8.7, §8.12).
- **Cost per run:** for a test file, typecheck or driver, a few seconds
  (capture and bundle 0.6 s, transfer, checkout and install about 2 s) plus
  the client's privacy scan of the captured tree, which took about 4 s for
  a small change and is answered from its cache for a tree it has scanned.
  A remote pre-push scans twice here, once in the hook and once in the
  client: 169 to 638 CPU-seconds here per pre-push in the rehearsal, where
  the same lane's pre-push run here took 3,884 to 4,122 (§8.12). 0.1–3 MiB
  of network.

## 4. Decision questions

**Answered 2026-10-22, relayed by the seat at 14:03Z:** Q1 A, the server
stays; Q2–Q4 take the recommended options. Q4 A is not built in v1: the
attention service moves the operator's board to a conversation, and a runner
outage has none, so the notice needs its own surface (follow-up slice). Until
then the `running here` lines and the decision log carry it.

**Q1. What happens to the gate runner after tonight?**

- **A (recommended):** keep the temporary server 7 more days, about €35
  (€0.2083 per hour, billed hourly, deletable at any time):
  - the manual run already passed there, and the build stage's rehearsal
    (§8.12) runs on it without provisioning another host;
  - the 7 days hold the three days of rollout measurement after deploy;
  - you then decide with the measured *k*, runner queues and moved CPU: keep
    the same type (€129.99 per month), move to B, or delete it.
- **B:** a dedicated AX102 (16 cores, 32 threads, 128 GB), €259 per month
  plus €129 setup, no minimum term. You order it in the dedicated-server
  console, and `provision.sh` sets it up.
- **C:** delete it tonight, as decided at 12:33Z. Gates run here through the
  fallback, and `provision.sh` sets up a runner whenever you decide.

**Q2. Which projects use the runner?**

- **A (recommended):** Delegatus only. The runner holds its toolchain.
- **B:** every project whose agents use the installed wrapper and need only
  Bun or Node.
- **C:** every project.

**Q3. Development in the cloud?**

- **A (recommended):** agent turns stay on this machine, and cloud agents are
  used by hand for self-contained tasks. Moving turns frees little CPU.
- **B:** build cloud agents into pipelines as a stage engine now.

**Q4. How do you hear that the runner is down?**

- **A (recommended):** after 30 minutes of continuous fallback, one attention
  item through the existing queue, cleared when the runner answers again.
- **B:** only the `gate-runner: running here` lines in gate output.

## 5. Rejected and deferred

**Rejected:**

- Remoting only the pre-push hook: it covers under a third of gate CPU.
- A second linked install that runs whole lanes: it needs accounts and state
  on the server, which the redirect rules out.
- Hosted or self-hosted CI: its checks would run after the push.
- rsync of the whole tree: 40 MiB per run against 0.1–3 MiB of bundle, and
  the baseline needs history.
- Mounting the checkout on the runner: the live tree could change under a run.
- A long-running service on the runner: SSH already authenticates, streams
  and ends sessions.

**Deferred — not currently justified:**

- automatic creation and deletion of servers;
- several runners;
- remote Docker, self-update and candidate builds;
- cloud agents as stage engines (Q3 B) and other projects (Q2 B, C);
- a verdict cache keyed by tree id, which belongs to lane dc3412b8;
- a Viewer status surface for the runner;
- outbound network limits on the runner;
- git-less copies without an export record, and memory admission per shape
  (§8.13);
- the other items in §8.13.

## 6. Validation against the requirement

| Requirement | Where |
| --- | --- |
| Unload the current server | §1.2: gates used 8.4 CPUs, 55% of busy CPU; v1 moves 4.2 to 7.4 of them, and the decision log measures the rest. |
| Prevent hangs | §1.4: stalls double with gate load; §8.12 measures the change; production's CPU priority waits for a restart. |
| How to set it up | §1.3 (as provisioned), §8.2 (configuration), §8.5 (runner contract). |
| Development here or in the cloud | §2, Q3. |
| Heavy work on the server where possible | §2, §8.1. |
| Exact tree, frozen cached install | §8.4, §8.5. |
| Same CPU admission and isolation | §8.5: the shipped tree's own wrapper runs there. |
| Streamed logs, same verdict format, fail closed | §8.6. |
| Secrets and private data off the runner | §8.3 (privacy, path arguments), §8.4, §8.5, §8.6, §8.8. |
| Concurrent runs per server size | §1.3 (CPU and memory bounds), §8.5 (`provision.sh`), §8.12 step 4. |
| Permanent or on-demand, configuration as code, health check, fallback | §3, §8.5 (`provision.sh`), §8.3 step 2, §8.7. |
| Cost/benefit, slices, 3–5 questions | §3, §4, §8. |
| Redirect: steps and drivers that go remote | §8.1. |
| Redirect: git bundle of the commit | §8.4. |
| Redirect: target that stage agents pick up | §8.2. |
| Redirect: fail-closed verdict, fallback, streaming, exit codes, cleanup, tests | §8.6–§8.11. |

## 7. Evidence record

Reads ran between 12:36Z and 13:15Z into this stage's scratch directory.
Nothing changed in the live installation, at the provider or on the runner.
One `git fetch origin main` moved the remote-tracking ref to check for drift.

- **Gate CPU:**
  `journalctl --user --since "2026-10-19 00:00:00 UTC" --until "2026-10-22 12:00:00 UTC" -o short-unix`,
  filtered to `Consumed .* CPU time` and the `Started` lines of
  `delegatus-gate-`, `delegatus-work-` and `delegatus-agent-` units: 230,345
  lines, sha256 prefix `e93346f427624f8f`.
  - Origin comes from the `owned-runner.ts` path in each `Started` line.
  - The six scratch directories that started `delegatus-campaign-*` units
    count as campaigns.
  - `delegatus-gate-measure-*` units are load padding.
- **Busy CPU:** `sar -u` on the files for Oct 19–22, busy = 100 − `%idle`,
  local time minus 3 hours. 523 samples, sha256 prefix `fd3431f9fb7619ca`.
- **Stalls:** journal lines with `[viewer loop-gap]`, split by `role`
  (37,229 `viewer`, 574 `runtime-host`).
- **Production:** cgroup `cpu.stat` over the time since `ActiveEnterTimestamp`.
- **Runner:**
  - `ssh -o BatchMode=yes -o ControlMaster=no -o ControlPath=none <alias> …`
    reading `PATH`, tool locations, the Bun version, the user manager,
    delegated controllers, CPUs, memory, disk, the mirror head and the
    contents of `~/bin/gate-env`;
  - the provisioning agent's results for the round-trip timings and versions,
    relayed by the seat at 13:16Z.
- **Shipping recipe, tried in scratch on this checkout:**
  - a temporary bare repository with the repository's objects as alternates,
    a copy of the index, then `git add -A`, `write-tree`, `commit-tree` and
    refs `refs/gate/{tree,head,base}`;
  - `git bundle create … --not origin/main~20` took 586 ms in all and gave
    2.0 MB;
  - fetching it into a shared clone, a detached worktree at `head`, then
    `read-tree --reset -u` on `tree` reproduced the tree id;
  - `git for-each-ref` was unchanged and the worktree untouched;
  - `git bundle create` with a raw commit id as tip fails with "Refusing to
    create empty bundle", so the tips must be refs.
- **Prices:**
  - the provider's pricing API, response date 2026-10-22 12:41:48 GMT;
  - product pages read whole at 12:42Z: AX102 "€ 259.00 per month",
    "€ 129.00 one-time setup fee", "No minimum contract term",
    "Cancellation period: immediately".

Reads of this revision, 13:20Z to 13:50Z, read-only in the same way:

- **Times** come from the primary records: the operator's decision form at
  12:33:09Z, the operator's voice request at 12:42:49Z, and the seat's
  messages to the design stage at 13:03:32Z (redirect) and 13:16:39Z
  (runner facts). The design stage completed at 13:19:13Z.
- **Gate CPU by checkout kind:** the same `journalctl` window, read at
  13:34:56Z, filtered to `Started` and `Consumed` lines of
  `delegatus-{gate,work,agent,campaign}-` units: 337,659 lines, sha256 prefix
  `4cb999e62f7c1152`. The journal then began at 2026-10-19 08:56:15Z.
  - Each `delegatus-gate-` service is classed by the directory above
    `scripts/owned-runner.ts` in its `Started` line; `delegatus-gate-measure-`
    scopes (padding) are left out.
  - Campaigns are the directories that started `delegatus-campaign-` units and
    the `before-N`/`after-N` checkouts of the same campaign layout.
  - `.git` presence was read from each directory that still existed.
- **Live gate memory:** every 5 s from 13:38:31Z to 13:40:31Z, the sum of
  `memory.current` (page cache included) over active `delegatus-gate-`
  services, beside the work slice's `cpu.stat` rate.
- **Live scratch census, 13:47Z:** directories up to six levels under the
  stage scratch roots holding `package.json` and `scripts/gate-slot.sh`,
  classed by `.git` and by the `llv-review-export-*/checkout` name.
- **Runner, 13:45Z:** `ptrace_scope`, `MemTotal` (32,083,512 kB),
  `SwapTotal`, the systemd version, the user manager's controllers, the count
  of run directories (1) and the absence of `~/.gate-runner.env`.
- **Git-less shipping, tried in scratch** on an export that
  `scripts/review-export.ts` made of `a4000d2a6`:
  - with a fresh index, `add -A` and `write-tree` gave a tree id different
    from the commit's; with the index seeded by `read-tree <commit>` they gave
    the commit's tree id, in 422 ms;
  - after an edit, a new file and a deletion, `commit-tree` with the main tip
    as parent bundled in 25,674 bytes and 54 ms; a parentless commit bundled
    in 44,212,015 bytes;
  - a bare shared clone, the bundle fetched into it and
    `read-tree --reset -u` into a separate work tree reproduced the tree id,
    with no `.git` in the tree and the tracked ignored file present;
  - after overwriting a file there, `write-tree` alone still printed that id,
    and `add -A` followed by `write-tree` printed another.
- **Passwd home:** with `HOME` set to another directory, Bun 1.4.0's
  `os.userInfo().homedir` returned that directory, Node 22.16's returned the
  passwd entry's, and `getent passwd <uid>` returned the passwd entry's.

## 8. v1: what the build stage implements

### 8.1 What goes remote

A command goes remote when all of these hold:

1. **Call.** It reaches `scripts/gate-slot.sh` as a top-level call (no
   inherited slot), `LLV_GATE_RUNNER` is not `off`, and `NODE_ENV` is not
   `test`. `bun test` sets `NODE_ENV=test`, so a caller with that value is
   inside a test run and its wrapper calls are fixtures.
2. **Tree.** The tree is the nearest ancestor of the working directory that
   contains `scripts/gate-slot.sh` and `scripts/gate-runner/`, and it is one
   of:
   - **a git work tree** whose top level is that directory;
   - **a review export:** it has no `.git`, and the directory above it holds
     the `export.json` that `scripts/review-export.ts` writes (§8.10). The
     record names this checkout's real path, the exported commit and the
     repository it came from, and that repository still holds the commit.

   Any other git-less copy runs here (§8.13).
3. **Shape.** The argv matches a shape below, where `bun` is any path whose
   base name is `bun`. In a review export only the shapes marked *yes* in the
   Export column qualify; the others read git history, which an export lacks
   on this machine too.
4. **Paths.** Every path argument (§8.3) and every `input-path` variable
   (§8.5) stays inside the tree.

| Shape | Export | What it covers |
| --- | --- | --- |
| `bun scripts/local-gate.ts pre-push --admitted` | no | Every step of the hook's admitted half (`local-gate.ts:833-834`): frozen install (on lockfile changes), types, eslint, touched tests, Linux backend, Linux tests, runtime verdict tests, Viewer build, MCP size budgets, Viewer runtime, runtime host, runtime negative controls, native Codex per version and shared contracts, audit retry tests, supply chain. |
| `bun test <args>` and `bun run test <args>` | yes | An agent's test files, including the browser drivers below. |
| `bunx tsc …` | yes | Typecheck. |
| `bun scripts/local-gate-tests.ts …` and `bun scripts/eslint-changes.ts …` | no | The comparator and changed-file lint run by hand. |

A review-export checkout with its record therefore runs its test files,
typecheck and drivers on the runner. Its hook and comparator runs stay here,
where they fail for lack of git as they do today.

Browser drivers that go remote, with their switches passed through:

- `src/components/kanban/kanbanBoard.browser.test.tsx`
  (`LLV_KANBAN_BROWSER_TEST=1`; one case ran on the runner in 13.3 s);
- `src/components/mobile/issue1671Evidence.browser.test.tsx`
  (`LLV_SWIPE_BROWSER_TEST=1`);
- `src/components/conversation/conversationWindow.browser.test.tsx`
  (`LLV_CONVERSATION_BROWSER_TEST=1`).

A test file whose name ends in `.browser.test.tsx` is a *driver shape*: its
outputs come back (§8.8).

The board geometry driver, `scripts/capture-board-geometry.ts`, runs here.
It serves the checkout's own production build with `next start`, and that
build lives in the ignored `.next`, which the shipment never carries; it
also refuses a capture directory outside its own `TMPDIR`. The rehearsal
sent it once from each kind of tree (§8.12 step 5), and it failed in 5 s on
the second reason before reaching the first.

These stay here:

- the hook's outer half: fetch, planning and privacy (`local-gate.ts:831-832`);
- pre-commit;
- `git push`;
- a measurement campaign of this machine's gates, which sets
  `LLV_GATE_RUNNER=off`;
- every other command, including an agent's direct `bun run build`, whose
  `.next` output later commands here may read.

### 8.2 Where the target is configured

- **The file.** `~/.config/delegatus/gate-runner.json` under the home
  directory of the account's passwd entry contains `{"ssh": "<alias>"}`,
  where `<alias>` is the configured SSH alias. Bun 1.4.0's
  `os.userInfo().homedir` returns `$HOME` when it is set (§7; Node 22 returns
  the passwd entry), so neither side reads it or `$HOME` directly. The client
  reuses `machineHome()` (`src/lib/runtime/cpuAdmission.ts:62-85`), which CPU
  admission already uses for the same reason: it probes with `HOME` removed.
  The shell branch reads field 6 of `getent passwd <uid>`. The passwd home is
  the real home whatever `HOME` or `XDG_CONFIG_HOME` a stage agent, its
  sandbox or its isolated test command sets, and OpenSSH reads `~/.ssh/config`
  from it too. The file is absent by default. The seat writes it at rollout
  and deletes it to switch the runner off.
- **`LLV_GATE_RUNNER`** overrides the file: `off` disables the runner for one
  command, and any other value names the alias. The name survives
  `pipelinePublicationHookEnv` (`git.ts:1612-1619`), which keeps `LLV_GATE_*`.
- **`isolatedEnvironment`** (`local-gate.ts:207-236`) sets
  `LLV_GATE_RUNNER=off`, so isolated checks, comparator file runs and test
  fixtures that start the wrapper never go remote. On the runner the client
  sets it to `off` as well, so nothing recurses.
- **Test seams:** `LLV_GATE_RUNNER_CONFIG` (a config path),
  `LLV_GATE_RUNNER_CACHE` (the directory for the health file and the decision
  log), `LLV_GATE_RUNNER_SSH` (the ssh executable) and
  `LLV_GATE_RUNNER_RETURN_LIMIT` (a lower bound on returned outputs) on the
  client; `LLV_GATE_RUNNER_NODE_MODULES` and
  `LLV_GATE_RUNNER_TEST_AFTER_INSTALL` on the stub runner's side. Only tests
  set them.

The resolution order is `LLV_GATE_RUNNER`, then `LLV_GATE_RUNNER_CONFIG`, then
the passwd-home file.

### 8.3 One remote run, client side

`scripts/gate-slot.sh` gets one branch between `:96` and `:97`, after the
nested-slot check and before local admission. On Linux, when
`LLV_GATE_RUNNER` is not `off` and either it is set or the config file exists
under the passwd home (`getent passwd "$(id -u)" | cut -d: -f6`), the wrapper
runs `bun "$(dirname "$0")/gate-runner/client.ts" "$@"` as a job, forwards
`TERM` and `INT` to it, and hands it a decision file. The client either exits
with the remote verdict, which the wrapper returns, or writes `here` and exits;
the wrapper then sets `LLV_GATE_RUNNER=off` and continues into local admission,
so a local run carries no extra process. Everything else is the client's job,
`scripts/gate-runner/client.ts`:

1. **Eligibility (§8.1).** When it fails, the client appends the reason to
   the decision log (§8.7), answers `here` and prints nothing. The original
   command then runs exactly as today.
2. **Health.** The answer is cached for 60 s, healthy or not, in
   `~/.cache/delegatus-gate/runner-health.json` under the passwd home. A
   probe is one call,
   `ssh -o BatchMode=yes -o ConnectTimeout=5 <alias> '<fixed probe>'`,
   bounded at 10 s, that prints:
   - the runner's Bun version from `~/.bun/bin/bun`;
   - free disk in the home directory;
   - `systemctl --user show-environment` status;
   - the mirror's `refs/heads/main`.

   Healthy means:
   - the Bun version equals the version running the client
     (`Bun.version`);
   - at least 10 GB free;
   - the user manager answers;
   - the mirror exists.

   A failed probe keeps only the kind of failure, never ssh's own text,
   which names the host, the account, its address and the key's path: `ssh
   exited <n>` followed by one of "the runner's host name does not
   resolve", "the runner's host key is not the pinned one", "the runner
   refused this machine's key", "the runner refused the connection", "the
   connection to the runner timed out", "the runner's network is
   unreachable" or "the runner closed the connection". Every other reason
   the client prints, keeps in the health file or appends to the decision
   log (a setup step's last line from the runner, a capture error) passes
   through one redaction first, which replaces absolute and home-relative
   paths, `account@host` pairs, host names after `host`, `server` or `to`,
   IP addresses and URLs with `<path>`, `<account>@<host>`, `<host>`,
   `<address>` and `<url>`. The run session itself uses `LogLevel=QUIET`,
   since its standard error is the command's.

   Every runner-side failure, before or after `started` (§8.6, §8.7), writes
   `unhealthyUntil` = now + 30 minutes into the same file, and the client
   treats the runner as unhealthy until then without probing. 30 minutes
   outlasts the publication's retry delays of 1, 5 and 15 minutes
   (`publicationHistory.ts:4`), so the next attempt after a lost run, and
   every attempt while the mark holds, runs here. A runner that answers
   probes and keeps losing runs costs one run per 30 minutes across all
   callers. The file is replaced by write and rename. When the cache
   directory cannot be written, caching is off and each call probes.
3. **Capture and bundle (§8.4).** Nothing leaves this machine yet.
4. **Privacy.** The scan's subject is the shipment, never the live checkout:
   an edit made after capture must neither hide a value from it nor change
   what a cached answer stands for. The capture's tree `T` is checked out
   from the capture's own objects into a scratch directory, and the gate
   that runs is `T`'s own `scripts/privacy-publication-gate.ts` with `T`'s
   fingerprints, `--require-known-values`, the hook's privacy environment
   (`local-gate.ts:795-799`) and the caller's `LLV_PRIVACY_KNOWN_VALUES_FILE`:
   - in a git work tree, the scratch checkout is a repository whose `HEAD`
     is the bundle's head and whose index and files are `T`, scanned with
     `--base <merge-base head origin/main> --check-commits`;
   - in a review export, a plain directory holding `T`, scanned with
     `--paths <the files that differ between the bundle's parent and C>`
     (§8.4). No commit message of the lane travels from an export, so there
     is nothing for `--check-commits` to read.

   The bundle also carries what that scan does not read: in a git work tree,
   every blob of every lane commit, including a version a later commit
   replaced or deleted. Every blob the bundle carries outside the scanned
   paths of `T` (`git rev-list --objects` of its tips, minus the mirror's
   main and the local `origin/main`, which are public) is written under the
   name it travelled with and scanned with `--paths`. So is a list of every
   path name the transmitted commits touch. A finding in any of them runs
   the command here: a private value one commit added and a later one
   deleted never leaves this machine.

   The answer is cached by object ids only: the kind, `C`, head, base or
   parent, the bundle's prerequisite and the known-value digests, at most
   256 entries, oldest evicted first. A refusal or a configuration error
   runs the command here; only a refusal by the gate itself is cached. That
   includes a changed media file in an export, whose provenance the scan
   cannot read without git, and a media file whose earlier version a lane
   commit replaced, whose manifest is not beside the old version.
5. **Upload.** `tar` of `manifest.json`, `run.bundle` and the client's own
   sibling `serve.ts` is piped into
   `ssh <alias> 'mkdir -p ~/runs/<id> && tar -xf - -C ~/runs/<id>'`. The run id
   is 12 lowercase hex characters, which the client checks before using it in
   a command.
6. **Run.** `ssh -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 <alias> '~/.bun/bin/bun ~/runs/<id>/serve.ts run ~/runs/<id>'`
   runs with the client writing a 32-byte random nonce, hex-encoded, and the
   push budget left at that moment in milliseconds (or `-`) as the first line
   of the session's standard input, then holding that input open.
   Nothing the runner writes before the `started` record reaches the caller.
   When `started` arrives, the client prints
   `gate-runner: running on the gate runner (run <id>, tree <12 chars>)` to
   standard error, then copies the session's output to its own as it
   arrives, minus control records (§8.6).
7. **Outputs**, for driver shapes only (§8.8).
8. **Remove.** `ssh <alias> '~/.bun/bin/bun ~/runs/<id>/serve.ts remove ~/runs/<id>'`
   runs after every run, with any result, bounded at 60 s. Its result is
   checked (§8.9): a run is reported as passed only once the runner has
   confirmed that it is gone.
9. **Exit** with the code from §8.6.

The manifest carries:

- protocol version 1 and the run id; the nonce never enters it;
- argv, with the first `bun`/`bunx` element replaced by the runner's binary
  and path arguments mapped (below), and the working directory relative to
  the tree's top level;
- the tree kind (git or export) and its ids: tree, head and base (the local
  `origin/main`) for a git tree; tree and parent for an export;
- the shape;
- the allowlisted environment (§8.5);
- whether the caller set `CHROME_BIN`;
- the output-directory map (§8.8).

**Path arguments.** Every argument after the program that is an absolute
path, or `--name=` followed by one, is resolved against the tree:

- inside the tree, it is rewritten relative to the working directory, as
  `./…` or `../…` so Bun reads it as a path. The working directory maps to
  the same place on both ends, so the rewritten argument names the same file
  there (`bun test $PWD/src/x.test.ts` becomes `bun test ./src/x.test.ts`);
- outside the tree, it makes the command ineligible, so the command runs here
  and no local path travels. A relative argument whose `..` segments leave
  the tree does the same.

### 8.4 Shipping the exact tree: a git bundle of a commit

The capture steps run in the client and write only into a temporary
directory, which is removed afterwards. **In a git work tree:**

1. `git init --bare <tmp>/ship.git`. Its `objects/info/alternates` names the
   repository's object directory (`git rev-parse --git-common-dir` +
   `/objects`).
2. Copy the checkout's index (`git rev-parse --git-path index`) to
   `<tmp>/index`. With `GIT_INDEX_FILE=<tmp>/index` and
   `GIT_OBJECT_DIRECTORY=<tmp>/ship.git/objects`
   (`GIT_ALTERNATE_OBJECT_DIRECTORIES` set to the repository's objects), run
   `git add -A` and `git write-tree`. The result is the tree id `T` the hook
   would judge:
   - committed, staged and unstaged content;
   - untracked files the ignore rules admit;
   - deletions, modes and symlinks.

   Copying the index matters: a fresh empty index drops tracked files that
   match an ignore rule and gives a different id (measured in §7).

   The copy must not let git trust what the index claims about a file. It
   keeps the original's modification time (to the millisecond, so never
   later), because git rereads every entry as new as the index file. `add`
   runs with `core.fsmonitor=false`, `core.ignoreStat=false`,
   `core.checkStat=default`, `core.fileMode=true` and `core.symlinks=true`:
   with either of the last two off in the checkout's config, an executable
   bit changed on disk, or a symlink replaced by a file, keeps the mode the
   index recorded. The runner's verify step uses the same two. An entry marked assume-unchanged keeps its old
   blob whatever the file holds, so that flag is cleared in the copy before
   `add`. An entry marked skip-worktree stands for a file this checkout does
   not have (a sparse checkout): neither its old blob nor a deletion is the
   tree here, so such a checkout runs here with `capturing the tree failed:
   … skip-worktree entries`. The caller's index is never written.
3. `git --git-dir <tmp>/ship.git commit-tree T -p HEAD -m gate-run`, with
   `GIT_AUTHOR_*` and `GIT_COMMITTER_*` set to `gate-run <gate-run@invalid>`,
   so no identity travels. The result is commit `C`. A clean tree gives
   `T == HEAD^{tree}`.
4. Set refs in `<tmp>/ship.git` (`refs/gate/tree` = `C`, `refs/gate/head` =
   `HEAD`, `refs/gate/base` = local `origin/main`), then
   `git --git-dir <tmp>/ship.git bundle create <tmp>/run.bundle refs/gate/tree refs/gate/head refs/gate/base --not <M>`.
   `M` is the runner mirror's main from the health answer, when this
   repository has that commit. Otherwise `M` is
   `git merge-base HEAD origin/main`; the runner's mirror is then newer and
   contains it. The tips must be refs: `git bundle create` refuses a raw
   commit id.

**In a review export**, from its record (§8.1):

1. `git init --bare <tmp>/ship.git`, whose alternates name the recorded
   repository's object directory.
2. `GIT_INDEX_FILE=<tmp>/index git --git-dir <tmp>/ship.git read-tree <commit>`
   seeds the index from the exported commit. Like the index copy above, this
   keeps tracked files that match an ignore rule, which `git archive` exported
   (this repository tracks one, `.artifacts/form-draft-brief.md`). Then
   `git --work-tree <export> add -A` and `write-tree` give T. In scratch, an
   unedited export gave the commit's own tree id in 422 ms, and a fresh index
   gave another id (§7).
3. `commit-tree T -p P` with the same `gate-run` identity gives `C`. `P` is
   `git merge-base <commit> origin/main` in the recorded repository, else the
   mirror's main `M` when that repository has it. Main is append-only, so the
   mirror holds `P` either way, and the files that differ between `P` and `C`
   are exactly the lane's changes, which is what the privacy scan reads. The parent lets the bundle leave out every
   object main already has: with three edits it took 25,674 bytes and 54 ms,
   against 44,212,015 bytes for a parentless commit (§7). Neither the
   exported commit nor any lane commit message travels.
4. `git --git-dir <tmp>/ship.git bundle create <tmp>/run.bundle refs/gate/tree --not P`,
   with `refs/gate/tree` = `C`.

**On the runner**, `serve.ts` (§8.5) checks the bundle with
`git bundle verify` against a shared clone of the mirror. When a prerequisite
is missing, it fetches the mirror from its origin once and verifies again; a
second failure is a setup failure (§8.7).

The checkout's index, refs and object store, and every file of an export, are
never written; T4 and T19 in §8.11 check this.

### 8.5 Runner side: `serve.ts` and the runner contract

`serve.ts` is self-contained (Node built-ins only), so it runs before the
tree exists. The client uploads its own copy, so both ends always speak the
same protocol.

**`serve.ts run <dir>`:**

1. **Owner and sweep.** First write `<dir>/owner`: this process's id and
   its start time from `/proc/self/stat`. Then remove every `~/runs/<id>`
   named by this protocol (12 lowercase hex characters) whose `lease` file
   is older than 30 minutes, whose owner process is gone, and whose two
   units, `gate-setup-<id>` and `gate-run-<id>`, are both inactive
   (`systemctl --user is-active`). Directories under other names belong to
   whoever made them by hand and stay. Then write `<dir>/lease`, touched
   every 30 s while the run lives.
2. **Nonce.** Read one line from standard input within 10 s and keep it in
   memory only. The line also carries the push budget left when the session
   opened; the runner's clock at that moment plus that budget becomes the
   command's `LLV_GATE_PUSH_DEADLINE`, so setup on the runner counts against
   it. It is never written to disk, the manifest, an environment or
   the argv of `serve.ts exec`. The command runs as the same account, and
   `kernel.yama.ptrace_scope` = 1 (read on the runner, asserted by
   `provision.sh`) stops it from reading the memory of `serve.ts run`, which
   is no descendant of the command.

Steps 3 to 7 run as `serve.ts setup <dir>` in a unit of their own,
`systemd-run --user --quiet --collect --wait --pipe --unit=gate-setup-<id> -p TimeoutStopSec=15s -p RuntimeMaxSec=3600 --setenv=HOME=<home> -- ~/.bun/bin/bun <dir>/serve.ts setup <dir>`,
so every clone, install and check they start belongs to that unit from its
first process. The unit starts with the user manager's environment; the
session's own reaches it in `<dir>/setup-env.json` (mode 0600, removed once
read), which never holds the nonce. The unit's answer is
`<dir>/setup-result.json`; a unit that leaves none is a setup failure.

3. **Materialize.** In a git tree:
   - `git clone --quiet --shared --no-checkout ~/mirror/delegatus.git <dir>/tree`;
   - `git -C <dir>/tree fetch --quiet <dir>/run.bundle 'refs/gate/*:refs/gate/*'`;
   - `git -C <dir>/tree update-ref refs/remotes/origin/main <base>`;
   - `git -C <dir>/tree -c core.hooksPath=/dev/null checkout --quiet --detach <head>`;
   - `git -C <dir>/tree read-tree --reset -u refs/gate/tree`.

   `HEAD` is now the reviewed commit, and `origin/main` gives the same merge
   base as here (`local-gate.ts:767`, `local-gate-tests.ts:404-406`).

   In an export:
   - `git clone --quiet --bare --shared ~/mirror/delegatus.git <dir>/src.git`;
   - `git --git-dir <dir>/src.git fetch --quiet <dir>/run.bundle 'refs/gate/*:refs/gate/*'`;
   - `GIT_INDEX_FILE=<dir>/index git --git-dir <dir>/src.git --work-tree <dir>/tree read-tree --reset -u refs/gate/tree`.

   The tree then has no `.git`, like the export here.
4. **Install.** When `package.json` and `bun.lock` exist, run
   `bun install --frozen-lockfile` in the tree, the publication's command
   (`git.ts:2172`), with the runner account's real home. Bun's warm cache
   makes this about 0.6 s. A failure is a setup failure (§8.7).
5. **Verify.** Hash the working tree as it is after install: `git add -A`,
   then `git write-tree`, with the run's index (in `<dir>/tree` for a git
   tree; with `--git-dir <dir>/src.git --work-tree <dir>/tree` and
   `GIT_INDEX_FILE=<dir>/index` for an export). The id must equal `T`.
   `write-tree` alone serializes the index that `read-tree` just wrote, so it
   prints `T` whatever the files hold (§7). `add -A` rehashes only files whose
   stat changed, so the step is cheap. A mismatch is a setup failure named
   `the runner checked out tree <T'> for <T>`.
6. **Environment.** Start from an empty environment and add:
   - `PATH` = `~/.bun/bin` plus the system path;
   - `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` from the session, which
     `systemctl --user` needs;
   - fresh directories under `<dir>/iso/` for the keys `isolatedEnvironment`
     replaces: `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `LLV_STATE_DIR`,
     `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GEMINI_CLI_HOME`, `LLV_CODEX_HOME`
     and `LLV_CLAUDE_HOME`;
   - `TMPDIR=<dir>/t`, kept short for Chrome's sockets;
   - `XDG_CACHE_HOME=~/.cache/gate-runner`, persistent, so the pinned Bun and
     Codex fixtures install once (`local-gate.ts:283-302`);
   - `PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright`;
   - when the caller set `CHROME_BIN`, a `<dir>/chrome` wrapper around the
     newest `chromium-*/chrome-linux64/chrome` that sets a short `TMPDIR`, as
     `~/bin/gate-env` does;
   - `LLV_GATE_RUNNER=off` and `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`;
   - `GIT_AUTHOR_*` and `GIT_COMMITTER_*` set to `gate-run` and a no-reply
     address. The caller's identity never travels, and without one a test
     that commits without its own identity fails there only: the rehearsal
     found one in `src/lib/pipelines/git.test.ts`. A no-reply address passes
     the privacy rules publication code applies to the commits it reads;
     `gate-run@invalid` failed 23 of that file's tests;
   - `LLV_CPU_WAIT_ROOTS` and `LLV_GATE_ADMISSION_WAIT_ROOTS` set to
     `["<dir>/ledger"]`, so runner-side queue time is excluded from the
     budget there;
   - `LLV_GATE_PUSH_DEADLINE` from step 2;
   - every `NAME=value` line of `~/.gate-runner.env`, the runner's own
     settings: `LLV_GATE_SLOTS` (2 on this server, §1.3);
   - the manifest's allowlisted variables.

   **Allowlist:**
   - `LLV_OWNED_RUN_TIMEOUT_MS`, `NODE_OPTIONS`, `NO_COLOR` and
     `FORCE_COLOR`;
   - `CLAUDECODE` and `AGENT`, which switch Bun's test reporter to its compact
     agent output, so an agent reads the same lines from either side;
   - the drivers' switch variables, classified in one table in `client.ts`.
     Every `process.env.NAME` the four drivers and `scripts/local-gate*.ts`
     read is either `pass`, `isolated`, `output-dir` (§8.8), `input-path` or
     `never`. A test fails on an unclassified name.
   - An `input-path` variable whose value is an absolute path outside the tree
     makes the command run here (for example `OVERVIEW_BASELINE_BUNDLE`).
     `never` covers credentials such as `OPENROUTER_API_KEY`.
   - Nothing else is sent: no token, no `LLV_PRIVACY_*`, no `GH_*`, no
     `HOME`.
7. **Containment.** With that environment, run the two checks the shipped
   wrapper would refuse on:
   - `systemctl --user set-property --runtime delegatus-agents-work.slice CPUWeight=100 CPUQuota=<⌊0.75 × CPUs⌋ × 100>% CPUQuotaPeriodSec=20ms`,
     the call `gate-slot.sh:75` makes on every run;
   - `systemd-run --user --quiet --wait --pipe --collect --slice=delegatus-agents-work.slice -p CPUQuota=300% -- bash <dir>/tree/scripts/gate-slot.sh --in-cpu-scope /bin/true`,
     which runs the wrapper's own kernel check (`gate-slot.sh:46-62`) in a
     unit of the work slice and takes no slot.

   Either failing is a setup failure: the command then runs here, and none
   of its output exists yet. After `started`, an exit 69 passes through like
   any other code.
8. **Launch.** Write the `started` record. Run
   `systemd-run --user --quiet --collect --wait --pipe --unit=gate-run-<id> -p TimeoutStopSec=15s --setenv=HOME=<home> -- ~/.bun/bin/bun <dir>/serve.ts exec <dir>`.
   Inside that unit, `serve.ts exec` spawns `bash <dir>/tree/scripts/gate-slot.sh <argv>`
   in `<dir>/tree/<cwd>` with that environment. The runner's own
   `gate-slot.sh` admission, slots, work slice, 300% scope quota,
   `MemoryMax=8G` units and owned runner apply, because they come from the
   shipped tree (`gate-slot.sh:88-143`, `owned-runner.ts:145-159`).
9. **End.** When the unit ends, write the record `end <exit code> <T>`, or
   `no-verdict <reason>` when the code cannot be trusted. The command runs
   as the same account, so it can write any file of the run, including the
   `exit` record that `serve.ts exec` writes after its child ends; it cannot
   change the code its unit reports. That code is the verdict:
   `systemd-run --wait` exits with the unit's main process's own code.
   `systemd-run` also exits 0 when that process dies by `SIGTERM`, `SIGHUP`,
   `SIGINT` or `SIGPIPE`, or when the unit is stopped (measured under
   systemd 255), so the `exit` record only tells a real 0 from those. The
   end record is written only when both name the same code. `serve.ts exec`
   forwards `SIGTERM`, `SIGHUP` and `SIGINT` to the command and ignores
   `SIGPIPE`, so none of them ends it without its record; it removes
   whatever the command left at the record's name before writing its own.
   A record planted before `exec` is killed, or rewritten after it wrote its
   own, therefore gives `no-verdict`, never a pass. A stop the client asked
   for gives no record at all.

Setup output (git, install, the containment checks) goes to
`<dir>/setup.log`. On a setup failure, `serve.ts` writes the record
`setup-failed <step>` with the log's last line, which the client puts in its
`running here` reason, and starts nothing.

A stop the session asks for (end of standard input, `SIGTERM`, `SIGHUP`,
`SIGINT`) stops both units, asks again every second until the
`systemd-run` waiting on the current unit has returned, because a stop that
reaches systemd before the unit is loaded stops nothing, and only then lets
`serve.ts run` exit.

**`serve.ts pack-outputs <dir>` and `serve.ts remove <dir>`** are described
in §8.8 and §8.9. Both refuse any `<dir>` that is not directly under
`~/runs/`.

**The runner contract.** Any host reachable through the configured SSH alias
that has these is a runner. Today's server has all of them except the env
file and the memory drop-in.

- the `gate` account, with lingering on and `cpu memory pids` delegated;
- `kernel.yama.ptrace_scope` of 1 or more;
- `~/.bun/bin/bun` at the `Dockerfile` pin;
- Node 22, git, tar and `systemd-run`;
- `~/mirror/delegatus.git`, refreshed;
- Chromium under `~/.cache/ms-playwright`;
- `~/.gate-runner.env` with `LLV_GATE_SLOTS` (§1.3: 2 for 16 vCPU and
  30.6 GiB);
- a user drop-in giving `delegatus-agents-work.slice` its `MemoryHigh`
  (§1.3).

**Provisioning as code: `scripts/gate-runner/provision.sh`.** It runs as
root on a fresh Ubuntu 24.04 host (`ssh root@<new host> 'bash -s' < …`). Its
inputs are the public half of this machine's runner key, the public
repository URL, the pinned Bun version and the version of the Codex CLI
the agents here run. Every step checks its result first, so a second run changes
nothing. The steps are the ones that set up today's server:

1. create `gate`, install the key, enable lingering, and add a 16 GB
   swapfile when none exists;
2. install `git`, `curl`, `unzip`, `build-essential`, `rsync`, `zstd`,
   unattended upgrades, and Node 22 from a checksum-verified official
   tarball;
3. install, as `gate`, the Bun version the `Dockerfile` pins
   (`pinnedBunVersion`, `local-gate.ts:270`) into `~/.bun`, and the Codex
   CLI into `~/.bun/bin`, the command's `PATH`: tests that ask it for its
   MCP configuration (`src/lib/agent/cli.ts`) fail without one, on base and
   head alike, which the comparator then hides as pre-existing (§8.12);
4. create the bare mirror `~/mirror/delegatus.git` and the checkout `~/warm`
   with a frozen install, plus a user timer that every 5 minutes fetches the
   mirror, moves `~/warm` to `main` and installs again when `bun.lock`
   changed;
5. install Chromium with the lockfile's `playwright-core` from `~/warm`, and
   its system libraries;
6. derive the concurrency settings from `nproc` and `MemTotal` (§1.3) and
   write them as `gate`:
   - `~/.gate-runner.env` with
     `LLV_GATE_SLOTS` = max(1, min(⌊0.75 × CPUs ÷ 6⌋, ⌊(MemTotal − 4 GiB) ÷ 12 GiB⌋));
   - `~/.config/systemd/user/delegatus-agents-work.slice.d/50-memory.conf`
     with `MemoryHigh` = MemTotal − 4 GiB, then
     `systemctl --user daemon-reload`.

   `provision.sh --print-settings` prints both values and changes nothing;
   `LLV_PROVISION_CPUS` and `LLV_PROVISION_MEMTOTAL_KB` replace the two
   readings for its test (T22). Today's server gets 2 slots and 26.6 GiB;
7. configure SSH: keys only (`PasswordAuthentication no`,
   `PermitRootLogin prohibit-password`, so that later runs of this script can
   still log in), `ClientAliveInterval 15`, `ClientAliveCountMax 3`;
8. set `kernel.yama.ptrace_scope` to 1 through a sysctl drop-in when it reads
   0.

The host firewall stays with the cloud provider's firewall, which admits
port 22 from this machine only.

### 8.6 Streaming, exit codes and the fail-closed verdict

- **Streaming.** The command's standard output and error come back over the
  session's two streams. The client writes them unchanged, line by line, so
  the hook's lines (`pre-push: <phase>`, `pre-push: <check>: passed in …`,
  `touched-tests: …`, `NEW …`, `FLAKY …`, `(fail) …`, the no-verdict line of
  `local-gate.ts:351`) reach the publication's readers unchanged
  (`git.ts:1936-1946`, `publication.ts:16-31`,
  `publicationHistory.ts:12-19`).
- **Control records.** `serve.ts run` writes each record to standard error
  as a newline, the nonce, a space, the record and a newline: `started`,
  `setup-failed <step> <detail>`, `end <code> <tree>` or
  `no-verdict <reason>`. The leading newline
  makes a record start a line even when the command's last line had none.
  The client removes each record together with that leading newline, so the
  caller receives the command's bytes unchanged, an unterminated last line
  included. The nonce reaches `serve.ts run` only on its standard input
  (§8.5 step 2), so the command cannot forge a record, and the code an
  end record carries comes from the command's unit, which the command cannot
  set (§8.5 step 9).

| Outcome | Client exit | Line on standard error |
| --- | --- | --- |
| End record with code N, 69 included | N | — |
| Setup failure before `started` (upload, bundle, clone, install, tree check, containment, disk) | runs here (§8.7) | `gate-runner: running here: <step> failed: <detail>` |
| Session lost, or the stream ends without an end record, after `started` | 75 | `gate-runner: no verdict: the connection to the runner was lost after <n> s; nothing was judged` |
| The unit's code and the run's `exit` record disagree, or the record is missing (§8.5 step 9) | 75 | `gate-runner: no verdict: <reason>; nothing was judged` |
| Driver outputs refused or not returned | 75 | `gate-runner: no verdict: outputs were not returned (<reason>)` |
| End record with code 0, and the runner did not confirm the run's removal (§8.9) | 75 | `gate-runner: no verdict: the run passed, but its cleanup on the runner was not confirmed (<cause>)` |
| End record with code N ≠ 0, and the removal not confirmed | N | `gate-runner: cleanup on the runner was not confirmed (<cause>); run <id> stays there until the runner's sweep removes it` |
| Cancelled and the run's removal confirmed (§8.9) | 143 (`SIGTERM`) or 130 (`SIGINT`) | — |
| Cancelled and the removal not confirmed within 60 s | 75 | `gate-runner: no verdict: cancellation was not confirmed on the runner` |

- **No pass without an end record.** A run that started and lost its end
  record is not rerun here in the same invocation: part of its budget is
  spent. Every row above that runs here or exits 75 marks the runner
  unhealthy for 30 minutes (§8.3 step 2). The publication's first retry,
  after 1 minute, and every later call while the mark holds therefore run
  here with the `running here` line.
- **The publication.** It reads a 75 from the hook (`local-gate.ts:747`
  passes the code through). `publication.ts:16-31` gains
  `^gate-runner: no verdict:` as a deadline-only line, so the push is retried
  after 1, 5 and 15 minutes and then parks with the cause on its first line.
  A `NEW`, `(fail)` or privacy refusal line in the same output still makes
  the push decisive, as today. `publicationFailureCause` and
  `publicationInterruptionCause` (`git.ts:1565-1602`) name the runner when
  that line is present.

### 8.7 Automatic local fallback

These run the command on this machine:

- the runner is unhealthy or unreachable, or marked unhealthy after a recent
  failure (§8.3 step 2);
- a setup step fails before `started`, the tree check and the containment
  checks included (§8.5);
- the privacy scan refuses.

The client prints `gate-runner: running here: <reason>` to standard error,
then execs `scripts/gate-slot.sh` with `LLV_GATE_RUNNER=off`. Admission,
quotas, budgets and the verdict are then exactly today's.

**Decision log.** Each call the client handles appends one line to
`~/.cache/delegatus-gate/runner-decisions.log` under the passwd home: the
time, the decision (`remote`, `here` or `ineligible`), its reason, the shape
and the tree kind. The log is kept to its last 10,000 lines. It measures what
stays here (§1.2, §8.12), and Q4 decides who is told about fallbacks.

### 8.8 Driver outputs

For driver shapes only, the runner returns regular files from the **output
roots** and nothing else:

- **`evidence/` and `.artifacts/` in the tree:** files new or changed after
  the command, ignored ones included
  (`git status --porcelain=v1 -z --untracked-files=all --ignored=matching -- evidence .artifacts`,
  with the run's index). Changed tracked files under these roots come back,
  because drivers rewrite committed evidence JSON. A change anywhere else in
  the tree, `.githooks/`, `scripts/` and `package.json` included, never comes
  back. Deleted files under the roots are listed in one line and not
  propagated.
- **Output-directory variables** classified `output-dir`: for example
  `LLV_KANBAN_FRAMES`, `LLV_SEAT_TICK_SHOTS_DIR`, `LLV_TASK_STATES_PNG_DIR`,
  `ACTIVITY_RENDER_DIR`, `PD_OUT`, `SEND_PAINT_OUT` and
  `LLV_LONG_HISTORY_OUT`. When such a variable holds an absolute local
  directory outside the tree, the runner sets it to `<dir>/out/<NAME>`, and
  the client writes that directory's files into the original local
  directory. A relative value stays inside the tree, and only its part under
  the two roots above comes back.

`serve.ts pack-outputs` writes those files to standard output as one ustar
stream (`tar --format=ustar --hard-dereference`), with entries named
`tree/<path>` or `out/<NAME>/<path>`. The client trusts nothing in it. It
reads the stream with its own header reader into a temporary file, at most
512 MiB, and refuses the whole return when any entry:

- is anything but a regular file: a symlink, hard link, directory, device,
  or pax or GNU extension header;
- has an absolute name or a `..` segment;
- lies outside `tree/evidence/`, `tree/.artifacts/` and `out/<NAME>/` for the
  names in the manifest's output map.

After the whole stream has passed, it checks every destination before
writing any, against this machine's files and against the other entries:

- a parent that already exists as a symlink, or as something other than a
  directory, refuses the return;
- two entries with the same destination, or one entry whose destination is
  a parent directory of another's (`tree/evidence/c` beside
  `tree/evidence/c/child`, in either order), refuse it;
- output directories that are the same directory, lie one inside the other,
  or overlap the checkout, resolved through symlinks, refuse it. A directory
  that does not exist yet resolves as its nearest existing ancestor's real
  path plus the missing rest, so a new directory beneath a link to the
  checkout is the checkout's; an entry on the way that cannot be resolved (a
  dangling link) refuses it. Every destination is then planned under the
  resolved roots. The client already runs such a call here at eligibility,
  so the return only rechecks.

Then it stages every file beside its destination (creating missing
directories) and, once all are staged, renames each into place, mode 0644.
A failure while staging removes what was staged and the directories it
made; a failed rename puts back the files already replaced. A refused or
oversized return writes nothing and ends the run with 75 (§8.6).

### 8.9 Cancellation and cleanup

- **Cancellation.** On `SIGTERM` or `SIGINT` the client closes the run
  session's standard input, ends the session and calls `serve.ts remove`
  (below), whether the run was in setup or in its command. `serve.ts run`
  stops both its units when its standard input reaches end of file, so a
  client that dies is treated the same way. A removal that does not confirm
  ends the cancelled run with 75 and `gate-runner: no verdict: cancellation
  was not confirmed on the runner`. Within 45 s, the runner's keep-alive
  detects a dead client (`ServerAliveInterval=15`, 3 misses) and stops the
  run the same way. Stopping the unit stops the owned runner, which stops the
  `delegatus-gate-<uuid>` services it started (`owned-runner.ts:164-176`).
  Those services also end on their own when their owner disappears
  (`owned-runner.ts:122-125`).
- **Cleanup.** `serve.ts remove` deletes `~/runs/<id>` after every run, with
  any result. That includes the clone, `node_modules`, the isolation
  directories, the temporary directory and the outputs. It deletes only a
  run whose session process is gone and whose two units are proven
  inactive. An owner process still alive (same id and start time, any task
  not a zombie) gets `SIGTERM` and up to 40 s to stop its units and exit;
  then `systemctl --user is-active` must answer `inactive` or `failed` for
  `gate-setup-<id>` and `gate-run-<id>`, after a `systemctl --user stop`
  for one that was active. An owner that does not exit, a stop that fails,
  or a user manager that gives no answer leaves the directory, its owner
  record and its lease, and exits 3. The sweep applies the same test.
- **Unconfirmed cleanup.** The client checks the removal's result. When the
  removal's connection fails, it does not finish within 60 s, or
  `serve.ts remove` refuses, the client marks the runner unhealthy for 30
  minutes, prints `gate-runner: cleanup on the runner was not confirmed
  (<cause>); run <id> stays there until the runner's sweep removes it`, and
  reports a passing run as no verdict (exit 75, §8.6). A failing code stays
  decisive. The lease is then no longer touched, so the first run after the
  mark expires sweeps that directory once its unit is inactive, and nothing
  else.
- **Leftovers.** Anything a dead client left behind is removed by the next
  run's sweep, 30 minutes after its lease stops being touched. The health
  probe reports how many run directories exist, and the fallback reason
  names a full disk. The sweep reads only names of this protocol (12
  lowercase hex characters), so the provisioning agent's `~/runs/e2e-…`
  directory and the `run-…` directories of the interim `gate-remote` tool
  stay; whoever made them removes them.

### 8.10 Edits to existing files

| File | Edit |
| --- | --- |
| `scripts/gate-slot.sh` (between `:96` and `:97`) | The remote branch of §8.3, behind a cheap shell test: `LLV_GATE_RUNNER` is set, or the config file exists under the passwd home from `getent passwd "$(id -u)"`. A `$HOME` test would miss the agents that run their tests with a private `HOME`. |
| `scripts/local-gate.ts:207-236` | `isolatedEnvironment` sets `LLV_GATE_RUNNER=off`. |
| `src/lib/pipelines/publication.ts:16-31` | `^gate-runner: no verdict:` is a deadline-only line. |
| `src/lib/pipelines/git.ts:1565-1602` | The cause text names the runner. |
| `scripts/build-gate.ts` | Bundle `gate-runner/client.ts` and copy `gate-runner/serve.ts` into `dist/gate/gate-runner/`, so the installed wrapper that stage briefs name has the client beside it. |
| `scripts/review-export.ts:31-56` and `scripts/review-export.test.ts` | Write `export.json` in the directory `reviewExport` creates, beside `checkout`: version 1, the checkout's real path, `head`, and the repository's real common git directory. It sits outside the tree, so no test and no tree id sees it. A test case checks the record. |
| `AGENTS.md`, local-hooks section | One paragraph: the runner file, `LLV_GATE_RUNNER=off` (which a measurement of this machine's gates sets), what runs where, review exports, and the `gate-runner:` lines. |
| Only if Q4 A (chosen; deferred to a follow-up slice, §4): a Viewer timer | Every 5 minutes, registered with the loop monitor, read the decision log's last lines, and raise one item through `raiseAttentionRequest` (`src/lib/attention/service.ts:197`) after 30 minutes with fallbacks and no remote run; close it through the same service on the next remote run. |
| New `scripts/gate-runner/client.ts`, `serve.ts` and their tests | §8.3–§8.9. |
| New `scripts/gate-runner/provision.sh` | §8.5. |

Unchanged: the hook's steps, verdict rules and budgets, `owned-runner.ts`,
`cpu-admission.ts`, local quotas and slots, and the privacy gate. Open draft
#2926 (last updated 2026-10-15) edits `run()` and the `--reuse-slot` lines of
`gate-slot.sh`, and carries the same `scripts/build-gate.ts` that main now
has. The new branch sits after those lines, and the `build-gate.ts` edit adds
one bundle and one copy to its loop, so a rebase is small.

### 8.11 Tests that prove it

All tests run isolated: private `HOME`, `TMPDIR` and `LLV_STATE_DIR`, the
Viewer control URL on a closed port, the configuration file through
`LLV_GATE_RUNNER_CONFIG` and the cache directory through
`LLV_GATE_RUNNER_CACHE`, so no test reads or writes the passwd home.

**The stub runner.** `LLV_GATE_RUNNER_SSH` points at a stub that runs the
remote command with `bash -c` under a temporary runner home. That home holds
`mirror/delegatus.git` (a bare clone of the checkout under test) and
`.bun/bin/bun` (a link to the running Bun), and the stub records every
invocation and its standard input size.

**The fixture.** A shared clone of the checkout under test, with its
`node_modules` linked through the test-only `LLV_GATE_RUNNER_NODE_MODULES`
seam in `serve.ts`. The remote side uses `DELEGATUS_AGENT_CPU=off` and a
private `LLV_GATE_LOCK_DIR`. Tests that need `systemd-run --user` are skipped
off Linux, as `scripts/gate-slot.test.ts:101` does.

| # | Case | Red when |
| --- | --- | --- |
| T1 | No configuration | The stub records any invocation, or the command's output differs from today's. |
| T2 | `LLV_GATE_RUNNER=off`; a nested call holding a slot; `NODE_ENV=test`; an ineligible shape; an isolated environment | Any invocation is recorded. |
| T3 | Eligible and healthy, with a fixture test file that passes and one that fails | The exit code or the output (minus `gate-runner:` lines) differs from a local run of the same tree, or more than one run happens. |
| T4 | Exact tree: staged edit, unstaged edit, untracked file, deleted file, mode change, symlink, tracked file that matches an ignore rule; an edit to an assume-unchanged file; an edit to a skip-worktree file; executable bits set and cleared, and a symlink replaced by a file, in a checkout with `core.fileMode` and `core.symlinks` off | The runner's verify step (`add -A`, then `write-tree`) gives an id other than `T`; the assume-unchanged file's shipped blob differs from the file's bytes; the skip-worktree checkout uploads anything or does not run here; or the local index bytes, `git for-each-ref` output or loose-object count change; a shipped mode differs from the file on disk, or the checkout's index or config changes. |
| T5 | Mirror behind the local `origin/main`, and mirror ahead of it | Either run fails to verify its bundle. |
| T6 | Health probe fails (stub exits 255) | The command does not run here exactly once with the `running here` line, or a second call within 60 s probes again. |
| T7 | Session killed after `started` at a handshake: the stub cuts it when the command's first line arrives, while the command waits for a release file the test writes only after the first run returns. Then a second invocation, then a third after the mark in the health file is moved back 31 minutes | The first exits other than 75, lacks the `no verdict` line, or reruns here. The second probes, uploads, or does not run here with the `running here` line. The third does not go remote. |
| T8 | The command reads `../manifest.json` and `/proc/<pid>/environ` and `cmdline` of `serve.ts run` and prints them, prints a forged `end 0` line, ends its last standard error line without a newline, and then the stream is cut. A second command ends its last standard error line without a newline and exits 3. | The nonce appears in anything the command read; the first run exits 0; the second exits other than 3, or its last line reaches the caller changed or lost. |
| T9 | The stub alters one file in the runner's tree after install, before verify | The command starts, or it does not run here with `running here: … the runner checked out tree`. Red against a verify step that runs `write-tree` alone. |
| T10 | `SIGTERM` during a fixture test that has printed from inside its unit (the test waits for that line, never for a delay); `SIGTERM` while the runner's clone holds (a stub `git`), and a lost session while a step after install holds, each holding a lock until its last process ends | `gate-run-<id>` or `gate-setup-<id>` is still active once the client has exited, a held lock is still taken, the run directory remains, the cancelled exit is not 143, or the lost session's command does not run here. |
| T11 | Cleanup after pass, fail and cancel; a stale directory with an old lease; a directory with an active unit | A run directory survives its run, the stale one survives the next run, or the active one is removed. |
| T12 | `GH_TOKEN`, `LLV_TOKEN`, `LLV_PRIVACY_KNOWN_VALUES_FILE`, `OPENROUTER_API_KEY`, a git author and committer identity and a driver switch set locally | A secret or the local identity appears in the remote command's environment, the remote identity is not `gate-run` with a no-reply address, or the switch is missing. Also red when `LLV_GATE_PUSH_DEADLINE` there is more than 2 s off the local remaining budget. |
| T13 | The env classification table | Any `process.env.NAME` in the four drivers or `scripts/local-gate*.ts` is unclassified. |
| T14 | A fixture driver writes `evidence/x/a.json`, `.artifacts/y/b.png` and into an absolute `FOO_DIR`, and edits `.githooks/pre-push` and `package.json` in the runner's tree. A hostile `pack-outputs` stub then returns, in turn, an entry `tree/../x`, an absolute name, a symlink `tree/evidence/l` → `/` followed by `tree/evidence/l/f`, a hard link, and an entry under `tree/scripts/`. | A declared file is missing locally; any other file changes, compared by a hash list of the whole local tree and of the parent of `FOO_DIR`; a hostile return writes anything or exits other than 75; over the size bound, the exit is not 75 or a partial file appears. |
| T15 | A tree containing a known value from a temporary known-values file, in a git tree and in a review export | Anything is uploaded, or the command does not run here with the privacy line. |
| T16 | `publicationDeadlineOnly` (`src/lib/pipelines/publication.test.ts`) | It is false for `gate-runner: no verdict:` alone, or true when a `NEW` or `PRIVACY GATE: FAIL` line accompanies it. |
| T17 | `isolatedEnvironment` (`scripts/gate-runner/client.test.ts`) | It leaves `LLV_GATE_RUNNER` other than `off`. |
| T18 | `serve.ts` isolation keys | A key `isolatedEnvironment` replaces is neither given a fresh directory nor mapped to the persistent cache (`XDG_CACHE_HOME`) in `serve.ts`. |
| T19 | A review export that `reviewExport()` made of a fixture commit, then edited, with a new file and a deleted file, keeping a tracked file that matches an ignore rule; a fixture test file run there; and a copy of the same files without `export.json` | For the export: the test does not run remotely; its exit or output (minus `gate-runner:` lines) differs from a local run; `T` differs from the tree of the export's files; the runner's tree holds `.git` or lacks the ignored tracked file; the bundle carries the exported commit or a lane commit message; any file of the export changes. For the copy: any invocation is recorded, or the decision log lacks its `ineligible` line. |
| T20 | Containment refused: a stub `systemctl` on the runner's `PATH` refuses `set-property`; in a second case the probe unit exits 69; in a third, the command itself exits 69 after `started` | In the first two, any line from the runner reaches the caller before `gate-runner: running here: containment failed`, the command does not run here, or a `started` record is written. In the third, the client does anything but exit 69. |
| T21 | `bun test $PWD/<fixture>.test.ts`, and `bun test` with an absolute path outside the tree | The first gives an exit or output (minus `gate-runner:` lines) different from a local run, or its manifest argv holds an absolute path. The second records any invocation. |
| T22 | `provision.sh --print-settings` with 16 CPUs and `MemTotal` 32,083,512 kB, with 32 CPUs and 128 GiB, with 64 CPUs and the same `MemTotal`, with 64 CPUs and 24 GiB, and with 4 CPUs and 8 GiB | The slots differ from 2, 4, 2 and 1 (both the memory bound) and 1, or `MemoryHigh` differs from `MemTotal` − 4 GiB. |
| T24 | A fixture writes `../exit` = 0, sends `SIGKILL` to its own run's `serve.ts exec`, and fails an assertion; a second sends it `SIGPIPE` instead | The first exits other than 75 with `no verdict: the run's completion record disagrees with its unit`; the second exits other than 1; either reports a pass. `completion()` is also checked alone for a planted 0 against unit codes 255, 0 without a record, and 1. |
| T25 | A lane commit adds a file holding a known value and the next commit deletes it | Anything but the probe reaches the runner, or the command does not run here with the privacy line. Without the known value the same history runs remotely. |
| T26 | A passing run whose removal's connection fails; a failing run whose removal never answers (bound lowered by the test-only `LLV_GATE_RUNNER_REMOVE_TIMEOUT_MS`); a passing run whose unit the runner cannot stop (a stub `systemctl`); then a run after their leases are 31 minutes old, beside a live run and a foreign directory | A pass exits other than 75, the failing run other than 1, a retained directory lacks its lease, the health file is not marked, or the last run's sweep removes anything but the three retained runs. |
| T27 | `ship()` then `privacy()` with a known value in a new file (git work tree) and an edited file (export), the value removed from the live files after capture; then the same private tree captured again | Either scan passes, or the second capture of the same tree is answered from a cached pass. |
| T28 | Probe failures whose ssh text names a sentinel host, account, address and key path: host name not resolving, key refused, changed host key, connection refused | The `running here` line lacks the failure's kind, or a sentinel appears in the client's output, the health file or the decision log. |
| T29 | Returns with `tree/evidence/c` and `tree/evidence/c/child` in both orders, a duplicate entry, nested `out/` entries; output maps naming one directory twice, a nested directory, a link into the checkout, and the checkout's parent; missing directories beneath a link to the checkout, beneath a link to another output, and beneath a dangling link; a staged write that fails part-way | Any return is accepted, eligibility admits an overlapping map, or any file or directory changes; a missing directory beneath a link elsewhere is not written at its real place. |
| T23 | The client's config lookup (through `machineHome()`) and the shell branch's, run with `HOME` and `XDG_CONFIG_HOME` set to temporary directories | Either resolves under `HOME`, or under anything other than field 6 of `getent passwd <uid>`. |
| T30 | `scanBudgetMs` with and without a push deadline; then a captured tree whose privacy gate records its pid and holds while a hold file exists, scanned with a 10 s bound, then released and scanned again | The budget is not what is left of the push budget less a minute (at least 30 s), or 15 minutes without one; the held scan is a refusal, is cached, or returns while the gate's process still lives; the released scan is not scanned again and cached. |

The cases live in `scripts/gate-runner/`: `client.test.ts` holds the fast
ones (selection, streams, archives, health cache, T13, T17, T18, T22, T23,
T28, T29, T30's budget half and T24's `completion()` half), and the stub-runner files hold at
most three cases each, so every file stays under half the comparator's
300 s file budget on a loaded runner: `remote.test.ts` (T1–T3, T21),
`remoteCheckout.test.ts` (T4, T5), `remoteTree.test.ts` (T9, T12),
`remoteExport.test.ts` (T15, T19), `remoteFaults.test.ts` (T6, T7),
`remoteControl.test.ts` (T8, T20), `remoteLifecycle.test.ts` (T10, T11),
`remoteOutputs.test.ts` (T14), `remoteShip.test.ts` (T4's symlink and index
flags), `remoteVerdict.test.ts` (T24, T25), `remoteCleanup.test.ts` (T26) and
`remotePrivacy.test.ts` (T27, T30's scan half). The stub records every process group it
starts, and each test stops and waits for them, because the runner side
outlives a killed session as it would on a real host. A test that interrupts
a run does so at a line the command prints, and a deadline in a fixture is
a guard against a hang, never the event the test waits for. A fixture never
embeds an absolute path: the privacy scan reads it as a home path and runs
the command here. The privacy gate refuses any changed symlink, so T4's
symlink case is in `remoteShip.test.ts`, which ships through `ship()` and the
real `serve.ts run` without the scan, as does T19's check of what an export
bundle carries. T14's size bound uses the test-only
`LLV_GATE_RUNNER_RETURN_LIMIT`.

### 8.12 Rehearsal on the real runner and rollout

The build stage runs this rehearsal once, with `LLV_GATE_RUNNER` set to the
configured SSH alias on its own commands only, so nothing else on the
machine changes. It runs while today's server lives (Q1), or against the
next host once `provision.sh` has set it up, and records the results below
the steps.

0. **Provisioning.** A first `provision.sh` run against the current runner
   adds the env file and the memory drop-in, a second changes nothing, and
   the health probe then reports the runner healthy.
1. **The admitted pre-push.** Run it for one lane branch remotely and here, on
   the same tree id. Record the wall times and the client's local CPU (its
   cgroup `cpu.stat`). The `NEW` and `PRE-EXISTING` sets must be equal.
2. ***k*.** The ten heaviest engine test files run remotely and here, one at a
   time on each side. *k* = CPU-seconds here ÷ CPU-seconds there.
3. **Typecheck and build.** Time `bunx tsc --noEmit` through the wrapper,
   remotely and here on the same tree. Time `bun run build` by hand in a run
   directory on the runner, and here, on the same tree. Neither has been
   measured yet.
4. **Memory.** Run as many engine-family admitted pre-pushes at once as
   `LLV_GATE_SLOTS` allows, plus one that queues behind them, from three
   lane trees. Record the work slice's `memory.peak`, swap used, wall times
   and verdicts. The step passes when all three end with their verdicts
   within budget. When one ends by deadline, the CPU divisor grows; when
   swap use passes 8 GiB, the memory divisor becomes 12 GiB; and the step
   repeats. (The first run, at 3 slots, ended one push by deadline, so the
   divisor went from 3 to 6 work CPUs, §1.3.)
5. **Drivers.** One case each of the kanban, phone and conversation-window
   drivers runs remotely, from a lane worktree and from a review export.
   Their frames come back and are opened here. (The board geometry driver
   runs here, §8.1.)
6. **Faults.**
   - Kill the client's ssh session mid-run. That must give 75, the next
     command must run here with the `running here` line, and no run directory
     may remain after the next sweep.
   - Set `LLV_GATE_RUNNER` to an alias that does not resolve, for one command.
     That must give a local run with the `running here` line.

**Record.** The build stage ran every step between 2026-10-23 01:08Z and
04:13Z, from this branch at `f65144870` (tree `fa4d251f6`) and lane trees
made from it. The changes the rehearsal led to came after: the git
identity in `serve.ts`, the Codex CLI in `provision.sh` (installed on the
runner as well), the 12 GiB memory divisor. Each was run again on its own,
and step 1 was repeated on the final tree. Conditions, as sampled during
the runs:

- this machine: 24 threads at load 10 to 37 from other agents' work, with
  local test files waiting up to 41 minutes in the CPU queue;
- the runner: 16 vCPU at load 3 to 51. One to nine hand runs of the interim
  remote test tool shared it, outside the work slice.

Every local command ran with a private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR`
and `LLV_STATE_DIR` and the Viewer control URL on a closed port. CPU is the
`Consumed … CPU time` of the run's `delegatus-gate-` units in that side's
user journal; the client's own CPU is the user and system time of the
processes it waited for.

0. **Provisioning.** Two runs of `provision.sh --user-settings` exited 0 and
   left both files unchanged (same modification times): 2 slots,
   `MemoryHigh` 27,889,208 kB. The client's health probe then answered
   healthy, with the runner's mirror at the current `main`.
1. **The admitted pre-push**, lane F (11 changed files), tree `ba8bf26a008f`
   on both sides:

   | Side | Exit | Wall | CPU on the runner | CPU here | Verdict |
   | --- | --- | ---: | ---: | ---: | --- |
   | Runner | 0 | 657 s | 2,085 s (93 units) | 453 s | 0 new, 16 pre-existing, 5 flaky |
   | Here | 0 | 570 s | — | 4,121.7 s (3,994.4 in 101 gate units, 127.3 in the hook) | 0 new, 12 pre-existing, 12 flaky |

   The remote run spent its first six minutes here, in the hook's privacy
   scan and the client's scan of the captured tree, before its session
   started. The NEW sets were equal (empty), and the PRE-EXISTING sets
   differed. Six tests failed on base and head only on the runner, in
   `engine.ports.part3`, `engine.ports`, `engine.recovery` and
   `engine.rolePrivacy`, all with `Codex MCP configuration could not be
   enumerated safely`: the runner had no Codex CLI on its `PATH`.
   `provision.sh` now installs the one the agents here run, and with it
   those four files passed on the runner one at a time (18, 71, 66 and 13
   pass). The two that failed only here, in
   `registry.servingWriters.test.ts` and
   `engine.cpuAdmissionPolling.test.ts`, failed on base and head here at
   load 17 and passed there.

   Repeated on the final tree, both halves at once from 03:59Z, tree
   `0b784258db1b`:

   | Side | Exit | Wall | CPU on the runner | CPU here | Verdict |
   | --- | --- | ---: | ---: | ---: | --- |
   | Runner | 0 | 785 s | 2,093.5 s (92 units) | 637.9 s | 0 new, 10 pre-existing, 6 flaky |
   | Here | 0 | 460 s | — | 3,883.6 s (3,740.8 in 100 gate units, 142.8 in the hook) | 0 new, 10 pre-existing, 7 flaky |

   The NEW and PRE-EXISTING sets were equal. Both remote runs took longer
   than the local ones, because the two privacy scans here come first and
   ran at load 13 to 20.
2. ***k***, ten engine test files, each run alone, twice on each side:

   | File | Here, run 1 | Here, run 2 | Runner, run 1 | Runner, run 2 | *k* |
   | --- | ---: | ---: | ---: | ---: | ---: |
   | `git.test.ts` | 135.6 | 111.3 | 58.1 | 48.7 | 2.31 |
   | `worktreeSweep.test.ts` | 74.1 | 58.0 | 64.6 | 78.9 | 0.92 |
   | `engine.provisioning.test.ts` | 42.5 | 38.5 | 25.4 | 26.1 | 1.57 |
   | `engine.creation.test.ts` | 34.8 | 28.8 | 23.1 | 23.4 | 1.37 |
   | `runtimeSwitch.test.ts` | 94.8 | 130.7 | 65.0 | 68.5 | 1.69 |
   | `engine.routing.test.ts` | 85.4 | 43.7 | 43.9 | 45.8 | 1.44 |
   | `engine.activation.test.ts` | 21.6 | 35.6 | 19.6 | 19.5 | 1.46 |
   | `engine.settlement.test.ts` | 60.5 | 62.7 | 52.0 | 48.0 | 1.23 |
   | `engine.recovery.test.ts` | 33.0 | 32.5 | 29.7 | 30.9 | 1.08 |
   | `parkedPublication.test.ts` | 86.2 | 68.9 | 99.8 | 100.6 | 0.77 |
   | All ten | | | | | 1.32 (640 s ÷ 486 s) |

   CPU-seconds per run. This machine ran at load 11 to 27 during the series
   and the runner at 5 to 24, and two runs of one file here differed by up
   to half, so *k* describes both hosts under today's load. Every file gave
   the same pass and fail counts on both sides except two: `git.test.ts`
   failed one test only on the runner (the git identity below), and
   `parkedPublication.test.ts` failed one isolated case only here, under
   load.
3. **Typecheck and build**, tree `fa4d251f6` on both sides:

   | Command | Runner wall | Runner CPU | Here wall | Here CPU |
   | --- | ---: | ---: | ---: | ---: |
   | `bunx tsc --noEmit` | 142 s | 209.7 s | 194 s | 252.3 s |
   | `bun run build` (by hand in a run directory there) | 250 s | 472.6 s | 258 s | 402.8 s |

4. **Memory**, three engine-family pre-pushes, all sent at 01:16Z: lanes D
   (9 changed files, 51 test files run), E (29 and 33) and F (11 and 89):

   | Lane | Exit | Wall | CPU on the runner | CPU here | Verdict |
   | --- | --- | ---: | ---: | ---: | --- |
   | E | 0 | 310 s | 343.5 s | 228.1 s | passed |
   | D | 1 | 1,137 s | 2,487.6 s | 512.6 s | 1 new: `engine.spawnSilence.test.ts`, owned test children survived teardown; 65 flaky |
   | F | 0 | 1,420 s | 2,185.9 s | 585.2 s | 0 new, 16 pre-existing, 6 flaky |

   The work slice peaked at 25,430 MiB (`MemoryHigh` 27,235 MiB) and its own
   swap at 6.4 GiB. Host swap reached 13.5 GiB at 01:30Z, when nine hand
   runs of the interim tool shared the runner outside the slice, with load
   up to 51. E had finished before D and F reached the runner, so nothing
   queued. D's one new failure passed alone on the runner afterwards (25
   pass, 0 fail) and in the repeat below: it came from load. Swap above
   8 GiB moved the memory divisor to 12 GiB, which still gives 2 slots
   (§1.3).

   The repeat sent D and F at 02:20Z and E five minutes later, each with
   an empty privacy cache. All three reached the runner between 02:27:44Z
   and 02:28:41Z, three run units were active at once, E took a slot
   without waiting, and D and F each printed `Waiting for a heavy command
   slot` there:

   | Lane | Exit | Wall | CPU on the runner | CPU here | Verdict |
   | --- | --- | ---: | ---: | ---: | --- |
   | E | 0 | 263 s | 327.0 s | 168.6 s | passed |
   | D | 0 | 1,015 s | 2,189.1 s | 498.1 s | 0 new, 10 pre-existing, 5 flaky |
   | F | 0 | 1,009 s | 2,228.0 s | 578.3 s | 0 new, 17 pre-existing, 8 flaky |

   The slice peaked at 16,776 MiB, host swap at 1.1 GiB, load at 31, with
   at most four hand runs beside it. Every run of both rounds ended with
   its verdict inside the 25-minute engine budget.
5. **Drivers.** One case each, through the tree's own `scripts/gate-slot.sh`:

   | Driver | Work tree | Review export |
   | --- | --- | --- |
   | Kanban, `a strip pinned to the page returns it to the seat` | 0, 77 s | 0, 85 s |
   | Phone, `machine worker limit` | 0, 31 s | 0, 38 s |
   | Conversation window, `said once in the interface language` | 0, 15 s | 0, 24 s |

   Each printed `running on the gate runner`. 30 kanban frames came back
   to the declared directories, and the drivers' evidence JSON came back
   into the work tree. One frame from each source was opened here: the
   board in dark Ukrainian at desktop width from the export, and in light
   English at narrow width from the work tree, both real renders.
6. **Faults.**

   - Killing the client's ssh session once the first test result had
     arrived gave exit 75 and `gate-runner: no verdict: the connection to
     the runner was lost after 2 s; nothing was judged`. Two seconds later
     the run's unit was inactive and its run directory gone, so no sweep was
     needed. The next command ran here with `running here: the runner is
     unavailable: marked unhealthy after a failed run (a run lost its
     verdict)`.
   - An alias that does not resolve, for one command, ran here with
     `running here: the runner is unavailable: ssh exited 255: the runner's
     host name does not resolve`. Neither that line nor the decision log
     names the alias or a host.

What the rehearsal found:

- **A test that commits without its own git identity failed only on the
  runner.** The caller's identity never travels, and git on the runner
  cannot guess an address from its host name. `serve.ts` now sets a
  neutral one (§8.5), and `src/lib/pipelines/git.test.ts` then passed
  there in full (180 pass) where it had failed one test.
- **The runner lacked the Codex CLI.** Tests that ask it for its MCP
  configuration failed there on base and head alike, so the comparator
  hid them as pre-existing. `provision.sh` installs it (§8.5), and the
  live runner has it.
- **A remote pre-push still costs this machine one extra privacy scan.**
  The hook scans the push here, and the client scans the captured tree
  before upload (§8.3). In the runs above a remote pre-push used 169 to
  638 CPU-seconds here, against 327 to 2,488 on the runner. In the two step
  1 pairs the hook alone used 127 and 143 CPU-seconds here and the remote
  pre-push 453 and 638, so the client's scan cost about 326 and 495; the
  same pre-push run here took 4,122 and 3,884. The scans also come before
  the run, so both remote pre-pushes took longer in wall time than the
  local ones. Letting the hook's own scan read the captured tree, so it
  runs once, is listed in §8.13.
- **The interim remote test tool shares the runner outside the slots.**
  Its hand runs pushed host swap to 13.5 GiB while the slice held 6.4 GiB.
  When v1 rolls out, those runs either move to v1 or stop on that host,
  or the slot count no longer bounds the runner's memory.

Rollout:

1. After merge and deploy, the seat writes
   `~/.config/delegatus/gate-runner.json`.
2. Before it, and for three days after, the seat records daily:
   - gate CPU on this machine, measurement campaigns and padding excluded
     (the §1.2 method);
   - busy CPU (sysstat);
   - Viewer gaps of 1 s or more (§1.4);
   - the decision log's counts of `remote`, `here` and `ineligible` calls,
     by reason.

The change is working when, with the runner healthy, gate CPU on this machine
averages at most 60% of the same measure over the three days before rollout.
That bar is the half of gate CPU that ran in checkouts v1 accepts (§1.2),
less a margin for shapes the journal cannot see. The decision log then shows
what stayed here, and whether git-less copies or direct builds are worth a
v2.

Deleting the file, or `LLV_GATE_RUNNER=off`, restores today's behaviour at
once.

### 8.13 Not in v1

- Git-less copies without an export record: 0.4% of gate CPU through their
  own scripts, plus an unknown part of the installed wrapper's third (§1.2).
  Shipping them needs a local object store that holds main, and a way to keep
  the tracked files that match an ignore rule without the exported commit.
  The decision log measures them first.
- One privacy scan per remote pre-push. The hook scans the push here, then
  the client scans the captured tree before upload; on lane F the second
  scan cost about 326 and 495 CPU-seconds here in the rehearsal (§8.12). The hook's
  own scan could read the captured tree instead, so it runs once.
- Memory admission per shape on the runner: the slot count, the work slice's
  `MemoryHigh` and rehearsal step 4 bound memory in v1.
- Mirroring the runner's queue wait into this machine's CPU-wait ledger: the
  runner's own deadline already excludes it.
- An agent's direct `bun run build` and other commands whose outputs later
  local commands read.
- The board geometry driver (§8.1). Sending it needs the runner to build the
  tree first, which repeats a build the caller already ran here, and a
  capture directory under the run's `TMPDIR`.
- Load campaigns and their padding scopes.
- Running the client through a host-side service for agents whose sandbox
  has no network: they fall back to running here.
- Several Bun versions on the runner: a version mismatch falls back.
- A forced command in the runner's `authorized_keys`.
- A dependency cache keyed by lockfile fingerprint: the warm Bun cache makes
  the per-run install about 0.6 s.
- Other projects (Q2).

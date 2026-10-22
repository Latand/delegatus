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

Operator redirect of 2026-10-22, about 12:35Z, relayed by the orchestrator
seat during this stage, verbatim:

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
- That server is deleted tonight: the operator's decision form of 12:33Z set
  its life to this evening, and the seat restated it at 13:20Z. The design
  therefore targets any host reachable through the configured SSH alias that
  meets the runner contract (§8.5), and falls back to this machine when none
  answers.
- The operator chose not to request a higher dedicated-core limit from the
  cloud provider (decision form, 12:33Z), so larger dedicated cloud servers
  are not offered.

Written against `main` at `e12215c01`. Every `file:line` below is on that
commit. At 13:02Z `origin/main` was `8851fb611`, and the files cited in §1.1
were identical there. §7 records the commands behind the measurements.

## Summary

| Question | Answer |
| --- | --- |
| Can a separate server unload this machine? | Yes. Gate commands are the largest CPU consumer here: 702 CPU-hours in the 84 hours from 2026-10-19 00:00Z, on average 8.4 of 24 CPUs and 55% of busy CPU. Without them the hourly busy series has a median of 6.5 CPUs and a P90 of 8.8 (§1.2). |
| Does it prevent hangs? | It removes the load the Viewer's stalls rise with: hours with at least 11 gate CPUs had 104.6 loop gaps of 1 s or more per hour, hours under 8 had 53.4 (§1.4). Some gaps occur at low gate load too. Production also still runs at default CPU weight until its next restart (§1.4). |
| What is built now? | v1 (§8). Every top-level heavy command that reaches `scripts/gate-slot.sh` in a Delegatus checkout and has an eligible shape runs on the runner: the pre-push admitted checks, test files, typecheck, the lint and comparator scripts, and four browser drivers. |
| How does the tree ship? | As a git bundle of a commit whose tree is the exact working tree. The commit is built in a private temporary repository, so the checkout is never written. The runner refuses to run unless it checks out the same tree id. |
| Where is the target set? | In `~/.config/delegatus/gate-runner.json` under the account's passwd home directory, which agents' changed `HOME` and `XDG_CONFIG_HOME` do not hide. `LLV_GATE_RUNNER` overrides it. |
| What comes back? | The command's output, line by line, and its exit code. A run without the runner's end record exits 75 with `gate-runner: no verdict: …`, which the publication retries as an interruption. If the runner is unreachable, the command runs here as today. |

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

Per run: gate units from one pipeline worktree, split at 5 idle minutes, gave
477 runs. The median run took 455 CPU-seconds over 261 s (2.5 CPUs); the P90
run took 4,531 CPU-seconds over 1,316 s (4.3 CPUs). The heaviest shape is
an engine-family pre-push, about 10 threads and at most 15 GiB at its peak.
Memory per gate unit: comparator file runs peaked at 2.5 GiB; typecheck and
build reached the 8 GiB cap.

### 1.3 The runner as provisioned

These facts come from read-only probes over the configured SSH alias at
about 13:10Z, and from the provisioning agent's report of 12:47Z, which the
seat relayed at 13:20Z. The server is temporary and is deleted tonight.

- **Reach:** the configured SSH alias on this machine logs in as `gate` with a
  dedicated key, a pinned known-hosts file and connection sharing that
  persists 10 minutes.
- **Host:** a 16-vCPU shared cloud server with 30 GiB of RAM, 16 GB of swap,
  556 GB of free disk and Ubuntu 24.04.5. Its account `gate` has lingering on,
  a reachable user manager and the controllers `cpu memory pids` delegated,
  as here.
- **Toolchain:** Bun 1.4.0 at `~/.bun/bin/bun` (the `Dockerfile` pin), which
  is not on the `PATH` of a non-interactive SSH command; Node 22.23.4; git;
  tar; `systemd-run`.
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
- **Not measured yet:** typecheck and build on the runner, and a side-by-side
  local timing of the same commands. §8.12 measures both.

Capacity is 0.75 × 16 = 12 work-slice CPUs × *k*, where *k* is how much faster
or slower a runner thread is than a thread here. Demand averaged 8.4 CPUs, and
12.1 in the P90 hour. The server therefore covers average demand if *k* ≥ 0.7,
and the P90 hour only if *k* ≥ 1.0. *k* is unmeasured and v1's rehearsal
records it (§8.12). A runner short of capacity queues there, while this
machine stays unloaded either way.

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
| Pre-push admitted checks, test files, typecheck, lint and comparator scripts, browser drivers | Runner (v1, §8.1). |
| Privacy gate, `git fetch`, planning, `git push`, pre-commit | This machine: they read the private known values or carry forge credentials, and pre-commit takes seconds. |
| Viewer, runtime host, launcher, MCP servers, deploys, self-update builds, Docker images | This machine: they own state, or their output runs here. |
| An agent's direct `bun run build`, load campaigns, other projects | This machine in v1 (§8.13, Q2). |

No credential reaches the runner: account homes, forge tokens, App keys, the
cloud API token, relay and Telegram tokens, Delegatus access keys.

## 3. Lifecycle and cost

- **Now:** the temporary 16-vCPU server at €0.2083 per hour (€129.99 per
  month listed), deleted tonight. When it is gone, the health check fails and
  every gate runs here as today. Any later host takes over by meeting the
  runner contract (§8.5) and being named by the configured SSH alias.
- **Permanent:** gate demand is continuous (3 of 84 hours under 2 CPUs), so
  creating a server per busy period would save little. Options with list
  prices from the provider's API and product pages on 2026-10-22, excl. VAT:
  - the same server type, €129.99 per month;
  - a dedicated AX102 (16 cores, 32 threads, 128 GB), €259 per month plus
    €129 setup, no minimum term, cancellable immediately. It covers the P90
    hour at *k* ≥ 0.5.
- **Configuration as code:** v1 commits `scripts/gate-runner/provision.sh`
  (§8.5), which turns a fresh Ubuntu 24.04 host into one that meets the
  contract. Tonight's deletion makes this part of v1: the next host has to be
  reproducible.
- **Benefit:** up to 8.4 CPUs, 55% of busy CPU, leave this machine.
- **Cost per run:** a few seconds of overhead (privacy scan about 4 s,
  capture and bundle 0.6 s, transfer, checkout and install about 2 s), and
  0.1–3 MiB of network.

## 4. Decision questions

**Q1. Which host is the gate runner after tonight's deletion?**

- **A (recommended):** a permanent cloud server of the same type (16 shared
  vCPU, 32 GB, €129.99 per month):
  - it is created through the cloud API within the current limits, and set up
    by `provision.sh`;
  - the manual run already passed on this type;
  - if the rehearsal measures *k* below 0.7, or runner queues persist, move
    to B.
- **B:** a dedicated AX102 (16 cores, 32 threads, 128 GB), €259 per month
  plus €129 setup, no minimum term. You order it in the dedicated-server
  console, and `provision.sh` sets it up.
- **C:** no runner after tonight. Gates run here through the fallback until
  you decide.

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
- the items in §8.13.

## 6. Validation against the requirement

| Requirement | Where |
| --- | --- |
| Unload the current server | §1.2: 8.4 CPUs, 55% of busy CPU, move. |
| Prevent hangs | §1.4: stalls double with gate load; §8.12 measures the change; production's CPU priority waits for a restart. |
| How to set it up | §1.3 (as provisioned), §8.2 (configuration), §8.5 (runner contract). |
| Development here or in the cloud | §2, Q3. |
| Heavy work on the server where possible | §2, §8.1. |
| Exact tree, frozen cached install | §8.4, §8.5. |
| Same CPU admission and isolation | §8.5: the shipped tree's own wrapper runs there. |
| Streamed logs, same verdict format, fail closed | §8.6. |
| Secrets and private data off the runner | §8.3 step 3, §8.5, §8.6. |
| Concurrent runs per server size | §1.3, §3. |
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
  - the provisioning agent's report for the round-trip timings and versions,
    relayed by the seat at 13:20Z.
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

## 8. v1: what the build stage implements

### 8.1 What goes remote

A command goes remote when it reaches `scripts/gate-slot.sh` as a top-level
call (no inherited slot) in a git work tree whose top level contains
`scripts/gate-slot.sh` and `scripts/gate-runner/`. Its argv must also match
one of these shapes, where `bun` is any path whose base name is `bun`:

| Shape | What it covers |
| --- | --- |
| `bun scripts/local-gate.ts pre-push --admitted` | Every step of the hook's admitted half (`local-gate.ts:833-834`): frozen install (on lockfile changes), types, eslint, touched tests, Linux backend, Linux tests, runtime verdict tests, Viewer build, MCP size budgets, Viewer runtime, runtime host, runtime negative controls, native Codex per version and shared contracts, audit retry tests, supply chain. |
| `bun test <args>` and `bun run test <args>` | An agent's test files, including the browser drivers below. |
| `bunx tsc …` | Typecheck. |
| `bun scripts/local-gate-tests.ts …` and `bun scripts/eslint-changes.ts …` | The comparator and changed-file lint run by hand. |
| `bun scripts/capture-board-geometry.ts …` with `BOARD_CAPTURE_DIR` set to an existing absolute directory outside the tree | The board geometry driver. Without that variable it runs here, because it refuses capture directories inside the repository or the home directory and v1 returns outputs only from known places. |

Browser drivers that go remote, with their switches passed through:

- `src/components/kanban/kanbanBoard.browser.test.tsx`
  (`LLV_KANBAN_BROWSER_TEST=1`; one case ran on the runner in 13.3 s);
- `src/components/mobile/issue1671Evidence.browser.test.tsx`
  (`LLV_SWIPE_BROWSER_TEST=1`);
- `src/components/conversation/conversationWindow.browser.test.tsx`;
- `scripts/capture-board-geometry.ts`.

A test file whose name ends in `.browser.test.tsx`, and the geometry script,
are *driver shapes*: their outputs come back (§8.8).

These stay here:

- the hook's outer half: fetch, planning and privacy (`local-gate.ts:831-832`);
- pre-commit;
- `git push`;
- every other command, including an agent's direct `bun run build`, whose
  `.next` output later commands here may read.

### 8.2 Where the target is configured

- **The file.** `~/.config/delegatus/gate-runner.json`, resolved from the
  account's passwd home directory (`os.userInfo().homedir`), contains
  `{"ssh": "<alias>"}`, where `<alias>` is the configured SSH alias. The
  passwd home is the real home whatever `HOME` or
  `XDG_CONFIG_HOME` a stage agent, its sandbox or its isolated test command
  sets, and it is where OpenSSH reads `~/.ssh/config` from too. The file is
  absent by default. The seat writes it at rollout and deletes it to switch
  the runner off.
- **`LLV_GATE_RUNNER`** overrides the file: `off` disables the runner for one
  command, and any other value names the alias. The name survives
  `pipelinePublicationHookEnv` (`git.ts:1612-1619`), which keeps `LLV_GATE_*`.
- **`isolatedEnvironment`** (`local-gate.ts:207-236`) sets
  `LLV_GATE_RUNNER=off`, so isolated checks, comparator file runs and test
  fixtures that start the wrapper never go remote. On the runner the client
  sets it to `off` as well, so nothing recurses.
- **Test seams:** `LLV_GATE_RUNNER_CONFIG` (a config path) and
  `LLV_GATE_RUNNER_SSH` (the ssh executable). Only tests set them.

The resolution order is `LLV_GATE_RUNNER`, then `LLV_GATE_RUNNER_CONFIG`, then
the passwd-home file.

### 8.3 One remote run, client side

`scripts/gate-slot.sh` gets one branch between `:96` and `:97`, after the
nested-slot check and before local admission. On Linux, when
`LLV_GATE_RUNNER` is not `off` and either it is set or the config file
exists, the wrapper execs `bun "$(dirname "$0")/gate-runner/client.ts" "$@"`.
Everything else is the client's job, `scripts/gate-runner/client.ts`:

1. **Eligibility (§8.1).** When it fails, the client execs the wrapper again
   with `LLV_GATE_RUNNER=off` and prints nothing. The original command then
   runs exactly as today.
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
3. **Privacy.** The tree's own
   `scripts/privacy-publication-gate.ts --base <merge-base HEAD origin/main> --require-known-values --check-commits`
   runs here, with the hook's privacy environment (`local-gate.ts:795-799`)
   plus the caller's `LLV_PRIVACY_KNOWN_VALUES_FILE`. Its result is cached by
   tree id, head and base, at most 256 entries, oldest evicted first. A
   refusal or a configuration error runs the command here.
4. **Capture and bundle (§8.4).**
5. **Upload.** `tar` of `manifest.json`, `run.bundle` and the client's own
   sibling `serve.ts` is piped into
   `ssh <alias> 'mkdir -p ~/runs/<id> && tar -xf - -C ~/runs/<id>'`. The run id
   is 12 lowercase hex characters, which the client checks before using it in
   a command.
6. **Run.** `ssh -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 <alias> '~/.bun/bin/bun ~/runs/<id>/serve.ts run ~/runs/<id>'`
   runs with standard input held open by the client. The client prints
   `gate-runner: running on the gate runner (run <id>, tree <12 chars>)` to
   standard error first. It then copies the session's output to its own as
   it arrives, minus control lines (§8.6).
7. **Outputs**, for driver shapes only (§8.8).
8. **Remove.** `ssh <alias> '~/.bun/bin/bun ~/runs/<id>/serve.ts remove ~/runs/<id>'`
   runs after every run, with any result.
9. **Exit** with the code from §8.6.

The manifest carries:

- protocol version 1, the run id and a 32-byte random nonce;
- argv, with the first `bun`/`bunx` element replaced by the runner's binary,
  and the working directory relative to the tree's top level;
- tree, head and base ids: base is the local `origin/main`;
- the shape;
- the allowlisted environment (§8.5);
- the remaining push budget in milliseconds, when `LLV_GATE_PUSH_DEADLINE`
  was set;
- whether the caller set `CHROME_BIN`;
- the output-directory map (§8.8).

### 8.4 Shipping the exact tree: a git bundle of a commit

Steps 1–4 below run in the client and write only into a temporary
directory, which is removed afterwards.

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
5. On the runner, `serve.ts` (§8.5) checks the bundle with `git bundle verify`
   against a shared clone of the mirror. When a prerequisite is missing, it
   fetches the mirror from its origin once and verifies again; a second
   failure is a setup failure (§8.7).

The checkout's index, refs and object store are never written; T4 in §8.11
checks this.

### 8.5 Runner side: `serve.ts` and the runner contract

`serve.ts` is self-contained (Node built-ins only), so it runs before the
tree exists. The client uploads its own copy, so both ends always speak the
same protocol.

**`serve.ts run <dir>`:**

1. **Sweep.** Remove every `~/runs/*` whose `lease` file is older than 30
   minutes and whose unit `gate-run-<id>` is not active
   (`systemctl --user is-active`). Then write `<dir>/lease`, touched every
   30 s while the run lives.
2. **Materialize.**
   - `git clone --quiet --shared --no-checkout ~/mirror/delegatus.git <dir>/tree`;
   - `git -C <dir>/tree fetch --quiet <dir>/run.bundle 'refs/gate/*:refs/gate/*'`;
   - `git -C <dir>/tree update-ref refs/remotes/origin/main <base>`;
   - `git -C <dir>/tree -c core.hooksPath=/dev/null checkout --quiet --detach <head>`;
   - `git -C <dir>/tree read-tree --reset -u refs/gate/tree`.

   `HEAD` is now the reviewed commit, and `origin/main` gives the same merge
   base as here (`local-gate.ts:767`, `local-gate-tests.ts:404-406`).
3. **Verify.** `git -C <dir>/tree write-tree` must equal `T`. On a mismatch,
   write the end record `tree-mismatch` and stop before any command starts.
4. **Install.** When `package.json` and `bun.lock` exist, run
   `bun install --frozen-lockfile` in the tree, the publication's command
   (`git.ts:2172`), with the runner account's real home. Bun's warm cache
   makes this about 0.6 s. A failure is a setup failure (§8.7).
5. **Environment.** Start from an empty environment and add:
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
   - `LLV_CPU_WAIT_ROOTS` and `LLV_GATE_ADMISSION_WAIT_ROOTS` set to
     `["<dir>/ledger"]`, so runner-side queue time is excluded from the
     budget there;
   - `LLV_GATE_PUSH_DEADLINE` = the runner's clock now + the remaining
     milliseconds;
   - `LLV_GATE_SLOTS` from `~/.gate-runner.env` (3 on this server, 12 work
     CPUs);
   - the manifest's allowlisted variables.

   **Allowlist:**
   - `LLV_OWNED_RUN_TIMEOUT_MS`, `NODE_OPTIONS`, `NO_COLOR` and
     `FORCE_COLOR`;
   - the drivers' switch variables, classified in one table in `client.ts`.
     Every `process.env.NAME` the four drivers and `scripts/local-gate*.ts`
     read is either `pass`, `isolated`, `output-dir` (§8.8), `input-path` or
     `never`. A test fails on an unclassified name.
   - An `input-path` variable whose value is an absolute path outside the tree
     makes the command run here (for example `OVERVIEW_BASELINE_BUNDLE`).
     `never` covers credentials such as `OPENROUTER_API_KEY`.
   - Nothing else is sent: no token, no `LLV_PRIVACY_*`, no `GH_*`, no
     `HOME`.
6. **Launch.** Write the control line `started`. Run
   `systemd-run --user --quiet --collect --wait --pipe --unit=gate-run-<id> -p TimeoutStopSec=15s -- ~/.bun/bin/bun <dir>/serve.ts exec <dir>`.
   Inside that unit, `serve.ts exec` spawns `bash <dir>/tree/scripts/gate-slot.sh <argv>`
   in `<dir>/tree/<cwd>` with that environment. The runner's own
   `gate-slot.sh` admission, slots, work slice, 300% scope quota,
   `MemoryMax=8G` units and owned runner apply, because they come from the
   shipped tree (`gate-slot.sh:88-143`, `owned-runner.ts:145-159`).
7. **End.** Write the control line `end <exit code> <T>` when the unit ends.

**`serve.ts pack-outputs <dir>` and `serve.ts remove <dir>`** are described
in §8.8 and §8.9. Both refuse any `<dir>` that is not directly under
`~/runs/`.

**The runner contract.** Any host reachable through the configured SSH alias
that has these is a runner. Today's server has all of them except the env
file.

- the `gate` account, with lingering on and `cpu memory pids` delegated;
- `~/.bun/bin/bun` at the `Dockerfile` pin;
- Node 22, git, tar and `systemd-run`;
- `~/mirror/delegatus.git`, refreshed;
- Chromium under `~/.cache/ms-playwright`;
- `~/.gate-runner.env` with `LLV_GATE_SLOTS` (3 for 16 vCPU).

**Provisioning as code: `scripts/gate-runner/provision.sh`.** It runs as
root on a fresh Ubuntu 24.04 host (`ssh root@<new host> 'bash -s' < …`). Its
inputs are the public half of this machine's runner key and the public
repository URL. Every step checks its result first, so a second run changes
nothing. The steps are the ones that set up today's server:

1. create `gate`, install the key, enable lingering, and add a 16 GB
   swapfile when none exists;
2. install `git`, `curl`, `unzip`, `build-essential`, `rsync`, `zstd`,
   unattended upgrades, and Node 22 from a checksum-verified official
   tarball;
3. install, as `gate`, the Bun version the `Dockerfile` pins
   (`pinnedBunVersion`, `local-gate.ts:270`) into `~/.bun`;
4. create the bare mirror `~/mirror/delegatus.git` and the checkout `~/warm`
   with a frozen install, plus a user timer that every 5 minutes fetches the
   mirror, moves `~/warm` to `main` and installs again when `bun.lock`
   changed;
5. install Chromium with the lockfile's `playwright-core` from `~/warm`, and
   its system libraries;
6. write `~/.gate-runner.env` with `LLV_GATE_SLOTS` = ⌊0.75 × CPUs ÷ 4⌋, at
   least 1;
7. configure SSH: keys only (`PasswordAuthentication no`,
   `PermitRootLogin prohibit-password`, so that later runs of this script can
   still log in), `ClientAliveInterval 15`, `ClientAliveCountMax 3`.

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
- **Control lines.** These are written to standard error as
  `<nonce> started` and `<nonce> end <code> <tree>`. The client removes every
  line that starts with the nonce. The nonce is never placed in the command's
  environment, so the command cannot forge an end record.

| Outcome | Client exit | Line on standard error |
| --- | --- | --- |
| End record with code N | N | — |
| End record 69 together with `gate-slot: CPU containment for gates is unavailable` | runs here (§8.7) | `gate-runner: running here: the runner refused CPU containment` |
| Setup failure before `started` (upload, bundle, clone, install, disk) | runs here (§8.7) | `gate-runner: running here: <step> failed` |
| `tree-mismatch` | 75 | `gate-runner: no verdict: the runner checked out tree <T'> for <T>; nothing was judged` |
| Session lost, or the stream ends without an end record, after `started` | 75 | `gate-runner: no verdict: the connection to the runner was lost after <n> s; nothing was judged` |
| Driver outputs could not be returned | 75 | `gate-runner: no verdict: outputs were not returned (<reason>)` |
| Cancelled and stop confirmed | 143 (`SIGTERM`) or 130 (`SIGINT`) | — |
| Cancelled and stop not confirmed within 15 s | 75 | `gate-runner: no verdict: cancellation was not confirmed on the runner` |

- **No pass without an end record.** A lost run is not rerun here in the
  same invocation: part of its budget is spent. The caller's retry runs
  locally, because the failed health check is cached for 60 s.
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

- the runner is unhealthy or unreachable;
- a setup step fails before `started`;
- containment is refused;
- the privacy scan refuses;
- an input path lies outside the tree.

The client prints `gate-runner: running here: <reason>` to standard error,
then execs `scripts/gate-slot.sh` with `LLV_GATE_RUNNER=off`. Admission,
quotas, budgets and the verdict are then exactly today's. Each fallback is
appended to `~/.cache/delegatus-gate/runner-fallbacks.log` under the passwd
home, which is trimmed to its last 1,000 lines; Q4 decides who is told.

### 8.8 Driver outputs

For driver shapes only, `serve.ts pack-outputs` writes one tar stream to
standard output, which the client unpacks:

- **Files in the tree** that are new or changed after the command, including
  ignored ones: `git status --porcelain=v1 -z --untracked-files=all --ignored=matching`,
  minus `node_modules/`, `.next/`, `dist/` and `tsconfig.tsbuildinfo`. This
  covers `evidence/**` and `.artifacts/**`. They go to the same relative
  paths in the local tree. Deleted files are listed in one line and not
  propagated.
- **Output-directory variables** classified `output-dir`: for example
  `BOARD_CAPTURE_DIR`, `LLV_SEAT_TICK_SHOTS_DIR`, `LLV_TASK_STATES_PNG_DIR`,
  `ACTIVITY_RENDER_DIR`, `PD_OUT`, `SEND_PAINT_OUT` and
  `LLV_LONG_HISTORY_OUT`. When such a variable holds an absolute local
  directory outside the tree, the runner sets it to `<dir>/out/<NAME>`, and
  the client copies that directory's contents back into the original local
  directory. A relative value stays inside the tree and is covered above.
- **Size bound:** 512 MiB in total. Over it, nothing is unpacked and the run
  ends with 75 (§8.6).
- **Unpacking:** the client unpacks into a temporary directory first and
  moves files into place only after the whole stream has arrived.

### 8.9 Cancellation and cleanup

- **Cancellation.** On `SIGTERM` or `SIGINT` the client closes the run
  session's standard input and calls
  `ssh <alias> 'systemctl --user stop gate-run-<id>'`. `serve.ts run` also
  stops its unit when its standard input reaches end of file, so a client
  that dies is treated the same way. Within 45 s, the runner's keep-alive
  detects a dead client (`ServerAliveInterval=15`, 3 misses) and stops the
  run the same way. Stopping the unit stops the owned runner, which stops the
  `delegatus-gate-<uuid>` services it started (`owned-runner.ts:164-176`).
  Those services also end on their own when their owner disappears
  (`owned-runner.ts:122-125`).
- **Cleanup.** `serve.ts remove` deletes `~/runs/<id>` after every run, with
  any result. That includes the clone, `node_modules`, the isolation
  directories, the temporary directory and the outputs. Anything a dead
  client left behind is removed by the next run's sweep, 30 minutes after its
  lease stops being touched. The health probe reports how many run
  directories exist, and the fallback reason names a full disk. The manual
  run's leftover `~/runs/e2e-…` directory has no lease, so the first sweep
  removes it.

### 8.10 Edits to existing files

| File | Edit |
| --- | --- |
| `scripts/gate-slot.sh` (between `:96` and `:97`) | The remote branch of §8.3, behind a cheap shell test for `LLV_GATE_RUNNER` or the config file. |
| `scripts/local-gate.ts:207-236` | `isolatedEnvironment` sets `LLV_GATE_RUNNER=off`. |
| `src/lib/pipelines/publication.ts:16-31` | `^gate-runner: no verdict:` is a deadline-only line. |
| `src/lib/pipelines/git.ts:1565-1602` | The cause text names the runner. |
| `scripts/build-gate.ts` | Bundle `gate-runner/client.ts` and copy `gate-runner/serve.ts` into `dist/gate/gate-runner/`, so the installed wrapper that stage briefs name has the client beside it. |
| `AGENTS.md`, local-hooks section | One paragraph: the runner file, `LLV_GATE_RUNNER=off`, what runs where, and the `gate-runner:` lines. |
| New `scripts/gate-runner/client.ts`, `serve.ts` and their tests | §8.3–§8.9. |
| New `scripts/gate-runner/provision.sh` | §8.5. |

Unchanged: the hook's steps, verdict rules and budgets, `owned-runner.ts`,
`cpu-admission.ts`, local quotas and slots, and the privacy gate. Open draft
#2926 edits `run()` and the `--reuse-slot` lines of `gate-slot.sh`; the new
branch sits after them, so a rebase is small.

### 8.11 Tests that prove it

All tests run isolated: private `HOME`, `TMPDIR` and `LLV_STATE_DIR`, the
Viewer control URL on a closed port, and the configuration file through
`LLV_GATE_RUNNER_CONFIG`.

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
| T4 | Exact tree: staged edit, unstaged edit, untracked file, deleted file, mode change, symlink, tracked file that matches an ignore rule | The runner's `write-tree` differs from `T`; or the local index bytes, `git for-each-ref` output or loose-object count change. |
| T5 | Mirror behind the local `origin/main`, and mirror ahead of it | Either run fails to verify its bundle. |
| T6 | Health probe fails (stub exits 255) | The command does not run here exactly once with the `running here` line, or a second call within 60 s probes again. |
| T7 | Session killed after `started` | The exit is not 75, the `no verdict` line is missing, or the command reruns here. |
| T8 | The command prints a forged `end 0` line, then the stream is cut | The client exits 0. |
| T9 | The stub alters one file in the runner's tree before verify | The command starts, or the exit is not 75. |
| T10 | `SIGTERM` during a sleeping fixture test | `gate-run-<id>` is still active after 15 s, the run directory remains, or the exit is not 143. |
| T11 | Cleanup after pass, fail and cancel; a stale directory with an old lease; a directory with an active unit | A run directory survives its run, the stale one survives the next run, or the active one is removed. |
| T12 | `GH_TOKEN`, `LLV_TOKEN`, `LLV_PRIVACY_KNOWN_VALUES_FILE`, `OPENROUTER_API_KEY` and a driver switch set locally | A secret appears in the remote command's environment, or the switch is missing. Also red when `LLV_GATE_PUSH_DEADLINE` there is more than 2 s off the local remaining budget. |
| T13 | The env classification table | Any `process.env.NAME` in the four drivers or `scripts/local-gate*.ts` is unclassified. |
| T14 | A fixture driver writes `evidence/x/a.json`, `.artifacts/y/b.png` and into an absolute `FOO_DIR` | A file is missing locally. Over the size bound, the exit is not 75 or a partial file appears. |
| T15 | A tree containing a known value from a temporary known-values file | Anything is uploaded, or the command does not run here with the privacy line. |
| T16 | `publicationDeadlineOnly` (`src/lib/pipelines/publication.test.ts`) | It is false for `gate-runner: no verdict:` alone, or true when a `NEW` or `PRIVACY GATE: FAIL` line accompanies it. |
| T17 | `isolatedEnvironment` (`scripts/local-gate.test.ts`) | It leaves `LLV_GATE_RUNNER` other than `off`. |
| T18 | `serve.ts` isolation keys | A key `isolatedEnvironment` replaces is neither given a fresh directory nor mapped to the persistent cache (`XDG_CACHE_HOME`) in `serve.ts`. |

### 8.12 Rehearsal on the real runner and rollout

The build stage runs this rehearsal once, with `LLV_GATE_RUNNER` set to the
configured SSH alias on its own commands only, so nothing else on the
machine changes. It runs before tonight's deletion, or against the next host
once `provision.sh` has set it up, and records the results in its report.

0. **Provisioning.** A second `provision.sh` run against the current runner
   changes nothing, and the health probe then reports it healthy.
1. **The admitted pre-push.** Run it for one lane branch remotely and here, on
   the same tree id. Record the wall times and the client's local CPU (its
   cgroup `cpu.stat`). The `NEW` and `PRE-EXISTING` sets must be equal.
2. ***k*.** The ten heaviest engine test files run remotely and here, one at a
   time on each side. *k* = CPU-seconds here ÷ CPU-seconds there.
3. **Typecheck and build.** Time `bunx tsc --noEmit` through the wrapper,
   remotely and here on the same tree. Time `bun run build` by hand in a run
   directory on the runner, and here, on the same tree. Neither has been
   measured yet.
4. **Drivers.** One case each of the kanban, phone and conversation-window
   drivers, and one board-geometry case, run remotely. Their frames come back
   and are opened here.
5. **Faults.**
   - Kill the client's ssh session mid-run. That must give 75 and leave no run
     directory after the next sweep.
   - Set `LLV_GATE_RUNNER` to an alias that does not resolve, for one command.
     That must give a local run with the `running here` line.

Rollout:

1. After merge and deploy, the seat writes
   `~/.config/delegatus/gate-runner.json`.
2. Before it, and for three days after, the seat records daily:
   - gate CPU on this machine (the §1.2 method);
   - busy CPU (sysstat);
   - Viewer gaps of 1 s or more (§1.4);
   - the fallback count.

The change is working when gate units on this machine average at most 1.5
CPUs a day with the runner healthy; before v1 they ran at 6.9–10.1 CPUs a
day.

Deleting the file, or `LLV_GATE_RUNNER=off`, restores today's behaviour at
once.

### 8.13 Not in v1

- Mirroring the runner's queue wait into this machine's CPU-wait ledger: the
  runner's own deadline already excludes it.
- An agent's direct `bun run build` and other commands whose outputs later
  local commands read.
- Load campaigns and their padding scopes.
- Running the client through a host-side service for agents whose sandbox
  has no network: they fall back to running here.
- Several Bun versions on the runner: a version mismatch falls back.
- A forced command in the runner's `authorized_keys`.
- A dependency cache keyed by lockfile fingerprint: the warm Bun cache makes
  the per-run install about 0.6 s.
- Other projects (Q2).

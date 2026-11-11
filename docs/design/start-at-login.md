# Start at login: one command installs and removes a per-user login service

## Requirement

Recorded on 2026-11-10 in `docs/design/install-and-onboarding-second-view.md`
§10, as the answer to question V2 ("Start with the computer"), answer a:

> Opt-in: one command installs and removes a login service for a packaged
> install on macOS and Linux.

The operator's own wording stays private; the quote above is the decision as
the design records it. The same document gives the reason (§1 part A item 2,
W7): the website's
install prompt starts Delegatus with `nohup`, which ends at the next reboot,
and after a reboot the installed app window shows a connection error until
someone starts Delegatus from a terminal. Slice 5 of its §6 asks for the
command, its doctor row and the install prompt's step, with three review
rounds because it touches launcher and runtime-host lifecycle.

This document states what exists today, chooses one mechanism, gives the two
service files, the refusals, the interplay with a running instance and with
updates, and the acceptance tests. It changes no product code.

## 1. What exists today

All line numbers are at commit `26de6016` (main, 2026-11-11).

### 1.1 The CLI entry and its commands

- `package.json` maps `delegatus` and `dlg` to `bin/cli.mjs`; the file's
  shebang is `#!/usr/bin/env bun` (`bin/cli.mjs:1`).
- Commands: `doctor` is dispatched at module top level, before launcher
  credential custody and release selection (`bin/cli.mjs:1871-1878`). `team`,
  `stop`, `export` and `import` are one-shot commands inside `main()`
  (`bin/cli.mjs:1148-1181`) and pass through the release handoff marked as
  one-shot (`bin/cli.mjs:1742`, `1884`). Anything else is a start: options
  are parsed at `bin/cli.mjs:1182` (`--port`, `--hostname`, `--tailscale`,
  `--no-open`, `--new-token`, `--new-operator-token`).
- Help text lists `doctor` and `stop --all` (`bin/cli.mjs:85`, `98-100`; uk
  `141`, `154-156`).

### 1.2 How a packaged install starts today

`bun add -g delegatus-cli` (`docs/guide/getting-started.md:93-104`). I
observed the layout with a throw-away package under a private `BUN_INSTALL`
in this stage's scratch directory, written `$P` below (Bun 1.4.0, Linux,
2026-11-11):

```text
$ bun add -g ./llv-layout-probe-0.0.1.tgz          # BUN_INSTALL=$P/home/.bun
$P/home/.bun/bin/llv-layout-probe -> ../install/global/node_modules/llv-layout-probe/bin/cli.mjs
$ $P/home/.bun/bin/llv-layout-probe                 # prints import.meta.url and argv[1]
{"meta":"$P/home/.bun/install/global/node_modules/llv-layout-probe/bin/cli.mjs",
 "argv1":"$P/home/.bun/install/global/node_modules/llv-layout-probe/bin/cli.mjs", ...}
$ env -i PATH=/usr/bin:/bin $P/home/.bun/bin/llv-layout-probe
/usr/bin/env: 'bun': No such file or directory
$ bunx --package ./llv-layout-probe-0.0.1.tgz llv-layout-probe
{"meta":"$P/tmp/bunx-1000-@.../node_modules/llv-layout-probe/bin/cli.mjs", ...}
```

So: (a) the command is a symlink into
`~/.bun/install/global/node_modules/delegatus-cli/bin/cli.mjs`, and Bun runs
the resolved path; (b) the shebang needs `bun` on `PATH`; (c) `bunx` runs a
copy under the temp directory, in a directory named after the requested spec.

The website's install prompt (`landing/site/copy.js:33-38`) installs the
package, then starts it with
`nohup ~/.bun/bin/delegatus --no-open > ~/.cache/delegatus/server.log 2>&1 &`
and waits for `http://127.0.0.1:8898/`. `landing/site/copy.test.ts:22` pins
that the MCP step comes after the `nohup` step. Nothing restarts that process
after a crash or a reboot.

### 1.3 Where the claim, the port and the state directory are decided

- **State-owner claim.** The launcher claims `launcher` when nothing is set
  (`bin/cli.mjs:46`); the Viewer child gets `viewer` (`bin/cli.mjs:505`). A
  manual start sets neither in its environment.
- **Port.** `DEFAULT_PORT = 8898`, hostname `127.0.0.1` (`bin/cli.mjs:47-48`);
  the Viewer child gets `PORT` and `HOSTNAME` (`bin/cli.mjs:506-508`).
- **State directory.** `LLV_STATE_DIR`, else `<XDG_CONFIG_HOME or
  ~/.config>/delegatus/state` with the legacy `agent-log-viewer` fallback
  (`bin/server-runtime.mjs:192-197`, `bin/cli.mjs:1650-1657`). Releases live
  under `XDG_CACHE_HOME or ~/.cache` (`bin/cli.mjs:1211`,
  `bin/self-update-supervisor.mjs:58-60`).
- **Install identity.** `installId` is the first 16 hex digits of
  sha256(resolved package root) (`bin/server-runtime.mjs:198`). It names the
  runtime-host socket and fence, the journal (`server-runtime.mjs:202-203`,
  `238-239`), the launcher record, request, release pointer, trial, adopt and
  readiness files (`bin/self-update-supervisor.mjs:48-57`) and the releases
  directory. A service that starts another path gets another identity and
  none of this state.

### 1.4 How the runtime host and the Viewer start, and how they are replaced

- One launcher process starts the runtime host, then the Viewer
  (`bin/cli.mjs:1336-1400`). Startup is serialized by a kernel `flock` per
  install, refused with "Another launcher is starting this installation."
  (`bin/launcher-lock.mjs:7-21`), and refused with "A live launcher already
  supervises this installation." when the record names a live launcher
  (`bin/launcher-adoption.mjs:83-88`, called at `bin/cli.mjs:1219`, `1291`,
  `1324`). A busy port is never taken over unless an adopt record proves the
  holder is this install's Viewer (`bin/launcher-adoption.mjs:93-103`).
- In CLI mode the Viewer binds the port and the runtime host owns its socket
  and singleton fence. The stable listener on the port exists only when
  deployments are enabled (`src/runtime-host/hostRehearsalRun.ts:148`), which
  is the Docker runtime-host shape.
- **Updater.** A packaged install updates from the Update dialog: the release
  is installed into the cache, the pointer `{kind: "package", …}` is written,
  and the launcher relaunches itself with `execve` in the same process
  (`docs/design/self-update-every-install.md` P1.1 and P4, #2495). The design
  states this keeps "supervisor and bootstrap PIDs", so "the bootstrap,
  systemd and `auto.pending.launcherPid` see nothing change" (line 104).
  After a relaunch, the installed `bin/cli.mjs` is a bootstrap that hands off
  to the release's launcher as its child and stays its parent
  (`bin/cli.mjs:1659-1749`).
- On a failed switch or rollback the launcher exits 75 so that "a manager's
  next start can retry the prior release" (`bin/launcher-relaunch.mjs:370`,
  `793`; `docs/design/launcher-start-deadlines.md:17`).
- **Deploy by exact commit.** `deployRevision` serves a checkout or a package
  install whose launcher advertises `relaunch`, through the same relaunch
  (`src/lib/selfUpdate/service.ts:1820-1845`). Automatic updates stay
  unavailable for packaged installs (`service.ts:420`,
  `docs/guide/operations.md:39-40`).
- **What the Viewer knows about user services already.**
  `bin/launcher-service-proof.mjs` proves that a unit runs this install when
  its `ExecStart` names `<root>/bin/cli.mjs` or its `MainPID` is the
  recorded launcher or its bootstrap. `src/lib/selfUpdate/actions.ts` offers
  `restart-service` and `start-service` from that proof (`50-56`, `187-211`)
  and runs them through `systemd-run --user` (`216-229`). `bin/oomPolicy.mjs`
  prints a notice when the unit a launcher runs in uses `OOMPolicy=stop` or
  `kill`. Agent scopes are bound with `BindsTo=` and `After=` to the unit the
  Viewer runs in (`src/lib/runtime/agentMemory.ts:89`, `134`).

### 1.5 What doctor reports today

`delegatus doctor [--json] [--port <n>]` runs seven presence probes
(`bin/doctor.mjs:130-189`, ids in `src/lib/doctor/contracts.ts:1-4`): the two
engine CLIs, the Codex credential file, two transcript roots, local
transcription and `viewer.server`. States are available, degraded, blocked
and unknown; exit 1 means a blocked row (`bin/doctor-command.mjs:84`). The
same registry answers `GET /api/onboarding/diagnostics` for the owner
(`src/app/api/onboarding/diagnostics/route.ts:21`,
`src/lib/team/workspaceRoutes.ts:98`); no UI reads it yet. Its design says
the probes "never … execute subprocesses" (`docs/design/onboarding-diagnostics.md:47`,
#3295). Nothing reports a login service.

### 1.6 What the guides say about systemd

`docs/guide/operations.md:42-48` says a checkout launcher "may also run under
a user systemd service" and points to the migration notice for the retired
`agent-log-viewer` units. `docs/agent-resource-limits.md:74-94` gives the
`OOMPolicy=continue` drop-in for "an existing user-service install".
`docs/deploy-checkout.md` deploys a checkout supervised by a user service and
requires `KillMode=process` (`36-37`, `66-67`). The CLI still prints, when an
`agent-log-viewer*.service` file exists, that "the systemd install of
Delegatus is retired: Docker is the only install" (`bin/legacySystemd.mjs:58`,
#2112, 2026-09-24); that sentence is about the tmux-era units and becomes
untrue for packaged installs once this lands.

The maintainers' own checkout runs as a user service named
`delegatus.service` with `Restart=on-failure`, `RestartSec=5`,
`TimeoutStopSec=120`, an explicit `PATH`, and drop-ins for `KillMode=process`
("the launcher stops its serving children; preserve independent agent
processes"), `OOMPolicy=continue` and CPU placement
(`docs/design/self-update-every-install.md:57`; read with `systemctl --user
cat`, nothing changed). It is the one service shape the launcher has run
under in production.

### 1.7 The user service manager on Linux

Read-only on this machine (systemd 255):

```text
$ systemctl --user show-environment | grep ^PATH=
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin:/snap/bin
$ systemctl --user show -p DefaultStartLimitIntervalUSec -p DefaultStartLimitBurst
DefaultStartLimitIntervalUSec=10s
DefaultStartLimitBurst=5
```

The manager's `PATH` has neither `~/.bun/bin` nor `~/.local/bin`, so a unit
that runs `~/.bun/bin/delegatus` fails at the shebang (§1.2). With
`RestartSec=5` the default limit of 5 starts in 10 seconds is never reached,
so the checkout unit above has no bound on a crash loop.

A private user manager can run here. In a delegated transient scope I
started `/lib/systemd/systemd --user --unit=probe.target` with private
`HOME`, `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`, `XDG_DATA_HOME` and
`XDG_STATE_HOME` under the stage scratch directory, confirmed that
`systemctl --user` reached it (its `UnitPath` listed the private directory),
enabled and started a unit whose command exits 1 with `Restart=on-failure`,
`RestartSec=1`, `StartLimitIntervalSec=60`, `StartLimitBurst=3`, then
disabled it and stopped the manager with `systemctl --user exit`:

```text
Created symlink $PRIV/config/systemd/user/default.target.wants/hello.service → …/hello.service.
Result=exit-code  NRestarts=3  ExecMainStatus=1  LoadState=loaded
ActiveState=failed  SubState=failed  UnitFileState=enabled
Removed "$PRIV/config/systemd/user/default.target.wants/hello.service".
manager exit=0
```

No process was left behind. The limit ended the loop with
`ActiveState=failed` and `Result=exit-code`; the doctor row must therefore
read `ActiveState` and `NRestarts` and never wait for
`Result=start-limit-hit`.

### 1.8 Earlier work

Transcript searches scoped to this project (launchd and LaunchAgents; a
systemd unit for a packaged install; restart-service and the unit proof) and
one unscoped search (reboot, `nohup`, connection error), plus a memory search
on login services, found no earlier design of a login service for a packaged
install. They found only the install designs below. The work this builds on:

- `docs/design/install-and-onboarding.md` (#3817) and
  `install-and-onboarding-second-view.md` (#3839): the requirement.
- `docs/design/self-update-every-install.md` (#2495): relaunch in place, the
  packaged pointer, the service proof and `restart-service`/`start-service`.
- `docs/design/launcher-start-deadlines.md` (#3681): exit 75 for a manager.
- `docs/design/agent-memory-isolation.md` (#2418): `Restart=on-failure`
  recovery after a Viewer kill, `OOMPolicy=continue`, scopes bound to the unit.
- `docs/design/onboarding-diagnostics.md` (#3295): the doctor registry.
- #2112: the tmux-era systemd units retired; #3252: `delegatus stop --all`.

## 2. Options

| # | Mechanism | Verdict |
|---|---|---|
| A | A unit or agent that runs the CLI start command: `<bun> <root>/bin/cli.mjs --no-open --port <p>`, with `<root>` the resolved global install | **Chosen.** The same entry, claim, port, state directory and `installId` as a manual start. Updates replace the release inside the running launcher, so the service manager sees one process throughout. The existing unit proof (§1.4) matches its `ExecStart`, so `start-service` and `restart-service` work unchanged. |
| B | A unit that runs the current release's launcher directly (`~/.cache/delegatus/self-update/<id>/releases/npm-<v>/bin/cli.mjs`) | Rejected. Another root gives another `installId` (§1.3). Release retention can delete the directory. The bootstrap's checks on the pointer and its hand-made-upgrade rule are skipped. |
| C | Two units, one for the runtime host and one for the Viewer | Rejected, OVER-BUILT. It duplicates the launcher's supervision, record and relaunch, which the updater and deploy by exact commit require (`service.ts:1843-1846`). |
| D | A unit that runs `~/.bun/bin/delegatus` | Rejected. The shebang needs `bun` on the manager's `PATH`, which it lacks (§1.7). The unit proof matches `<root>/bin/cli.mjs` and misses a symlink. |
| E | A unit that runs `bunx delegatus-cli` | Rejected. It runs a temp copy with its own identity and downloads on start. |
| F | Desktop autostart (`~/.config/autostart`, macOS Login Items) | Rejected. It runs only in a graphical session, restarts nothing after a crash, and doctor cannot read its state. |
| G | Docker with a restart policy | Exists already for long-running servers (`docs/docker.md`). Out of scope: the requirement names the packaged install. |

## 3. The design

### 3.1 Commands

```text
delegatus service install [--port <n>]
delegatus service remove
```

Checking is `delegatus doctor` (§3.9). Both commands are dispatched at module
top level next to `doctor` (`bin/cli.mjs:1871`), before credential custody,
release selection and every start side effect. They run the code of the
installed command, which is the bootstrap the service will start. The install
root is `findPackageRoot(cliDir)`. When the CLI runs inside a release handoff
(`LLV_LAUNCHER_REEXEC=1`), the installed command predates `service`; the
release refuses with "Your installed command is older than this release. Run
`bun add -g delegatus-cli@latest`, then run this again." It writes nothing.
The older bootstrap then falls back to its own launcher and prints its
unknown-option error (`bin/cli.mjs:1742-1745`); the guide names the same
update. Refusing here also keeps the stop fix of §3.8 in the bootstrap the
service starts. Neither command needs elevation, and both refuse to run as
root.

Both print in English or Ukrainian by the CLI's existing language rule
(`bin/cli.mjs:72-77`) and add `service install|remove` to the help text.

### 3.2 Linux: `~/.config/systemd/user/delegatus.service`

```ini
# Written by "delegatus service install". "delegatus service remove" deletes it.
[Unit]
Description=Delegatus
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
ExecStart=<bun> <root>/bin/cli.mjs --no-open --port <port>
Environment="PATH=<PATH at install time>"
Environment="<NAME>=<value>"   # one line per captured setting, see below
Restart=on-failure
RestartSec=5
KillMode=process
TimeoutStopSec=120
OOMPolicy=continue
OOMScoreAdjust=100

[Install]
WantedBy=default.target
```

- `<bun>` is `process.execPath` of the installing process. When a `bun`
  found on `PATH` resolves to the same file, that `PATH` entry is written, so
  an upgrade that keeps the link keeps the unit valid. `<root>` is the
  resolved install root. Both are absolute, so the unit proof
  (`bin/launcher-service-proof.mjs:48-58`) matches `ExecStart`.
- The directory is the one the manager reads: `$XDG_CONFIG_HOME/systemd/user`
  when the manager's own environment (`systemctl --user show-environment`)
  sets `XDG_CONFIG_HOME`, else `~/.config/systemd/user` under the account's
  home. A shell's `XDG_CONFIG_HOME` does not move it, because the manager
  never sees that shell.
- **Rendering.** Values are quoted, and `%` is written `%%` because systemd
  expands specifiers in `ExecStart=` and `Environment=`; the plist is
  XML-escaped. A path or value with a newline, a `"` or a control character
  is refused.
- **Captured settings.** `PATH` always. `XDG_CONFIG_HOME` and
  `XDG_CACHE_HOME` always hold the effective absolute paths from the
  installing shell, falling back to its home's `.config` and `.cache`.
  `LLV_STATE_DIR` always holds the effective absolute state directory,
  including the legacy-directory fallback. `DELEGATUS_STATE_DIR` holds the
  same value because the CLI folds that alias over `LLV_STATE_DIR`.
  This pins defaults as well as explicit settings: a user manager passes
  its own environment to jobs, and its conflicting state aliases or XDG
  roots must not change the launcher record, release pointer, runtime-host
  endpoint or cache. Relative state, config or cache paths are refused
  before writes or manager calls. These rules also apply to the macOS
  agent. The remaining settings are copied only when set: `LANG`, `LC_ALL`, `LLV_LANG`;
  and the telemetry opt-outs `DELEGATUS_TELEMETRY`, `LLV_TELEMETRY` and
  `DO_NOT_TRACK` (`src/lib/telemetry/store.ts:41-45`), so a person who opted
  out in their shell stays opted out. Nothing else is copied: no access key,
  no API key, no `LLV_STATE_OWNER`. The unit therefore never sets
  `LLV_TOKEN`, `LLV_PUBLIC_HOST`, `LLV_TS_HOST` or `LLV_TS_URL`, the settings
  whose difference makes a start discard an open credential handoff
  (`bin/launcher-credentials.mjs:25`, `256-259`). Install computes the state
  directory under the unit's environment, with `HOME` from the account
  database as the manager sets it, and refuses if it differs from its own.
- **Why these lines.** `Restart=on-failure` restarts after a crash and after
  exit 75. `KillMode=process`, `TimeoutStopSec=120`, `OOMPolicy=continue`
  and `OOMScoreAdjust=100` repeat the production checkout service and the
  drop-in the docs ask for (§1.6). systemd's manual says `process` is "not
  recommended" because processes "escape the service manager's lifecycle"
  (`systemd.kill(5)`); here that is the intent: the launcher stops its
  Viewer and runtime host in order and retires every Viewer generation
  before it exits (`bin/cli.mjs:562-570`, `1058-1065`), and agent hosts are
  meant to outlive the launcher. The start limit bounds a loop at 5 starts
  in 10 minutes (§3.8). Phone access needs no flag: the remembered
  phone-access file applies to every start (`bin/cli.mjs:1185-1188`).
- Left out on purpose: CPU placement (`bin/install-cpu-placement.mjs --unit
  delegatus.service` adds it), `LimitNOFILE` (a manual start has the shell's
  limit), `After=network-online.target` (a user manager cannot order on the
  system target).
- **Logs** go to the journal: `journalctl --user -u delegatus.service`. The
  CLI already keeps service diagnostics when `JOURNAL_STREAM` is set
  (`bin/cli.mjs:1263`).
- **When it runs.** `default.target` of the user manager starts at the
  first login and stops after the last logout, unless lingering is on for
  the account. The guide says so and leaves `loginctl enable-linger` to the
  person.

### 3.3 macOS: `~/Library/LaunchAgents/org.delegatus.server.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by "delegatus service install". "delegatus service remove" deletes it. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>org.delegatus.server</string>
  <key>ProgramArguments</key>
  <array>
    <string><bun></string><string><root>/bin/cli.mjs</string>
    <string>--no-open</string><string>--port</string><string><port></string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string><PATH at install time></string><!-- and the captured settings --></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>ExitTimeOut</key><integer>120</integer>
  <key>StandardOutPath</key><string><home>/Library/Logs/Delegatus/server.log</string>
  <key>StandardErrorPath</key><string><home>/Library/Logs/Delegatus/server.log</string>
</dict>
</plist>
```

From `launchd.plist(5)`: with `SuccessfulExit` false "the job will be
restarted in the inverse condition", that is after a non-zero exit, so exit 0
from a stop ends it and exit 1 or 75 restarts it; "by default, jobs will not
be spawned more than once every 10 seconds" (`ThrottleInterval`); without a
`ProcessType` "the system will apply light resource limits to the job,
throttling its CPU usage and I/O bandwidth", while `Interactive` jobs "run
with the same resource limitations as apps, that is to say, none", which I
take to match a start from Terminal (unconfirmed, §5); `ExitTimeOut` is the wait between SIGTERM
and SIGKILL. The captured settings are the same as on Linux. launchd does not
rotate the log; the CLI already bounds diagnostic volume for packaged
installs (`bin/cli.mjs:1270-1272`).

The agent is loaded into the login session with `launchctl bootstrap
gui/<uid> <plist>` and removed with `launchctl bootout gui/<uid>/org.delegatus.server`.
Install first reads `launchctl print-disabled gui/<uid>` and, after proving
the plist is owned, calls `launchctl enable gui/<uid>/org.delegatus.server`
only when that label has a persisted disabled override. This precedes
bootstrap or kickstart and also restores login startup when a running
agent was disabled. A missing override means enabled; an unreadable list
refuses install before writing. `disable` persists across boots until
`enable`, independently of the plist ([launchctl(1)](https://keith.github.io/xcode-man-pages/launchctl.1.html)).
The `gui/<uid>` domain is the one Terminal and apps run in. Engine CLIs that
keep their login in the keychain need it; whether they read it from a launchd
agent is unconfirmed (§5).

### 3.4 Install

In order, each step printed:

1. Run the refusals of §3.6. A refusal writes nothing and exits 1.
2. Render the file. If the target exists with the marker line and the same
   bytes, write nothing. If it exists with the marker and different bytes
   (Bun moved, port changed), replace it by writing a temporary file and
   renaming it over the target. If it is absent, create it with an exclusive
   create (`O_EXCL`), so a file another process created meanwhile is refused
   and never overwritten. The marker check happens inside that write.
3. Linux: `systemctl --user daemon-reload`, then `systemctl --user enable
   delegatus.service`, and `reset-failed` when the unit is failed. macOS: the
   log directory is created, and a persisted disabled override is cleared
   with `enable` before any start. An already enabled agent receives no
   enable command.
4. Start now only when nothing serves this install: no live launcher in this
   install's record (the check of `bin/launcher-adoption.mjs:83-88`) and the
   port is free. Linux: `systemctl --user start delegatus.service`. macOS:
   `launchctl bootstrap gui/<uid> <plist>` (when it is not loaded yet;
   otherwise `launchctl kickstart`). If Delegatus already runs, say: "Delegatus
   is already running, started another way. The service starts it at your next
   login. To switch now: `delegatus stop --all`, then run `delegatus service
   install` again." If the port belongs to something else, name the port.
5. Print what was written: the file path, the start command, the names of
   the captured settings, the log command, and "Undo: `delegatus service
   remove`". Check with `delegatus doctor`.

When the file changed while the service runs, install does not restart it,
because a restart stops agents bound to the unit (§1.4). It prints that the
change applies at the next start (on macOS, at the next login, because launchd
keeps the loaded definition) and how to restart at a quiet moment.

A second run with nothing changed writes nothing, calls nothing that changes
state, and prints "Already installed".

### 3.5 Remove

1. If the target file is missing and the manager has no unit or job of that
   name: print "Not installed. Nothing to remove." and exit 0. A second run
   ends here.
2. If the file lacks the marker: refuse and name the file. It is never
   removed.
3. Linux: `systemctl --user disable --now delegatus.service`, delete the
   file, `daemon-reload`, `reset-failed delegatus.service` (an error here is
   ignored). macOS: `launchctl bootout gui/<uid>/org.delegatus.server` (not
   loaded is fine), delete the plist, then the log file and its directory
   when empty.
4. Print what was removed. If the service was running, say that Delegatus
   stopped and that `delegatus` starts it from a terminal. A drop-in
   directory the person made (`delegatus.service.d/`) is theirs: it is left
   and named.

### 3.6 Refusals

Each prints one plain sentence with the reason and what to do instead.

| Case | How it is detected | Message, in short |
|---|---|---|
| Windows or another OS | `process.platform` | Start at login exists on Linux and macOS. |
| Run as root | `process.getuid() === 0` | Run it as the user who uses Delegatus, without sudo. |
| Container | `LLV_DOCKER_NSENTER_SHIMS=1`, `/.dockerenv` or `/run/.containerenv` | Use the container's restart policy (`docs/docker.md`). |
| No user service manager | Linux: `systemctl` missing, or `systemctl --user show --property=Version` fails within 5 s. macOS install: `gui/<uid>` unavailable, or disabled overrides unreadable. | Use a desktop login session with a per-user service manager. |
| Not running under Bun | `process.versions.bun` absent | The service runs Delegatus with Bun; run the command where `bun` runs Delegatus. |
| A checkout | `<root>/.git` exists | A checkout keeps its own unit and deploy procedure (`docs/guide/operations.md`, `docs/deploy-checkout.md`). |
| A temporary copy | root under the temp directory or a `bunx-<uid>-` path segment (§1.2) | Install the command with `bun add -g delegatus-cli`, then run `delegatus service install`. |
| A release, or an incomplete package | `LLV_LAUNCHER_REEXEC=1`, root under the releases directory, or no `dist/standalone/server.js` and `dist/runtime-host.mjs` | Run the installed `delegatus` command (§3.1). |
| A foreign file with the same name | target exists without the marker; on Linux also a `FragmentPath` elsewhere, such as `/etc/systemd/user` | Names the file; nothing is changed. |
| Different state directory | §3.2 parity check | Names both directories. |
| Bad `--port` | the CLI's existing `parsePort` | The existing message. |

macOS install requires a graphical login domain. Without one (for example,
an SSH-only session), or when its disabled overrides cannot be read, install
refuses before writing: it cannot confirm or restore login startup there.
Remove can still delete an owned, unloaded plist without that domain and
never changes disabled overrides. A later install reads the persisted
override again and enables the agent if necessary.

### 3.7 A Delegatus that is already running

The service starts the same root, so every existing guard applies to it:

- Install never starts it while this install has a live launcher (§3.4).
- A terminal start while the service runs is refused at
  `assertLauncherAvailable` with "A live launcher already supervises this
  installation.", before it writes a record, takes the port or starts a
  child. What runs before that refusal: credential restore (which keeps an
  open handoff, `bin/launcher-credentials.mjs:252`), skill links (none for a
  package, `bin/skillLinks.mjs:10-11`), and the startup lock file.
- A service start while a terminal instance runs (only after the service's
  own instance died) is refused the same way, exits 1 and is retried within
  the limits of §3.8. On Linux it then stays failed; on macOS it is retried
  every 10 seconds and takes over within 10 seconds of the other instance
  stopping.

### 3.8 Updates, deploy by exact commit, stop, and crash loops

- **Update dialog and deploy by exact commit.** Both relaunch the launcher in
  place (§1.4). The unit's main process is the launcher or its bootstrap and
  keeps its PID, so systemd and launchd see no change. A refused switch exits
  75 after restoring the pointer. When the bootstrap is the parent, it starts
  its own launcher on the restored pointer (`bin/cli.mjs:1742-1745`); when the
  launcher is the unit's main process, the manager restarts it after
  `RestartSec` or the throttle, and the start follows the restored pointer.
- **`start-service` and `restart-service`.** The unit names
  `<root>/bin/cli.mjs`, so `serviceFor` and the proof select it
  (`src/lib/selfUpdate/actions.ts:50-56`). These actions are for launchers
  without `relaunch` and are systemd only; a new install has `relaunch`.
- **`delegatus stop --all`.** It sends SIGTERM to the recorded launcher, which
  exits 0 (`bin/cli.mjs:1076-1078`); neither manager restarts after exit 0.
  The unit stays inactive until the next login or `systemctl --user start
  delegatus.service` / `launchctl kickstart gui/<uid>/org.delegatus.server`.
  One risk, inferred from code and not run: after an update, the unit's main
  process is the bootstrap and the recorded launcher is its child. That child
  removes its record on shutdown, and the bootstrap's close handler treats a
  child it finds unrecorded as a failed start and starts its own launcher
  (`bin/cli.mjs:1736-1745`). If so, `stop --all` restarts Delegatus at the
  installed version inside the unit, and the same happens to a terminal
  start. Acceptance test L5 checks it first; if it reproduces, the bootstrap
  ends with the child's status once the child has published a healthy
  generation.
- **Crash loops.** Linux: `StartLimitIntervalSec=600` and
  `StartLimitBurst=5` stop the unit after five starts in ten minutes; the
  unit is then `failed` (observed shape in §1.7) and doctor shows it.
  `delegatus service install` again, after the cause is fixed, resets and
  starts it. macOS: launchd has no burst limit; its own bound is one spawn
  per 10 seconds, and doctor shows the loop as restarting. The runtime host's
  own restarts inside a healthy launcher stay with the launcher's backoff
  (`bin/cli.mjs:57-58`) and never reach the manager.
- `src/runtime-host` is untouched, and so is the Bun pin.

### 3.9 The doctor row

One new id, `service.login`, last in `CAPABILITY_IDS`. The probe runs one
read-only command (up to three on macOS) with a fixed argument list, asynchronously
with `spawn`, an `AbortSignal` and the existing 1.5 s deadline, with no
shell. The report carries no path or command output. The row describes the
unit or agent of that name whoever wrote it, so a checkout's own
`delegatus.service` reports as well.
`docs/design/onboarding-diagnostics.md` changes its "never execute
subprocesses" sentence to name this one exception: only the service manager
knows whether a unit is enabled, running or failed.

- Linux: `systemctl --user show delegatus.service --property=LoadState,UnitFileState,ActiveState,SubState,NRestarts`.
- macOS: the plist's presence, then `launchctl print-disabled gui/<uid>`
  for the exact label's persisted override. A true override gives
  `SERVICE_DISABLED` even if the job is loaded or running. An unreadable
  or refused list gives `SERVICE_UNAVAILABLE`; it never implies enabled.
  If enabled, `launchctl print gui/<uid>/org.delegatus.server`
  for its exit status only (its text "is NOT API", `launchctl(1)`), then
  `launchctl list org.delegatus.server` for `PID` and `LastExitStatus`. An
  answer it cannot parse gives `unknown`.
- Windows and containers answer without running anything.

| Observation | State | Reason | Human line (en) |
|---|---|---|---|
| Unit or plist absent | degraded | `SERVICE_NOT_INSTALLED` | Not installed: Delegatus does not start at login. `delegatus service install` adds it. |
| Installed, disabled | degraded | `SERVICE_DISABLED` | Installed and turned off. `delegatus service install` turns it on. |
| Installed, enabled, not running, no failure | degraded | `SERVICE_NOT_RUNNING` | Installed and enabled. It starts at the next login. |
| Restarting (`activating`/`auto-restart`; macOS no PID and a non-zero last exit) | degraded | `SERVICE_RESTARTING` | It keeps failing to start. See its log. |
| `failed` | degraded | `SERVICE_FAILED` | It stopped after repeated failures. Read the log, fix the cause, run `delegatus service install`. |
| Running | available | `SERVICE_RUNNING` | Installed, enabled and running. |
| No user manager, container, Windows | unknown | `SERVICE_UNAVAILABLE` | No per-user service manager here. |

No state is `blocked`: the row never changes the exit code, because the
service is optional and `viewer.server` already reports an unreachable
Delegatus. The Ukrainian label is "Запуск під час входу". Every reason has a
Ukrainian sentence. The log hint names `journalctl --user -u
delegatus.service` on Linux and `~/Library/Logs/Delegatus/server.log` on
macOS.

### 3.10 The install prompt and the guides

- **Prompt** (`landing/site/copy.js:33-38`): step 4 becomes one optional
  step. "Ask me whether Delegatus should start by itself whenever I log in.
  If yes, run `~/.bun/bin/delegatus service install`; it starts Delegatus now
  and at every login and prints how to remove it. If I say no, or the command
  refuses, start it in the background:" followed by the existing `nohup` line
  and the existing 60-second wait. The prompt keeps its order, so
  `copy.test.ts:22` still holds. No new test checks the prompt for phrases,
  which AGENTS.md forbids; review reads the rendered prompt in both
  languages.
- **`docs/guide/getting-started.md`**: one subsection "Start at login" under
  "Keep a command installed", and step 4 of the agent install list.
- **`docs/guide/operations.md`**: "Running as a user service" covers both:
  a packaged install uses `delegatus service install`, `delegatus doctor` and
  `delegatus service remove`, its logs, the 5-in-10-minutes limit and
  lingering; a checkout keeps its own unit as today.
- **Stale text to repair in the same change**: `bin/legacySystemd.mjs:48-63`
  ("Docker is the only install") names the current ways to start, including
  this command; `docs/agent-resource-limits.md:74` says the installed unit
  already sets the OOM lines; the comment at `bin/cli.mjs:1469-1470` says
  restart requests come only from a checkout, which #2495 changed; and the
  CHANGELOG entry.

## 4. Acceptance tests

Run each file by path through `scripts/gate-slot.sh`, with private `HOME`,
`XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`, `TMPDIR` and
`LLV_STATE_DIR`, and `LLV_VIEWER_CONTROL_URL` on a closed port. No test
touches the real user manager, a real `~/.config/systemd/user`, a real
`~/Library/LaunchAgents` or the running Delegatus. Service managers are
stubbed by injected ports or by stub `systemctl`/`launchctl` executables on
`PATH`.

Unit tests:

- **U1** The rendered unit for given inputs equals the expected text byte for
  byte, including a root with a space and a `%` in it. Where
  `systemd-analyze` exists, `systemd-analyze --user verify` on the rendered
  file in scratch passes. A stubbed manager environment with
  `XDG_CONFIG_HOME` moves the target directory; the shell's own does not.
- **U2** The rendered plist equals the expected text and parses as a plist
  with the keys of §3.3.
- **U3** Idempotence: a second install with the same inputs writes nothing
  and issues no enable or start; a changed Bun path rewrites the file and
  issues `daemon-reload` without restart.
- **U4** Each refusal of §3.6 writes nothing and issues no manager call.
- **U5** Remove twice: the first deletes the file and issues `disable --now`,
  `daemon-reload` and `reset-failed`; the second prints "Not installed" and
  exits 0. A foreign file survives remove byte for byte.
- **U6** A live launcher record for this install (a fixture child with its
  real start identity): install enables and issues no start.
- **U7** With `LLV_TOKEN`, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` set, none
  appears in the rendered file; `DO_NOT_TRACK=1` and `XDG_CONFIG_HOME` do.
- **U8** The state directory and `installId` derived from the unit's
  environment equal those of `cliRuntimeHostConfig` in the installing process.
  Run the real CLI with the rendered unit or plist environment merged over
  conflicting manager `LLV_STATE_DIR`, `DELEGATUS_STATE_DIR`, config and
  cache roots. Its launcher record, release pointer, runtime-host paths and
  releases directory equal a manual start for default paths, explicit paths,
  alias precedence and existing legacy directories. Refuse relative roots
  before writes or manager calls.
- **U9** A persisted disabled macOS agent is enabled before bootstrap;
  reinstalling an enabled agent leaves it running without mutations.
  Cover loaded and unloaded jobs, enable refusal and retry, unreadable
  overrides, foreign plists and replacement during enable. Remove twice
  never enables a disabled job. A missing graphical domain refuses install
  before writes.
- **D1** Each row of the §3.9 table from stubbed manager output, in JSON and
  human output, en and uk; a hung stub ends as `PROBE_TIMEOUT` within the
  deadline; no report contains a path. `bin/doctor.test.ts:99` still
  compares the ids with `CAPABILITY_IDS`.
- **W1** The existing `landing/site/copy.test.ts` passes unchanged after the prompt edit of §3.10.

Linux, real (a private user manager, the recipe of §1.7: a delegated
transient scope, `systemd --user --unit=<private target>`, private runtime
and config directories, `systemctl --user exit` at the end, the scope's PID
recorded at start). The package root is a fixture with stub Viewer and
runtime host, as `bin/cli.selfUpdate.integration.test.ts` builds them, on a
port read back from a port-0 bind:

- **L1** Install starts the unit; the launcher record appears, its
  launcher or bootstrap is the unit's `MainPID`, and the port answers. The
  doctor row is `SERVICE_RUNNING`.
- **L2** A fixture whose launcher exits 1 ends `ActiveState=failed` within
  the start limit, and doctor shows `SERVICE_FAILED`.
- **L3** With the unit running, a terminal start of the same root exits
  non-zero with the live-launcher refusal; the record, the PIDs and the
  listener are unchanged.
- **L4** A relaunch request under the unit moves to the new release with the
  unit's `MainPID` unchanged and the unit active.
- **L5** With a release pointer, `delegatus stop --all` leaves the unit
  inactive and no launcher running (§3.8 risk).
- **L6** Remove stops the unit, deletes the file, and `systemctl --user show`
  reports `LoadState=not-found`.

If the private manager cannot start on the machine that runs the build,
L1-L6 are reported as not run, with the error.

macOS, open: a run on a real Mac is unavailable here. The pull request lists
it as an open verification, never as passed: install from a terminal; log out
and in; `delegatus doctor`; an agent of each engine signs in from the
service; an update from the dialog; `stop --all`; a crash loop; remove.

## 5. What could not be confirmed, and where I looked

| Question | Where I looked | Status |
|---|---|---|
| launchd behaviour of the plist under the pinned Bun | `launchd.plist(5)` and `launchctl(1)` (Xcode man pages, keith.github.io/xcode-man-pages); nothing in this repository | Documented only; needs a Mac |
| Whether Claude Code and Codex read their keychain login when started from a `gui/<uid>` launchd agent | Nothing found in this repository | Unknown; part of the Mac run |
| Whether launchd restarts a job killed by a signal with `SuccessfulExit` false | `launchd.plist(5)` describes `SuccessfulExit` by exit status and `Crashed` by crash signals | Unknown; part of the Mac run |
| `launchctl list <label>` output keys on current macOS | `launchctl(1)` calls `list` legacy and `print` output not API | The row falls back to `unknown`; part of the Mac run |
| Where `process.execPath` points for a Homebrew Bun | Observed only for Bun's own installer (`~/.bun/bin/bun`) | The `PATH` preference of §3.2 covers a stable link; unconfirmed |
| `delegatus stop --all` restarting a bootstrap's launcher | `bin/cli.mjs:1736-1745`, `bin/stop-all.mjs:347-358` | Inferred from code; L5 decides |
| Whether a GitHub-hosted macOS runner has a `gui/<uid>` domain for a CI smoke run | `platform-tests.yml` runs macOS jobs today | Not checked; deferred |
| Bun's `bunx` directory naming for a registry spec | Observed for a local tarball spec only | The refusal also matches any root under the temp directory |

What was run here: the Bun layout probe (§1.2), the read-only manager reads
(§1.7) and the private user manager probe (§1.7), all in this stage's
scratch directory, with every process started by the probe ended by its
recorded identity. No service was installed, enabled, started or stopped on
this machine's user manager, and no Delegatus process was touched.

## 6. Deferred — not currently justified

- **On by default.** The requirement says opt-in.
- **Windows.** The requirement names macOS and Linux; native Windows cannot
  run the orchestrator's MCP server (`install-and-onboarding-second-view.md`
  §4).
- **A system-wide service, and enabling lingering for the person.** Both
  need elevation or change login policy; the guide names `loginctl
  enable-linger` as the person's choice.
- **A signed app, a menu-bar item, and any change to the first-run guide's
  UI.** Second view §7.
- **A `service status` command.** `delegatus doctor` answers it.
- **Checkout installs.** They keep their own unit and the deploy procedure.
- **CPU placement and `LimitNOFILE` in the generated unit.** Neither is part
  of a manual start; `bin/install-cpu-placement.mjs` adds the first.
- **A burst limit of our own on macOS, and log rotation there.** launchd's
  throttle bounds the loop; revisit if a loop fills the log in practice.
- **A launchd smoke run in CI.** Revisit after the first Mac run shows which
  steps a runner can reproduce.

## 7. Check against the requirement

| Point | Where |
|---|---|
| One command installs, one removes | §3.1, §3.4, §3.5 |
| A per-user login service on Linux and macOS | §3.2, §3.3 |
| Opt-in, nothing without the command | §3.4; §6 |
| For a packaged install | §3.6 refuses checkouts and temporary copies |
| Same entry, claim, port and state as a manual start | §1.3, §3.2, U8 |
| No fight with a running Delegatus | §3.4 step 4, §3.7, L3 |
| Updates and deploy by exact commit keep working | §3.8, L4 |
| Bounded crash loop, visible in doctor | §3.8, §3.9, L2 |
| Doctor row in JSON and human output | §3.9, D1 |
| Install prompt step and guides | §3.10, W1, review of the rendered prompt |
| The app window after a reboot | Linux: L1 plus `default.target`; macOS: the open Mac run |

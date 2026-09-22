# Self-update prototype — design (#2007)

## Originating requirement

Operator request, 2026-09-22, paraphrased into English from the pipeline
specification for issue #2007:

> A standalone self-update prototype, deliberately not wired into the Viewer
> yet, that the operator opens by link and tries against a duplicate Viewer
> pinned to an older commit. It shows how an install updates itself and
> restarts its two processes separately: an update-available check, a staged
> update with live steps, separate web and runtime-host restarts, and a
> changelog summary.

Everything below is validated against that requirement. What the requirement
does not demand is kept in "Deferred" at the end.

## Prior work

`search_transcripts` was run in five phrasings (self-update prototype, restart
of the runtime host standalone, config-root isolation for builds, ls-remote
update check, runtime host restart dropping agents), project-scoped and
unscoped. Nothing existed on self-update or on restarting the runtime host
outside the CLI. Three hits on config-root isolation came from the #1870
slice-7 lanes; their conclusion is already current code and prose
(`src/lib/stateOwnership.ts`, the "Only a declared owner resolves the
operator's state directory" section of `AGENTS.md`), so this design cites those
rather than the transcripts.

## What the code says today

The prototype reproduces, standalone, what `bin/cli.mjs` does for a packaged
install. These are the facts the design rests on, each read from the checkout
at `7fb7345e5`.

**The two processes.** `bin/cli.mjs` starts the runtime host first, then the
web server, and stops both on exit:

| | runtime host | web |
| --- | --- | --- |
| command | `<bun> --bun <entry>` where `<entry>` is `dist/runtime-host.mjs` if present, else `src/runtime-host/main.ts` (`cliRuntimeHostConfig`, `spawnHost`) | `<bun> --bun node_modules/next/dist/bin/next start --hostname 127.0.0.1` (`resolveServer`, the `next start` branch; `.next/standalone` exists only under `LLV_STANDALONE=1`, which `bun run build` does not set) |
| cwd | the checkout | the checkout |
| endpoint | Unix socket `LLV_RUNTIME_HOST_SOCKET`, fence file `LLV_RUNTIME_HOST_FENCE` (`cliRuntimeHostEndpoint`: `<state>/runtime-host-<installId>.sock` and `.sock.lock`) | TCP `PORT` on `HOSTNAME` |
| readiness | socket accepts a connection **and** the fence file's `pid` equals the spawned child's pid (`waitForRuntimeHost`), 15 s budget, 100 ms poll | `GET /api/files` answers 2xx–4xx (`waitForReadiness`), 15 s budget, 200 ms poll |
| stop | `SIGTERM`, then `SIGKILL` after 2 s (`stopChild`). The host's own handler closes the socket server, the journal and releases the fence (`src/runtime-host/main.ts` `stop()`) | same `stopChild` |
| owner token | claims `LLV_STATE_OWNER=runtime-host` itself in its body before any dynamic import (`main.ts`) | `LLV_STATE_OWNER=viewer` set by the CLI (`buildChildEnv`); `package.json`'s `start` script sets the same |

The CLI's `createRuntimeHostSupervisor` also restarts a host that exits after
it was ready, with exponential backoff. The prototype does **not** reproduce
that: a host that dies shows as `failed` and the operator restarts it. Auto
restart is a Viewer concern (Deferred).

**Health beyond readiness.** The host answers a newline-framed JSON request
`{"id":"…","method":"runtime-host-health","params":{}}` with
`{"ok":true,"result":{…pid, generation, phases…}}` (`host.ts`, wired in
`main.ts` to `startup.readyEvidence()`); `scripts/verify-runtime-host.ts`
probes the same socket the same way. The web process answers `GET /` with 200
once it serves.

**The config root.** `src/lib/configDir.ts` resolves state as
`LLV_STATE_DIR` if set, else `$XDG_CONFIG_HOME/agent-log-viewer/state`, else
`~/.config/agent-log-viewer/state`. `XDG_CONFIG_HOME` is the root switch;
`LLV_STATE_DIR` overrides the state directory wholesale; `XDG_CACHE_HOME` moves
the cache. A path under `/tmp` or `/var/tmp` is never classified as the
operator's (`stateOwnership.ts` `underTemp`), which is exactly what lets a
build under an isolated root run without an owner token: `next build` sets
`NEXT_PHASE=…build`, and `admitOperatorDirectory` hands a build a throw-away
directory anyway. The prototype sets all three explicitly and points them under
`/var/tmp`, so the guard and the override agree.

**What else the build and start need.** Per `bin/cli.mjs` and the memory of
the #1905 and standalone-leak incidents:

- `__NEXT_PRIVATE_STANDALONE_CONFIG`, `__NEXT_PRIVATE_ORIGIN`,
  `NEXT_DEPLOYMENT_ID` must be **absent** for a clean `next build` (a leaked
  serialized config bypasses `next.config.ts`).
- `NODE_ENV` must be absent for the build and the start (the rehearsal deletes
  it too); `PORT` and `HOSTNAME` are set per process, never inherited (zsh
  exports `HOSTNAME` as the machine name).
- Every inherited `LLV_*` is dropped before the prototype sets its own: a
  stage shell carries the lane's `LLV_STATE_DIR`, `TMPDIR` under the
  operator's `scratch`, and the Viewer's socket. `TMPDIR` is set to a
  directory under the bench root for the same reason.
- The host needs `LLV_RUNTIME_HOST_SOCKET`, `LLV_RUNTIME_HOST_FENCE`,
  `LLV_RUNTIME_JOURNAL`, `LLV_STRUCTURED_HOSTS=1`, `LLV_RUNTIME_EVENTS=1`,
  `LLV_SPAWN_TRANSPORT=structured`, `NEXT_PUBLIC_RUNTIME_UI=1`
  (`cliRuntimeHostEnvironment`). The web process gets the same set so it finds
  the host. `LLV_VIEWER_DEPLOYMENTS` stays **unset**: with it the host binds a
  stable listener on `LLV_VIEWER_PORT` and needs a deploy adapter and Docker,
  none of which the prototype has.
- The interpreter is the pinned Bun 1.4.0 (`Dockerfile`), on this machine at
  `~/.cache/llv-bun-1.4.0/bin/bun`. Bun 1.3.3 boots the build and then answers
  500 on every route; the prototype and bench run under `process.execPath` and
  pass that path down, never a bare `bun`.
- A fresh checkout needs `bun install --frozen-lockfile` before `tsc` or
  `next` (no `node_modules` in a clone).

**The Docker release flow this prototype is the sibling of.** In
`docs/RELEASING.md` a release is `POST /api/runtime/deployments` with
`{"revision":"<full sha>","idempotencyKey":"…"}` or
`{"ref":"refs/heads/main","idempotencyKey":"…"}`, admitted by the runtime host,
which builds the revision from its canonical mirror into a candidate container,
health-gates it, and atomically repoints the stable listener; the runtime host
itself hands over to a successor generation through the singleton fence. The
prototype has no mirror, no candidate and no fence handoff: it builds **in
place** and restarts **by PID**. The canonical remote is
`https://github.com/Latand/live-log-viewer-next.git` (overridable with
`LLV_VIEWER_CANONICAL_REMOTE`), and an anonymous `git ls-remote` against it
answers `refs/heads/main` without credentials (checked 2026-09-22).

**CHANGELOG format.** Keep a Changelog: `## [Unreleased]` then
`## [1.2.2] — 2026-09-19` headings, `### Added|Changed|Fixed|…` subsections,
`- ` bullets that wrap over several lines and end with `(#issue)`.

## Architecture

One Bun process, one page, no framework, no bundler.

```
prototypes/self-update/
  server.ts          entry: flags → config, Bun.serve, routes, SSE hub, health ticker
  lib/config.ts      flags/env → Config (pure)
  lib/env.ts         child environment builder (pure)
  lib/git.ts         ls-remote, head, fetch tip, commits between, file at rev
  lib/changelog.ts   parse Keep a Changelog, section delta, summary (pure)
  lib/steps.ts       sequential step runner with injected spawn (pure over a port)
  lib/processes.ts   ManagedProcess: start, readiness, stop by PID, health
  lib/state.ts       Snapshot type, store, change subscription
  ui/index.html      the page
  ui/app.ts          renders Snapshot → DOM, EventSource with polling fallback
  ui/app.css         tokens copied from docs/design/viewer-design-system.md
  bench.ts           start | stop
  README.md
  *.test.ts          beside the module they test
```

`ui/app.ts` is served through `new Bun.Transpiler({ loader: "ts" })` on
request (one call, cached in memory), so the UI is TypeScript with no build
step. Nothing under `prototypes/` imports from `src/`, `bin/` or `scripts/`:
the prototype must run against a duplicate checkout whose `src/` is older than
its own, and a shared helper is out of scope. Where the prototype repeats a
pattern from the code (port-0 allocation, fence-owner parse, socket frame) the
comment names the original.

### Configuration

| flag | env | default |
| --- | --- | --- |
| `--checkout <dir>` | `SELF_UPDATE_CHECKOUT` | required |
| `--config-root <dir>` | `SELF_UPDATE_CONFIG_ROOT` | required; refused unless under `/tmp` or `/var/tmp` or explicitly `--allow-any-root` |
| `--web-port <n>` | `SELF_UPDATE_WEB_PORT` | required |
| `--port <n>` | `SELF_UPDATE_PORT` | `0` (kernel picks; printed) |
| `--remote <url>` | `SELF_UPDATE_REMOTE` | `https://github.com/Latand/live-log-viewer-next.git` |
| `--branch <name>` | `SELF_UPDATE_BRANCH` | `main` |
| `--poll-minutes <n>` | `SELF_UPDATE_POLL_MINUTES` | `60` |
| `--bun <path>` | `SELF_UPDATE_BUN` | `process.execPath` |
| `--processes <file>` | | `<config-root>/self-update/processes.json` |

The prototype binds `127.0.0.1` only. It refuses to start when `--config-root`
resolves to anything under `~/.config`, whatever the flags say, and when
`--web-port` is `8898` or `8899`.

### Child environment (`lib/env.ts`)

`childEnv(config, role)` starts from `process.env`, **deletes** every key
matching `/^(LLV_|NEXT_|__NEXT_)/` plus `PORT`, `HOSTNAME`, `NODE_ENV`,
`NEXT_DEPLOYMENT_ID`, `TMPDIR`, then sets:

```
XDG_CONFIG_HOME = <root>                      XDG_CACHE_HOME = <root>/cache
LLV_STATE_DIR   = <root>/state                TMPDIR         = <root>/tmp
LLV_RUNTIME_HOST_SOCKET = <root>/state/runtime-host.sock
LLV_RUNTIME_HOST_FENCE  = <root>/state/runtime-host.sock.lock
LLV_RUNTIME_JOURNAL     = <root>/state/runtime-events.sqlite
LLV_STRUCTURED_HOSTS=1  LLV_RUNTIME_EVENTS=1  LLV_SPAWN_TRANSPORT=structured
NEXT_PUBLIC_RUNTIME_UI=1
```

Then per role: `build` adds nothing (no owner token; the build resolves a
throw-away directory, and the override already points under the root); `web`
adds `LLV_STATE_OWNER=viewer`, `PORT=<web-port>`, `HOSTNAME=127.0.0.1`;
`runtime-host` adds nothing (the entry claims its own owner). `PATH` and `HOME`
stay inherited: a minimal environment breaks Next's compiled runtimes, and Bun
ignores `HOME` for `os.homedir()` anyway. A test pins that a `process.env`
carrying `LLV_STATE_DIR=$HOME/.config/agent-log-viewer/state` and
`__NEXT_PRIVATE_STANDALONE_CONFIG` yields neither.

### HTTP routes

| route | answer |
| --- | --- |
| `GET /` | `ui/index.html` |
| `GET /ui/app.js`, `GET /ui/app.css` | transpiled `app.ts`, the stylesheet |
| `GET /api/state` | the full `Snapshot` (below) |
| `GET /api/events` | SSE: one `state` event carrying the Snapshot on every change, coalesced to at most one per 250 ms; `: keepalive` every 15 s |
| `GET /api/steps/:name/log` | full log of one update step, `text/plain` |
| `POST /api/check` | starts a check; `202` with Snapshot, `409` while an update runs |
| `POST /api/update` | starts an update toward the tip the last check saw; `409` if none available or an action runs |
| `POST /api/update/retry` | reruns from the failed step; `409` unless update is `failed` |
| `POST /api/restart/web` | `202`; `409` while another action runs |
| `POST /api/restart/runtime-host` | body `{"confirm":true}` required, else `400`; `202`; `409` while another action runs |

One mutating action at a time (`update`, `restart web`, `restart runtime
host`); a `check` may run beside a restart but not beside an update, because
the update moves `HEAD`. The UI never reasons about that itself: it disables
buttons from `snapshot.busy`.

SSE over polling: a Next build streams hundreds of log lines over minutes, and
the page must show a step turning `failed` the moment it does. The UI opens
`EventSource("/api/events")`; after two consecutive `error` events it falls
back to `GET /api/state` every second and says so in the footer ("Live updates
unavailable, polling"). Both paths render the same Snapshot, so the render code
has one input.

### Snapshot

```ts
interface Snapshot {
  running:   { version: string; sha: string; short: string; date: string };   // from package.json + git at HEAD
  available: { version: string; sha: string; short: string; date: string } | null;
  check:  { state: "idle"|"checking"|"up-to-date"|"update-available"|"failed";
            at: string|null; error: string|null; nextPollAt: string|null;
            delta: { commits: {short:string; subject:string}[]; changelog: ChangelogDelta } | null };
  update: { state: "idle"|"running"|"done"|"failed"; target: string|null;
            steps: Step[]; startedAt: string|null; finishedAt: string|null };
  processes: { web: ProcessStatus; runtimeHost: ProcessStatus };
  busy: "update"|"restart-web"|"restart-runtime-host"|null;
}
interface Step { name: "fetch"|"checkout"|"install"|"build"|"ready";
  state: "pending"|"running"|"done"|"failed"; startedAt: string|null;
  durationMs: number|null; exitCode: number|null; tail: string[] /* last 40 */ }
interface ProcessStatus { state: "stopped"|"stopping"|"starting"|"healthy"|"failed";
  pid: number|null; port: number|null; socket: string|null; startedAt: string|null;
  lastHealthAt: string|null; lastHealthOk: boolean|null; error: string|null }
```

## Process model

A **managed process** is one the prototype started itself. At `spawn` it
records `{ role, pid, startIdentity, startedAt, port|socket }` in memory and
in `processes.json` (atomic rename). `startIdentity` is field 22 of
`/proc/<pid>/stat` (process start time in clock ticks), the same identity
`src/lib/proc` uses; a PID that is reused after a crash will not match it.

Both children are spawned with `detached: true` so each leads its own process
group, `stdio: ["ignore","pipe","pipe"]` so the prototype keeps a 200-line
ring of their output for the status block's "last lines", and the prototype
holds the `ChildProcess` handle for `exit`.

**Stop is by recorded PID only.** `stop(role)`:

1. Read the record. No record → the process is `stopped`; nothing to signal.
2. Re-read `/proc/<pid>/stat`; if the start identity differs, the PID belongs
   to someone else: mark the record stale, report `stopped`, signal nothing.
3. `process.kill(-pid, "SIGTERM")` (the group the recorded PID leads, so a
   worker Next forks goes with it). Wait for exit up to 10 s (the handle's
   `exit`, or `/proc` disappearance when adopted). Then `process.kill(-pid,
   "SIGKILL")` and wait 2 s more. The host's own `SIGTERM` handler closes the
   socket, the journal and the fence, so 10 s is generous; the CLI gives 2 s.
4. Clear the record.

No `pkill`, `killall`, `fuser`, `lsof`, no kill by port or pattern, anywhere,
including `bench.ts`. A grep for those tokens under `prototypes/` is one of the
tests.

**Adoption after a prototype restart.** On boot the prototype reads
`processes.json`; a record whose PID still carries the same start identity is
adopted (status from the next health tick), one that does not is dropped. The
bench's `stop` uses `bench.json` the same way.

**Readiness and health.**

| | ready after start | health every 10 s |
| --- | --- | --- |
| web | `GET http://127.0.0.1:<port>/` is `200`, 90 s budget (cold `next start` on this checkout takes 10–30 s), 500 ms poll | same request, 5 s timeout |
| runtime host | socket connects **and** fence file `pid` equals recorded PID, 15 s budget, 100 ms poll; then one `runtime-host-health` frame answered `"ok":true` | the same frame, 5 s timeout; `result.pid` must equal the recorded PID |

A start whose child exits before readiness is `failed` with the exit code and
the last 40 lines. A health miss flips `healthy → failed` with the error; the
next successful tick flips it back. A restart never runs from a health tick.

**Ports.** The web port is fixed for the life of the prototype (a restart
reuses it). A start that logs `EADDRINUSE` fails with "Port <n> is in use";
the prototype never frees a port.

## Update pipeline

**Check.** `git ls-remote <remote> refs/heads/<branch>` (no objects) and
`git -C <checkout> rev-parse HEAD`. Equal → `up-to-date`. Different → the
check also runs `git -C <checkout> fetch --no-tags <remote>
refs/heads/<branch>:refs/self-update/tip`, which brings objects into the
repository and moves nothing in the working tree or on any branch, and then
computes the delta locally:

- commits: `git log --format=%h%x09%s HEAD..refs/self-update/tip`;
- changelog: `git show refs/self-update/tip:CHANGELOG.md` and
  `git show HEAD:CHANGELOG.md`, parsed by `lib/changelog.ts`;
- available version: `package.json` at the tip, the tip's short SHA and
  `%cI` date.

The poll is `ls-remote` alone; the fetch happens only when something is new.
A tip that is an ancestor of `HEAD` (the checkout is ahead) is reported as
`up-to-date` with "Ahead of origin/main by N". A tip that neither contains nor
is contained by `HEAD` is `update-available` with "Diverged" in the summary;
the update still checks out the exact tip.

**Changelog delta.** Parse both files into `{ heading, sections: { type,
items[] } }` where an item is its bullet text joined to one line. The delta is
every version heading present at the tip and absent at `HEAD`, whole, plus for
`[Unreleased]` every item present at the tip and absent at `HEAD` (compared
after whitespace normalisation). Summary line: `N commits · M changelog
entries (2 Added, 3 Changed, 1 Fixed)`. Below it, per type, each item's first
sentence cut to 160 characters, at most 8 items, then `+k more`. No changelog
difference → `No changelog entries for these commits.`

**Update** runs five steps, each `{ command, args, cwd: checkout, env:
childEnv("build") }`, sequentially, stopping at the first failure, never
starting or stopping a process:

| step | command | done when |
| --- | --- | --- |
| fetch | `git fetch --no-tags <remote> refs/heads/<branch>:refs/self-update/tip` | exit 0 and `git rev-parse refs/self-update/tip` equals the target recorded at update start; else failed with "The remote moved since the last check. Check again." |
| checkout | `git checkout --detach <target sha>` | exit 0 (a dirty checkout fails here with git's own message; nothing is reset) |
| install | `<bun> install --frozen-lockfile` | exit 0 |
| build | `<bun> run build` | exit 0 (`next build --webpack && bun scripts/build-mcp.ts`) |
| ready | `git rev-parse HEAD` equals target and `.next/BUILD_ID` is readable | both true |

Before `install` and `build` the runner reads `/proc/meminfo` `MemAvailable`
and fails the step with "Not enough free memory (N MB available, 4096 needed)"
when it is under 4 GB, without running the command. Step output goes to
`<config-root>/self-update/logs/<step>.log` (truncated per run) and the last
40 lines to the Snapshot. `retry` reruns from the failed step with the same
target. A build in place means the running web process serves the previous
build's HTML while `.next` changes underneath it; asset hashes can 404 until
the restart, which is why the `done` copy says to restart promptly and why the
build stage's evidence run restarts web right after the update.

## State machines and copy

All copy is English. `HH:MM` is local time.

**Check**

| state | copy |
| --- | --- |
| idle | `Not checked yet` · button `Check now` |
| checking | `Checking origin/main…` · button disabled |
| up-to-date | `Up to date, checked at 12:04` · `Next check at 13:04` |
| update-available | `Update available · 5 commits behind origin/main` · the delta · button `Check now` |
| failed | `Check failed at 12:04` · error line in danger, e.g. `fatal: unable to access '…': Could not resolve host` · button `Retry check` |
| any, while update runs | copy unchanged, `Check now` disabled with tooltip `Update in progress` |

**Update**

| state | copy |
| --- | --- |
| idle, nothing available | section hidden except `Run a check to see if an update is available.` |
| idle, available | heading `Update to a1b2c3d (1.2.3)` · primary button `Update` · `This builds the new version. Nothing restarts until you choose to.` |
| running | button replaced by `Updating… step 4 of 5` · steps as below |
| done | `Built a1b2c3d in 4 m 12 s. Running processes still serve the previous version. Restart web, then the runtime host, to apply.` · button `Update` hidden |
| failed | `Update stopped at build after 1 m 03 s. Running processes were not touched.` · button `Retry from build` |

Step rows, one per step, in order: `fetch` → `Fetch a1b2c3d`, `checkout` →
`Check out a1b2c3d`, `install` → `Install dependencies`, `build` → `Build`,
`ready` → `Ready`. Row states: pending `○ Fetch a1b2c3d` muted; running
`◐ Build · 1 m 03 s` accent with the spinner; done `● Build · 4 m 12 s`
success; failed `✕ Build · 1 m 03 s · exit 1` danger; skipped after a failure
stays pending. Each row with output has a `Show log` disclosure (last 40 lines,
mono, sunken) and a `Full log` link to `/api/steps/<name>/log`.

**Restart web** (process block "Web")

| state | copy |
| --- | --- |
| healthy | badge `● healthy` · `PID 48213 · port 45123 · up 2 h 14 m · checked 12:04:31` · button `Restart web` |
| stopping | badge `◐ stopping` · `Stopping PID 48213…` · button disabled |
| starting | badge `◐ starting` · `Starting on port 45123… waiting for HTTP 200` |
| failed | badge `✕ failed` · `Exited with code 1 after 0.8 s` or `No HTTP 200 within 90 s` · last lines disclosure · button `Start web` |
| stopped | badge `○ stopped` · `Not running` · button `Start web` |

**Restart runtime host** (process block "Runtime host", warning tone)

| state | copy |
| --- | --- |
| healthy | badge `● healthy` · `PID 48190 · socket runtime-host.sock · up 2 h 14 m · checked 12:04:31` · button `Restart runtime host` (warning style) |
| armed (UI only) | inline panel: `Restarting the runtime host stops every agent it supervises. Sessions that are mid-turn are interrupted, and not all of them will come back after the restart.` · buttons `Stop and restart runtime host` (warning, primary) and `Cancel` |
| stopping | badge `◐ stopping` · `Stopping PID 48190… agents are being dropped` |
| starting | badge `◐ starting` · `Starting… waiting for the socket and the fence` |
| failed | badge `✕ failed` · `Exited with code 1 after 0.4 s` or `Socket not ready within 15 s` · last lines · button `Start runtime host` |
| stopped | badge `○ stopped` · `Not running` · button `Start runtime host` |

The standing warning line under the block heading, always visible:
`Restarting the runtime host drops the agents it supervises. Restart web first
if you only changed the Viewer.`

## UI spec

Tokens are copied from `docs/design/viewer-design-system.md` §1 into
`ui/app.css` as CSS custom properties with the same names (`--surface-canvas`,
`--surface-card`, `--surface-sunken`, `--surface-raised`, `--text-primary`,
`--text-secondary`, `--text-muted`, `--border-default`, `--accent`,
`--accent-soft`, `--success`/`-soft`, `--warning`/`-soft`, `--danger`/`-soft`,
`--text-caption` 10 px … `--text-title` 15 px, `--radius-control` 8 px,
`--radius-surface` 12 px, `--shadow-1`, `--motion-fast/base`, the ease), light
and dark under `prefers-color-scheme`. One primary surface: each section is a
`--surface-card` with `--shadow-1` on the canvas; everything inside is flat with
hairline borders. State is an icon and an edge, never a washed header. Type:
title 15/600, section headings 13/600, values 12/400 `tabular-nums`, meta
11/400 `text-muted`, badges the Badge recipe (soft role fill, role text,
10/600, 20 px). Mono only for SHAs, PIDs, paths, log lines. Buttons:
`--radius-control`, 32 px tall on desktop and 44 px on coarse pointers, primary
= accent fill, secondary = card surface with hairline, warning primary =
`--warning` fill with white text, all with a 2 px focus ring in the role
colour. Motion: the running icon spins with `--motion-slow` and a linear ease;
`prefers-reduced-motion` freezes it to a static half-disc.

State icons (inline SVG, 14 px, `currentColor`): pending `○` muted; running
`◐` accent, spinning; done `●` success; failed `✕` danger; warning `▲`
warning.

**1440 px** (two columns, 1120 px content width centred; left 2/3, right 1/3):

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Agent Log Viewer · self-update                                          [ Check now ]  │
│ Running  1.2.2 · 7fb7345 · 22 Sep 2026        Available  1.2.3 · a1b2c3d · 23 Sep 2026 │
│ ▲ Update available · 5 commits behind origin/main · checked 12:04                      │
├───────────────────────────────────────────────┬────────────────────────────────────────┤
│ Update to a1b2c3d (1.2.3)          [ Update ] │ Web                      ● healthy     │
│ This builds the new version. Nothing restarts │ PID 48213 · port 45123 · up 2 h 14 m   │
│ until you choose to.                          │ checked 12:04:31                       │
│                                               │                       [ Restart web ]  │
│ ● Fetch a1b2c3d · 1.2 s          Show log ▸   ├────────────────────────────────────────┤
│ ● Check out a1b2c3d · 0.4 s      Show log ▸   │ Runtime host             ● healthy     │
│ ● Install dependencies · 3.1 s   Show log ▸   │ ▲ Restarting the runtime host drops    │
│ ◐ Build · 1 m 03 s               Show log ▾   │   the agents it supervises. Restart    │
│ ┌───────────────────────────────────────────┐ │   web first if you only changed the    │
│ │ ▲ Next.js 16.3.3                          │ │   Viewer.                              │
│ │   Creating an optimized production build  │ │ PID 48190 · runtime-host.sock          │
│ │   …                                       │ │ up 2 h 14 m · checked 12:04:31         │
│ └───────────────────────────────────────────┘ │              [ Restart runtime host ]  │
│ ○ Ready                                       │                                        │
├───────────────────────────────────────────────┤                                        │
│ What changes · 5 commits · 4 changelog entries│                                        │
│ (1 Added, 3 Changed)                          │                                        │
│ Added                                         │                                        │
│  · Board placements are stored in SQLite …    │                                        │
│ Changed                                       │                                        │
│  · A state-mutating startup step runs only …  │                                        │
│  · …                                          │                                        │
│ Commits                                       │                                        │
│  a1b2c3d  Seat tick: one standing wake card … │                                        │
│  …                                            │                                        │
└───────────────────────────────────────────────┴────────────────────────────────────────┘
  footer: live (SSE) · prototype on 127.0.0.1:38771 · checkout /var/tmp/…/checkout
```

The header is one `--surface-card` spanning both columns. The armed
runtime-host confirm expands inline inside its block (below the meta row),
pushing the block taller; nothing overlays.

**390 px** (one column, 16 px gutters, sections stacked in this order:
header, web, runtime host, update, what changes). The restart blocks come
before the update section on the phone because they are the actions the
operator reaches for after an update, and the long log tails go last:

```
┌──────────────────────────────────────┐
│ Agent Log Viewer · self-update       │
│ Running   1.2.2 · 7fb7345 · 22 Sep   │
│ Available 1.2.3 · a1b2c3d · 23 Sep   │
│ ▲ Update available · 5 commits       │
│   behind origin/main · checked 12:04 │
│ [        Check now        ]          │
├──────────────────────────────────────┤
│ Web                      ● healthy   │
│ PID 48213 · port 45123               │
│ up 2 h 14 m · checked 12:04:31       │
│ [       Restart web       ]          │
├──────────────────────────────────────┤
│ Runtime host             ● healthy   │
│ ▲ Restarting the runtime host drops  │
│   the agents it supervises. Restart  │
│   web first if you only changed the  │
│   Viewer.                            │
│ PID 48190 · runtime-host.sock        │
│ up 2 h 14 m · checked 12:04:31       │
│ [   Restart runtime host   ]         │
│ ┌──────────────────────────────────┐ │  ← armed
│ │ Restarting the runtime host      │ │
│ │ stops every agent it supervises. │ │
│ │ Sessions that are mid-turn are   │ │
│ │ interrupted, and not all of them │ │
│ │ will come back after the restart.│ │
│ │ [Stop and restart runtime host]  │ │
│ │ [           Cancel            ]  │ │
│ └──────────────────────────────────┘ │
├──────────────────────────────────────┤
│ Update to a1b2c3d (1.2.3)            │
│ [          Update          ]         │
│ This builds the new version. Nothing │
│ restarts until you choose to.        │
│ ● Fetch a1b2c3d · 1.2 s   Show log ▸ │
│ ● Check out a1b2c3d · 0.4 s        ▸ │
│ ● Install dependencies · 3.1 s     ▸ │
│ ◐ Build · 1 m 03 s        Show log ▾ │
│ ┌──────────────────────────────────┐ │
│ │ ▲ Next.js 16.3.3                 │ │  ← horizontal scroll inside,
│ │   Creating an optimized …        │ │    never the page
│ └──────────────────────────────────┘ │
│ ○ Ready                              │
├──────────────────────────────────────┤
│ What changes · 5 commits · 4 entries │
│ Added                                │
│  · Board placements are stored in …  │
│ …                                    │
└──────────────────────────────────────┘
```

Layout rules that keep both viewports correct: the header meta uses
`flex-wrap` with each `label value` pair as one `white-space: nowrap` unit;
buttons are full width under 640 px; the step row's title has
`min-width: 0` and `overflow: hidden; text-overflow: ellipsis` while its
duration and disclosure are `flex-shrink: 0`; log tails are `<pre>` with
`overflow-x: auto` and `max-height: 16 lines`; SHAs and PIDs are `nowrap`;
nothing is positioned absolutely. The build stage measures both viewports for
overflow (`scrollWidth > clientWidth` on `html`), clipped controls (every
button's bounding box inside the viewport) and overlapping text (no two text
nodes' rects intersect), and attaches the numbers.

## Bench

`bun prototypes/self-update/bench.ts start` (run with the pinned Bun) builds
everything under `/var/tmp/llv-self-update-bench/`:

```
checkout/     duplicate checkout      config/   isolated config root
tmp/          TMPDIR for children     logs/     web.log host.log prototype.log
bench.json    { pids, ports, paths, startedAt }
```

Steps, in order, each printed before it runs, each heavy one preceded by a
`MemAvailable` read that aborts under 4 GB with the number:

```
git clone --no-hardlinks <this repository's root> checkout
git -C checkout remote set-url origin https://github.com/Latand/live-log-viewer-next.git
git -C checkout fetch --no-tags origin refs/heads/main
git -C checkout checkout --detach "$(git -C checkout rev-parse origin/main~5)"   # or --at <sha|tag>
<bun> install --frozen-lockfile                        (cwd checkout, env childEnv("build"))
<bun> run build                                        (cwd checkout, env childEnv("build"))
allocate web port  → P1        allocate prototype port → P2
<bun> --bun src/runtime-host/main.ts                   (cwd checkout, env childEnv("runtime-host"), detached)
  wait: socket + fence pid + runtime-host-health ok
<bun> --bun node_modules/next/dist/bin/next start --hostname 127.0.0.1   (env childEnv("web") with PORT=P1)
  wait: GET / → 200
<bun> prototypes/self-update/server.ts --checkout checkout --config-root config \
      --web-port P1 --port P2 --bun <bun> --processes config/self-update/processes.json
  wait: GET /api/state → 200
write bench.json; print
  Viewer (older):   http://127.0.0.1:P1/
  Self-update:      http://127.0.0.1:P2/
```

`--at <sha|tag>` overrides `origin/main~5` (for example `v1.2.2`). The
prototype adopts the web and host records the bench started, because the bench
writes them into the prototype's `processes.json` in the same format before
starting it; from then on the prototype owns their PIDs, and `bench.ts stop`
reads `bench.json`, verifies each PID's start identity, sends `SIGTERM` to the
prototype first, then to any web or host PID still alive (they may have been
replaced by the prototype's restarts, so `stop` also reads
`processes.json`), waits, `SIGKILL`s after 10 s, and removes nothing on disk.
`bench.ts stop --purge` removes the directory afterwards.

Port-0 allocation, the same shape as `ephemeralPort()` in
`src/runtime-host/hostRehearsalRun.ts`, repeated in `lib/processes.ts` because
the prototype imports nothing from `src/`:

```ts
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no port assigned"));
      server.close(() => resolve(address.port));
    });
  });
}
```

Operator path: open the second URL, see `Update available · 5 commits behind
origin/main` with the changelog, press `Update`, watch the five steps, press
`Restart web`, watch `stopping → starting → healthy`, press `Restart runtime
host`, confirm, watch the same, then open the first URL and see the new
version.

## Test plan (`bun test`, no network)

All tests run under an isolated root (`LLV_STATE_DIR` under the test temp
dir) and use `/var/tmp` when a checkout is cloned (the `/tmp` quota).

1. **`changelog.test.ts`** (pure): parse the real `CHANGELOG.md` shape (a
   fixture string with `[Unreleased]`, two versions, wrapped bullets, `###`
   types); delta = new version heading whole + new Unreleased items only;
   identical files → empty delta; summary counts per type; 160-char cut on
   the first sentence; `+k more` past eight.
2. **`git.test.ts`** against a local bare-repo fixture: `git init --bare
   remote.git`; a work clone commits `package.json` `1.0.0` + `CHANGELOG.md`
   v1, tags nothing, pushes `main`; a second commit bumps to `1.0.1`, adds a
   `[1.0.1]` section and three more commits, pushes; the "checkout" clone sits
   at the first commit with `origin` = `remote.git`. Assert: `check` →
   `update-available`, 4 commits with subjects, delta contains `[1.0.1]`,
   available version `1.0.1`; after `git checkout` of the tip → `up-to-date`;
   remote path renamed → `failed` with git's message and the previous
   `available` retained; a local branch ahead of the remote → `up-to-date`
   with "Ahead".
3. **`steps.test.ts`** with a stubbed spawn: a fake that emits lines and an
   exit code per step. Assert the sequence stops at the first non-zero, later
   steps stay `pending`, durations are recorded, the tail keeps 40 lines and
   the file keeps all, `retry` reruns from the failed step only, the
   `MemAvailable` guard fails `install` without spawning when the injected
   reader says 2 GB, and `fetch` fails when the injected `rev-parse` disagrees
   with the target.
4. **`processes.test.ts`** with a stub child: a tiny Bun script that binds
   port 0, prints its port, answers `GET /` 200 and exits on `SIGTERM`; and a
   variant that ignores `SIGTERM` (to prove the `SIGKILL` escalation) and one
   that exits 3 at once (to prove `failed` with the exit code). Assert the
   record carries PID and start identity, stop signals the recorded group and
   nothing else (the stub's parent pid is untouched), a record with a
   mismatched start identity is dropped without a signal, and adoption after a
   fresh `ManagedProcess` load reads the file.
5. **`server.test.ts`**: start `server.ts`'s `createServer` on port 0 with
   the git module and the process module replaced by fakes. Assert the route
   table above: `400` without `confirm`, `409` during a running action,
   `202` shapes, SSE delivers a `state` event within 300 ms of a change,
   `/api/state` refuses nothing, the transpiled `app.js` parses.
6. **`safety.test.ts`**: reads every file under `prototypes/self-update/`
   and fails on `pkill`, `killall`, `fuser`, `lsof`, `8898`, `8899`, or
   `.config/agent-log-viewer`; asserts `childEnv` strips inherited `LLV_*`,
   `__NEXT_*`, `NODE_ENV`, `TMPDIR` and refuses a root under `$HOME/.config`.

The build stage also runs the bench end to end once and captures the frames the
specification lists (up to date, update available with changelog, update in
progress, a failed step, the restart states at 1440 and 390) with
`playwright-core` and `CHROME_BIN=google-chrome-stable`. A failed step is
produced honestly by pointing `--remote` at a path that exists for the check
and is renamed before `Update`, so `fetch` fails; no fake state is injected.

## File fence

Written by the build stage: `prototypes/self-update/**`, one `[Unreleased]`
entry in `CHANGELOG.md` under `### Added`. Written by this stage:
`docs/design/self-update.md`. Nothing under `src/`, `bin/`, `scripts/`,
`package.json` or `bun.lock` changes; `prototypes/` gets no `package.json`
of its own (the repository's `node_modules` already provides `playwright-core`
and the types).

## Safety fences the builder inherits

Never `127.0.0.1:8898`, never the production runtime-host container, never
Docker, never `~/.config/agent-log-viewer`. `free -m` before every heavy
command, one at a time, none under 4 GB available. Every process the stage
starts is stopped by its recorded PID before `stage_report`; the seat starts
the bench for the operator afterwards.

## Deferred — not currently justified by the requirement

- **Viewer integration.** On a Docker install the same UI would not build in
  place: it would `POST /api/runtime/deployments` with `{"ref":
  "refs/heads/main","idempotencyKey":…}` (or a pinned `revision`) carrying the
  operator spawn capability header the route requires, then follow `GET
  /api/runtime/deployments/:id` and the runtime SSE stream for the phases the
  host journals (build candidate, verify, promote, host handoff), and the
  "restart runtime host" action would be the fence handoff the host already
  performs rather than a `SIGTERM`. The check (`ls-remote` against the
  canonical remote), the changelog delta and the status blocks lift as they
  are; the step runner and the process supervisor do not. That needs the
  settings surface, the capability plumbing and a decision on who may trigger
  a deploy from the UI.
- **Automatic restart after update** and the CLI's crash-restart backoff.
- **i18n** (the Viewer is en + uk; the prototype is English only).
- **Auth.** The prototype binds loopback and has no token. Anything reachable
  over a tailnet needs the Viewer's operator capability.
- **Docker installs** (the runtime-host container, candidate containers) and
  **Windows** (named pipes, no `/proc`, no process groups).
- **Rollback** to the previous checkout and build.
- **A shared helper** between the prototype and `bin/cli.mjs` for the child
  environment, the fence-owner parse and port allocation.

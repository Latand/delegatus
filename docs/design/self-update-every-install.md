# Every Delegatus install updates itself from the Update dialog — design

## Originating requirement

The operator wrote this on 2026-10-02 at 21:50 Kyiv time, in this project's orchestrator conversation. The message came with a screenshot of the Update dialog, which read: «Цю інсталяцію Delegatus запущено не лаунчером delegatus, а її runtime host не виконує розгортань, тож оновити себе звідси вона не може. Оновіть її так, як її встановлювали.» Verbatim:

> «це треба профіксити для всіх, щоб не треба було руками щось робити»

In English: "This has to be fixed for everyone, so that nobody has to do anything by hand."

The pinned specification turns this into five criteria:
1. On every install shape, the dialog either updates in one click, or offers the single action that makes the install updatable as a button.
2. A recovery or manual launch keeps or re-adopts supervision.
3. The restart never strands the session that pressed the button.
4. `deploy_exact_sha` works on a checkout install, or answers with the dialog's action.
5. The AGENTS.md rules hold.

The specification also fences PR #2474 and PR #2430, and forbids a live restart of this machine during the lane. This design is checked against the quote. Anything the quote does not demand is listed under "Deferred".

## Decisions

1. **The launcher replaces itself.** One request, "relaunch onto release R", makes the long-running launcher:
   - stop web and the runtime host;
   - `execve` itself into R's `bin/cli.mjs` under the same PID;
   - start both children from R and verify them;
   - on failure, restore the previous release pointer and `execve` back.

   Every update uses this path. Web, runtime host and launcher therefore always move together, and a launcher fix arrives with the update that carries it.
2. **A Viewer finds its launcher without the environment variable.** It matches the runtime-host socket it already uses, or its port, against the launcher records. A Viewer the launcher did not start declares itself in an adopt file. The launcher then replaces that Viewer after an identity check, and never starts a second web on an occupied port.
3. **The launcher never leaves the web down.** The fallback to the release that was serving is admitted on liveness alone. A fallback that dies is restarted with backoff, as the runtime host already is.
4. **Update is one click** wherever the launcher speaks the relaunch protocol. Every launcher running today predates it. For those, the dialog shows the one action that loads the new launcher:
   - a button, where Delegatus can run it from outside the unit (`systemd-run --user … systemctl --user restart <unit>`);
   - the exact command, where only the operator's terminal can.
5. **`deploy_exact_sha` on a checkout install** deploys through the same path, with a `checkout-…` id that the seat tick reads. When the install needs an action first, it answers with that action and never with "disabled".
6. **Packaged installs use the same model**: releases plus a pointer plus relaunch. The release is installed from the npm package instead of being built from git.
7. **Docker production** already updates in one click. Nothing is built there.

## Prior work consulted

I searched transcripts with `search_transcripts`, first scoped to the project and then unscoped. The queries covered: the recovery unit, `LLV_SELF_UPDATE_RECORD`, launcher record, launcher relaunch and handoff, `systemctl restart delegatus.service`, and "temporary web recovery probe auth". `search_memory` for self-update, launcher, recovery and 401 returned nothing.

The relevant hit was today's Codex investigation (rollout 2026-10-02T19-44-35). It established three things:
- "Restart web" sends the internal service tag without the bearer token. Both the candidate and the fallback got 401, and the launcher stopped both.
- The recovery unit was started at 16:40Z, outside that investigation.
- `auto_updates` then reported "packaged / unsupported".

I found no prior design for launcher self-replacement or for re-adoption. I checked these designs against current `main` and build on them:
- `docs/design/self-update.md` (#2007): checkout releases, pointer and restart requests.
- `docs/design/self-update-auto.md`: the automatic path, and the finding that engine processes are children of the web process.

## What the code and this machine say

The machine observations are read-only: `systemctl --user cat/show`, the launcher record, `/proc` cgroup and environ key names (values were not printed), and `ps`.

| Fact | Evidence |
| --- | --- |
| `delegatus.service` runs the checkout's `bin/cli.mjs` with `Restart=on-failure`, plus the `OOMPolicy=continue` drop-in. The bootstrap has run since 07:45 local and handed off to `releases/30f500351099/bin/cli.mjs`. That file is byte-identical to the checkout's own `bin/cli.mjs`; the `5b046f5` release's launcher differs. | `systemctl --user cat delegatus.service`, `ps`, `sha256sum` |
| The launcher record says web `failed`, error `GET / answered 401`. Its revision `30f5003` is the fallback attempt. The runtime host is `healthy` on `5b046f5`. So both web attempts failed and the launcher left the web down. | `~/.config/delegatus/state/self-update/launcher-<id>.json`; `bin/cli.mjs:1207-1216` |
| The web now comes from a transient `delegatus-web-recovery-20261002.service` (`PartOf=delegatus.service`, `Restart=no`). It runs a script that copies the **runtime host's** environ, sets `LLV_STATE_OWNER=viewer`, `PORT` and `HOSTNAME`, pops `LLV_SELF_UPDATE_RECORD`, and execs `next start` from `releases/5b046f54c74f`. | `~/.local/state/delegatus-recovery/20261002/start-web.py` |
| The host's environ never contains `LLV_SELF_UPDATE_RECORD`. The launcher hands that variable to the web child only. The script's `pop` therefore changes nothing: any copy of the host's environment has already lost the record. | `bin/cli.mjs:1113`; host env = `cliRuntimeHostEnvironment`, `bin/server-runtime.mjs:154-165`; `/proc/<host>/environ` key names |
| The recovery web has `LLV_RUNTIME_HOST_SOCKET` and `LLV_TOKEN`, but no record variable. | `/proc/<web>/environ` key names |
| The host has no `LLV_VIEWER_DEPLOYMENTS`, so every deployment request is refused with "viewer deployments are disabled". | `src/runtime-host/main.ts:183`, `src/runtime-host/host.ts:299-325` |
| Install mode is decided from the record environment variable, otherwise from that refusal, which yields `no-launcher`. | `src/lib/selfUpdate/mode.ts:35-46,48-58`, `instance.ts:272` |
| Automatic-update availability labels every non-checkout install as `packaged`. | `src/lib/selfUpdate/service.ts:289` |
| For an unsupported install, the dialog renders the sentence alone, with no action. | `src/components/selfUpdate/SelfUpdateView.tsx:664-672`; `uk.ts:4993`, `en.ts:5084-5086` |
| A checkout Update only builds and publishes the pointer at `ready`. Each restart is a separate click. | `service.ts:856-860,927-941`; `steps.ts:250-254` |
| The launcher is chosen once per process start. Nothing replaces a running launcher. | `bin/cli.mjs:1299-1325,1403-1405` |
| The handoff marker is checked as the literal string `delegatus-checkout-launcher-v2`. | `bin/cli.mjs:62,1322` |
| The record advertises launcher capabilities by field (`autoAdmission: 1`). It has no launcher revision. | `bin/self-update-supervisor.mjs:125-133` |
| A request with an unknown role is deleted silently. | `bin/self-update-supervisor.mjs:193-196` |
| A web restart spawns onto the port without checking it. Readiness accepts any responder on that port. Next's EADDRINUSE kills the child. If that exit lands after readiness, the launcher takes the "unexpected exit" path: it stops the runtime host and exits 0 on SIGTERM, which `Restart=on-failure` does not restart. With an orphan web on the port, this is the likely outcome, because the orphan answers the first probe. | `bin/cli.mjs:482-494,496-516,763-782,1185-1198`; `server-runtime.mjs:359-363` |
| The launcher refuses to start at all while its port answers. | `bin/cli.mjs:1030-1033` |
| Each install's socket and record are keyed by `installId` = hash of the package root (`runtime-host-<id>.sock`, `launcher-<id>.json`). | `bin/server-runtime.mjs:74-92`, `self-update-supervisor.mjs:44-54` |
| Release pruning protects the pointer, the rollback release and the web and host revisions. It does not protect the release the launcher itself runs from. | `src/lib/selfUpdate/auto.ts:122-151` |
| `deploy_exact_sha` POSTs `/api/runtime/deployments`, which goes straight to the runtime host. | `src/lib/mcp/bindings.ts:2895`, `src/app/api/runtime/deployments/route.ts:139` |
| The seat tick wakes a seat when its deployment settles, read from the runtime host ledger. | `seatTickSources.ts:633,975-1006`, `deploymentLedger.ts:166` |
| Engine processes are children of the web process; agents run in their own systemd scopes. This architect session is a child of the recovery web, inside `delegatus-agent-claude-*.scope`. Replacing the web severs live turns, and the next web resumes them. | `/proc/self/cgroup`, `ps`; `docs/design/self-update-auto.md` |
| Bun 1.4.0 `process.execve` replaces the process image and keeps the PID. Probed in `$TMPDIR`: an `sh` exec'd by Bun reported Bun's PID. | local probe |
| The README calls the systemd unit retired (`README.md:730-734`), yet configures a user-service OOM drop-in (`650-668`). `legacySystemd.mjs` knows only the `agent-log-viewer*` units (line 9). | — |
| Docker Compose defaults `LLV_VIEWER_DEPLOYMENTS` to `0`. | `docker-compose.yml:87`; production sets `1` per `docs/docker.md:100` |
| `delegatus-cli` 1.9.0 is published on npm. | `npm view` |
| Automatic updates have waited since 05:41Z (turns 14, stages 11); that is #2381/#2430's territory. | `auto.json` |

## Install shapes today

| | Shape | Where | Detected as | One click today? | Why |
| --- | --- | --- | --- | --- | --- |
| S1 | Checkout started in a terminal with `bun bin/cli.mjs` (bootstrap → release launcher) | repo, README "From a clone" | checkout | no | Update only builds (`service.ts:856-860`); restarts are separate (`927-941`); the launcher is never replaced (`cli.mjs:1403-1405`); a token-protected web restart gets 401 and the web is left down (`cli.mjs:1189,1207-1216`, fixed launcher-side by #2474) |
| S2 | The same checkout under a user service manager (systemd) | **this machine** | checkout | no | as S1; also the README contradiction above |
| S3 | Recovery or manual web next to a live launcher | **this machine now** | unsupported/no-launcher (auto says "packaged") | no | mode needs the environment variable (`mode.ts:36-42`), which only the web child receives (`cli.mjs:1113`); the host refuses deployments (`host.ts:321-323`); mislabel at `service.ts:289`; even with the record, a restart collides on the port and can tear down the launcher (`cli.mjs:482-516`) |
| S4 | Hand-made Viewer with no live launcher (`bun run start`, a dead launcher's leftovers) | repo `package.json` `start` | no-launcher / no-runtime-host | no | as S3, and the launcher refuses to start while the port answers (`cli.mjs:1030-1033`) |
| S5 | Any launcher running today: protocol v2, no self-replacement (every S1–S3 install) | **this machine's launcher** | n/a | n/a | a launcher fix (such as #2474) arrives only with a full restart |
| S6 | Packaged: `bunx delegatus-cli`, `bun add -g`, `npm i -g` | npm 1.9.0 | unsupported/not-a-checkout | no | `record.checkout` is null (`cli.mjs:1067`); restart requests are checkout-only (`1179`); the copy says "update with your package manager" (`en.ts:5086`) |
| S7 | Docker production (runtime-host profile, `LLV_VIEWER_DEPLOYMENTS=1`) | `docs/docker.md:37-110` | managed | **yes** | deployment: image, candidate, health, promote, host handoff, rollback (`service.ts:861,884-899`) |
| S8 | Docker non-production: `viewer-test`, `legacy-viewer-migration`, a runtime host without the flag | `docker-compose.yml` | no-launcher / no-runtime-host | no | test and migration containers, replaced by Compose |
| S9 | Hand-managed checkout (HEAD moved past the pointer) | `service.ts:849-853` | checkout | rebuild only | as S1 |
| S10 | Windows CLI | `docs/design/windows-support.md` | checkout | no | as S1; no `execve` |

`bun dev` is a development server, not an install, and is out of scope.

## Options

**A — Launcher relaunch protocol plus re-adoption (recommended).** Described below.
- Uniform across terminal, systemd, macOS and packaged installs. Supervisor and bootstrap PIDs are preserved, so the bootstrap, systemd and `auto.pending.launcherPid` see nothing change.
- Rollback runs in the launcher, outside the processes it replaces.
- Costs: Bun ≥ 1.4 and a POSIX system (Windows keeps the separate restarts), plus one manual restart per existing install to load the first relaunch-capable launcher. That restart is unavoidable: the process that would perform it runs old code.

**B — Service-manager restarts for every update** (`systemd-run … systemctl --user restart <unit>`).
- Simple where a unit exists.
- Leaves terminal and macOS installs out, ties the product to systemd, and puts rollback into the next start.
- Kept only as the one-time transition for S5 under systemd.

**C — Make checkout installs "managed"** (`LLV_VIEWER_DEPLOYMENTS=1` with a checkout deploy adapter, a stable listener and host succession in CLI mode).
- `deploy_exact_sha` would work natively.
- **OVER-BUILT.** The adapter is Docker-shaped (images, candidate containers, `setpriv`, `docker`), and the host would have to own port 8898 for every CLI user. Deferred.

**D — Fix detection only** (socket re-adoption plus #2474).
- Fails criterion 1 (one click, launcher replacement) and criterion 4.

## The design (option A)

### P1 — Launcher, `bin/` only

**P1.1 Relaunch protocol.** The record gains capability fields in the existing `autoAdmission` idiom:

```
launcher: { pid, startIdentity, autoAdmission: 1, relaunch: 1, revision: <40-hex | null>,
            requestId: <id | null>, state: "healthy" | "relaunching" | "failed",
            error: ProcessError | null }
```

The request file gains `{ requestId, role: "relaunch", target: <40-hex>, requestedAt, autoGateId? }`. An automatic request goes through the existing `launcher-admission` gate. When the launcher takes a relaunch request:

1. **Preflight.** Run `bun --bun <R>/bin/cli.mjs --version` with `LLV_LAUNCHER_REEXEC=1`, `LLV_LAUNCHER_CHECKOUT=<root>`, `LLV_STATE_DIR=<scratch>` and a 30-second limit. This proves the new launcher's modules load. If it fails: restore the rollback pointer, record `launcher.error`, and leave the children untouched.
2. **Trial intent.** Write `<state>/self-update/trial-<installId>.json` containing `{ requestId, target, rollbackPointer (raw | null), previousEntry (the running cli.mjs path), at }`.
3. **Stop.** Run `stopAll`, which covers web, a foreground `tailscale serve` and the host. Retain the launcher record across the same-PID exec so competing starts can still see its live custody. Remove it only when leaving the process for a service-manager fallback.
4. **Exec.** `process.execve(process.execPath, [execPath, ...execArgv, <R>/bin/cli.mjs, ...argv'], env)`, where:
   - `argv'` drops `--new-token` and `--new-operator-token` and adds `--no-open`;
   - `env` is `process.env` plus `LLV_LAUNCHER_REEXEC=1`, `LLV_LAUNCHER_CHECKOUT` and `LLV_LAUNCHER_TRIAL=<requestId>`.
5. **The new image** starts the host and web exactly as at startup. Web readiness uses the 90-second restart budget and #2474's authenticated page-and-chunk probe.
   - On success: write `launcher.revision` and `requestId`, and delete the intent.
   - On failure, including any `fail()` while the intent is live: stop the children, restore the pointer, mark the intent `rolled-back`, and `execve(previousEntry)`. The previous image starts the previous release and records `error: { kind: "fell-back", revision, detail }`.
6. **No `process.execve`** (old Bun or Windows): the launcher does not advertise `relaunch`.

Compatibility rules:
- Keep the literal `delegatus-checkout-launcher-v2`, which old bootstraps grep for.
- Add a separate `LAUNCHER_RELAUNCH_PROTOCOL` constant.
- A launcher started without a relaunch request also honours a trial intent written by the Viewer before a service restart (P2.4). On failure it restores the pointer and exits 75, so systemd starts the previous release.

**P1.2 Never spawn onto a busy port; take over adopted orphans.** Before any web spawn (startup, restart web, relaunch), the launcher requires the port to be free.

If the port is busy, it reads `<state>/self-update/adopt-<installId>.json` (`{pid, startIdentity, port, socket}`) and checks the named process:
- its `/proc/<pid>/stat` start time equals `startIdentity`;
- its environ has `LLV_RUNTIME_HOST_SOCKET` equal to the launcher's socket and `PORT` equal to the launcher's port.

If all three hold, the launcher sends SIGTERM, waits 10 seconds, then SIGKILL, and waits up to 5 seconds for the port to free. Otherwise it records `port-in-use` without spawning.

At startup, a fence owner whose environ carries this install's socket, while no other live launcher record exists, is stopped the same way. This closes the EADDRINUSE race and the teardown with exit 0.

**P1.3 Never leave the web down.** In `restartWeb`, the fallback to `previousRelease` is admitted on `/api/files` liveness only. If the fallback exits, it is restarted with the host's backoff (`RUNTIME_HOST_RESTART_*`). The current contract at `bin/cli.selfUpdate.integration.test.ts:480` changes accordingly.

### P2 — Viewer (`src/lib/selfUpdate/*`, dialog, i18n, docs)

**P2.1 Re-adoption.** `detectMode` looks up the record in this order:
1. `LLV_SELF_UPDATE_RECORD`;
2. a `launcher-*.json` whose `socket` equals `LLV_RUNTIME_HOST_SOCKET`;
3. one whose `port` equals `PORT`.

A record counts only if its launcher is alive. The decision gains `supervision: "launcher" | "adopted"`. An adopted web writes the adopt file at every decision. Fix `service.ts:289`.

**P2.2 One-click apply.** `startUpdate` and `retry`:
- capture the rollback pointer before the build;
- build (adding a sixth step, `switch`);
- if `launcher.relaunch === 1`: take #2430's launch hold, file one relaunch request, and persist `apply = { requestId, target, rollbackPointer, launcherPid, trigger: operator | seat | auto, deploymentId? }` in `state.json`. The next web settles the apply when `record.launcher.requestId` matches and both processes serve the target, then releases the hold and writes history.

Fell-back maps to the failure `{ kind: "rolled-back", detail }`. The automatic switch is turned off only when the trigger is `auto`. The dialog asks for confirmation and lists the live turns and stages that will be resumed (`probeQuiet` blockers).

The automatic path (after #2430) files the same request under #2430's custody. The two-request sequence remains only for launchers without `relaunch`.

**P2.3 Safety guard.** A web whose environment has `LLV_TOKEN` never files a web restart (manual or automatic) to a launcher without `relaunch`, because that launcher's probe gets 401. An adopted web never files any request to such a launcher.

**P2.4 Actions** (`Snapshot.action = { id, button, unit?, command? }`, new route `POST /api/self-update/action` behind `operatorGate`):

| id | When | Button |
| --- | --- | --- |
| `restart-service` | launcher without `relaunch`, its PID's cgroup is `user@<uid>.service/…/<unit>.service`, and the pointer's release passes the bootstrap's checks and contains the relaunch marker | yes: write the trial intent, then `systemd-run --user --collect --quiet --unit delegatus-apply-<id> -- systemctl --user restart <unit>`. Precedent: `src/lib/runtime/agentMemory.ts:61` |
| `restart-terminal` | same, in a terminal | no; the exact command from the bootstrap's argv |
| `update-first` | the pointer's release lacks the marker | the normal Update button |
| `start-service` | no live launcher; a `~/.config/systemd/user/*.service` whose `ExecStart` runs this checkout's `bin/cli.mjs` | yes, via `systemd-run` (the new launcher takes over through P1.2) |
| `start-launcher` | no live launcher, no unit | no; command |
| `docker-deployments` | in a container (`LLV_DOCKER_NSENTER_SHIMS=1`) and deployments disabled | no; names `LLV_VIEWER_DEPLOYMENTS=1` and `docs/docker.md` |

Remove the "update it the way you installed it" sentences in both locales.

Also in P2:
- `pruneReleaseWorktrees` protects the directory of `launcher.revision`, which is the execve rollback target.
- Docs: README Update section and service section, plus `docs/design/self-update.md`. Commit this design as `docs/design/self-update-every-install.md`.

### P3 — `deploy_exact_sha` on a checkout install

`POST /api/runtime/deployments`:
- When `selfUpdateService().decide()` is checkout or package with a live launcher, it calls `selfUpdateService().deployRevision({ revision | ref, idempotencyKey })`.
- A `ref` is resolved with `ls-remote`.
- An exact SHA must be an ancestor of the fetched tracked branch (the runner's `fetch` step in exact mode); otherwise the answer uses the `revisionNotFoundMessage` wording.
- The receipt is `{ state: "accepted" | "busy", deploymentId: "checkout-<uuid>", revision, replayed }`, kept in `<state>/self-update/deployments.json` and keyed by `idempotencyKey`.
- The apply runs with `trigger: "seat"`.
- `ledgerDeployment` and `GET /api/runtime/deployments/:id` answer `checkout-*` ids from that file with phases `admitted → building → switching → succeeded | rolled-back | failed`. The list includes those ids. The seat tick therefore wakes without changes (`seatTickSources.ts:633`).
- For `restart-service` (S5 under systemd), the deploy performs that action after the build.
- Otherwise: 409 with `{ code: "self-update-action-required", action, error: <the dialog's English sentence> }`.

`src/runtime-host` is untouched.

### P4 — Packaged

- **Release.** `bun add --exact delegatus-cli@<v>` into `<cache>/delegatus/self-update/<installId>/releases/npm-<v>` with the scrubbed `buildEnv`. Steps: `fetch` (registry `latest`) → `install` → `ready` (check `dist/standalone/server.js` and `dist/runtime-host.mjs`) → `switch`.
- **Pointer.** `{ kind: "package", version, dir, baseVersion }`.
- **Relaunch.** As in P1, with the identity pinned by `LLV_LAUNCHER_INSTALL_ROOT`, a generalized form of `LLV_LAUNCHER_CHECKOUT`; keep reading the old name.
- **Bootstrap.** Packaged bootstraps from this version on hand off to the pointer while their own version equals `baseVersion`. A package upgraded by hand wins, mirroring `checkoutHead`.
- **Root.** No root is needed, so `npm -g` works too.
- **Mode.** New mode `package`.

### Docker

Nothing is built. The managed snapshot carries no action. S8 shows `docker-deployments`, or for test and migration containers a sentence naming the Compose command.

## Each shape after the change

| Shape | Result |
| --- | --- |
| S1, S2, S9 | one click: build → relaunch (launcher + host + web) → verify → rollback |
| S3 | re-adopted; one click; the launcher replaces the orphan |
| S4 | `start-service` button, or the command (Delegatus did not launch this Viewer) |
| S5 | `restart-service` button under systemd; one terminal command otherwise. One time per install, because the running process predates the code that could replace it |
| S6 | one click after the first start on a version that has P4. Old versions (≤ 1.9.0) run old code and need one `bunx delegatus-cli@latest` |
| S7 | unchanged, one click |
| S8 | instruction |
| S10 | build plus today's separate restarts; a launcher change needs one manual restart |

## Acceptance tests

Run every file by path. Never sweep `src/lib/agent/` or `src/app/api/runtime/`.

**Launcher — `bin/cli.selfUpdate.integration.test.ts`** (real CLI, stub `next` and host, isolated root):

- **L1.** A relaunch request moves launcher, host and web onto R in one step:
  - bootstrap PID and supervisor PID and start identity are unchanged;
  - `launcher.revision` is R and `requestId` matches;
  - new web and host PIDs serve R's directory;
  - the previous web received SIGTERM.
- **L2 / L3.** When R's web or host does not become ready:
  - the pointer is restored byte for byte and the image is back on the previous entry;
  - both children serve the previous release;
  - `launcher.error.kind` is `fell-back`, carrying R's short SHA.
- **L4.** When R's `cli.mjs` throws at import: the children's PIDs are unchanged, the pointer is restored, and an error is recorded.
- **L5.** After a relaunch of a launcher started with `--new-token --new-operator-token`: the token file and operator capability are unchanged, and a `PATH` stub records no `xdg-open`.
- **L6.** An old-bootstrap fixture still hands off to a release built with the relaunch protocol (the v2 marker is present).
- **L7** (replaces `:480`). The new release fails the page probe and the previous release answers liveness only: the previous release keeps serving with `fell-back`. When the previous release exits, it is restarted with backoff. The launcher and host PIDs never change.
- **L8.** A foreign listener on the port: restart web spawns nothing, records `port-in-use`, and the launcher and host stay alive.
- **L9.** A test-started orphan web with this install's socket plus an adopt file is stopped by SIGTERM at startup, on restart web and on relaunch. With a mismatched start identity it is left alone.
- **L10.** An orphan host holding the fence with this install's socket is replaced at startup. With a second live launcher record, startup refuses with the existing mismatch message.
- **L11.** A Viewer-written trial intent plus a broken R: the launcher restores the pointer and exits 75. The next start serves the previous release, and the intent says `rolled-back`.
- **L12.** Every relaunch probe carries the bearer token (#2474's helper). The stub answers 401 without it.

**Viewer**

- **V1 — `mode.test.ts`, one table row per shape:**
  - record variable present → checkout/launcher;
  - **the 2026-10-02 recovery environment key set** (host env copy plus `LLV_STATE_OWNER=viewer`, `PORT`, `HOSTNAME`, no record variable) → checkout/adopted;
  - match by port only → adopted;
  - dead launcher → `start-service` with a unit fixture, `start-launcher` without one;
  - package → `package`;
  - deployments on → managed;
  - container plus deployments off → `docker-deployments`;
  - no host → `no-runtime-host`.
- **V2 — `apply.test.ts`:**
  - a launcher with `relaunch` gets exactly one request file;
  - the persisted rollback pointer equals the pre-build bytes;
  - a fresh service instance settles `done` and writes history;
  - fell-back gives `rolled-back`, pointer restored, auto untouched for an operator trigger;
  - an adopted web writes the adopt file;
  - S5 plus `LLV_TOKEN` produces no request file and the `restart-service` action;
  - terminal gives `restart-terminal` with the bootstrap command;
  - a pointer release without the marker gives `update-first`;
  - availability is never `packaged` for a checkout install.
- **V3 — `routes.test.ts`:** `restart-service` runs exactly the `systemd-run …` argv through an injected runner, with the unit taken from a cgroup fixture. Agents are refused, and so is a launcher outside a user service.
- **V4 — `SelfUpdateView.dom.test.tsx`:** for every shape snapshot, the old sentences are absent in en and uk; the action button renders exactly when `action.button`; the `switch` step renders all states.
- **V5 — `auto.test.ts` / `managedAuto.test.ts`** (on #2430): a launcher with `relaunch` gets one relaunch request with `autoGateId` under custody; a launcher without it keeps the old sequence, subject to the guard.
- **Rendered:** a case in `scripts/capture-board-geometry.ts` for the action card and the six-step update, at 1440×900 and 390×844, en and uk.

**`deploy_exact_sha`**

- **D1 — `src/app/api/runtime/deployments/route.test.ts`:**
  - checkout `{revision}` → 202 with `checkout-…`;
  - the same key → the same receipt with `replayed: true`;
  - a `ref` resolves to a SHA;
  - a non-ancestor is refused with the not-found wording;
  - during an update → 409 `busy` with the running id;
  - an install needing an action → 409 `self-update-action-required` with the action. No response contains "viewer deployments are disabled".
- **D2.** `ledgerDeployment("checkout-…")` and the `:id` route report the terminal status.
- **D3.** `seatTickSources` announces a settled checkout deployment once.
- **D4.** The `bindings` test: `deploy_exact_sha` from a designated seat on a checkout install returns `accepted` with `wakeOnSettle: true`.

**Packaged**

- **P-1.** A packaged fixture (no `.git`) plus a stub `bun add` on `PATH`:
  - one relaunch moves to `npm-<v>`;
  - a broken stub web rolls back;
  - a new-version bootstrap hands off while its version equals `baseVersion`, and stops handing off after a manual upgrade.
- **P-2.** Registry `latest` newer than the running version → `update-available`, with the delta from the tags.

**Docker**

- **K1.** The existing managed tests pass, and a managed snapshot carries no action.
- **K2.** A container without deployments → `docker-deployments`, no button.

**Isolated rehearsal.** One case in the same file, gated by `LLV_SELF_UPDATE_REHEARSAL=1`:
- export two real revisions under the stage's `$TMPDIR` and build both;
- start the real CLI with state under scratch and a port read back from a port-0 bind;
- relaunch succeeds; relaunch rolls back from a deliberately broken release; a hand-started `next start` carrying the install's socket is taken over.

Never use 8898 or the operator's state.

**Criterion 5.**
- `bun scripts/verify-runtime-host.ts --runtime <pinned bun>` runs only if a `src/runtime-host` file changes; P1–P4 change none.
- Suites run by path only.
- Only the declared owners touch live state. The launcher writes the record and the intent; the Viewer writes the adopt file and the trial intent; the preflight runs with `LLV_STATE_DIR`.

**Criterion 3.**
- L1, L9 and L11 prove that every step is performed by a process that survives it: the launcher outlives web and host, the PID survives `execve`, and the bootstrap and systemd sit outside the supervisor. Option B runs through `systemd-run`.
- Resume after a web stop is #2446's existing path, triggered the same way (SIGTERM to the web, asserted in L1), with #2476's access preservation.

## Order of work and the in-flight PRs

1. **#2474 — merge as is.**
   - Delivers: authenticated restart and admission probes on token installs, effective only once a launcher containing it runs.
   - Does not deliver: launcher replacement, re-adoption, one click, never-down web, `deploy_exact_sha`.
2. **P1** — `bin/` only, on #2474. It can run in parallel with #2430, which touches no `bin/` file.
3. **#2430 — merge.**
   - Delivers: automatic updates eventually apply on a busy machine (drain custody, a six-hour Needs-you decision).
   - Decides nothing about install shapes or the launcher.
4. **P2** — on #2430 and P1, because #2430 rewrites about 344 lines of `service.ts`.
5. **P3**, then **P4**.
6. **#2446** — open; delivers stage resume and seat wake after a restart. It must be merged before criterion 3 is signed off. **#2476** (merged) is already in place.

## Rollout on this machine (after P1 and P2 merge; not during the lane)

1. Turn automatic updates off. Otherwise a supervised `5b046f5` Viewer would build R and restart web through the pre-#2474 launcher, get 401, and leave the web down again.
2. Run `systemctl --user restart delegatus.service` from a terminal. `PartOf` stops the recovery unit, and the `5b046f5` launcher supervises again.
3. Press Update. It builds R into the pointer.
4. Restart the service again, which loads R's launcher. After that, everything is one click and automatic updates can be turned back on.

## Risks

- `execve` is fresh in Bun. Feature-detect it and cover it with L1–L5.
- A new launcher that crashes after the preflight, before it reads the intent, falls back to the checkout launcher on R. The preflight covers module loading.
- An orphan restarted by a unit with `Restart=always` ends as `port-in-use` (see Deferred).

## Deferred — not currently justified

- **Option C**, managed deployments for checkouts. OVER-BUILT for the quote.
- **A `delegatus restart web` command for hand recovery.** P1.3 removes the need.
- **Detecting a launcher change per file.** Every update relaunches, so there is nothing to detect.
- **One click on Windows.** No `execve`.
- **Stopping units that keep restarting an orphan Viewer.** Revisit if it is ever observed.
- **A quiet-window wait for operator and seat applies.** They chose the moment; #2430 covers automatic updates.
- **Intent awareness in the checkout bootstrap file.** It would reach new bootstraps only.
- **Self-update for Docker test and migration containers.** Compose replaces them.
- **Reinstalling `npm -g` in place.** The release directory needs no root.

## Validation against the quote

- Every install that Delegatus launched or recovered updates in one click once its launcher speaks the protocol. That includes today's recovery shape and the seat's deploys.
- The steps left to a human:
  - one restart per existing install, offered as a button under systemd. It cannot be automated because the running process predates the code that would perform it;
  - one `bunx delegatus-cli@latest` for old packaged versions;
  - setups the operator assembled by hand, where the dialog gives the single command.

**Notes:**
- All host checks were read-only. The only things executed were two Bun `execve` probes in `$TMPDIR`; no Delegatus process was touched.
- The EADDRINUSE teardown race (`cli.mjs:482-516`) and the unprotected launcher release in prune are real defects today. P1 and P2 fix them.


## Protected terminal credential custody

An Update prerequisite with an effective access key persists that exact key in
`<state>/launcher-custody-<installId>/environment.json`. The command carries only
`LLV_LAUNCHER_CREDENTIAL_HANDOFF=1`, alongside its existing nonsecret context.
The canonical install root and its filesystem identity are checked in a separate
private `identity.json` before the credential file is opened. `DELEGATUS_TOKEN`
uses the entrypoints' existing alias precedence. The new CLI reads custody before
pointer selection; the terminal bootstrap reads it before trials, probes or children.
Rollback and cold recovery retain the same record and key.

POSIX custody requires current-user ownership, directories with mode 0700,
regular single-link files with mode 0600, descriptor identity checks and
`O_NOFOLLOW`. Windows uses the current Windows SID and a protected NTFS DACL
with one FullControl grant to that SID, verified through PowerShell `Get-Acl`;
creation uses `Set-Acl` before writing any credential. Every reparse point is
refused. Existing unsafe ACLs or modes are never repaired automatically.
A foreign install identity, reused root, partial record or conflicting key refuses
the handoff. The Update surface then gives a storage prerequisite without a command;
the existing launcher remains running with its access gate intact.

The same custody includes the effective `LLV_PUBLIC_HOST`, `LLV_TS_HOST` and
`LLV_TS_URL`, which participate in origin admission and phone access. Team,
operator and internal-service authority are already durable under the carried
state/config roots. The Telegram connector has its own provisioned credential
and refuses startup without it. Client-only MCP control credentials and provider
credentials are outside this install's HTTP perimeter. No new key is minted and
no browser state is changed. An install with no key and no custody behaves as before.

Windows continues to apply each built update from its terminal because it has
no launcher exec capability. Both localized instructions and the shared capture
case describe that repeated prerequisite. Rendered evidence for the changed copy
is pending an independent build of the published head.


## Dispatch fences and cold publication recovery

A dispatch rechecks ownership synchronously after its last awaited read.
The request, apply, launcher, gate issuer and durable work evidence must still
match the accepted decision. Expired or stale custody refuses dispatch and
retains the accepted records. Admission release follows verified serving
settlement. Per-role restart controls remain maintenance actions when the
installed release already serves coherently.

| Path | Awaited reads after admission | Final fence |
| --- | --- | --- |
| Operator checkout/package build | runner completion; `applyBuilt.decide` | durable apply binding, launcher identity/liveness, request vacancy, synchronous work evidence before `apply.send` |
| Legacy operator apply | `applyBuilt.decide`; `actionFor` credential/release reads | same binding and work checks after `actionFor`, immediately before the trial write |
| Service prerequisite | selected release, green source, serving snapshot and rollback ancestry before reservation; replacement CLI load after reservation | `reserve` checks current owner before begin; post-load binding, owner, request and work checks precede ready/trial publication and the service request |
| Automatic publication | green reads, mode, ancestry, snapshot, quiet probe and rollback ancestry; final mode, snapshot and quiet probe | owned unexpired gate, copied launcher identity, request vacancy and synchronous work evidence before begin/send |
| Automatic launcher admission | mode, refreshed green, current branch ancestry, snapshot and quiet probe (including runtime snapshot, per-turn liveness and controller reads) | ancestry precedes quiet; durable apply/request, current launcher, issuer identity and unexpired gate plus synchronous work evidence are checked after the last await |
| Watcher | authenticated admission response and JSON body | current request, launcher, work evidence and unchanged unexpired gate immediately before handler dispatch |
| Resident launcher | replacement CLI load preflight | unchanged apply, trial, request, launcher, work evidence and unexpired gate immediately before starting intent and child shutdown; shutdown completion is an action, followed by the existing stop/exec fence |
| Credential restoration prerequisite | readiness, `ReleasePointer.current` checkout/candidate ancestry, prior checkout and release-cache ancestry | final request/apply/gate/drain/launcher/work binding and gate expiry before protected credential preparation or command return; restoration itself performs synchronous protected descriptor reads |

Cold startup binds recovery to the earliest accepted `apply.json`, including
when no request was published. It verifies the original launcher owner and the
prior checkout/package identity. A partial publication returns to the verified
source. A durable starting trial or verified target receipt may complete the
accepted target. Health proves launcher, Viewer and host together before the
Viewer settles the original apply and releases its hold. A terminal write that
outlived the process retains its receipt and releases only its own remaining
hold after cold serving verification.

`A` is the verified source, `B` the built target, `I` the original accepted
apply identity, `H` its admission hold, `Q` the launcher request, `T` its trial,
and `R` the terminal launcher receipt. Existing automatic cohort holds keep
their original owner; recovery does not replace them with a new cohort.

| Persisted boundary | Durable records | Cold outcome |
| --- | --- | --- |
| Begin | I building; pointer A or absent | verified A; original I fails with rollback receipt |
| Ready before pointer | I ready; pointer A or absent | verified A; original I fails with rollback receipt |
| Pointer before ready | I building; pointer B | restore and verify launcher/web/host A; original I fails |
| Ready after pointer | I ready; pointer B | restore and verify A before settlement |
| External ready prerequisite at target entry | I ready external; pointer B; original owner retained | derive original trial and verify B; import/health refusal restores verified A |
| Switching before publication | I switching; hold present; pointer B; request and trial absent | reconstruct recovery from I; restore and verify A; original I fails |
| Request before trial | I switching + H + Q; pointer B | matching Q belongs to I; restore and verify A |
| Preflight trial before consume | I switching + H + Q + T preflight | original trial owns rollback; verify A |
| Consume / awaited load | I switching + H + T preflight; Q absent | verify A; preserve original I and hold until settlement |
| Starting intent / child shutdown | I switching + H + T starting | an unmarked crash may complete verified B; handled stop marks roll back to verified A |
| Healthy target before apply settlement | I switching; hold present; terminal receipt present; trial and request absent | receipt bound to original owner permits verified B; settle original I once |
| Terminal apply before custody/hold release | I terminal + H + R; T/Q absent | verify terminal serving identity; retain R and terminal I; release owned H once |
| Fully settled | I terminal + R; H/T/Q absent | serve verified terminal release; retain I/R; repeated observations leave subsequent owners untouched |

The real CLI tests kill only recorded fixture PIDs and cold boot the same
installation. The publication matrix covers SIGKILL, SIGTERM and SIGINT.
Protected custody carries the original access key through target completion
and source rollback; HTTP and MCP accept that key and refuse wrong or absent
credentials. Changed Update copy and prerequisite frames require an independent
build of the published head before rendered evidence can be refreshed through
the shared capture driver.

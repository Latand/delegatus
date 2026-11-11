# Install and onboarding measurements

Measured on 2026-11-11 on Linux x86_64.
Source measurements use `2449d4c3b5d5d7d37e11afde84127a662206c3a8`.
The first design's measurement list is in section 8 of
`docs/design/install-and-onboarding.md`. The second view was read with
`git show 933c2cfd60:docs/design/install-and-onboarding-second-view.md`,
including N8 and section 6. The second view and the seven accepted decisions
supply the scope.

## Conditions and commands

Every probe ran in a source export or packaged install under this stage's
assigned scratch. Before the first probe, resolved paths were compared with
both current and legacy operator state directories. Each install had fresh
HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_DATA_HOME, TMPDIR and LLV_STATE_DIR.
LLV_VIEWER_CONTROL_URL was `http://127.0.0.1:1`. Child environments used an
allowlist. Ports came from a loopback port-0 socket. Shutdown targeted the
recorded child, and the owning gate handled descendant cleanup.

The source export reused the dependency tree through a symlink. The catalogue
and Codex-only startup probes copied this stage's subscription authentication
into private Codex homes. The Claude connection in (iv), seat designation,
liveness and delivered wake were fixtures. The import, curation controller,
role resolution, spawn refusal and persisted pass outcome used production code.
Paid model calls total **0**. Imported notes contained synthetic instructions.

The CLI matrix uses installed `delegatus-cli@2.0.0`, packed from
`ea4b1dd4c2f7c01e92d2c7520b5ff2972b8bc29b`. The upgrade starts at
`delegatus-cli@1.11.0`, packed from
`56f63d33d84f812e267f1498d9eddf735ab9b4c4`. Tarball SHA-512 integrity matched
npm metadata. Both declared dependency sets were installed before the final
matrix. The pinned runtime is Bun 1.4.0. The other runtime is Bun 1.4.3.
The catalogue client is Codex CLI 0.166.0.

Commands below use `$MEASURE` for `$TMPDIR/onboarding-measurements`, `$GATE`
for the stage-provided `gate-slot.sh` at serving revision `803f12c106a4`,
and `$PINNED_BUN` and `$CODEX_BINARY` for the resolved executables. These
substitutions remove machine-specific paths. The appendices preserve the
probe bodies with executable paths and operator-state comparison paths
replaced by environment lookups. `env.json` contains the private roots above,
`LLV_GATE_RUNNER=off`, telemetry off and `DO_NOT_TRACK=1`.

Every recorded command was followed once by `wait_for_check` on that exact
absolute log path. The timings below exclude CPU admission waits. Repeated command listings refer
to the same recorded campaign.

## (i) Import before and after the first seat

```sh
rtk proxy bash "$GATE" --record "$TMPDIR/source-measurements-final.log" python3 "$MEASURE/run-source.py"
```

The probe writes a topic note under each of `work-project` and `other-project`
in a private Claude memory root. Neither project is the Delegatus repository.
It calls `runMemoryImportWork` without a host override. The slug lookup supplies
the two fixture project identities. The second import starts in a fresh state
after designating the first seat in `work-project`. The first import is also
read again after that designation exists.

| Import start | Note origin | Saved curation project | Dispositions | Curation project has a seat |
| --- | --- | --- | --- | --- |
| Before first seat | work-project | Delegatus repository | 0 | false |
| Before first seat | other-project | Delegatus repository | 0 | false |
| After first seat | work-project | work-project | 0 | true |
| After first seat | other-project | Delegatus repository | 0 | false |

Relevant output from both imports was `importState=ready` and
`hostIsViewerProject=true`. After the later designation, the first import's
`workBatch` remained `0`. For the import started after designation,
`workBatch=1`. `viewerBatch=1` is the first batch offered for the host project,
whose seat is absent. Batch selection groups candidates by their origin.

The wait is at curation hosting. `importWork.ts` saves the host and candidate
curation project. `selectImportBatch` offers those saved candidates to that
project, and `hostAdmission` requires its designated seat and delivered wake.
The imported bytes have reached the ready store. Their dispositions remain
pending. The before-seat case also exposes saved routing that survives a
later designation.

Verdict **confirmed**. A seated user project supplies a necessary fallback when the Delegatus-repository projects have no seat.

## (ii) Codex catalogue and a missing model

```sh
rtk proxy bash "$GATE" --record "$TMPDIR/catalogue-measurements.log" python3 "$MEASURE/models.py"
rtk proxy bash "$GATE" --record "$TMPDIR/source-measurements-final.log" python3 "$MEASURE/run-source.py"
rtk proxy bash "$GATE" --record "$TMPDIR/dom-measurements.log" python3 "$MEASURE/run-dom.py"
```

The catalogue probe sends `initialize`, `initialized`, `account/read` with
`refreshToken=false`, then `model/list` with `includeHidden=true` over stdio.
Relevant output was `accountPresent=true`, `catalogueError=null`,
`hasGpt61Sol=true`, `nextCursor=null`. Ten models were returned, including
`gpt-6.1-sol`.

The source probe returned
`runtime={engine:codex,model:gpt-6.1-sol,effort:high}` and
`readiness={kind:ready}` with an empty available-model list. In the mounted
Codex-only guide, the mocked model endpoints returned empty catalogues.
The screen still offered Create and emitted a draft request for Codex,
GPT-6.1-Sol, high effort. `launchReadiness` checks the account's signed-out
state. The runtime fallback uses `defaultModelFor`.

Verdict **confirmed**. This account's catalogue contains GPT-6.1-Sol, and the current step still permits its draft when catalogue evidence is missing. A real account whose catalogue excludes the model remains unmeasured here.

## (iii) Launcher arguments, solo, team and SIGTERM

```sh
rtk proxy bash "$GATE" --record "$TMPDIR/cli-measurements-v2.log" python3 "$MEASURE/lifecycle.py"
```

Each process used the unofficial community launcher's start arguments, with
an assigned ephemeral port replacing 8898.

```sh
"$RUNTIME" "$MEASURE/npm-2.0.0/package/bin/cli.mjs" --port "$PORT" --hostname 127.0.0.1 --no-open
```

The team fixture used `claimInstall(teamStore(), "Fixture owner", device)`
before launch. Requests carried the loopback Host and followed no redirects.
The first GET had no Accept header. A second GET used `Accept: text/html`.
The solo HTML's first same-origin JavaScript was fetched separately.

| Bun | Install | GET / | HTML navigation | Contains Delegatus | Script GET | Launcher's healthy predicate |
| --- | --- | --- | --- | --- | --- | --- |
| 1.4.0 | Solo | 200 | 200 | true | 200 | true |
| 1.4.0 | Team, signed out | 401 | 307 | false | absent | false |
| 1.4.3 | Solo | 200 | 200 | true | 200 | true |
| 1.4.3 | Team, signed out | 401 | 307 | false | absent | false |

Verdict **confirmed** for solo startup under both runtimes. The premise that the same unauthenticated GET readiness predicate accepts a team install is **refuted** by 401 and 307.

The driver recorded descendant PIDs and start identities before sending
SIGTERM to its own CLI. After exit it checked those identities and requested
the same loopback URL again.

| Bun | Install | CLI exit | Shutdown seconds | Recorded live descendants after exit | Listener closed |
| --- | --- | --- | --- | --- | --- |
| 1.4.0 | Solo | 0 | 0.465 | 0 | true |
| 1.4.0 | Team | 0 | 0.365 | 0 | true |
| 1.4.0 | Access key | 0 | 0.465 | 0 | true |
| 1.4.3 | Solo | 0 | 0.414 | 0 | true |
| 1.4.3 | Team | 0 | 0.515 | 0 | true |
| 1.4.3 | Access key | 0 | 0.414 | 0 | true |

Verdict **confirmed**. SIGTERM shut down these empty isolated installs, including their recorded runtime-host and Viewer descendants.

### Update from 1.11.0

```sh
rtk proxy bash "$GATE" --record "$TMPDIR/update-measurements-v2.log" python3 "$MEASURE/update.py"
```

The old CLI used the same start arguments. A private cookie jar opened `/`
with `Accept: text/html`. The driver read `/api/self-update?work=0`, waited for
the check, then sent the Update dialog's request.

```http
POST /api/self-update/update
Content-Type: application/json
Origin: the isolated loopback URL

{"key":"measure-old-to-current"}
```

| Bun | Old page | Installed | Available | Check | Update POST | Code | Detail | Persisted update |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1.4.0 | 200 | 1.11.0 | 2.0.0 | update-available | 409 | deployment-refused | no-pull-request | idle |
| 1.4.3 | 200 | 1.11.0 | 2.0.0 | update-available | 409 | deployment-refused | no-pull-request | idle |

Both private stores had `pendingRestart=false` and zero release pointers.
The command's owning gate reported exit 1 during descendant cleanup. A later
identity read found every PID named by that cleanup report gone. The HTTP
refusal and durable idle state are the upgrade observations.

The first attempt's eight-second HTTP timeout preceded a state read showing
`update=idle`, `pendingRestart=false` and zero release pointers. The repeat
kept that install and request key and allowed 45 seconds for the response.

Verdict **refuted** for completing this Update from 1.11.0 here. The updater refused admission with `no-pull-request`; successful version handover and terminal-free completion could not be measured here past that refusal.

## (iv) Curator on a Claude-only install

```sh
rtk proxy bash "$GATE" --record "$TMPDIR/source-measurements-final.log" python3 "$MEASURE/run-source.py"
```

The isolated credential-presence fixture made `engineReadiness` return
`claude=connected` and `codex=signed-out`. Its Claude credential file was an
empty JSON document admitted by the current credential-presence check. The
fixture also supplied a live seated host and a recent delivered wake. A
pending imported candidate made curation due. `productionCurationController`
then used the real `launchAutonomousConversation` and spawn command.

```text
roleRuntime={engine:codex,model:gpt-6.1-sol,effort:high}
status=409 code=ENGINE_NOT_CONNECTED
engine=codex reason=signed-out role=curator
pass={state:failed,failure:no-account}
message=curation: failed, no-account
paidModelCalls=0
```

The refusal happens during engine admission, before a model turn starts.
This observation proves engine selection and failure settlement on the
production path with the stated fixtures. A successful subscription-backed
Claude curation turn remains outside this observation.

Verdict **confirmed**. On the Claude-only readiness state, the curator chooses Codex and settles as `no-account`. Selecting the connected engine is justified for slice 1.

## (v) Browser installation on a real Mac

```sh
uname -s
```

Output was `Linux`. The environment supplies Linux x86_64. Safari Add to Dock
and Chrome or Edge installation on physical macOS require a Mac with those
browsers. The manifest lane owns the optional Linux Chromium evidence.

Verdict **could not be measured here**. A real Mac is unavailable for Safari Add to Dock and Chrome or Edge installation.

## (vi) Readiness with the access key enabled

```sh
rtk proxy bash "$GATE" --record "$TMPDIR/cli-measurements-v2.log" python3 "$MEASURE/lifecycle.py"
```

The private install received a generated LLV_TOKEN. The unauthenticated
request reproduced the unofficial community launcher's GET predicate.

| Bun | Unauthenticated GET / | With private bearer key | Launcher's healthy predicate |
| --- | --- | --- | --- |
| 1.4.0 | 403 | 200 | false |
| 1.4.3 | 403 | 200 | false |

Verdict **confirmed**. The access-key install is serving, and the launcher's unauthenticated readiness predicate rejects it.

## (vii) N8 timings and interaction counts

```sh
MEASUREMENT_RUN_ID=cold-a rtk proxy bash "$GATE" --record "$TMPDIR/cli-cold-a.log" python3 "$MEASURE/lifecycle.py"
MEASUREMENT_RUN_ID=cold-b rtk proxy bash "$GATE" --record "$TMPDIR/cli-cold-b.log" python3 "$MEASURE/lifecycle.py"
rtk proxy bash "$GATE" --record "$TMPDIR/codex-cold-measurements.log" python3 "$MEASURE/codex-start.py"
rtk proxy bash "$GATE" --record "$TMPDIR/dom-measurements.log" python3 "$MEASURE/run-dom.py"
```

Each invocation uses its required run id to create new `cli-v2-<run-id>-*`
roots. The driver refuses a reused root and records the empty HOME and Bun
cache checks beside every launch. The two invocations therefore have distinct
empty roots for every runtime and mode.

Cold runs used a fresh HOME and Bun package cache per sample and this command.
The clock starts immediately before process creation and ends at the first
GET / returning 200 with Delegatus HTML. The data are empty installs and the
same published package. Other machine load was uncontrolled. These are
observed elapsed times from the `solo` rows in the two run ids above. Both
invocations also run the team, access-key and install modes; those results are
reported in their respective sections.

```sh
"$RUNTIME" "$MEASURE/npm-2.0.0/package/bin/cli.mjs" --port "$PORT" --hostname 127.0.0.1 --no-open
```

| Runtime | `cold-a` first response | `cold-b` first response | Per-sample response and isolation |
| --- | ---: | ---: | --- |
| Bun 1.4.0 | 9.576 s | 7.805 s | GET 200, Delegatus HTML, fresh HOME/cache |
| Bun 1.4.3 | 10.054 s | 8.886 s | GET 200, Delegatus HTML, fresh HOME/cache |

These timings measure the first HTTP response from the same installed package;
they do not measure a signed-in account's post-load account state. The separate
Codex catalogue and readiness probes above cover the Codex-only account.
Authenticated Claude-only and both-engine timings remain unmeasured because
the scratch install has no authenticated Claude account.

The interaction probe mounted the current guide components using the existing
`OnboardingDialog.dom.test.tsx` setup. HTTP responses were fixtures. It
intercepted the draft event before agent launch. The sequence was Continue,
project row, Continue, Continue past Telegram, Create. Accounts in the first
three cases started connected.

| Situation | Presses to draft request | Pastes | Sign-ins during fixture journey | Draft requests | Greeting |
| --- | --- | --- | --- | --- | --- |
| Claude only | 5 | 0 | 0 | 1 | Unmeasured |
| Codex only | 5 | 0 | 0 | 1 | Unmeasured |
| Both | 5 | 0 | 0 | 1 | Unmeasured |
| Neither, CLIs present | 4 | 0 | 0 | 0 | Unmeasured, Create absent |

Verdict **confirmed** for N8's five-press shortest path to the draft in the three connected fixtures. Presses, pastes and sign-ins through an actual greeting **could not be measured here**; greeting turns would exceed the paid calls needed for (i) and (iv), and fresh Claude authentication is unavailable.

## (viii) PushManager on an iPhone

```sh
uname -s
```

Output was `Linux`. An iPhone with Safari and a Home Screen installation is
required to compare `typeof PushManager` and notification permission on the
two surfaces.

Verdict **could not be measured here**. An iPhone is unavailable for the tab and Home Screen app comparison.

## Slice 1 premises and remaining work

Both backend premises are confirmed at the production seams exercised above.
For the import host, a seated project outside the Delegatus repository can
host the notes otherwise assigned to a seatless repository project. The
before-seat case additionally retains its saved curation routing after a seat
appears. For the curator, a connected Claude readiness state still resolves
the role to Codex and stores `no-account` after the real spawn refusal.

The next slice can build the import-host fallback and connected-engine
selection with regression tests. Those tests must cover the saved before-seat
routing as well as a new import started after designation. Successful Claude
model execution remains a later verification gap.

Deferred work includes the Settings line, all other UI changes, the manifest
and guide, first-task form and mandate, and start at login. The sibling
manifest lane's layout, manifest route, guide, second-view document and capture
driver diff were inspected. The prototype lane is active. Related open PRs
3606 and 3756 carry design documents for team memory and project-start MCP.
This note adds measurement evidence to their existing boundaries.

The six setup-guide scenarios remain tracked by task e6a358dc. Shared
onboarding diagnostics belong to 8cf753fd. Transfer bundles and their remaining
work belong to c2c481e5. This note measures the engine-memory import.

Final source probes passed 4 tests and 13 assertions. The DOM measurement
passed 4 tests and 64 assertions. CLI, catalogue and Codex-only cold-start
campaigns exited 0. The update campaign recorded the refusals above and exited
1 during owned cleanup. The first unpacked-package CLI attempt returned 500
because declared `zod` dependencies had yet to be installed. Installing the
package dependencies cleared that harness condition before the final matrix.
The source harness's first two attempts corrected an empty-pass setup and a
terminal-pass lookup. The final run uses a pending import and reads the pass
by its recorded ID.

The source checkout and remote main both resolved to `2449d4c3b5` at the
00:14 UTC base check. The publication privacy result is recorded after the appendices.

## Probe bodies

These are the final scratch drivers. Set the environment lookups below to the
resolved pinned Bun, Codex binary and the two operator-state comparison paths
before isolation. The operator paths are comparison inputs. The children use
the fresh roots in `env.json`. The source export is `git archive` of the source
revision recorded above, extracted into `$MEASURE/src`.

The package setup downloaded each version's metadata from
`https://registry.npmjs.org/delegatus-cli/<version>`, fetched its `dist.tarball`,
checked `dist.integrity` against SHA-512, and extracted into
`$MEASURE/npm-<version>/package`. Bun 1.4.3 was extracted into
`$MEASURE/bun-1.4.3/bun-linux-x64/bun`.

`env.json` is generated from `$MEASURE` before running the drivers.

```python
import json
import os
import pathlib

base = pathlib.Path(os.environ["MEASURE"]).resolve()
environment = {}
for key, name in [("HOME", "home"), ("XDG_CONFIG_HOME", "config"),
                  ("XDG_CACHE_HOME", "cache"), ("XDG_DATA_HOME", "data"),
                  ("TMPDIR", "tmp"), ("LLV_STATE_DIR", "state")]:
    directory = base / name
    directory.mkdir(parents=True, exist_ok=True)
    assert directory.resolve() == directory
    environment[key] = str(directory)
environment.update(LLV_VIEWER_CONTROL_URL="http://127.0.0.1:1",
                   LLV_GATE_RUNNER="off", DELEGATUS_TELEMETRY_OVERRIDE="off",
                   DO_NOT_TRACK="1")
(base / "env.json").write_text(json.dumps(environment))
```

<details>
<summary>src/measurement.test.ts</summary>

```typescript
import { test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runMemoryImportWork } from "./src/lib/memory/importWork";
import { readImportCandidates } from "./src/lib/memory/importStore";
import { selectImportBatch } from "./src/lib/memory/importCuration";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } from "./src/lib/orchestrator/seats";
import { viewerRepositoryProjects } from "./src/lib/projects/viewerRepository";
import metadata from "./package.json";
const root = process.env.TMPDIR!;
const at = new Date().toISOString();
function fresh(name: string) {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  process.env.LLV_STATE_DIR = path.join(dir, "state"); fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
  process.env.DELEGATUS_STATE_DIR = process.env.LLV_STATE_DIR;
  return dir;
}
function seat(project: string) {
  const key = `measure-${project}`;
  beginOrchestratorSeatIntent({ project, mandate: "Measure isolated note routing.", clientRequestId: key, mode: "existing", conversationId: "conversation_measure_seat", now: at });
  completeOrchestratorSeatIntent({ project, clientRequestId: key, conversationId: "conversation_measure_seat", path: null, now: at, preparedAuthCredentialBaseline: null });
  expect(orchestratorSeatFor(project).active).toBeTruthy();
}
for (const before of [true, false]) test(`import ${before ? "before" : "after"} first seat`, async () => {
  const dir = fresh(before ? "before-seat-final" : "after-seat-final");
  const claude = path.join(dir, "claude");
  for (const slug of ["work-project", "other-project"]) {
    const memory = path.join(claude, "projects", slug, "memory"); fs.mkdirSync(memory, { recursive: true });
    fs.writeFileSync(path.join(memory, "topic.md"), `Inspect current ownership before changing ${slug} workers.\n`);
  }
  if (!before) seat("work-project");
  const id = before ? "measure-before-final" : "measure-after-final";
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "importing", importId: id, importStartedAt: at, changedAt: at }));
  const record = await runMemoryImportWork({ importId: id, previous: null, roots: { claudeHomes: [claude], codexHomes: [] }, at }, { projectForSlug: slug => slug, writer: async () => ({ kind: "unknown", roleId: null }) });
  const viewer = viewerRepositoryProjects(metadata.repository.url, process.cwd())[0];
  if (before) seat("work-project");
  const candidates = readImportCandidates(id).candidates;
  console.log(JSON.stringify({ measurement: "i", started: before ? "before-seat-final" : "after-seat-final", importState: record.state, hostIsViewerProject: record.hostProject === viewer, hostHasSeat: Boolean(orchestratorSeatFor(record.hostProject!).active), candidates: candidates.map(c => ({ origin: c.occurrences[0].project, curation: c.curationProject === viewer ? "viewer-repository" : c.curationProject, dispositions: c.dispositions.length })), workBatch: selectImportBatch("work-project")?.candidates.length ?? 0, viewerBatch: selectImportBatch(viewer)?.candidates.length ?? 0 }));
  expect(record.hostProject).toBe(viewer);
  expect(orchestratorSeatFor(viewer).active).toBeNull();
});
test("curator controller on Claude-only credential-presence fixture", async () => {
  const dir = fresh("curator-controller-final");
  const claude = path.join(dir, "claude"); fs.mkdirSync(claude);
  fs.writeFileSync(path.join(claude, ".credentials.json"), "{}", { mode: 0o600 });
  process.env.LLV_CLAUDE_HOME = claude;
  process.env.DELEGATUS_CLAUDE_HOME = claude;
  const { engineReadiness } = await import("./src/lib/accounts/engineConnection");
  const connected = { claude: engineReadiness("claude", "work-project"), codex: engineReadiness("codex", "work-project") };
  const { importCandidate, seedImport } = await import("./src/lib/memory/fixtures/import");
  const candidate = importCandidate(); candidate.occurrences[0].project = "work-project";
  await seedImport([candidate], "work-project");
  const { readPass } = await import("./src/lib/memory/curation/store");
  const { resolveSpawnRole } = await import("./src/lib/roles/registry");
  const { launchAutonomousConversation } = await import("./src/lib/agent/autonomousConversation");
  const { productionCurationController } = await import("./src/lib/memory/curation/run");
  const { defaultSeatTickSources } = await import("./src/lib/monitor/seatTickSources");
  const { AgentRegistry } = await import("./src/lib/agent/registry");
  const { input } = await import("./src/lib/boardMaintenance/testFixture");
  const { emptySeatTickState } = await import("./src/lib/monitor/types");
  const { writeSeatTickState } = await import("./src/lib/monitor/seatTickState");
  const now = Date.now();
  const registry = new AgentRegistry(path.join(dir, "registry.json"));
  registry.conversation = () => ({ supersededBy: null, generations: [] }) as never;
  const designated = { conversationId: "conversation_measure_seat", seatEpoch: 1, designatedAt: new Date(now - 86400000).toISOString(), path: null };
  writeSeatTickState("work-project", { ...emptySeatTickState(), seatEpoch: 1, lastWakeAt: new Date(now - 1000).toISOString() });
  const sources = { ...defaultSeatTickSources(), now: () => now, registry: () => registry, workerCounts: undefined,
    seatFor: () => ({ active: designated, pending: null, history: [] }) as never,
    activeSeats: () => ["work-project"], pipelines: () => [{ project: "work-project", repoDir: dir }] as never,
    liveness: async () => [{ conversationId: designated.conversationId, host: { state: "alive", pid: process.pid, kind: "structured" }, lifecycle: "waiting", reason: "host_alive_turn_idle" }] as never,
    latestDeployment: () => ({ state: "ok" as const, value: null }),
  };
  let result: Awaited<ReturnType<typeof launchAutonomousConversation>> | null = null;
  let runtime: unknown = null;
  let passId = "";
  const controller = productionCurationController(sources, { archive: () => {}, launch: async (body, authorize) => {
    passId = String(body.clientAttemptId);
    const role = resolveSpawnRole(body); runtime = role.ok ? role.value?.config : role;
    result = await launchAutonomousConversation(body, authorize); return result;
  } });
  const message = await controller.launchIfDue({ ...input(), project: "work-project", now });
  const pass = readPass(passId);
  console.log(JSON.stringify({ measurement: "iv", fixture: "Claude credential presence, live seat and delivered wake are fixtures", connected, roleRuntime: runtime, status: result?.status, code: result?.body.code, details: result?.body.details, pass: { state: pass?.state, failure: pass?.failure }, message, paidModelCalls: 0 }));
  expect(connected.claude).toBe("connected"); expect(connected.codex).not.toBe("connected");
  expect(result?.status).toBe(409); expect(result?.body.code).toBe("ENGINE_NOT_CONNECTED");
  expect(pass?.failure).toBe("no-account");
});
test("Codex-only missing model readiness", async () => {
  fresh("codex-model");
  const { orchestratorRuntime } = await import("./src/components/onboarding/OrchestratorStep");
  const { launchReadiness } = await import("./src/components/draft/AgentLaunchControls");
  const runtime = orchestratorRuntime(null, { claude: false, codex: true });
  const catalog = { codex: { active: "fixture", accounts: [{ id: "fixture", label: "Fixture account", signedOut: false }] }, claude: { active: "", accounts: [] }, copilot: { active: "", accounts: [] } };
  console.log(JSON.stringify({ measurement: "ii", runtime, availableModels: [], readiness: launchReadiness({ engine: "codex", catalog, launchAccountId: "fixture" }) }));
  expect(runtime.model).toBe("gpt-6.1-sol");
  expect(launchReadiness({ engine: "codex", catalog, launchAccountId: "fixture" }).kind).toBe("ready");
});
```

</details>

<details>
<summary>run-source.py</summary>

```python
import os,json,pathlib,subprocess,sys
base=pathlib.Path(__file__).resolve().parent
env={'PATH':os.environ['PATH'],'LANG':'C.UTF-8',**json.loads((base/'env.json').read_text())}
for key in ['CODEX_HOME','CLAUDE_CONFIG_DIR','LLV_STATE_OWNER','LLV_VIEWER_CANONICAL_REMOTE','LLV_TOKEN','ANTHROPIC_API_KEY','OPENAI_API_KEY']:
 env.pop(key,None)
env['CODEX_HOME']=str(base/'home/.codex')
env['CLAUDE_CONFIG_DIR']=str(base/'home/.claude')
raise SystemExit(subprocess.call(['bun','test','./measurement.test.ts','--timeout','60000'],cwd=base/'src',env=env))
```

</details>

<details>
<summary>models.py</summary>

```python
import os, pathlib, subprocess, json, shutil, selectors, time
base=pathlib.Path(__file__).resolve().parent
original=pathlib.Path(os.environ['CODEX_HOME'])/'auth.json'
for directory in [os.environ['OPERATOR_CURRENT_STATE'],os.environ['OPERATOR_LEGACY_STATE']]:
    assert pathlib.Path(directory) not in original.resolve().parents
home=base/'catalog-home';home.mkdir(exist_ok=True)
auth=json.loads(original.read_text())
assert auth.get('auth_mode')=='chatgpt' and not auth.get('OPENAI_API_KEY')
shutil.copyfile(original,home/'auth.json');(home/'auth.json').chmod(0o600)
env={'PATH':os.environ['PATH'],'LANG':'C.UTF-8',**json.loads((base/'env.json').read_text()),'CODEX_HOME':str(home)}
for name in ['OPENAI_API_KEY','ANTHROPIC_API_KEY','LLV_STATE_OWNER','CLAUDE_CONFIG_DIR']:env.pop(name,None)
child=subprocess.Popen([os.environ['CODEX_BINARY'],'app-server','--listen','stdio://'],cwd=base/'src',env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(base/'catalog.stderr').open('w'),text=True,bufsize=1)
selector=selectors.DefaultSelector();selector.register(child.stdout,selectors.EVENT_READ)
def rpc(identifier,method,params):
    child.stdin.write(json.dumps({'id':identifier,'method':method,'params':params})+'\n');child.stdin.flush()
    limit=time.monotonic()+60
    while time.monotonic()<limit:
        if not selector.select(timeout=1):continue
        line=child.stdout.readline()
        if not line:raise RuntimeError('app-server stdout closed')
        message=json.loads(line)
        if message.get('id')==identifier:return message
    raise TimeoutError(method+' did not answer within 60 seconds')
try:
    init=rpc(1,'initialize',{'clientInfo':{'name':'onboarding-measurement','version':'1'},'capabilities':{'experimentalApi':True}})
    if 'error' in init:print(json.dumps({'measurement':'ii','initializeError':init['error']}))
    else:
        child.stdin.write(json.dumps({'method':'initialized','params':{}})+'\n');child.stdin.flush()
        account=rpc(2,'account/read',{'refreshToken':False})
        models=rpc(3,'model/list',{'includeHidden':True})
        data=models.get('result',{}).get('data',[])
        row={'measurement':'ii','accountPresent':bool(account.get('result',{}).get('account')),'catalogueError':models.get('error'),'models':[item.get('id',item.get('model')) for item in data],'hasGpt61Sol':any(item.get('id')=='gpt-6.1-sol' or item.get('model')=='gpt-6.1-sol' for item in data),'nextCursor':models.get('result',{}).get('nextCursor'),'paidModelCalls':0}
        print(json.dumps(row),flush=True);(base/'catalog-results.json').write_text(json.dumps(row,indent=2))
finally:
    child.terminate()
    try:child.wait(timeout=10)
    except subprocess.TimeoutExpired:child.kill();child.wait(timeout=10)
```

</details>

<details>
<summary>lifecycle.py</summary>

```python
import os, pathlib, subprocess, json, socket, time, urllib.request, urllib.error, re, signal, hashlib
base = pathlib.Path(__file__).resolve().parent
source = base / 'src'
sample = os.environ['MEASUREMENT_RUN_ID']
if not re.fullmatch(r'[a-z0-9-]+', sample): raise ValueError('invalid run id')
runtimes = [('1.4.0', pathlib.Path(os.environ['PINNED_BUN'])), ('1.4.3', base/'bun-1.4.3/bun-linux-x64/bun')]
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl): return None
opener = urllib.request.build_opener(NoRedirect)
def request(url, headers=None):
    try:
        response = opener.open(urllib.request.Request(url, headers=headers or {}), timeout=3)
    except urllib.error.HTTPError as error: response = error
    return response.status, dict(response.headers), response.read().decode(errors='replace')
def environment(directory, runtime):
    env = {key: os.environ[key] for key in ['LANG','LC_ALL','USER','LOGNAME'] if key in os.environ}
    for key, name in [('HOME','home'),('XDG_CONFIG_HOME','config'),('XDG_CACHE_HOME','cache'),('XDG_DATA_HOME','data'),('TMPDIR','tmp'),('LLV_STATE_DIR','state')]:
        location = directory/name; location.mkdir(parents=True,exist_ok=True)
        assert location.resolve() == location and location != pathlib.Path(os.environ['OPERATOR_CURRENT_STATE']) and location != pathlib.Path(os.environ['OPERATOR_LEGACY_STATE'])
        env[key] = str(location)
    binaries=directory/'bin';binaries.mkdir(exist_ok=True)
    if not (binaries/'bun').exists(): (binaries/'bun').symlink_to(runtime)
    env['BUN_INSTALL_CACHE_DIR']=str(directory/'cache/bun')
    env['BUN_INSTALL']=str(directory/'home/.bun')
    env.update(PATH=str(binaries)+':/usr/bin:/bin',LLV_VIEWER_CONTROL_URL='http://127.0.0.1:1',LLV_GATE_RUNNER='off',LLV_LANG='en',NO_COLOR='1',DELEGATUS_TELEMETRY='0',DELEGATUS_TELEMETRY_OVERRIDE='off',DO_NOT_TRACK='1')
    return env
def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); return sock.getsockname()[1]
def descendants(pid):
    found=[]
    try:
        for value in pathlib.Path(f'/proc/{pid}/task/{pid}/children').read_text().split():
            child=int(value); found.append(child);found.extend(descendants(child))
    except FileNotFoundError: pass
    return found
for version in ['1.11.0','2.0.0']:
    directory=base/('deps-'+version);directory.mkdir(exist_ok=True)
    env=environment(directory,runtimes[0][1])
    with (directory/'install.log').open('w') as stream:
        setup=subprocess.run([str(runtimes[0][1]),'install','--ignore-scripts'],cwd=base/('npm-'+version)/'package',env=env,stdout=stream,stderr=subprocess.STDOUT,timeout=180)
    print(json.dumps({'package':version,'dependencyInstallExit':setup.returncode}),flush=True)
    if setup.returncode:raise SystemExit(setup.returncode)
results=[]
for runtime_version, runtime in runtimes:
    for mode in ['solo','team','key','install']:
        directory=base/f'cli-v2-{sample}-{runtime_version}-{mode}'; directory.mkdir()
        env=environment(directory,runtime)
        home_empty=not any((directory/'home').iterdir())
        cache_empty=not any((directory/'cache').iterdir())
        if not home_empty or not cache_empty: raise RuntimeError('sample HOME or cache was not empty')
        if mode=='team':
            code='import {teamStore} from "./src/lib/team/store"; import {claimInstall} from "./src/lib/team/members"; claimInstall(teamStore(),"Fixture owner",{surface:"desktop",browser:"chrome"}); console.log("team-owner-created");'
            setup=subprocess.run([str(runtime),'--eval',code],cwd=source,env=env,capture_output=True,text=True,timeout=30)
            print(json.dumps({'runtime':runtime_version,'mode':mode,'setupExit':setup.returncode,'setupOutput':setup.stdout[-300:],'setupError':setup.stderr[-500:]}),flush=True)
            if setup.returncode: continue
        if mode=='key': env['LLV_TOKEN']=os.urandom(16).hex()
        selected=port()
        command=[str(runtime),str(base/'npm-2.0.0/package/bin/cli.mjs'),'--port',str(selected),'--hostname','127.0.0.1','--no-open']
        if mode=='install':command=[str(runtime),'x','--bun','delegatus-cli@2.0.0','--port',str(selected),'--hostname','127.0.0.1','--no-open']
        log=directory/'cli.log'; started=time.monotonic();child=None
        try:
            with log.open('w') as stream:
                child=subprocess.Popen(command,cwd=directory,env=env,stdout=stream,stderr=subprocess.STDOUT)
                deadline=started+100; observed=None
                while time.monotonic()<deadline and child.poll() is None:
                    try:
                        status,headers,body=request(f'http://127.0.0.1:{selected}/')
                        if status!=503:observed=(status,headers,body);break
                    except (OSError,urllib.error.URLError): time.sleep(.2)
                row={'measurement':'iii' if mode!='key' else 'vi','sample':sample,'runtime':runtime_version,'package':'2.0.0','mode':mode,'freshHome':home_empty,'freshBunCache':cache_empty,'homeRoot':directory.name+'/home','bunCacheRoot':directory.name+'/cache/bun','firstResponseSeconds':round(time.monotonic()-started,3)}
                if observed:
                    status,headers,body=observed
                    row.update(status=status,location=headers.get('Location'),containsDelegatus='Delegatus' in body)
                    row['navigationStatus']=request(f'http://127.0.0.1:{selected}/',{'Accept':'text/html'})[0]
                    scripts=re.findall(r'<script[^>]+src="([^"]+\.js[^\"]*)"',body)
                    row['scriptStatus']=request(f'http://127.0.0.1:{selected}'+scripts[0])[0] if scripts and scripts[0].startswith('/') else None
                    row['launcherHealthy']=status==200 and row['containsDelegatus'] and row['scriptStatus']==200
                    if mode=='key': row['authenticatedStatus']=request(f'http://127.0.0.1:{selected}/',{'Authorization':'Bearer '+env['LLV_TOKEN']})[0]
                    if mode=='solo':
                        status2,_,snapshot=request(f'http://127.0.0.1:{selected}/api/self-update?readOnly=1&work=0')
                        (directory/'update-snapshot.json').write_text(snapshot)
                        row['snapshotStatus']=status2
                else:row.update(status=None,earlyExit=child.poll())
                owned=descendants(child.pid)
                identities={}
                for pid in owned:
                    try:identities[pid]=pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
                    except FileNotFoundError:pass
                row['recordedDescendantsBeforeTerm']=len(identities)
                term=time.monotonic()
                if child.poll() is None:child.send_signal(signal.SIGTERM)
                try:row['sigtermExit']=child.wait(timeout=20)
                except subprocess.TimeoutExpired:row['sigtermExit']='did not exit within 20 seconds'
                row['shutdownSeconds']=round(time.monotonic()-term,3)
                surviving=[]
                for pid,start in identities.items():
                    try:
                        fields=pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()
                        if fields[19]==start and fields[0]!='Z':surviving.append(pid)
                    except FileNotFoundError:pass
                row['recordedDescendantsAfterTerm']=len(surviving)
                try:request(f'http://127.0.0.1:{selected}/');row['listenerClosed']=False
                except (OSError,urllib.error.URLError):row['listenerClosed']=True
                results.append(row);print(json.dumps(row),flush=True)
        finally:
            if child is not None and child.poll() is None:
                child.kill();child.wait(timeout=10)
(base/'lifecycle-results.json').write_text(json.dumps(results,indent=2))
```

</details>

<details>
<summary>update.py</summary>

```python
import pathlib
import http.cookiejar
exec((pathlib.Path(__file__).parent/'lifecycle.py').read_text().split("for version in ['1.11.0','2.0.0']:")[0])
results=[]
for runtime_version,runtime in runtimes:
    directory=base/f'update-{runtime_version}';directory.mkdir(exist_ok=True)
    env=environment(directory,runtime); selected=port(); url=f'http://127.0.0.1:{selected}'
    cookies=http.cookiejar.CookieJar();browser=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))
    def fetch(route, body=None):
        data=json.dumps(body).encode() if body is not None else None
        headers={'Accept':'text/html' if route=='/' else 'application/json'}
        if data is not None:headers.update({'Content-Type':'application/json','Origin':url})
        try:response=browser.open(urllib.request.Request(url+route,data=data,headers=headers),timeout=45)
        except urllib.error.HTTPError as error:response=error
        raw=response.read().decode(errors='replace')
        try:parsed=json.loads(raw)
        except ValueError:parsed={}
        return response.status,parsed
    def view(snapshot):
        return {'installed':snapshot.get('installed',{}).get('version'),'serving':{key:value.get('version') if isinstance(value,dict) else None for key,value in snapshot.get('serving',{}).items()},'available':(snapshot.get('available') or {}).get('version'),'check':snapshot.get('check',{}).get('state'),'checkError':snapshot.get('check',{}).get('error'),'update':snapshot.get('update',{}).get('state'),'busy':snapshot.get('busy'),'action':(snapshot.get('action') or {}).get('id'),'actionButton':(snapshot.get('action') or {}).get('button')}
    command=[str(runtime),str(base/'npm-1.11.0/package/bin/cli.mjs'),'--port',str(selected),'--hostname','127.0.0.1','--no-open']
    child=None;row={'measurement':'iii-update','runtime':runtime_version,'from':'1.11.0'}
    try:
        with (directory/'cli.log').open('w') as stream:
            child=subprocess.Popen(command,cwd=directory,env=env,stdout=stream,stderr=subprocess.STDOUT)
            limit=time.monotonic()+90;started=False
            while time.monotonic()<limit and child.poll() is None:
                try:
                    status,_=fetch('/')
                    if status==200:started=True;break
                except (OSError,urllib.error.URLError):pass
                time.sleep(.25)
            row['initialPage200']=started
            if started:
                status,snapshot=fetch('/api/self-update?work=0')
                limit=time.monotonic()+90
                while snapshot.get('check',{}).get('state') in ['idle','checking'] and time.monotonic()<limit:
                    time.sleep(1);status,snapshot=fetch('/api/self-update?readOnly=1&work=0')
                row['before']=view(snapshot)
                print(json.dumps({'runtime':runtime_version,'before':row['before']}),flush=True)
                (directory/'before-snapshot.json').write_text(json.dumps(snapshot))
                status,response=fetch('/api/self-update/update',{'key':'measure-old-to-current'})
                row['updatePostStatus']=status;row['updatePostCode']=response.get('code');row['updatePostDetail']=response.get('detail')
                if status==202:
                    limit=time.monotonic()+240
                    while time.monotonic()<limit:
                        try:
                            _,snapshot=fetch('/api/self-update?readOnly=1&work=0')
                            serving=snapshot.get('serving',{})
                            if all(isinstance(serving.get(role),dict) and serving[role].get('version')=='2.0.0' for role in ['web','runtimeHost']):break
                            if snapshot.get('update',{}).get('state')=='failed':break
                        except (OSError,urllib.error.URLError):pass
                        time.sleep(1)
                    row['after']=view(snapshot)
                else: row['after']=view(response.get('snapshot',{}))
                (directory/'final-snapshot.json').write_text(json.dumps(snapshot))
            print(json.dumps(row),flush=True);results.append(row)
    finally:
        if child is not None and child.poll() is None:
            child.send_signal(signal.SIGTERM)
            try:child.wait(timeout=20)
            except subprocess.TimeoutExpired:child.kill();child.wait(timeout=10)
(base/'update-results.json').write_text(json.dumps(results,indent=2))
```

</details>

<details>
<summary>codex-start.py</summary>

```python
import pathlib, shutil
exec((pathlib.Path(__file__).parent/'lifecycle.py').read_text().split("for version in ['1.11.0','2.0.0']:")[0])
source_auth=pathlib.Path(os.environ['CODEX_HOME'])/'auth.json'
assert json.loads(source_auth.read_text()).get('auth_mode')=='chatgpt'
rows=[]
for version,runtime in runtimes:
    for trial in [1,2]:
        directory=base/f'codex-cold-{version}-{trial}';directory.mkdir(exist_ok=True)
        env=environment(directory,runtime)
        auth_home=pathlib.Path(env['HOME'])/'.codex';auth_home.mkdir(exist_ok=True)
        shutil.copyfile(source_auth,auth_home/'auth.json');(auth_home/'auth.json').chmod(0o600)
        env.update(CODEX_HOME=str(auth_home),LLV_CODEX_HOME=str(auth_home))
        (directory/'bin/codex').symlink_to(os.environ['CODEX_BINARY'])
        selected=port();url=f'http://127.0.0.1:{selected}'
        command=[str(runtime),'x','--bun','delegatus-cli@2.0.0','--port',str(selected),'--hostname','127.0.0.1','--no-open']
        child=None;started=time.monotonic()
        try:
            with (directory/'cli.log').open('w') as log:
                child=subprocess.Popen(command,cwd=directory,env=env,stdout=log,stderr=subprocess.STDOUT)
                limit=started+100;observed=None
                while time.monotonic()<limit and child.poll() is None:
                    try:
                        status,_,body=request(url)
                        if status==200 and 'Delegatus' in body:observed=round(time.monotonic()-started,3);break
                    except (OSError,urllib.error.URLError):pass
                    time.sleep(.2)
                row={'measurement':'vii','situation':'codex-only','runtime':version,'trial':trial,'coldInstallToPageSeconds':observed,'paidModelCalls':0}
                if observed:
                    status,_,raw=request(url+'/api/accounts');accounts=json.loads(raw)
                    row['accountsStatus']=status
                    for engine in ['claude','codex']:
                        section=accounts.get(engine,{})
                        row[engine]={'credentialPresent':any(a.get('authPresent') for a in section.get('accounts',[])),'cli':section.get('cli')}
                print(json.dumps(row),flush=True);rows.append(row)
        finally:
            if child is not None and child.poll() is None:
                child.send_signal(signal.SIGTERM)
                try:child.wait(timeout=20)
                except subprocess.TimeoutExpired:child.kill();child.wait(timeout=10)
(base/'codex-start-results.json').write_text(json.dumps(rows,indent=2))
```

</details>

<details>
<summary>src/src/components/onboarding/measurement.dom.test.tsx</summary>

```tsx
import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

/*
 * #1876: the setup guide closes on Escape whatever holds focus. The capture
 * found a guide that ignored Escape once focus had left its panel, because the
 * key was only heard on the panel itself; it is now heard on the window for as
 * long as the dialog is open, Tab stays inside the panel, and focus returns to
 * whatever held it before the guide opened.
 */

const dom = new Window({ url: "http://localhost/" });
const matchMediaStub = (query: string) => ({
  matches: false,
  media: String(query),
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});
(dom as unknown as { matchMedia: typeof matchMediaStub }).matchMedia = matchMediaStub;
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  CustomEvent: dom.CustomEvent,
  localStorage: dom.localStorage,
  matchMedia: matchMediaStub,
  fetch: (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
    if (url.includes("/api/telegram/bot")) return json({ bot: botStatus });
    if (url.includes("/api/projects/settings")) {
      if (init?.method === "PUT") {
        const written = (JSON.parse(String(init.body)) as { reportTelegram: { chat: string; name: string } | null }).reportTelegram;
        return json({ ok: true, reportTelegram: written ?? { chat: null }, reportDestination: written ? { ...written, source: "chosen" } : null, reportNameSuggestion: nameSuggestion, postableChats: 1 });
      }
      return json({ ok: true, reportNameSuggestion: nameSuggestion, ...reportSettings });
    }
    /* The route answers every kept write with the marker it wrote. */
    if (url.includes("/api/onboarding")) {
      if (init?.method !== "PUT") return onboardingRead();
      if (onboardingRefusal) return json({ error: onboardingRefusal }, 500);
      return json({ marker: { schemaVersion: 1, completedAt: null, dismissedAt: null, reason: null, steps: {}, lastHealth: null, walk: null } });
    }
    if (url.includes("/api/external-relay")) return json(relayBody);
    if (url.includes("/api/roles")) return json(rolesBody);
    if (url.includes("/api/transcribe/backend")) return json({ backend: "local", lockedByEnv: false, options: [] });
    if (url.includes("/api/access")) return json({ tailnetUrl: null, phone: { state: "missing", dnsName: null, viewerPort: 8898, servingPort: null, persisted: false }, phoneError: null });
    if (url.includes("/api/orchestrator/seat")) return Promise.resolve(new Response("{}", { status: 404 }));
    if (url.includes("/api/accounts/copilot")) return json({ cli: { present: false, reason: null }, active: "", accounts: [] });
    if (url.endsWith("/api/accounts") || url.includes("/api/accounts?")) return json(accountsBody);
    return json({ claude: { active: "", accounts: [] }, codex: { active: "", accounts: [] } });
  },
});

/* What `GET /api/onboarding` answers; the host's marker cases set it. */
let onboardingRead: () => Promise<Response> = () => json({ marker: null });

/* What `/api/external-relay` answers; the relay step's cases set it. */
let relayBody: unknown = { relays: [], pending: [], status: [] };

/* What `/api/roles` answers; the agent mapping's case sets it. */
let rolesBody: unknown = { schemaVersion: 2, roles: [] };

/* Every request the guide made, and what the bot panel's status read answers:
   the Telegram step's cases set it (docs/design/orchestrator-reports.md §5.6). */
const requests: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
let nameSuggestion: string | null = "Widgets";
/* What the settings route answers about the destination: never chosen, and
   no chat the bot may post in, unless a case says otherwise. */
let reportSettings: Record<string, unknown> = { reportTelegram: null, reportDestination: null, postableChats: 0 };
let botStatus: unknown = { connected: false, bot: null, receiving: "stopped", lastUpdateAt: null, lastCheckedAt: null, chats: [], limits: [] };

/* What `/api/accounts` answers; the orchestrator step's cases set it. */
const signedIn = (id: string, label: string) => ({ id, label, kind: "legacy", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, auth: { state: "authenticated" } });
let accountsBody: unknown = { claude: { active: "", accounts: [] }, codex: { active: "", accounts: [] } };

const { OnboardingDialog } = await import("./OnboardingDialog");
/* The engine stores read `/api/accounts` once per process; each case that
   answers it differently starts them afresh. */
const { resetEngineAccountsStoresForTests } = await import("@/hooks/useEngineAccounts");
/* When set, the onboarding route refuses every write with this error. */
let onboardingRefusal: string | null = null;
function answerAccounts(body: unknown): void {
  accountsBody = body;
  resetEngineAccountsStoresForTests();
}

afterAll(() => { void dom.happyDOM.close(); });

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 150 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}
for (const situation of ["claude", "codex", "both", "neither"]) test(`measure first-run presses ${situation}`, async () => {
  localStorage.clear(); sessionStorage.clear(); requests.length = 0;
  const connected = (engine: string) => situation === engine || situation === "both";
  answerAccounts({ claude: { active: "default", cli: "found", accounts: connected("claude") ? [signedIn("default", "Fixture")] : [] }, codex: { active: "default", cli: "found", accounts: connected("codex") ? [signedIn("default", "Fixture")] : [] }, copilot: { active: "", accounts: [] } });
  const { onOrchestratorDraftRequest } = await import("@/components/orchestrator/draftPrefill");
  const drafts: unknown[] = []; const off = onOrchestratorDraftRequest(value => drafts.push(value));
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
  let presses = 0;
  const click = (selector: string) => { const button = host.querySelector(selector) as HTMLButtonElement; expect(button).toBeTruthy(); expect(button.disabled).toBe(false); flushSync(() => button.click()); presses++; };
  const current = () => host.querySelector("[data-onboarding-current]")?.getAttribute("data-onboarding-current");
  try {
    flushSync(() => root.render(<OnboardingDialog mode="guide" initialStep="engines" marker={null} markerStatus="read" projects={[{ project: "repo-fixture", name: "Fixture", cwd: "projects/fixture", conversations: 0 }]} onClose={() => {}} />));
    await until(() => current() === "engines"); click("[data-onboarding-primary]");
    await until(() => current() === "project"); click("[data-onboarding-project=repo-fixture]"); click("[data-onboarding-primary]");
    await until(() => current() === "telegram"); click("[data-onboarding-primary]");
    await until(() => current() === "orchestrator");
    await new Promise(resolve => setTimeout(resolve, 100));
    const create = host.querySelector("[data-onboarding-orchestrator-create]") as HTMLButtonElement | null;
    const runsOn = host.querySelector("[data-onboarding-orchestrator-runs-on]")?.textContent;
    if (situation !== "neither") { await until(() => Boolean(host.querySelector("[data-onboarding-orchestrator-create]:not([disabled])"))); click("[data-onboarding-orchestrator-create]"); expect(drafts.length).toBe(1); }
    console.log(JSON.stringify({ measurement: "vii", situation, pressesToDraftRequest: presses, pastes: 0, signIns: 0, alreadyAuthenticatedFixture: situation !== "neither", createPresent: Boolean(create), runsOn, draftRequests: drafts.length, greetingMeasured: false, modelCatalogues: "empty mocked endpoint", paidModelCalls: 0 }));
    expect(presses).toBe(situation === "neither" ? 4 : 5);
  } finally { off();flushSync(() => root.unmount());host.remove(); }
});
```

</details>

<details>
<summary>run-dom.py</summary>

```python
import os,json,pathlib,subprocess
base=pathlib.Path(__file__).resolve().parent
env={'PATH':os.environ['PATH'],'LANG':'C.UTF-8',**json.loads((base/'env.json').read_text())}
env['LLV_STATE_DIR']=str(base/'dom-state')
pathlib.Path(env['LLV_STATE_DIR']).mkdir(exist_ok=True)
raise SystemExit(subprocess.call(['bun','test','./src/components/onboarding/measurement.dom.test.tsx','--timeout','60000'],cwd=base/'src',env=env))
```

</details>

## Publication check

The final note was copied into the isolated source export and checked with
the committed known-value fingerprints.

```sh
python3 "$MEASURE/run-privacy.py"
```

That driver used the same private environment and executed this command from
`$MEASURE/src`, with `LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE` pointing to
`scripts/privacy-known-value-fingerprints.json` in that export.

```sh
bun scripts/privacy-publication-gate.ts --repository "$MEASURE/src" --require-known-values --paths docs/design/install-and-onboarding-measurements.md
```

```text
PRIVACY GATE: PASS
```

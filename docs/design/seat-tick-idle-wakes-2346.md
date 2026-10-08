# Seat tick idle wakes: investigation of #2346

Investigation date: 2026-10-09. Tested main:
`419c0f67b3ebf94afe52f81070f31bab647d77c3`, also the pipeline's starting
commit. `git ls-remote origin refs/heads/main` returned that commit before and
after the probes. File:line references below name that revision.

**Stage verdict: pass.** All four claim families have deterministic controller
evidence, classifications, causes for reproduced behavior, a minimal fix and
regression acceptance. This is the investigation deliverable; implementation
and publication belong to later stages.

| Pinned claim | Current-main verdict | Evidence |
| --- | --- | --- |
| C1. An idle seat misses a parented child's completion; perhaps checks require a delivery or turn. | **REPRODUCES / CONFIRMED** for the missed next-check deadline. **DOES NOT REPRODUCE / WRONG** for the proposed delivery-dependent timer. | C1a independently dispatches through `startSeatTick → reconcileSeatTick → runSeatTickCheck`, with zero operator turns. C1b delays a terminal child for eight minutes at the default five-minute check cadence. |
| C2. The interval does not count running children, and does not fire every five minutes while work is open. | **REPRODUCES / CONFIRMED** for cadence suppression and unexplained unparented exclusion. **DOES NOT REPRODUCE / WRONG** for exclusion of parented running children. | C2 gets interval deliveries at minutes 0, 5 and 10, then quiet checks at 15 and 20 under the retry guard. Its unparented-only control stays quiet while its settings card advertises five-minute wakes. |
| C3. Reading a child's final message and acting on it does not stop an “unharvested” announcement. | **REPRODUCES / CONFIRMED.** | C3 reads the actual final transcript through `conversation_messages`, reserves a follow-up worker, then receives `child-terminal` with “outcome unharvested”. Acknowledgement changes only after the wake lands. |
| C4. A deploy accepted after a transport error does not wake its seat on settlement. | **REPRODUCES / CONFIRMED.** | C4 admits into a controlled deployment ledger, throws the reported transport error, settles successfully, and observes no wake. The same-key accepted-reply control records attribution and produces `deploy-settled`. |

The cheapest falsification order was C3 (one read and check), C2 (bounded
repeated checks), C1 (the independent timer plus a phase-offset check), then
C4 (binding admission joined to controller settlement). These are hypotheses
under investigation: a disproved hypothesis does not fail this stage.

## Prior work checked first

Before controller inspection, `search_transcripts` searched `1465`, `2081`
and `2346` scoped to Delegatus, then without a project filter. Further queries
used `seat tick idle wake`, `unharvested`, `interval itemsShown`, and the exact
transport-error phrase with `deploy_exact_sha`. Relevant hits were opened
through `conversation_messages` at their transcript paths. Memory searches
used `seat tick`, `harvest`, and deployment admission/lost-reply terms; relevant
hits were opened with `search_memory` by id and their referenced memory files
were read. Private transcript paths and identifying material are omitted here.

- A 2026-09-09 investigation connected #1465 to an outstanding uncertain wake
  fencing later attempts. The fixture memory also warns to resolve a seat
  factory once. These probes reuse each fixture seat and begin without an
  outstanding wake. C2 remains unfenced when its interval stops. That earlier
  uncertain-send diagnosis does not explain these observations.
- The old #1465 memory said plain spawned children were absent from the
  interval agenda. Current code and C2's parented control disprove that old
  description: `seatTick.ts:1352` includes eligible running children. The
  source and existing regression tests now carry the child accounting.
- #2081 transcript searches produced unrelated line-number matches rather
  than a prior solution. Its issue and correction were read: the original
  claim of three continuously running lanes was corrected to completed lanes
  whose provisioned announcements swallowed settlement. The current tests
  for provisioned-then-completed and state-specific settlement both pass.
- #2346 history discussed its priority and a separate completion-before-merge
  trigger gap. Neither supplied a prior fix for the four cases here.
- The 2026-10-08 seat conversation confirms a deploy started despite the lost
  reply, then records that its settle notification was missed. No relevant
  memory supplied a ready fix. The deployment coordinator already has a
  serialized lookup by idempotency key (`src/runtime-host/deployment.ts:158`),
  which can support recovery without another deploy request.

Read [#2346](https://github.com/Latand/delegatus/issues/2346), both occurrence
comments, and the bodies/comments of
[#1465](https://github.com/Latand/delegatus/issues/1465) and
[#2081](https://github.com/Latand/delegatus/issues/2081).
`gh issue view 2346 --comments` failed on GitHub's retired `projectCards`
field; `gh issue view 2346 --comments --json number,title,body,comments,url`
returned the complete issue and its two comments.

## C1: idle checks and terminal-child latency

**DOES NOT REPRODUCE / WRONG: checks depend on a seat turn.** C1a captures the
controller's scheduled callback, runs the real sweep, lets the worker finish
one minute after the boot interval wake, and invokes the callback four minutes
later. It delivers `child-terminal` in 240,000 ms with zero operator turns.
`src/lib/monitor/seatTickController.ts:2056` installs the independent timer;
`:2064` gates overlapping sweeps, release handoff and drain; `:2070` schedules
the check and `:2074` runs it immediately. None of those gates waits for a
message on the seat.

**REPRODUCES / CONFIRMED: the next-check guarantee fails (P2).** C1b uses a
legitimate phase offset: worker reserved at minute 0, last wake credited at
minute 1, worker completed at minute 2, first check at minute 5. That check
returns `quiet`; the minute-10 check delivers `child-terminal`. Finish-to-wake
latency is **480,000 ms**, exceeding the **300,000 ms** check interval, with
one readable child, enabled five-minute settings and no outstanding attempt.
The offset models a wake landing between scheduled checks.

Root cause: `src/lib/monitor/seatTick.ts:1230` chooses a five-minute terminal
child interval and `:1233` still measures it against the project's
`lastWakeAt`. The candidate branch at `:1259` is inside `if (wakeDue)`;
`:1300` cannot raise the newly owed terminal child until that gate passes.
An unrelated recent wake can therefore suppress the first eligible check.

Minimal fix: allow a newly owed, actionable terminal outcome to compose its
`child-terminal` candidate on the next check independently of the ordinary
interval gate. Retain the existing enabled/busy checks, outstanding-send
fence, durable outcome identity, item bound and landed-wake acknowledgement.
Keep routine interval reasons on their existing clock. No timer redesign is
needed.

Test proving the fix: convert C1b's first assertion to `verdict: "wake"` and
require `child-terminal` on that first check. Its latency must be 180,000 ms;
the next check must not announce the same outcome again. Also run C1a and an
equivalent shorter check interval to prevent a hard-coded five-minute escape.
Busy-seat and retained-delivery controls must continue to defer correctly.

The eight-minute failure reproduces a missed deadline on current main. The
reported two-hour episode's individual live-state cause is not established by
this replay. In particular, C2's control shows a fresh terminal transition can
wake even after the interval retry guard has stopped routine wakes.

## C2: running work, cadence and its explanation

**DOES NOT REPRODUCE / WRONG: parented running children are absent.** C2 uses
one live, busy, parented child, no lane, and an idle seat. The first check wakes
for `interval` and names the child. `src/lib/monitor/seatTick.ts:308` includes
actionable running children in open work; `:1352` includes them in the interval
agenda.

**REPRODUCES / CONFIRMED: the recurring cadence stops (P1).** With the same
running child and unchanged board, C2 delivers at minutes 0, 5 and 10. Minutes
15 and 20 return `quiet` with “every wake reason is held by the retry guard”.
The project has no outstanding wake. A retry-guard card says resending stopped
until state moves. Finishing the child afterward produces `child-terminal`,
so this probe distinguishes suppressed periodic reminders from lost terminal
discovery.

Root cause: `src/lib/monitor/seatTick.ts:2165` leaves child items unversioned,
so they cannot pass the unseen-page exception at `:1396`. The shared guard at
`:1397` suppresses `interval` once the unchanged-wake count reaches two.
`seatTickWakeCommit` increments that count at `:2099`; the first changed
showing starts at zero, explaining the three deliveries. This is observable
policy, and it violates the pinned continuing cadence for running work.

Minimal fix: preserve interval reminders while eligible live work remains.
Exempt that periodic reminder from the fruitless-reason stop, while retaining
dedupe for completed outcomes and already delivered task/PR/stall obligations.
For open pipelines, ensure their versioned item dedupe also leaves a bounded
current-work reminder available; changing the guard alone cannot make an
empty post-dedupe agenda speak. Preserve quiet behavior for an empty agenda.

Test proving the fix: C2's five checks must all deliver, with each interval
gap at most five minutes in the idle fixture, no duplicate terminal credit,
and no retry-stop card for the live-work cadence. Repeat beyond the guard
threshold with an open running pipeline and with a cold inbox control.

**REPRODUCES / CONFIRMED: unparented work is excluded without a useful
explanation (P2).** C2's unparented-only control sends nothing. The newest
settings observation says the board is done and the proposal slot is not due;
the generated board card advertises five-minute wakes without explaining the
lineage requirement. This proves the generated settings/board data; no visual
UI change was made or assessed.

Root cause: discovery starts from the active seat's owner at
`src/lib/monitor/seatTickSources.ts:2102`, and its indexed child pages at
`:2016` require that lineage. An unparented worker is absent from the child
projection. This ownership boundary is intentional. The visibility defect is
the generic no-work clause at `src/lib/monitor/seatTick.ts:1530`, the settings
answer that relays that clause at `seatTickSettingsAnswer.ts:238`, and the
schedule-only settings card at `cards.ts:245` and `:266`. None says that an
unparented worker is excluded.

Minimal fix: retain the ownership boundary and state the interval eligibility
rule in `seat_tick_settings` and the existing board card. Record a specific
quiet explanation when no eligible agenda exists. Distinguish board open
work from an interval agenda: inbox/assigned cards can make `hasOpenWork`
true (`seatTick.ts:294`) without providing a running-child/lane reminder.
Do not call those two predicates the same thing.

Test proving the fix: the unparented-only control remains quiet, while both
its settings answer and board card explain that interval wakes need eligible
seat work and that unparented workers are excluded. A cold-inbox-only control
must report why it has no interval agenda. A parented running worker must
still produce the cadence tested above.

## C3: the harvest acknowledgement means delivery

**REPRODUCES / CONFIRMED (P2).** C3 reads a real assistant final message via
the actual binding and normalized transcript reader, then reserves a follow-up
worker based on that result. Before the controller check, acknowledged
outcomes: **0**. The wake still says “outcome unharvested”. After delivery,
acknowledged outcomes: **1**; a later check does not repeat `child-terminal`.

Root cause: `src/lib/mcp/bindings.ts:3064` gives `conversationMessages` reader
dependencies, and `:3152` returns the page without an outcome acknowledgement.
The accounting transition is at `src/lib/monitor/seatTickAccounting.ts:763`:
only `disposition === "landed"` acknowledges the child outcomes named by the
frozen wake, with `:773` changing them to `acknowledged`. Reserving another
worker does not identify or discharge that earlier outcome. The misleading
word is composed at `src/lib/monitor/seatTick.ts:1303` and `:1871`.

Minimal fix, using the specification's wording alternative: keep the reliable
delivery accounting and change the child reason/item to say that the outcome
has not yet been announced by a delivered seat-tick wake. State how that
acknowledgement is decided and that reading the transcript alone leaves it
unchanged. This requires no attempt to infer a seat's private reasoning from
a read, and no new mutation on `conversation_messages`.

Test proving the fix: retain C3's actual read and follow-up reservation, but
require an explicit delivered-wake acknowledgement explanation in the reason
or payload; the standalone ambiguous “outcome unharvested” wording must be
gone. Keep the positive control: one delivered complete outcome bullet
acknowledges once; a lost or cropped delivery leaves its obligation owed.
An implementation choosing automatic acknowledgement instead must prove the
specific caller, completed turn and action it credits; a read alone is
insufficient evidence for that alternative.

## C4: deployment admission survives a lost reply

**REPRODUCES / CONFIRMED (P1).** The injected admission seam creates the
deployment in a controlled ledger, then throws “Viewer control did not
reconnect after 2 attempts”. The deploy later becomes terminal/succeeded.
`seatDeploymentsFor` contains **0** records and the controller sends no wake.
Returning the accepted receipt for the same request key records the seat and
the otherwise unchanged controller produces `deploy-settled`.

Root cause: `src/lib/mcp/bindings.ts:3266` awaits the transport before any
seat/deploy association is persisted. The error exits before `:3277` tests
for an accepted receipt and `:3279` records attribution. The controller source
at `src/lib/monitor/seatTickSources.ts:1012` starts from those records, then
only looks up their deployment ids at `:1025`. A missing association gives it
no deployment to join, even when the deployment succeeded. This is the
admission/attribution gap; the normal attributed settle path is healthy.

Minimal fix: persist the authorized seat, revision and original request key
before dispatch as pending attribution in the existing seat-deployment
facility. Resolve it against the existing deployment lookup by idempotency
key after an uncertain reply and on later controller checks, including after
restart. Once that key is proven accepted, attach the deployment id and let
the existing settle/announcement path finish. A missing/unreadable lookup
stays pending. A definite refusal or busy receipt must not attribute somebody
else's deployment. Do not infer ownership from a matching SHA or submit a
second request under a new key.

The lookup already waits for preceding admission work at
`src/runtime-host/deployment.ts:158`; replay checks the original key at `:191`.
This design reuses that contract. It needs a narrow pending-attribution read
port where the tick currently reads seat deployments, plus recovery at the
binding/source seam. It needs no change to the pipeline engine or to the
deployment coordinator's admission algorithm.

Test proving the fix: C4's lost-reply path must itself wake on settlement,
without the manual accepted-reply positive control. Persist the pending
record, construct a fresh controller, make the original-key lookup first
unavailable and then accepted, and settle it: exactly one `deploy-settled`
wake and one announcement. Run refused, busy, foreign-seat, unknown-key and
same-SHA/different-key controls. The existing accepted-receipt authority test
does not cover the throw-before-recording branch.

## Scope, safety and validation

The executable blocks below are the only added test artifact. The controller,
sources, accounting, reader and deploy binding are production code. Existing
test helpers supply an isolated registry, durable SQLite accounting and an
event ledger; their source is extracted read-only and imports are redirected
to this checkout. The clock controls `Date.now`, no-argument `Date`, the
source clock and the timer callback. The timer test owns and clears its one
inert timer. No child or service process is signalled.

Every process has private `HOME`, `TMPDIR`, `XDG_CONFIG_HOME`, `LLV_STATE_DIR`
and a fixture scanner root. `LLV_VIEWER_CONTROL_URL` names a loopback port
obtained with port 0 and then closed. Seat listings, delivery, liveness,
deployment status, GitHub evidence, release ownership and maintenance are
injected. Neither the live seat nor its registry was read or changed by the
reproductions. Scratch files are removed with their owning temporary directory.

Validation under the pinned Bun 1.4.0:

- This document's five diagnostic cases: **5 pass, 0 fail, 36 assertions**.
- Seven selected tests from `src/lib/monitor/seatTickController.test.ts`:
  **7 pass, 0 fail** (running lanes, running spawn, busy-to-idle delivery,
  provisioned/completed settlement, state-specific settlement, attributed
  deploy settlement and immediate boot check).
- Three selected tests from `src/lib/monitor/seatTickSources.test.ts`:
  **3 pass, 0 fail** (fresh child admission, acknowledged projection removal,
  child finish/harvest fingerprint movement).
- `src/lib/mcp/deployAuthority.test.ts`: **12 pass, 0 fail**.
- Explicit-path publication privacy check with the committed fingerprints:
  **pass**. Whitespace check against the new document: **pass**.

Existing test files were run separately through `scripts/gate-slot.sh`, with
the same outer isolated environment and dependency aliases as the runner.
The tests emitted Bun's nonfatal temporary-tsconfig directory-cache warning;
each run completed with exit 0 and zero test errors. No build or broad
runtime/registry sweep was needed for this document-only change.

Implementation handoff seams: `seatTick.ts` for terminal eligibility, cadence
and wording; existing settings answer/card text for interval exclusions;
`mcp/bindings.ts`, `orchestrator/seatDeployments.ts` and the deployment source
for original-key attribution recovery. Leave `src/lib/pipelines/engine.ts`
to #2537. The timer/rotation lifecycle and settings schema are shared with the
#2577 lane: coordinate any required interface field, and keep its rotation
design untouched. The eventual PR body should list these seams. Publication
and the #2346 findings comment belong to later authorized stages.

## Executable reproductions

Run the Python block from the repository root. It extracts the TypeScript
block from this document, reuses only the existing controller test harness and
child fixtures, and runs in a private temporary directory. Dependencies are
read from the parent clone's installed `node_modules` (or `NODE_PATH`). No
installation, live server, live seat, or live registry is required.

```python
import json, os, pathlib, re, socket, subprocess, tempfile

repo = pathlib.Path.cwd()
doc = (repo / "docs/design/seat-tick-idle-wakes-2346.md").read_text()
case = re.search(r"```typescript\n(.*?)\n```", doc, re.S).group(1)
source = (repo / "src/lib/monitor/seatTickController.test.ts").read_text()
harness = source[:source.index("\ntest(")]
fixtures = source[source.index("\ninterface ChildFixture {"):
                  source.index("\n/* The RED assertion")]
helpers = re.sub(r'([\"\'])\./([^\"\']+)\1',
                 lambda m: json.dumps(str(repo / "src/lib/monitor" / m[2])),
                 harness + fixtures)
common = pathlib.Path(subprocess.check_output(
    ["git", "rev-parse", "--git-common-dir"], text=True).strip())
common = (repo / common).resolve() if not common.is_absolute() else common
modules = os.environ.get("NODE_PATH", str(common.parent / "node_modules"))
assert pathlib.Path(modules).is_dir(), "Provide installed dependencies in NODE_PATH"
with tempfile.TemporaryDirectory(prefix="llv-controller-repro-", dir="/var/tmp") as directory:
    root = pathlib.Path(directory)
    for name in ("home", "tmp", "state", "config"):
        (root / name).mkdir()
    # Bind port 0, record the assigned port, then close our own socket.
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    environment = {
        "PATH": os.environ["PATH"], "NODE_PATH": modules, "NODE_ENV": "test",
        "HOME": str(root / "home"), "TMPDIR": str(root / "tmp"),
        "XDG_CONFIG_HOME": str(root / "config"),
        "LLV_STATE_DIR": str(root / "state"),
        "LLV_VIEWER_CONTROL_URL": f"http://127.0.0.1:{port}",
        "LLV_AGENT_CPU": "off", "LLV_CPU_PRESSURE": "off",
    }
    config = root / "tsconfig.json"
    config.write_text(json.dumps({"compilerOptions": {
        "paths": {"@/*": [str(repo / "src") + "/*"],
            "@modelcontextprotocol/sdk/*": [str(pathlib.Path(modules) / "@modelcontextprotocol/sdk/dist/esm") + "/*"],
            "*": [str(pathlib.Path(modules)) + "/*"]}}}))
    testfile = root / "reproduction.test.ts"
    clock = '''let clock = Date.parse("2026-10-09T00:00:00.000Z");
const WallDate = Date;
globalThis.Date = new Proxy(WallDate, {
  construct(target, args) { return Reflect.construct(target, args.length ? args : [clock]); },
  apply() { return new WallDate(clock).toString(); },
  get(target, key, receiver) { return key === "now" ? () => clock : Reflect.get(target, key, receiver); },
});
'''
    testfile.write_text(clock + helpers + "\n" + case)
    result = subprocess.run(["bun", "test", "--tsconfig-override", str(config),
                             str(testfile)], cwd=repo, env=environment)
    raise SystemExit(result.returncode)
```

The assertions establish the observed current-main behavior. Assertions for
the required fixed behavior are specified separately for each defect, so a
green diagnostic run does not claim the product has been fixed.

```typescript
const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
const { seatDeploymentsFor } = await import("@/lib/orchestrator/seatDeployments");
const { seatTickSettingsAnswer } = await import("@/lib/monitor/seatTickSettingsAnswer");
const { seatTickIdle } = await import("@/lib/monitor/seatTickController");

function configured(f: ChildFixture) {
  return { ...defaultSeatTickSettings(f.project), wakeIntervalMinutes: 5,
    reason: "controller reproduction", updatedAt: new Date(clock).toISOString() };
}
function rigFor(f: ChildFixture) {
  f.registry.reconcileConversations([{
    engine: "claude", path: f.seat.path!, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: f.cwd, title: "seat" }),
    turn: { state: "idle", source: "assistant", terminalAt: new Date(clock).toISOString() },
    observedAt: new Date(clock).toISOString(),
  }]);
  expect(f.registry.conversation(f.seat.conversationId as never)!.turn.state).toBe("idle");
  const rig = childRig(f, { settings: configured(f) });
  rig.deps.sources!.now = () => clock;
  rig.deps.sources!.activeSeats = () => [f.project];
  rig.deps.ownsTraffic = () => true;
  rig.deps.recordSuccessions = () => [];
  rig.deps.maintenance = null;
  return rig;
}
function finish(f: ChildFixture, child: { id: string; path: string }) {
  f.registry.reconcileConversations([{
    engine: "claude", path: child.path, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: f.cwd, title: "worker" }),
    turn: { state: "idle", source: "assistant", terminalAt: new Date(clock).toISOString() },
    observedAt: new Date(clock).toISOString(),
  }]);
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  const generation = f.registry.conversation(child.id as never)!.generations[0]!.id;
  ledger.append(generation, { kind: "turn-started", turnId: "work", seq: 1 });
  ledger.append(generation, { kind: "turn-ended", turnId: "work", status: "completed", seq: 2 });
}
function observation(tag: string, value: unknown) {
  console.log(`${tag} ${JSON.stringify(value)}`);
}

test("C3: reading and acting precede a wake that still calls the outcome unharvested", async () => {
  const f = childFixture("handled"); clock = f.now;
  const child = f.spawn({ title: "worker", turn: "busy", host: "live" });
  clock += MINUTE; finish(f, child);
  f.seed(); setAgentRegistryForTests(f.registry);
  fs.writeFileSync(child.path, JSON.stringify({ type: "assistant", timestamp: new Date(clock).toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: "Final: review passed." }] } }) + "\n");
  const binding = viewerMcpBindings(undefined, undefined, {
    selectedContext: {
      selectedConversation: () => ({ resolve: () => ({ conversationId: child.id,
        engine: "claude", path: child.path, project: f.project }) }),
      pathAllowed: (candidate: string) => candidate === child.path,
    },
    pinnedTranscript: (candidate: string) => {
      expect(candidate).toBe(child.path);
      const descriptor = fs.openSync(candidate, "r");
      return { descriptor, stat: fs.fstatSync(descriptor), rootName: "claude-projects",
        root: SESSIONS, sameIdentity: () => true };
    },
  } as never);
  const page = await binding.conversation_messages({ conversationId: child.id, roles: ["assistant"] });
  expect(JSON.stringify(page.records)).toContain("Final: review passed.");
  // Act on that result by reserving a follow-up worker with explicit lineage.
  f.spawn({ title: "follow-up after passing review", turn: "busy", host: "live" });
  expect(f.acknowledged()).toEqual([]);
  const rig = rigFor(f);
  const result = await runSeatTickCheck(f.project, rig.deps);
  expect(result!.reasons).toContain("child-terminal");
  expect(rig.sent[0]!.text).toContain("outcome unharvested");
  expect(f.acknowledged()).toContain(child.id);
  clock += 5 * MINUTE;
  const next = await runSeatTickCheck(f.project, rig.deps);
  expect(next!.reasons).not.toContain("child-terminal");
  observation("C3", { finalRead: true, followUpReserved: true, acknowledgedBeforeWake: 0,
    listedUnharvested: true, acknowledgedAfterWake: f.acknowledged().length });
});

test("C2: parented running work enters the interval agenda; unchanged cadence eventually stops", async () => {
  const f = childFixture("cadence"); clock = f.now;
  const child = f.spawn({ title: "worker", turn: "busy", host: "live" }); f.seed();
  const rig = rigFor(f);
  rig.deps.sources!.liveness = async ({ conversationId }) => conversationId === child.id
    ? [{ conversationId, lifecycle: "running", reason: "host_alive_turn_active", turnState: "busy" } as never] : [];
  const rows = [];
  for (let check = 0; check < 5; check++) {
    const row = await runSeatTickCheck(f.project, rig.deps);
    rows.push({ minute: check * 5, verdict: row!.verdict, reasons: row!.reasons, detail: row!.detail });
    clock += 5 * MINUTE;
  }
  expect(rows[0]!.reasons).toContain("interval");
  expect(rows.at(-1)!.verdict).toBe("quiet");
  expect(f.row().outstandingWake).toBeNull();
  finish(f, child);
  clock += 5 * MINUTE;
  const settled = await runSeatTickCheck(f.project, rig.deps);
  expect(settled!.reasons).toContain("child-terminal");
  observation("C2-parented", { rows, intervalDelivered: rows.filter(row => row.reasons.includes("interval")).length,
    finishedAfterGuard: settled!.reasons,
    guardCards: rig.cards.filter(row => row.card.kind === "retry-guard").map(row => row.card.detail) });

  const unparented = childFixture("unparented"); clock = unparented.now;
  unparented.spawn({ title: "unparented worker", turn: "busy", host: "live", parent: null }); unparented.seed();
  const excluded = rigFor(unparented);
  const record = await runSeatTickCheck(unparented.project, excluded.deps);
  expect(record!.verdict).toBe("quiet"); expect(excluded.sent).toEqual([]);
  const answer = seatTickSettingsAnswer(unparented.project, false, { kind: "operator" } as never, {
    now: () => clock, settings: () => configured(unparented), readState: () => unparented.row(),
    records: () => excluded.journal, policy: () => DEFAULT_SEAT_TICK_POLICY,
  });
  observation("C2-unparented", { verdict: record!.verdict, detail: record!.detail,
    lastRun: answer.lastRun, cardText: answer.cardText, cards: excluded.cards.length });
});

test("C1a: an independent timer dispatches child-terminal while the seat stays idle", async () => {
  const f = childFixture("timer"); clock = f.now;
  const child = f.spawn({ title: "worker", turn: "busy", host: "live" }); f.seed();
  const rig = rigFor(f);
  rig.deps.sources!.liveness = async ({ conversationId }) => conversationId === child.id
    ? [{ conversationId, lifecycle: "running", reason: "host_alive_turn_active", turnState: "busy" } as never] : [];
  let callback!: () => void; let interval = 0;
  const drainSweep = async () => {
    for (let count = 0; !seatTickIdle() && count < 1000; count++)
      await new Promise<void>(resolve => setImmediate(resolve));
    expect(seatTickIdle()).toBe(true);
  };
  expect(startSeatTick({ policy: DEFAULT_SEAT_TICK_POLICY, recordSuccessions: () => [],
    handoffHeld: () => false, drainHeld: () => false,
    scheduleInterval: (run, delay) => { callback = run; interval = delay;
      return setInterval(() => {}, 1_000_000_000); },
    sweep: () => reconcileSeatTick(rig.deps), log: () => {},
  })).toBe(true);
  await drainSweep(); expect(rig.sent).toHaveLength(1);
  const wakeAt = clock;
  clock += MINUTE; finish(f, child);
  clock = wakeAt + interval; callback(); await drainSweep(); stopSeatTick();
  expect(rig.sent).toHaveLength(2);
  expect(rig.journal.at(-1)!.reasons).toContain("child-terminal");
  observation("C1a", { checkIntervalMs: interval, finishToWakeMs: 4 * MINUTE,
    operatorTurns: 0, reasons: rig.journal.at(-1)!.reasons });
});

test("C1b: a recent wake suppresses the first check of a new terminal child", async () => {
  const f = childFixture("recent-wake"); clock = f.now;
  const child = f.spawn({ title: "worker", turn: "busy", host: "live" });
  const firstCheckAt = clock + 5 * MINUTE;
  clock += MINUTE;
  f.seed({ lastWakeAt: new Date(clock).toISOString() });
  clock += MINUTE;
  const finishedAt = clock; finish(f, child);
  clock = firstCheckAt;
  const rig = rigFor(f);
  const first = await runSeatTickCheck(f.project, rig.deps);
  expect(first!.verdict).toBe("quiet"); expect(rig.sent).toEqual([]);
  clock += DEFAULT_SEAT_TICK_POLICY.checkIntervalMs;
  const second = await runSeatTickCheck(f.project, rig.deps);
  expect(second!.reasons).toContain("child-terminal");
  observation("C1b", { firstCheck: first!.verdict, secondCheck: second!.verdict,
    finishToWakeMs: clock - finishedAt, boundMs: DEFAULT_SEAT_TICK_POLICY.checkIntervalMs });
});

test("C4: deploy acceptance followed by a lost reply leaves no deploy-settled wake", async () => {
  const f = childFixture("deploy"); clock = f.now; f.seed();
  const deploymentId = "deployment_fixture"; const revision = "a".repeat(40);
  let accepted = false;
  const ledger = new Map<string, { phase: string; terminal: boolean }>();
  const domain = {
    callerAttribution: () => ({ kind: "manager", conversationId: f.seat.conversationId, role: null }),
    callerProject: () => f.project, viewerProjects: () => [f.project],
    authorizedSeats: () => [{ ...f.seat, project: f.project }],
  };
  const binding = viewerMcpBindings(undefined, { post: async () => {
    accepted = true;
    ledger.set(deploymentId, { phase: "building", terminal: false });
    throw new Error("Viewer control did not reconnect after 2 attempts");
  } }, domain as never);
  await expect(binding.deploy_exact_sha({ revision, clientRequestId: "accepted-lost-reply" }))
    .rejects.toThrow("Viewer control did not reconnect");
  expect(accepted).toBe(true); expect(seatDeploymentsFor(f.seat.conversationId)).toEqual([]);
  expect(ledger.get(deploymentId)).toEqual({ phase: "building", terminal: false });
  clock += MINUTE;
  ledger.set(deploymentId, { phase: "succeeded", terminal: true });
  const rig = rigFor(f);
  rig.deps.sources!.seatDeployments = seatDeploymentsFor;
  rig.deps.sources!.deployment = () => ({ state: "ok", value: { deploymentId, revision,
    ...ledger.get(deploymentId), error: null, updatedAt: new Date(clock).toISOString() } }) as never;
  const missing = await runSeatTickCheck(f.project, rig.deps);
  expect(missing!.reasons).not.toContain("deploy-settled"); expect(rig.sent).toEqual([]);
  // Positive control: the same admitted request with an accepted reply records its seat.
  const replied = viewerMcpBindings(undefined, { post: async () => ({ state: "accepted",
    deploymentId, revision, replayed: true }) }, domain as never);
  const receipt = await replied.deploy_exact_sha({ revision, clientRequestId: "accepted-lost-reply" });
  expect(receipt.wakeOnSettle).toBe(true);
  const found = await runSeatTickCheck(f.project, rig.deps);
  expect(found!.reasons).toContain("deploy-settled");
  observation("C4", { acceptedAfterError: accepted, attributedAfterError: 0,
    lostReplyVerdict: missing!.verdict, recoveredReplyReasons: found!.reasons });
});
```

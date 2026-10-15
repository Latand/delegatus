import { expect, spyOn, test, fs, path, createHash, spawn, SANDBOX, runSeatTickCheck, SEAT_TICK_WAKE_UNRESOLVED_REF, wakeReached, DEFAULT_SEAT_TICK_POLICY, seatMcpHealth, viewerMcpTransportForLaunch, defaultSeatTickSettings, deliverConversationMessage, readSeatTickState, writeSeatTickState, statePath, setAgentRegistryForTests, emptyLaunchProfile, sessionKeyFromTranscript, mcpLauncherImports, emptySeatTickState, PROJECT, CONVERSATION, SUCCESSOR, NOW, MINUTE, WALL_DATE, harness, OVERDUE, RECENT, outstandingWake, OPEN_LANE, terminalEvent, offSettings, FINISHED_LANE, FINISHED_PR_CREATED, ARCHIVED_LANE, standingGap, MONITOR_PROMPT, childFixture, childRig, ago } from "./seatTickController.fixture";
import type { SeatTickSettings, GithubRunner, RuntimeHostClient, AgentLivenessRecord } from "./seatTickController.fixture";


test("three running lanes this seat launched keep the hourly interval agenda open (#2081)", async () => {
  const pipelines = ["pipeline_a1", "pipeline_b2", "pipeline_c3"].map((id) => ({
    id, state: "running", attemptState: "running", src: CONVERSATION,
    createdAt: new Date(NOW - 90 * MINUTE).toISOString(), movedAt: new Date(NOW - 10 * MINUTE).toISOString(),
  }));
  const rig = harness({ pipelines, state: { ...OVERDUE, announcedLanes: pipelines.map((lane) => lane.id) } });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["interval"], items: 3 });
});

test("the controller delivers completed-lane merges once and keeps those the wake bound held back", async () => {
  const options = {
    pipelines: [], now: NOW,
    state: { ...OVERDUE, eventsThrough: 0, lastProposalAt: new Date(NOW).toISOString() },
    events: Array.from({ length: 7 }, (_, index) => ({ ...terminalEvent(index + 1), type: "pipeline_merged" as const,
      pipelineId: `pipeline_merge_${index + 1}`, summary: `pull request #${index + 1} merged, head ${"a".repeat(40)} — ship feature ${index + 1}` })),
  };
  const rig = harness(options);
  expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "wake", items: 5, deferred: 2 });
  expect(rig.written.at(-1)!.eventsThrough).toBe(5);
  expect(rig.sent[0]!.text).toContain("pull request #5 merged");
  expect(rig.sent[0]!.text).not.toContain("pull request #6 merged");
  options.now += 61 * MINUTE;
  expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "wake", items: 2 });
  expect(rig.sent[1]!.text).toContain("pull request #6 merged");
  expect(rig.sent[1]!.text).not.toContain("pull request #5 merged");
  expect(rig.written.at(-1)!.eventsThrough).toBe(7);
  options.now += 61 * MINUTE;
  expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "quiet" });
  expect(rig.sent).toHaveLength(2);
});

test("a quiet check writes one journal line, sends nothing, and raises no card", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: { lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString() } });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet", delivery: null, items: 0 });
  expect(rig.journal).toHaveLength(1);
  expect(rig.sent).toEqual([]);
  expect(rig.cards).toEqual([]);
});

test("a project whose tick is off is checked, journaled and never woken (#1275)", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings: offSettings() });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
  /* The line is the whole difference between a tick that is off and a tick
     that broke: one keeps writing, the other stops. */
  expect(record).toMatchObject({
    verdict: "quiet",
    delivery: null,
    detail: "ticking is off for this project: the only open lane is a draft nothing can discharge",
  });
  expect(rig.cards.map((entry) => entry.card)).toEqual([{
    ref: "seat-tick-settings",
    kind: "tick-settings",
    state: "open",
    settings: { enabled: false, wakeIntervalMs: 60 * 60_000, reason: offSettings().reason, until: null, setBy: offSettings().setBy, updatedAt: "2026-08-28T11:00:00.000Z" },
    detail: "ticking is off for this project: no wake will be sent until it is turned back on",
  }]);
});

test("a tick setting that reached its expiry is written back to the default by the check that reads it (#1275)", async () => {
  const settings = offSettings({ until: new Date(NOW - MINUTE).toISOString() });
  const persisted: SeatTickSettings[] = [];
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings });
  const record = await runSeatTickCheck(PROJECT, { ...rig.deps, writeSettings: (_project, row) => { persisted.push(row); } });
  /* The wake goes out — the setting lapsed — and the record on disk stops
     saying "off" beside a tick that is ticking. */
  expect(record).toMatchObject({ verdict: "wake" });
  expect(persisted).toEqual([{ ...defaultSeatTickSettings(PROJECT), reason: settings.reason, updatedAt: settings.updatedAt, setBy: settings.setBy }]);
  expect(rig.cards[0]!.card).toMatchObject({ state: "resolved" });
});

test("the lapse ends the setting that expired and keeps the monitor prompt it never covered (#1280)", async () => {
  const settings = offSettings({ until: new Date(NOW - MINUTE).toISOString(), monitorPrompt: MONITOR_PROMPT });
  const persisted: SeatTickSettings[] = [];
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings });
  await runSeatTickCheck(PROJECT, { ...rig.deps, writeSettings: (_project, row) => { persisted.push(row); } });
  /* The expiry was set on the on/off, so that is what it ended. The words the
     seat left for its own wakes were not part of it, and the wake this very
     check sent still carries them. */
  expect(persisted).toEqual([{
    ...defaultSeatTickSettings(PROJECT),
    monitorPrompt: MONITOR_PROMPT,
    reason: settings.reason,
    updatedAt: settings.updatedAt,
    setBy: settings.setBy,
  }]);
  expect(rig.sent[0]!.text).toContain(MONITOR_PROMPT);
});

test("the board card for a quiet tick is written, kept in step, and closed when the tick comes back (#1275)", async () => {
  const project = `card-lifecycle-${crypto.randomUUID().slice(0, 8)}`;
  const tasksFile = path.join(SANDBOX, "state", "tasks.json");
  const { loadTasks } = await import("@/lib/tasks/store");
  const readCards = (): { text: string; status: string }[] => loadTasks(tasksFile)
    .filter((task) => task.project === project).map((task) => ({ text: task.text, status: task.status }));

  const off = harness({ pipelines: OPEN_LANE, settings: { ...offSettings(), project } });
  /* The real card writer, not the harness stub: this is the board surface the
     issue asks for. */
  await runSeatTickCheck(project, { ...off.deps, ensureCard: undefined });
  const raised = readCards();
  expect(raised).toHaveLength(1);
  /* The card's first line is the setting; this sandbox records no operator
     language, so it is the default Ukrainian. */
  expect(raised[0]!.text.split("\n")[0]).toBe("Тікер: вимкнено");
  expect(raised[0]!.text).toContain("the only open lane is a draft nothing can discharge");
  expect(raised[0]!.status).not.toBe("done");

  /* A check that finds the same setting rewrites nothing … */
  await runSeatTickCheck(project, { ...off.deps, ensureCard: undefined });
  expect(readCards()).toEqual(raised);

  /* … a changed setting updates the one card … */
  const slowed = harness({
    pipelines: OPEN_LANE,
    settings: { ...offSettings(), project, enabled: true, wakeIntervalMinutes: 240, reason: "batching this board", updatedAt: "2026-08-28T11:30:00.000Z" },
  });
  await runSeatTickCheck(project, { ...slowed.deps, ensureCard: undefined });
  const updated = readCards();
  expect(updated).toHaveLength(1);
  expect(updated[0]!.text).toContain("batching this board");

  /* … and the check that reads the project back on its defaults closes it. */
  const restored = harness({
    pipelines: OPEN_LANE,
    settings: { ...defaultSeatTickSettings(project), project, updatedAt: "2026-08-28T12:00:00.000Z" },
  });
  await runSeatTickCheck(project, { ...restored.deps, ensureCard: undefined });
  expect(readCards().map((task) => task.status)).toEqual(["done"]);
});

test("a check whose cards already say what they should takes no task write (#1987)", async () => {
  /* Each task write rebuilds and fingerprints every task under the lease; a
     sweep over thirty-odd seats paid that for every card it merely confirmed. */
  const project = `card-current-${crypto.randomUUID().slice(0, 8)}`;
  /* A board of its own: the suite's shared board fills up with earlier tests'
     cards, and a full board refuses the first card this test needs. */
  const own = fs.mkdtempSync(path.join(SANDBOX, "card-current-state-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = own;
  const store = await import("@/lib/tasks/store");
  const readCards = (): { text: string; status: string }[] => store.loadTasks(path.join(own, "tasks.json"))
    .filter((task) => task.project === project).map((task) => ({ text: task.text, status: task.status }));
  try {
    const off = harness({ pipelines: OPEN_LANE, settings: { ...offSettings(), project } });
    await runSeatTickCheck(project, { ...off.deps, ensureCard: undefined });
    const raised = readCards();
    expect(raised).toHaveLength(1);

    const writes = spyOn(store, "mutateTasksFile");
    try {
      await runSeatTickCheck(project, { ...off.deps, ensureCard: undefined });
      expect(writes).not.toHaveBeenCalled();
    } finally {
      writes.mockRestore();
    }
    expect(readCards()).toEqual(raised);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
  }
});

/* The card writer resolves the board file per call, not once at import.
   `mutateTasksFile`'s default is frozen the first time `@/lib/tasks/store` is
   loaded anywhere in the process, so a tick that took it would write to
   whichever state dir happened to be set THEN — in a suite, another test
   file's; in a sandboxed run, the real board outside the sandbox. Asserted
   here by moving the state dir under a running tick, which is the only way the
   two readings can be told apart within one process. */
test("a card is written to the state dir the tick is pointed at now, not the one loaded at import", async () => {
  const project = `card-statedir-${crypto.randomUUID().slice(0, 8)}`;
  const moved = fs.mkdtempSync(path.join(SANDBOX, "moved-state-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = moved;
  try {
    const off = harness({ pipelines: OPEN_LANE, settings: { ...offSettings(), project } });
    await runSeatTickCheck(project, { ...off.deps, ensureCard: undefined });
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
  }

  const { loadTasks } = await import("@/lib/tasks/store");
  const cards = loadTasks(path.join(moved, "tasks.json")).filter((task) => task.project === project);
  expect(cards).toHaveLength(1);
  expect(cards[0]!.text.split("\n")[0]).toBe("Тікер: вимкнено");
});

test("a wake is delivered by durable conversation id, with an idempotent client message id", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]).toMatchObject({ conversationId: CONVERSATION, pid: null, images: [] });
  expect(rig.sent[0]!.clientMessageId).toBe(record!.delivery!.clientMessageId);
  expect(record!.delivery!.clientMessageId.startsWith(`seat-tick:${PROJECT}:7:${OVERDUE.lastWakeAt}:interval:`)).toBe(true);
  expect(rig.written.at(-1)!.lastWakeAt).toBe(new Date(NOW).toISOString());
});

test("a completed dead seat receives its deploy-settled wake in one tick and never twice", async () => {
  let revived = false;
  const rig = harness({
    seatActivity: { conversationId: CONVERSATION, lifecycle: "gone", reason: "host_gone_turn_settled", host: { state: "gone", kind: "structured", pid: null } },
    seatDeployments: [{ conversationId: CONVERSATION, deploymentId: "settled-deploy" }],
    deployments: { "settled-deploy": { phase: "succeeded", terminal: true, revision: "abcdef1234" } },
    deliverWith: async message => {
      expect(rig.deps.readState!(PROJECT).outstandingWake?.clientMessageId).toBe(message.clientMessageId ?? undefined);
      revived = true;
      return { ok: true, target: null, spawned: true, structured: true, outcome: "delivered" };
    },
  });
  rig.deps.mcpHealth = () => revived ? { status: "healthy", detail: "fresh MCP is live" }
    : { status: "dead", detail: "old MCP has no heartbeat" };
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record?.reasons).toContain("deploy-settled");
  expect(rig.sent).toHaveLength(1);
  expect(rig.deps.readState!(PROJECT).announcedDeploys).toEqual(["settled-deploy"]);
  await runSeatTickCheck(PROJECT, { ...rig.deps });
  expect(rig.sent).toHaveLength(1);
});

test("a seat whose stdio Viewer MCP is dead is carded and receives no more tick wakes", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const record = await runSeatTickCheck(PROJECT, {
    ...rig.deps,
    mcpHealth: () => ({ status: "dead", detail: "the session's stdio MCP launcher stopped reporting liveness" }),
  });
  expect(rig.sent).toHaveLength(0);
  expect(record?.delivery?.outcome).toBe("seat-mcp-unavailable");
  expect(rig.cards).toContainEqual({ project: PROJECT, card: expect.objectContaining({
    kind: "mcp-unavailable", ref: "seat-viewer-mcp-unavailable", state: "open", instance: "7",
  }) });
  expect(rig.written.at(-1)?.lastWakeAt).toBe(OVERDUE.lastWakeAt);
});

test.each([
  "cleared", "retained dead claim", "retained during MCP grace", "terminal failure", "unsettled failure",
  "composer after cleanup", "composer during MCP grace", "rotation after cleanup",
] as const)("a deploy-settled wake runs shared composer recovery with %s", async scenario => {
  const { recoverDeadStructuredConversation } = await import("@/lib/runtime/structuredRecovery");
  const f = childFixture("composer-deploy-recovery", false, "off");
  setAgentRegistryForTests(f.registry);
  fs.writeFileSync(f.seat.path!, "");
  const key = sessionKeyFromTranscript("claude", f.seat.path!)!;
  const entry = { key, artifactPath: f.seat.path!, cwd: f.cwd, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: f.cwd, title: "Completed orchestrator" }), status: "dead" as const, host: null,
    structuredHost: null, claimEpoch: 1, claimOwner: null, pendingAction: null };
  const old = f.registry.beginSpawnRequest({ engine: "claude", cwd: f.cwd, transport: "structured",
    conversationId: f.seat.conversationId as never, expectedArtifactPath: f.seat.path!, launchProfile: entry.launchProfile,
    spawnCapabilityDigest: "a".repeat(64) });
  f.registry.completeSpawn(old.receipt.launchId, entry);
  f.registry.setReceiptViewerMcpTransport(old.receipt.launchId, "stdio");
  const composerRace = scenario === "composer after cleanup" || scenario === "composer during MCP grace";
  const mcpGrace = scenario === "retained during MCP grace" || scenario === "composer during MCP grace";
  const retainedClaim = scenario === "retained dead claim" || mcpGrace || composerRace || scenario === "rotation after cleanup";
  if (retainedClaim) f.registry.upsert({ ...entry, status: "idle", claimOwner: "structured-host:predecessor",
    structuredHost: { kind: "claude-broker", endpoint: "stdio:predecessor", process: { pid: 2_000_000_000, startIdentity: "gone" },
      eventCursor: 0, protocolVersion: "v1", writerClaimEpoch: entry.claimEpoch, activeTurnRef: null, pendingAttention: [], activeFlags: [] } });
  const oldDigest = f.registry.seatMcpReceipt(f.seat.conversationId)!.spawnCapabilityDigest;
  f.seed();
  let spawns = 0;
  const deliveredKeys: string[] = [];
  const rig = childRig(f, { seatDeployments: [{ conversationId: f.seat.conversationId, deploymentId: "composer-deploy" }],
    deployments: { "composer-deploy": { phase: "succeeded", terminal: true, revision: "abcdef1234" } },
    seatActivity: { conversationId: f.seat.conversationId, host: { state: "gone", kind: "structured", pid: null }, lifecycle: "gone", reason: "host_gone_turn_settled" },
    deliverWith: message => deliverConversationMessage(message, {
      recover: request => recoverDeadStructuredConversation(request, { registry: f.registry, client: {} as RuntimeHostClient,
        transport: () => "structured", park: () => null,
        resolveAccount: () => {
          if (composerRace) f.registry.upsert({ ...entry, claimEpoch: 2, claimOwner: "structured-host:replacement", status: "idle" });
          if (scenario === "rotation after cleanup") rig.seat = { conversationId: SUCCESSOR, seatEpoch: 8, path: null };
          return { engine: "claude", accountId: "default", kind: "legacy", home: f.dir, transcriptRoot: f.dir, env: { NODE_ENV: "test" } };
        },
        spawn: async input => {
          expect(f.row().outstandingWake?.clientMessageId).toBe(message.clientMessageId ?? undefined);
          spawns += 1;
          if (scenario === "terminal failure" || scenario === "unsettled failure") {
            if (scenario === "terminal failure") f.registry.failSpawn(input.receipt.launchId, "No conversation found with session ID");
            throw new Error("No conversation found with session ID");
          }
          f.registry.rotateSpawnCapabilityForReceipt(input.receipt.launchId);
          f.registry.setReceiptViewerMcpTransport(input.receipt.launchId, "stdio");
          f.registry.completeSpawn(input.receipt.launchId, entry);
          return { ok: true, target: null, path: f.seat.path!, launchId: input.receipt.launchId,
            conversationId: f.seat.conversationId as never, launched: true, retrySafe: false, initialMessage: "delivered", state: "settled" };
        }, requestDeliveryDrain: () => {},
      }),
      enqueueStructured: async request => {
        request.admissionGuard?.();
        expect(request.clientMessageId).toBe(message.clientMessageId);
        deliveredKeys.push(request.clientMessageId!);
        const held = f.registry.holdDelivery(f.seat.conversationId as never, request.text, request.clientMessageId!);
        f.registry.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
        return { ok: true, structured: true, target: f.seat.conversationId, outcome: "delivered", operationId: held.command.operationId,
          receipt: { operationId: held.command.operationId, idempotencyKey: request.clientMessageId!,
            conversationId: f.seat.conversationId, kind: "send", status: "delivered", at: held.createdAt, revision: 1 } };
      },
    }),
  });
  rig.deps.sources!.seatDeployments = () => [{ conversationId: f.seat.conversationId, deploymentId: "composer-deploy",
    project: f.project, revision: "abcdef1234", requestedAt: ago(f, 10) }];
  rig.deps.sources!.deployment = () => ({ state: "ok", value: { deploymentId: "composer-deploy", phase: "succeeded",
    terminal: true, revision: "abcdef1234", error: null, updatedAt: ago(f, 2) } }) as never;
  rig.deps.mcpHealth = () => f.registry.seatMcpReceipt(f.seat.conversationId)?.spawnCapabilityDigest === oldDigest
    ? { status: mcpGrace ? "untracked" : "dead", detail: "predecessor MCP absent" }
    : { status: "untracked", detail: "fresh stdio MCP starting" };
  let rotations = 0;
  rig.deps.seatRecovery = { rotate: async body => {
    expect(body.expectedIncumbentSeatEpoch).toBe(f.seat.seatEpoch);
    rotations += 1;
    return { status: 503, body: { error: "replacement unavailable" } };
  } };
  if (retainedClaim) expect(f.registry.readOnlySnapshot().entries[`claude:${key.sessionId}`]?.structuredHost?.process?.pid).toBe(2_000_000_000);
  if (composerRace || scenario === "rotation after cleanup") {
    await runSeatTickCheck(f.project, rig.deps);
    expect(spawns).toBe(0);
    expect(rotations).toBe(0);
    expect(Object.values(f.registry.readOnlySnapshot().receipts)).toHaveLength(1);
    expect(f.row().announcedDeploys ?? []).not.toContain("composer-deploy");
    return;
  }
  if (scenario === "terminal failure" || scenario === "unsettled failure") {
    await runSeatTickCheck(f.project, rig.deps);
    const owed = f.row().outstandingWake?.clientMessageId;
    expect(spawns).toBe(1);
    expect(rotations).toBe(scenario === "terminal failure" ? 1 : 0);
    expect(f.row().announcedDeploys ?? []).not.toContain("composer-deploy");
    expect(owed).toBeTruthy();
    if (scenario === "terminal failure") {
      expect(f.row().hostRecovery?.state).toBe("failed");
      expect(rig.cards.filter(({ card }) => card.ref === "seat-host-recovery" && card.state === "open")).toHaveLength(1);
      await runSeatTickCheck(f.project, rig.deps);
      expect(rotations).toBe(1);
      expect(f.row().outstandingWake?.clientMessageId).toBe(owed);
    } else expect(f.row().hostRecovery).toBeFalsy();
    return;
  }
  expect((await runSeatTickCheck(f.project, rig.deps))?.delivery?.outcome).toBe("delivered");
  expect(spawns).toBe(1);
  expect(f.registry.seatMcpReceipt(f.seat.conversationId)?.spawnCapabilityDigest).not.toBe(oldDigest);
  expect(f.registry.seatMcpReceipt(f.seat.conversationId)?.viewerMcpTransport).toBe("stdio");
  expect(rig.cards.some(({ card }) => card.kind === "mcp-unavailable" && card.state === "resolved")).toBe(false);
  expect(f.row().announcedDeploys).toEqual(["composer-deploy"]);
  await runSeatTickCheck(f.project, rig.deps);
  expect(spawns).toBe(1);
  expect(rotations).toBe(0);
  expect(deliveredKeys).toHaveLength(1);
});

test.each(["rotated", "failed"] as const)("a definitively failed dead-seat revival rotates once and leaves a durable %s notice", async state => {
  let failedFreshReceipt = false;
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE,
    seatActivity: { conversationId: CONVERSATION, lifecycle: "gone", reason: "host_gone_turn_settled", host: { state: "gone", kind: "structured", pid: null } },
    deliverWith: async () => { failedFreshReceipt = true; return { ok: false, outcome: "failed", status: 503, error: "resume failed to publish", code: "structured_revival_impossible" }; },
  });
  rig.deps.mcpHealth = () => failedFreshReceipt ? { status: "untracked", detail: "failed successor is still inside MCP startup grace" }
    : { status: "dead", detail: "old MCP has no heartbeat" };
  const rotations: Record<string, unknown>[] = [];
  rig.deps.seatRecovery = { rotate: async body => {
    rotations.push(body);
    expect(body.expectedIncumbentSeatEpoch).toBe(7);
    if (state === "rotated") rig.seat = { conversationId: SUCCESSOR, seatEpoch: 8, path: null };
    return state === "rotated" ? { status: 200, body: { ok: true } }
      : { status: 503, body: { ok: false, error: "replacement unavailable" } };
  } };
  await runSeatTickCheck(PROJECT, rig.deps);
  await runSeatTickCheck(PROJECT, { ...rig.deps });
  expect(rotations).toHaveLength(1);
  expect(rig.deps.readState!(PROJECT).hostRecovery?.state).toBe(state);
  expect(rig.cards.filter(({ card }) => card.ref === "seat-host-recovery" && card.state === "open")).toHaveLength(1);
  expect(rig.deps.readState!(PROJECT).lastWakeAt).toBe(OVERDUE.lastWakeAt);
});

test("a failed revival notice stays owed across controller restart until the board accepts it", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE,
    seatActivity: { conversationId: CONVERSATION, host: { state: "gone", kind: "structured", pid: null }, reason: "host_gone_turn_settled" },
    delivery: { ok: false, outcome: "failed", status: 503, error: "resume did not publish", code: "structured_revival_impossible" },
  });
  let boardReady = false;
  let notices = 0;
  let rotations = 0;
  rig.deps.mcpHealth = () => ({ status: "dead", detail: "old MCP absent" });
  rig.deps.ensureCard = (_project, card) => {
    if (card.kind !== "host-recovery") return true;
    if (!boardReady) return false;
    notices += 1;
    return true;
  };
  rig.deps.seatRecovery = { rotate: async () => { rotations += 1; return { status: 503, body: { error: "replacement unavailable" } }; } };
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.deps.readState!(PROJECT).hostRecovery?.told).toBe(false);
  boardReady = true;
  await runSeatTickCheck(PROJECT, { ...rig.deps });
  await runSeatTickCheck(PROJECT, { ...rig.deps });
  expect(rig.deps.readState!(PROJECT).hostRecovery?.told).toBe(true);
  expect(notices).toBe(1);
  expect(rotations).toBe(1);
});

test.each([false, true])("a pending recovery after restart updates one production card before recording the failure as told (closed: %s)", async closed => {
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(SANDBOX, "recovery-board-"));
  try {
    const { loadTasks, mutateTasksFile } = await import("@/lib/tasks/store");
    const { patchTask } = await import("@/lib/tasks/commands");
    const { seatHostRecoveryKey } = await import("./seatHostRecovery");
    const stateFile = statePath("seat-tick.json");
    writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE, accounting: undefined,
      hostRecovery: { id: seatHostRecoveryKey(PROJECT, 7, CONVERSATION), conversationId: CONVERSATION,
        seatEpoch: 7, at: new Date(NOW - MINUTE).toISOString(), state: "pending", detail: "resume did not publish", told: false },
    }, stateFile);
    const cards = () => loadTasks(statePath("tasks.json")).filter(task =>
      task.project === PROJECT && task.text.startsWith("Відновлення оркестратора"));
    let rotations = 0;
    let pendingCards: ReturnType<typeof cards> = [];
    const toldCards: ReturnType<typeof cards>[] = [];
    const check = async () => {
      const rig = harness({ pipelines: OPEN_LANE, stateFile,
        seatActivity: { conversationId: CONVERSATION, host: { state: "gone", kind: "structured", pid: null }, reason: "host_gone_turn_settled" },
        delivery: { ok: false, outcome: "failed", status: 503, error: "resume did not publish", code: "structured_revival_impossible" },
      });
      const writeState = rig.deps.writeState!;
      await runSeatTickCheck(PROJECT, { ...rig.deps, ensureCard: undefined,
        mcpHealth: () => ({ status: "dead", detail: "old MCP absent" }),
        writeState: (project, row) => {
          if (row.hostRecovery?.state === "failed" && row.hostRecovery.told) toldCards.push(cards());
          writeState(project, row);
        },
        seatRecovery: { rotate: async () => {
          rotations += 1;
          pendingCards = cards();
          if (closed) {
            mutateTasksFile(state => {
              const done = patchTask(state.tasks, pendingCards[0]!.id, { status: "done" });
              if (!done.ok) throw new Error(done.error);
              return { state: { ...state, tasks: done.tasks }, result: undefined };
            }, statePath("tasks.json"));
            expect(cards()[0]!.status).toBe("done");
          }
          return { status: 503, body: { error: "replacement unavailable" } };
        } },
      });
    };
    await check();
    expect(pendingCards).toHaveLength(1);
    expect(pendingCards[0]!.text).toContain("Ротацію розпочато");
    const terminal = cards();
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.id).toBe(pendingCards[0]!.id);
    expect(terminal[0]!.status).toBe("inbox");
    expect(terminal[0]!.text).toContain("Відновлення та ротація не вдалися");
    expect(terminal[0]!.details).toContain(`${new Date(NOW).toISOString()}: failed; replacement unavailable`);
    expect(terminal[0]!.details).toContain("monitor-ref: seat-host-recovery-");
    expect(toldCards.length).toBeGreaterThan(0);
    for (const snapshot of toldCards) expect(snapshot).toEqual(terminal);
    expect(readSeatTickState(PROJECT, stateFile).hostRecovery).toMatchObject({ state: "failed", told: true });
    await check();
    expect(rotations).toBe(1);
    expect(cards()).toEqual(terminal);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
  }
});

test("a composer host appearing during fallback fences rotation even with healthy MCP", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE,
    seatActivity: { conversationId: CONVERSATION, lifecycle: "gone", reason: "host_gone_turn_settled", host: { state: "gone", kind: "structured", pid: null } },
    delivery: { ok: false, outcome: "failed", status: 503, error: "resume did not publish", code: "structured_revival_impossible" },
  });
  let composerLive = false;
  const registry = rig.deps.sources!.registry();
  registry.seatMcpReceipt = () => ({ spawnCapabilityDigest: (composerLive ? "b" : "a").repeat(64),
    createdAt: new Date(NOW - 30 * MINUTE).toISOString(), viewerMcpTransport: "stdio" });
  rig.deps.sources!.registry = () => registry;
  rig.deps.mcpHealth = () => ({ status: composerLive ? "healthy" : "dead", detail: "fixture MCP" });
  let rotations = 0;
  rig.deps.seatRecovery = { rotate: async (_body, _dependencies, _triggeredBy, admission) => {
    rotations += 1;
    composerLive = true;
    const hold = await admission!.replacementHold!();
    expect(hold?.status).toBe(409);
    return hold!;
  } };
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rotations).toBe(1);
  expect(rig.deps.readState!(PROJECT).hostRecovery?.state).toBe("superseded");
});

test.each(["live", "unknown"] as const)("a %s host with broken MCP refuses even a newly confirmed lane stall", async hostState => {
  const rig = harness({ pipelines: [{ ...OPEN_LANE[0]!, state: "running", attemptState: "running", attemptConversationId: "stalled-stage" }], state: OVERDUE });
  rig.deps.mcpHealth = () => ({ status: "dead", detail: "broken MCP" });
  rig.deps.sources!.liveness = async request => [{ conversationId: request.conversationId ?? "stalled-stage",
    host: { state: hostState === "live" ? "alive" : "unknown", kind: "structured", pid: null },
    pipeline: request.conversationId ? null : { pipelineId: OPEN_LANE[0]!.id, stageId: "build", attempt: 1 },
    lifecycle: "stalled", reason: "host_alive_transcript_silent", turnState: "busy" } as AgentLivenessRecord];
  await runSeatTickCheck(PROJECT, rig.deps);
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
});

test("a composer replacement during dead-host evidence refuses recovery into its broken MCP", async () => {
  let receipt = { spawnCapabilityDigest: "a".repeat(64), createdAt: new Date(NOW - 30 * MINUTE).toISOString(), viewerMcpTransport: "stdio" as const };
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const registry = rig.deps.sources!.registry();
  registry.seatMcpReceipt = () => receipt;
  rig.deps.sources!.registry = () => registry;
  rig.deps.mcpHealth = () => ({ status: "dead", detail: "MCP broken" });
  rig.deps.sources!.liveness = async request => {
    if (request.conversationId !== CONVERSATION) return [];
    receipt = { ...receipt, spawnCapabilityDigest: "b".repeat(64) };
    return [{ conversationId: CONVERSATION, host: { state: "gone", kind: "structured", pid: null }, reason: "host_gone_turn_settled" } as AgentLivenessRecord];
  };
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
});

test("a rotation during dead-host evidence starts no predecessor recovery", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  rig.deps.mcpHealth = () => ({ status: "dead", detail: "old MCP absent" });
  rig.deps.sources!.liveness = async () => {
    rig.seat = { conversationId: SUCCESSOR, seatEpoch: 8, path: null };
    return [{ conversationId: CONVERSATION, host: { state: "gone", kind: "structured", pid: null }, reason: "host_gone_turn_settled" } as AgentLivenessRecord];
  };
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
});

test("persisted MCP cards survive repeated outages and equal-epoch projects", async () => {
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(SANDBOX, "mcp-board-outages-"));
  try {
    const { loadTasks } = await import("@/lib/tasks/store");
    const projectA = "mcp-board-a";
    const projectB = "mcp-board-b";
    const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
    const health = { status: "dead" as const, detail: "stdio MCP has no heartbeat" };
    const deps = { ...rig.deps, ensureCard: undefined, mcpHealth: () => health };
    const cards = (project: string) => loadTasks(statePath("tasks.json")).filter((task) =>
      task.project === project && task.text.includes("monitor-ref: seat-viewer-mcp-unavailable"));

    expect((await runSeatTickCheck(projectA, deps))?.delivery?.outcome).toBe("seat-mcp-unavailable");
    expect((await runSeatTickCheck(projectB, deps))?.delivery?.outcome).toBe("seat-mcp-unavailable");
    expect(cards(projectA).filter((task) => task.status !== "done")).toHaveLength(1);
    expect(cards(projectB).filter((task) => task.status !== "done")).toHaveLength(1);
    await runSeatTickCheck(projectA, deps);
    expect(cards(projectA)).toHaveLength(1);

    await runSeatTickCheck(projectA, { ...deps, mcpHealth: () => ({ status: "healthy", detail: "stdio MCP is live" }) });
    expect(cards(projectA)[0]?.status).toBe("done");
    await runSeatTickCheck(projectA, deps);
    expect(cards(projectA).filter((task) => task.status !== "done")).toHaveLength(1);
    expect(cards(projectB).filter((task) => task.status !== "done")).toHaveLength(1);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
  }
});

test("an HTTP successor closes the predecessor's persisted MCP alert and receives wakes", async () => {
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(SANDBOX, "mcp-board-http-"));
  try {
    const { loadTasks } = await import("@/lib/tasks/store");
    const options = { pipelines: OPEN_LANE, state: OVERDUE, now: NOW };
    const rig = harness(options);
    const sources = rig.deps.sources!;
    const deps = {
      ...rig.deps,
      ensureCard: undefined,
      sources: { ...sources, registry: () => ({ ...sources.registry(), seatMcpReceipt: (id: string) => id === SUCCESSOR
        ? { spawnCapabilityDigest: "a".repeat(64), createdAt: new Date(NOW).toISOString(), viewerMcpTransport: "http" as const }
        : { spawnCapabilityDigest: "b".repeat(64), createdAt: new Date(NOW - 30 * MINUTE).toISOString(), viewerMcpTransport: "stdio" as const } } as never) },
    };
    const cards = () => loadTasks(statePath("tasks.json")).filter((task) =>
      task.project === PROJECT && task.text.includes("monitor-ref: seat-viewer-mcp-unavailable"));

    expect((await runSeatTickCheck(PROJECT, deps))?.delivery?.outcome).toBe("seat-mcp-unavailable");
    expect(cards().filter((task) => task.status !== "done")).toHaveLength(1);
    await runSeatTickCheck(PROJECT, { ...deps, mcpHealth: () => ({ status: "untracked", detail: "MCP liveness could not be read" }) });
    expect(cards().filter((task) => task.status !== "done")).toHaveLength(1);

    rig.seat = { conversationId: SUCCESSOR, seatEpoch: 8, path: null };
    options.now = NOW + 120 * MINUTE;
    expect((await runSeatTickCheck(PROJECT, deps))?.delivery?.outcome).toBe("delivered");
    expect(rig.sent).toHaveLength(2);
    expect(rig.sent.at(-1)?.conversationId).toBe(SUCCESSOR);
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.status).toBe("done");
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
  }
});

test("transport failure opens the MCP card and recovery closes it before wakes resume", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const stateDir = fs.mkdtempSync(path.join(SANDBOX, "mcp-card-"));
  const digest = "c".repeat(64);
  const heartbeatFile = path.join(stateDir, "mcp-runtime", "sessions", `${digest}.json`);
  fs.mkdirSync(path.dirname(heartbeatFile), { recursive: true });
  const receipt = { spawnCapabilityDigest: digest, createdAt: new Date(NOW - 30 * MINUTE).toISOString() };
  const designatedAt = new Date(NOW - 20 * MINUTE).toISOString();
  const write = (failedCalls: number) => fs.writeFileSync(heartbeatFile, JSON.stringify({
    checkedAt: new Date(NOW).toISOString(), ready: true, unreadySince: null, failedCalls,
  }));
  const deps = { ...rig.deps, mcpHealth: () => seatMcpHealth(receipt, designatedAt, stateDir, NOW) };
  write(3);
  expect((await runSeatTickCheck(PROJECT, deps))?.delivery?.outcome).toBe("seat-mcp-unavailable");
  expect(rig.sent).toHaveLength(0);
  expect(rig.cards.at(-1)?.card).toMatchObject({ kind: "mcp-unavailable", state: "open" });
  write(0);
  await runSeatTickCheck(PROJECT, deps);
  expect(rig.cards.at(-1)?.card).toMatchObject({ kind: "mcp-unavailable", state: "resolved" });
  expect(rig.sent).toHaveLength(1);
});

test("seat MCP health follows its recorded launch transport across server flag changes", async () => {
  const prior = process.env.LLV_MCP_TRANSPORT;
  try {
    for (const { selected, current, blocked, requestedHttp, legacy } of [
      { selected: "stdio", current: "http", blocked: true, requestedHttp: false, legacy: false },
      { selected: "http", current: "stdio", blocked: false, requestedHttp: false, legacy: false },
      /* HTTP requested at admission but rejected by the capability or local
         endpoint gate: the actual launch remains stdio. */
      { selected: "stdio", current: "http", blocked: true, requestedHttp: true, legacy: false },
      { selected: "stdio", current: "http", blocked: true, requestedHttp: false, legacy: true },
    ] as const) {
      const fixture = childFixture(`mcp-transport-${selected}-${current}-${crypto.randomUUID()}`);
      const digest = createHash("sha256").update(crypto.randomUUID()).digest("hex");
      // This is an old launch; fresh receipts intentionally get startup grace.
      globalThis.Date = new Proxy(WALL_DATE, {
        construct(target, args) { return Reflect.construct(target, args.length ? args : [fixture.now - 30 * MINUTE]); },
      });
      const begun = fixture.registry.beginSpawnRequest({ engine: "claude", cwd: fixture.cwd,
        conversationId: fixture.seat.conversationId as never, spawnCapabilityDigest: digest,
        launchProfile: { title: "Seat transport" } });
      globalThis.Date = WALL_DATE;
      const launched = requestedHttp
        ? viewerMcpTransportForLaunch({ LLV_SPAWN_CAPABILITY: "c".repeat(43) }, {
            LLV_MCP_TRANSPORT: "http", LLV_TOKEN: "test-key", LLV_MCP_HTTP_URL: "http://127.0.0.1:41234/api/mcp",
          })
        : selected;
      expect(launched).toBe(selected);
      if (!legacy) fixture.registry.setReceiptViewerMcpTransport(begun.receipt.launchId, launched);
      fixture.spawn({ title: "owed worker", turn: "terminal" });
      fixture.seed();
      process.env.LLV_MCP_TRANSPORT = current;
      const seat = { ...fixture.seat, designatedAt: ago(fixture, 20) };
      const rig = childRig(fixture, { seat });
      const record = await runSeatTickCheck(fixture.project, rig.deps);
      expect(rig.sent).toHaveLength(blocked ? 0 : 1);
      expect(record?.delivery?.outcome).toBe(blocked ? "seat-mcp-unavailable" : "delivered");
      expect(rig.cards.some(({ card }) => card.kind === "mcp-unavailable" && card.state === "open")).toBe(blocked);
    }
  } finally {
    if (prior === undefined) delete process.env.LLV_MCP_TRANSPORT;
    else process.env.LLV_MCP_TRANSPORT = prior;
  }
});

test("repeated real launcher child crashes block seat wakes until a tool response proves recovery", async () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Node is required for the launcher test");
  const packageRoot = fs.mkdtempSync(path.join(SANDBOX, "mcp-launcher-"));
  const bin = path.join(packageRoot, "bin");
  const dist = path.join(packageRoot, "dist");
  fs.mkdirSync(bin);
  fs.mkdirSync(dist);
  // The module set the product publishes beside the stable launcher, and nothing else.
  const sourceBin = path.join(import.meta.dir, "../../../bin");
  for (const name of ["mcp-server.mjs", ...mcpLauncherImports(sourceBin)]) fs.copyFileSync(path.join(sourceBin, name), path.join(bin, name));
  const crashFlag = path.join(packageRoot, "crash.flag");
  fs.writeFileSync(crashFlag, "crash");
  fs.writeFileSync(path.join(dist, "mcp-server.mjs"), `
    const fs = await import("node:fs");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      input += chunk;
      while (input.includes("\\n")) {
        const at = input.indexOf("\\n");
        const request = JSON.parse(input.slice(0, at)); input = input.slice(at + 1);
        if (request.id === undefined) continue;
        if (request.method === "tools/call" && fs.existsSync(process.env.LLV_TEST_CRASH_FLAG)) process.exit(7);
        const result = request.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "viewer", version: "1" } }
          : request.method === "tools/list"
            ? { tools: [{ name: "check", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: "recovered" }] };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      }
    });
  `);
  const stateDir = path.join(packageRoot, "state");
  const capability = "D".repeat(43);
  const digest = createHash("sha256").update(capability).digest("hex");
  const heartbeatFile = path.join(stateDir, "mcp-runtime", "sessions", `${digest}.json`);
  const session = spawn(node, [path.join(bin, "mcp-server.mjs")], {
    cwd: packageRoot,
    env: { ...process.env, LLV_STATE_DIR: stateDir, LLV_SPAWN_CAPABILITY: capability,
      LLV_BUN_EXECUTABLE: process.execPath, LLV_TEST_CRASH_FLAG: crashFlag },
    stdio: ["pipe", "pipe", "pipe"],
  });
  type McpResponse = { id: number; result: { serverInfo?: { name: string }; isError?: boolean; content?: { text: string }[] } };
  const pendingResponses = new Map<number, (message: McpResponse) => void>();
  let output = "";
  session.stdout.setEncoding("utf8");
  session.stdout.on("data", (chunk: string) => {
    output += chunk;
    while (output.includes("\n")) {
      const at = output.indexOf("\n");
      const message = JSON.parse(output.slice(0, at)); output = output.slice(at + 1);
      if (pendingResponses.has(message.id)) {
        pendingResponses.get(message.id)!(message);
        pendingResponses.delete(message.id);
      }
    }
  });
  const call = (id: number, method: string) => new Promise<McpResponse>((resolve, reject) => {
    const timeout = setTimeout(() => { pendingResponses.delete(id); reject(new Error(`MCP response ${id} timed out`)); }, 5_000);
    pendingResponses.set(id, (message) => { clearTimeout(timeout); resolve(message); });
    session.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { name: "check", arguments: {} } }) + "\n");
  });
  const readyHeartbeat = async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(heartbeatFile) && JSON.parse(fs.readFileSync(heartbeatFile, "utf8")).ready === true) return;
      await Bun.sleep(20);
    }
    throw new Error("MCP child did not reinitialize");
  };
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const receipt = { spawnCapabilityDigest: digest, createdAt: new Date(Date.now() - 30 * MINUTE).toISOString() };
  const designatedAt = new Date(Date.now() - 20 * MINUTE).toISOString();
  const deps = { ...rig.deps, mcpHealth: () => seatMcpHealth(receipt, designatedAt, stateDir, Date.now()) };
  try {
    expect((await call(1, "initialize")).result.serverInfo?.name).toBe("viewer");
    for (let id = 2; id <= 4; id++) {
      await readyHeartbeat();
      expect((await call(id, "tools/call")).result.isError).toBe(true);
      expect(JSON.parse(fs.readFileSync(heartbeatFile, "utf8")).failedCalls).toBe(id - 1);
    }
    await readyHeartbeat();
    expect(seatMcpHealth(receipt, designatedAt, stateDir, Date.now()).status).toBe("dead");
    expect((await runSeatTickCheck(PROJECT, deps))?.delivery?.outcome).toBe("seat-mcp-unavailable");
    expect(rig.sent).toHaveLength(0);
    expect(rig.cards.at(-1)?.card).toMatchObject({ kind: "mcp-unavailable", state: "open" });
    fs.unlinkSync(crashFlag);
    expect((await call(5, "tools/call")).result.content?.[0]?.text).toBe("recovered");
    expect(JSON.parse(fs.readFileSync(heartbeatFile, "utf8")).failedCalls).toBe(0);
    await runSeatTickCheck(PROJECT, deps);
    expect(rig.cards.at(-1)?.card).toMatchObject({ kind: "mcp-unavailable", state: "resolved" });
    expect(rig.sent).toHaveLength(1);
  } finally {
    session.stdin.end();
    if (session.exitCode === null) await new Promise<void>((resolve) => session.once("close", () => resolve()));
  }
}, 20_000);

/* Two checks that found the same thing raise the same wake, so a re-send after
   a send that never landed is the replay the delivery layer treats it as —
   rather than a second copy of a message the seat may yet receive. */
test("the wake's identity comes from what it says, so an unlanded wake re-sends as a replay", async () => {
  const held = { ok: true as const, target: null, outcome: "held" as const };
  const first = harness({ pipelines: OPEN_LANE, state: OVERDUE, delivery: held });
  await runSeatTickCheck(PROJECT, first.deps);
  const second = harness({ pipelines: OPEN_LANE, state: OVERDUE, delivery: held });
  await runSeatTickCheck(PROJECT, second.deps);
  expect(second.sent[0]!.clientMessageId).toBe(first.sent[0]!.clientMessageId);
});

/* The other half of the same key. An hourly wake on a board that has not moved
   carries the same reasons and the same fingerprint as the last one, so without
   the delivered-wake stamp in the key the delivery layer would swallow it as a
   replay — silence the seat cannot tell from a healthy board. */
test("the wake after a delivered one is a new message, not a replay of it", async () => {
  const first = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const before = await runSeatTickCheck(PROJECT, first.deps);
  const next = harness({
    pipelines: OPEN_LANE,
    state: { lastWakeAt: first.written.at(-1)!.lastWakeAt, lastWakeFingerprint: first.written.at(-1)!.lastWakeFingerprint },
  });
  /* An hour on, with the board in exactly the state it was left in. */
  next.deps.sources!.now = () => NOW + 61 * MINUTE;
  const after = await runSeatTickCheck(PROJECT, next.deps);
  expect(after!.verdict).toBe("wake");
  expect(after!.delivery!.clientMessageId).not.toBe(before!.delivery!.clientMessageId);
});

test("a seat that rotated between the decision and the send is never woken", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: OVERDUE,
    rotateBeforeSend: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
  expect(record!.delivery).toMatchObject({ outcome: "seat-rotated" });
  expect(rig.written.at(-1)!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
});

test("a seat revoked with no successor is likewise refused at the send", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, rotateBeforeSend: null });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
  expect(record!.delivery).toMatchObject({ outcome: "seat-rotated" });
});

/* The finding this rule exists for: a delivery the layer accepted is not a
   delivery the seat has. A held or queued message would otherwise start the
   hourly clock and — worse — acknowledge the lane events that raised it. */
test("a held, queued, delivering or pending send is not a delivered wake", async () => {
  expect(wakeReached({ ok: true, target: null, outcome: "held" })).toBe(false);
  expect(wakeReached({ ok: true, target: null, outcome: "queued", operationId: "op", receipt: {} as never, structured: true })).toBe(false);
  expect(wakeReached({ ok: true, target: null, outcome: "delivering", operationId: "op", receipt: {} as never, structured: true })).toBe(false);
  expect(wakeReached({ ok: true, target: null, outcome: "pending" })).toBe(false);
  expect(wakeReached({ ok: true, target: "pane", outcome: "delivered-to-live" })).toBe(true);
  expect(wakeReached({ ok: true, target: null, outcome: "resumed" })).toBe(true);
  expect(wakeReached({ ok: true, target: "pane" })).toBe(true);
  expect(wakeReached({ ok: false, outcome: "failed", error: "gone", status: 409 })).toBe(false);
});

test("a held wake leaves the wake stamp and the event cursor exactly where they were", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    events: [terminalEvent(44)],
    state: { ...OVERDUE, eventsThrough: 12 },
    delivery: { ok: true, target: null, outcome: "held" },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.delivery).toMatchObject({ outcome: "held" });
  expect(rig.written.at(-1)!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
  expect(rig.written.at(-1)!.eventsThrough).toBe(12);
  expect(record!.eventsThrough).toBe(12);
});

/* The half of the epoch check the re-read before the send cannot do. The layer
   keeps a held or queued payload durably, so the seat can rotate while it
   waits — and it would then arrive at the predecessor, which is the failure
   this whole mechanism exists to end. The record names WHICH layer kept it,
   because a revocation aimed at the wrong one changes nothing. */
test("a wake the runtime host queued is written down against that operation", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    events: [terminalEvent(44)],
    state: { ...OVERDUE, eventsThrough: 12 },
    delivery: { ok: true, target: null, outcome: "queued", operationId: "op-wake-1", receipt: {} as never, structured: true },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.written.at(-1)!.outstandingWake).toMatchObject({
    clientMessageId: record!.delivery!.clientMessageId,
    conversationId: CONVERSATION,
    seatEpoch: 7,
    operationId: "op-wake-1",
    commit: { proposal: false, reasons: ["lane-event"], fingerprint: record!.delivery!.clientMessageId.split(":").at(-1)!, eventsThrough: 44, children: [] },
  });
});

/* And the hold that never reached a host: there is no runtime operation, so the
   Viewer registry's own reservation IS the retention and the record says so by
   carrying no operation id. */
test("a wake an account migration held names no operation, because no host has it", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: OVERDUE,
    delivery: { ok: true, target: null, outcome: "held" },
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.written.at(-1)!.outstandingWake).toMatchObject({ operationId: null, seatEpoch: 7 });
});

test("the next check takes that wake back out of the queue holding it, the moment the epoch moves", async () => {
  const rig = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
    pipelines: OPEN_LANE,
    /* The row the predecessor left: its epoch, and its unlanded wake. */
    state: { ...OVERDUE, seatEpoch: 7, outstandingWake: outstandingWake() },
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.withdrawn).toHaveLength(1);
  expect(rig.withdrawn[0]!.wake.operationId).toBe("op-wake-1");
  expect(rig.withdrawn[0]!.reason).toContain("has since been replaced");
  const revocation = rig.journal.find((line) => line.verdict === "revoked");
  expect(revocation).toMatchObject({ seatEpoch: 7, delivery: { outcome: "withdrawn" } });
  expect(rig.written.at(-1)!.outstandingWake).toBeNull();
});

/* The answer this mechanism has to be able to give. A holder that has already
   let the payload go cannot be made to take it back, and reporting that as a
   revocation would be the silent version of the very defect being prevented. */
test("a withdrawal the holder was already past is recorded as too late, never as a revocation", async () => {
  const rig = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, seatEpoch: 7, outstandingWake: outstandingWake() },
    withdrawal: "too-late",
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  const line = rig.journal.find((entry) => entry.delivery?.outcome === "too-late")!;
  expect(line.detail).toContain("may have received it");
  /* The predecessor may have it, so the attempt is neither credited nor
     replaced (#1465): it keeps its original key and nothing it carried is
     acknowledged. This seat is provably superseded — another conversation, at a
     higher epoch — so the attempt keeps that key as the REPLACED seat's
     obligation rather than as a fence on the successor's wake (#1594), and the
     next check asks the holder again there. */
  expect(line.verdict).toBe("retired");
  const written = rig.written.at(-1)!;
  expect(written.outstandingWake).toBeNull();
  expect(written.retiredWakes).toMatchObject([{ wake: { clientMessageId: outstandingWake().clientMessageId, commit: outstandingWake().commit } }]);
  /* And the successor, no longer waiting behind it, is woken under its own. */
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]!.conversationId).toBe(SUCCESSOR);
  expect(rig.sent[0]!.clientMessageId).not.toBe(outstandingWake().clientMessageId);
});

/* The same seat is not a replacement, so a wake the holder still has stays
   outstanding — that one is the replay the next check re-raises under the same
   key. */
test("a seat that is still the same seat keeps a wake its holder is still holding", async () => {
  const outstanding = outstandingWake();
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { ...RECENT, outstandingWake: outstanding },
    wakeState: "retained",
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.withdrawn).toEqual([]);
  expect(rig.journal.some((line) => line.verdict === "revoked")).toBe(false);
  /* The attempt is kept as it was, with one addition: a row written before
     the instant existed is stamped with when it was first seen (#1465), so
     the bound on an attempt nobody can account for is measured from a fact. */
  expect(rig.written.at(-1)!.outstandingWake).toEqual({ ...outstanding, preparedAt: new Date(NOW).toISOString() });
  expect(rig.cards).toEqual([]);
});

/* The other half of the same question, and the reason `queued` may be believed
   at all. A structured host admits every send as queued whether it is idle or
   mid-turn, so "did the seat get it?" is only ever answered by the layer that
   took it — and that answer has to apply the stamp and the cursor the raising
   check wrote down. Without it the hourly bound the ADR rests on is bypassed by
   a wake that was delivered and never recorded. */
test("a wake the holder delivered after the send is credited with the plan that raised it", async () => {
  const outstanding = outstandingWake();
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { ...RECENT, eventsThrough: 12, outstandingWake: outstanding },
    wakeState: "landed",
  });
  await runSeatTickCheck(PROJECT, { ...rig.deps,
    mcpHealth: () => ({ status: "dead", detail: "stdio MCP has no heartbeat" }),
  });
  const landing = rig.journal.find((line) => line.verdict === "landed")!;
  expect(landing.delivery).toEqual({ clientMessageId: outstanding.clientMessageId, outcome: "landed" });
  expect(rig.written.at(-1)!.lastWakeAt).toBe(new Date(NOW).toISOString());
  expect(rig.written.at(-1)!.lastWakeReasons).toEqual(["interval"]);
  expect(rig.written.at(-1)!.eventsThrough).toBe(44);
  expect(rig.written.at(-1)!.outstandingWake).toBeNull();
});

/* And the bound that landing restores: an hour has to pass from the delivery
   the holder made, not from a delivery the tick happened to observe. */
test("crediting the landing starts the hourly bound, so the same check does not wake again", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, outstandingWake: outstandingWake() },
    wakeState: "landed",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
  expect(record!.verdict).toBe("quiet");
});

/* A holder that settled the payload without delivering it woke nobody, so no
   stamp moves and the wake is owed again. */
test("a wake the holder settled unsent moves no stamp, and the same check raises it again", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, eventsThrough: 12, outstandingWake: outstandingWake() },
    wakeState: "dropped",
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  const dropped = rig.journal.find((line) => line.verdict === "dropped")!;
  expect(dropped.delivery).toMatchObject({ outcome: "dropped" });
  expect(dropped.eventsThrough).toBe(12);
  expect(rig.sent).toHaveLength(1);
});

/* A rotation that lands while the send is in flight is the one the row cannot
   carry to a later check, because there may not be one before the payload
   flushes. So a retained send is re-checked at once. */
test("a rotation during the send is caught by the same check that made the wake", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: OVERDUE,
    delivery: { ok: true, target: null, outcome: "queued", operationId: "op-inflight", receipt: {} as never, structured: true },
  });
  const deliver = rig.deps.deliver!;
  rig.deps.deliver = async (...args) => {
    const result = await deliver(...args);
    rig.deps.sources!.seatFor = () => ({ active: { conversationId: SUCCESSOR, seatEpoch: 8, path: null } as never, pending: null, history: [] });
    return result;
  };
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.withdrawn.map((entry) => entry.wake.operationId)).toEqual(["op-inflight"]);
  expect(rig.written.at(-1)!.outstandingWake).toBeNull();
});

/* A holder that cannot answer must not take the check down with it, and it is
   not evidence either way: the payload is exactly where it was, so the row
   keeps it and the next check asks again. */
test("a holder that cannot be reached is journaled, and the attempt is retained whole", async () => {
  const outstanding = outstandingWake();
  const rig = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
    pipelines: OPEN_LANE,
    state: { ...RECENT, seatEpoch: 7, outstandingWake: outstanding },
    holderThrows: true,
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.verdict).not.toBe("error");
  const line = rig.journal.find((entry) => entry.delivery?.outcome === "unknown")!;
  expect(line.detail).toContain("could not be revoked");
  /* Nothing about the payload is known, so nothing about it is decided: it is
     retained exactly as it stood, under its own key, stamped with when it was
     first seen. It is retained against the seat it was addressed to, which this
     project has provably replaced (#1594), so the next check asks that same
     holder again without the successor waiting on the answer. */
  expect(line.verdict).toBe("retired");
  expect(rig.written.at(-1)!.outstandingWake).toBeNull();
  expect(rig.written.at(-1)!.retiredWakes).toEqual([
    { wake: { ...outstanding, preparedAt: new Date(NOW).toISOString() }, retiredAt: new Date(NOW).toISOString(),
      supersededBy: { conversationId: SUCCESSOR, seatEpoch: 8 }, reason: "seat-superseded" },
  ]);
  expect(rig.cards).toEqual([]);
});

/* Before #1465 this check sent the new wake and let its landing settle the old
   one. That put a second wake in flight behind one the seat may yet receive —
   the duplicate the issue's correction warns about — so a different wake now
   waits until the holder answers for the first. */
test("a different wake is withheld while the outstanding one is unresolved, and the row keeps the first (#1465)", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, outstandingWake: outstandingWake() },
    wakeState: "retained",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "deferred-outstanding" } });
  expect(record!.delivery!.clientMessageId).not.toBe(outstandingWake().clientMessageId);
  expect(rig.sent).toEqual([]);
  expect(rig.written.at(-1)!.outstandingWake).toEqual({ ...outstandingWake(), preparedAt: new Date(NOW).toISOString() });
  expect(rig.written.at(-1)!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
});

/* The bound made visible (#1465): an attempt a live holder still keeps past a
   whole wake interval is never ended here — that holder will deliver or fail
   it — but the wait goes on the board once, under the attempt's own key. */
test("a wake a holder still retains past the wake interval is carded once and kept (#1465)", async () => {
  const outstanding = outstandingWake({ preparedAt: new Date(NOW - 70 * MINUTE).toISOString() });
  const rig = harness({ pipelines: OPEN_LANE, state: { ...OVERDUE, outstandingWake: outstanding }, wakeState: "retained" });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "deferred-outstanding" } });
  expect(rig.written.at(-1)!.outstandingWake).toEqual(outstanding);
  expect(rig.journal.map((line) => line.verdict)).toEqual(["wake"]);
  expect(rig.cards.map((entry) => entry.card)).toMatchObject([{ ref: SEAT_TICK_WAKE_UNRESOLVED_REF, kind: "wake-unresolved", instance: outstanding.clientMessageId }]);
  expect(rig.cards[0]!.card.detail).toContain('last answered "retained"');
  /* The same attempt on the next check is the same occurrence: the board's own
     create receipt collapses it. A second attempt rewrites the same card. */
  const again = harness({ pipelines: OPEN_LANE, state: { ...OVERDUE, outstandingWake: outstanding }, wakeState: "retained" });
  await runSeatTickCheck(PROJECT, again.deps);
  expect(again.cards.map((entry) => entry.card.instance)).toEqual([outstanding.clientMessageId]);
});

test("the same outstanding wake remains fenced under its original key (#1465)", async () => {
  const first = harness({
    pipelines: OPEN_LANE,
    state: OVERDUE,
    delivery: { ok: true, target: null, outcome: "queued", operationId: "op-wake-1", receipt: {} as never, structured: true },
  });
  const raised = await runSeatTickCheck(PROJECT, first.deps);
  const outstanding = first.written.at(-1)!.outstandingWake!;
  expect(outstanding.clientMessageId).toBe(raised!.delivery!.clientMessageId);

  const second = harness({ pipelines: OPEN_LANE, state: { ...OVERDUE, outstandingWake: outstanding }, wakeState: "retained" });
  const record = await runSeatTickCheck(PROJECT, second.deps);
  expect(record!.delivery).toEqual({ clientMessageId: outstanding.clientMessageId, outcome: "deferred-outstanding" });
  expect(second.sent).toHaveLength(0);
});

test("a delivered wake is what moves the event cursor past the events it carried", async () => {
  const rig = harness({ pipelines: OPEN_LANE, events: [terminalEvent(44)], state: { ...OVERDUE, eventsThrough: 12 } });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.reasons).toEqual(["lane-event"]);
  expect(rig.written.at(-1)!.eventsThrough).toBe(44);
});

/* #1262, end to end: the seat's very first check, against a journal that
   already holds a day of settled work. The wake that produced the report said
   "stage_completed since the last delivered wake and 85 more" for a seat that
   had never had a delivered wake at all. */
test("a project's first check seals the cursor at the head instead of replaying the journal", async () => {
  const history = [terminalEvent(9848), terminalEvent(9850), terminalEvent(9853)];
  const rig = harness({ pipelines: OPEN_LANE, events: history, state: OVERDUE });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  /* The lane is open and the hour has elapsed, so a wake is owed — but on the
     open lane, not on three days of finished stages. */
  expect(record!.reasons).toEqual(["interval"]);
  expect(rig.sent[0]!.text).not.toContain("the round passed");
  expect(record!.items).toBe(1);
  expect(record!.eventsThrough).toBe(9853);
  expect(rig.written.at(-1)!.eventsThrough).toBe(9853);
});

/* And the check after it is the one the cursor exists for: what happened since
   the tick began is still delivered, in full. */
test("the check after the seal carries the events that arrived since it", async () => {
  const history = [terminalEvent(9848), terminalEvent(9853)];
  const sealed = harness({ pipelines: OPEN_LANE, events: history, state: OVERDUE });
  await runSeatTickCheck(PROJECT, sealed.deps);
  const next = harness({
    pipelines: OPEN_LANE,
    events: [...history, terminalEvent(9854)],
    state: { ...OVERDUE, eventsThrough: sealed.written.at(-1)!.eventsThrough },
  });
  const record = await runSeatTickCheck(PROJECT, next.deps);
  expect(record!.reasons).toEqual(["lane-event"]);
  expect(record!.eventsThrough).toBe(9854);
});

/* The report: three consecutive wakes whose every item named a pipeline that
   had reached a terminal state the day before. Nothing was owed on any of them,
   and establishing that was the entire cost of the wake. */
test("events belonging to a lane that has finished send nothing, and the check that read them discharges them", async () => {
  const rig = harness({
    pipelines: FINISHED_LANE,
    tasks: [{ id: "task_b2", status: "inbox" }],
    events: [terminalEvent(44), terminalEvent(45), terminalEvent(46)].map((event) => ({ ...event, pipelineId: "pipeline_z9" })),
    state: { ...OVERDUE, eventsThrough: 12 },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet", delivery: null, detail: "no eligible interval agenda: unparented workers and inbox cards alone do not qualify" });
  expect(rig.sent).toEqual([]);
  /* And the backlog does not come back for a second, third and fourth wake:
     one look moved the cursor past all of it. */
  expect(rig.written.at(-1)!.eventsThrough).toBe(46);
  expect(record!.eventsThrough).toBe(46);
});

/* Twelve hours of `quiet — nothing owed` while three approved pull requests sat
   unmerged, because the tick counts open lanes and board cards and a finished
   lane is neither. */
test("a completed lane whose pull request is still open wakes the seat, naming the pull request", async () => {
  const rig = harness({
    pipelines: FINISHED_LANE,
    state: OVERDUE,
    openPullRequests: [{
      number: 1289,
      title: "wake on a merge that is waiting",
      headRefName: "topic-merge-queue",
      createdAt: FINISHED_PR_CREATED,
      updatedAt: "2026-08-28T11:30:00.000Z",
    }],
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["unmerged-pr"], items: 1 });
  expect(rig.sent[0]!.text).toContain("pull request #1289 left open by a lane that finished");
  expect(rig.sent[0]!.text).toContain("[pull-request] #1289 — wake on a merge that is waiting");
});

test("legacy exhausted PR guard drains every page and then suppresses unchanged PRs", async () => {
  const previousStateDir = process.env.LLV_STATE_DIR;
  const stateDir = fs.mkdtempSync(path.join(SANDBOX, "legacy-pr-pagination-"));
  process.env.LLV_STATE_DIR = stateDir;
  const stateFile = path.join(stateDir, "seat-tick.json");
  const branches = Array.from({ length: 22 }, (_, index) => `pipeline/legacy-pr-${index + 1}`);
  const lanes = branches.map((branch, index) => ({
    ...FINISHED_LANE[0]!, id: `pipeline_legacy_pr_${index + 1}`, branch,
  }));
  const openPullRequests = branches.map((headRefName, index) => ({
    number: index + 1, title: `Completed lane ${index + 1}`, headRefName,
    createdAt: FINISHED_PR_CREATED, updatedAt: "2026-08-28T11:30:00.000Z",
  }));
  const stateOptions = { stateFile, pipelines: lanes, openPullRequests };
  let now = NOW;
  try {
    writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE }, stateFile);
    /* Establish the current gathered fingerprint and a complete delivered
       history, then create the already-present retry card with the real board
       writer. The following write models a pre-upgrade SQLite row: all legacy
       retry state survives and the newer showing-history column is absent. */
    const alreadyDelivered = new Set<string>();
    for (let page = 0; page < 5; page += 1) {
      const rig = harness({ ...stateOptions, now });
      const record = await runSeatTickCheck(PROJECT, rig.deps);
      expect(record).toMatchObject({ verdict: "wake", reasons: ["unmerged-pr"], items: page < 4 ? 5 : 2 });
      for (const match of rig.sent[0]!.text.matchAll(/\[pull-request\] (#[0-9]+)/g)) alreadyDelivered.add(match[1]!);
      now += 61 * MINUTE;
    }
    expect(alreadyDelivered.size).toBe(22);
    const delivered = readSeatTickState(PROJECT, stateFile);
    expect(delivered.itemsShown).toHaveLength(22);

    const { loadTasks, saveTasks } = await import("@/lib/tasks/store");
    const { seatTickRetryGuardCardText, seatTickRetryGuardRef } = await import("./cards");
    const tasksFile = path.join(stateDir, "tasks.json");
    const retryRef = seatTickRetryGuardRef("unmerged-pr");
    const retryCardText = seatTickRetryGuardCardText(PROJECT,
      'Wakes for "unmerged-pr" stopped producing any board or pipeline change; the tick has stopped re-sending it until state moves',
      retryRef, new Date(now).toISOString());
    saveTasks([{
      id: crypto.randomUUID(), project: PROJECT, status: "inbox", text: retryCardText,
      placement: "unplaced", assignments: [], createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    }], tasksFile);
    const retryCard = loadTasks(tasksFile).find((task) => task.text.includes(retryRef));
    expect(retryCard).toBeDefined();
    const cardBefore = { text: retryCard!.text, status: retryCard!.status };

    const legacy = readSeatTickState(PROJECT, stateFile);
    const currentFingerprint = legacy.lastWakeFingerprint;
    expect(currentFingerprint).toBeTruthy();
    delete legacy.itemsShown;
    legacy.lastWakeAt = new Date(now - 61 * MINUTE).toISOString();
    legacy.wakesWithoutChange = { "unmerged-pr": DEFAULT_SEAT_TICK_POLICY.retryGuard };
    writeSeatTickState(PROJECT, legacy, stateFile);
    const persistedLegacy = readSeatTickState(PROJECT, stateFile);
    expect(persistedLegacy.itemsShown).toBeUndefined();
    expect(persistedLegacy.accounting).toBeDefined();
    expect(persistedLegacy).toMatchObject({
      lastWakeFingerprint: currentFingerprint,
      wakesWithoutChange: { "unmerged-pr": DEFAULT_SEAT_TICK_POLICY.retryGuard },
    });

    const reached = new Set<string>();
    let wakeCount = 0;
    for (let page = 0; page < 6; page += 1) {
      const rig = harness({ ...stateOptions, now });
      const record = await runSeatTickCheck(PROJECT, { ...rig.deps, ensureCard: undefined });
      if (record?.verdict !== "wake") break;
      wakeCount += 1;
      expect(record.reasons).toEqual(["unmerged-pr"]);
      expect(record.items).toBeLessThanOrEqual(DEFAULT_SEAT_TICK_POLICY.itemsPerWake);
      for (const match of rig.sent[0]!.text.matchAll(/\[pull-request\] (#[0-9]+)/g)) reached.add(match[1]!);
      now += 61 * MINUTE;
    }
    expect(wakeCount).toBeLessThanOrEqual(5);
    expect(wakeCount).toBeGreaterThan(0);
    expect(reached.size).toBe(22);
    expect(loadTasks(tasksFile).find((task) => task.id === retryCard!.id)).toMatchObject(cardBefore);

    const repeat = harness({ ...stateOptions, now });
    expect(await runSeatTickCheck(PROJECT, repeat.deps)).toMatchObject({ verdict: "quiet", items: 0 });
    expect(repeat.sent).toEqual([]);
  } finally {
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
  }
});

test("a completed lane's delivery branch identifies the pull request it left open (#2081)", async () => {
  const rig = harness({
    pipelines: [{ ...FINISHED_LANE[0]!, branch: "pipeline/internal-lane", deliveryBranch: "pipeline/skeletons-transitions" }],
    state: OVERDUE,
    openPullRequests: [{ number: 2076, title: "phone loading states", headRefName: "pipeline/skeletons-transitions", createdAt: FINISHED_PR_CREATED, updatedAt: new Date(NOW - MINUTE).toISOString() }],
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["unmerged-pr"], items: 1 });
  expect(rig.sent[0]!.text).toContain("[pull-request] #2076");
});

test("a pull request line announces its creator's completed lane only after delivery (#2081)", async () => {
  const lane = {
    ...FINISHED_LANE[0]!, src: CONVERSATION, branch: "pipeline/internal-lane",
    deliveryBranch: "pipeline/skeletons-transitions",
  };
  const rig = harness({
    pipelines: [lane], state: { ...OVERDUE, announcedLanes: [lane.id] },
    openPullRequests: [{ number: 2076, title: "phone loading states", headRefName: "pipeline/skeletons-transitions", createdAt: FINISHED_PR_CREATED, updatedAt: new Date(NOW - MINUTE).toISOString() }],
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.reasons).toEqual(["own-lane-settled", "unmerged-pr"]);
  expect(record!.items).toBe(1);
  expect(rig.written.at(-1)!.announcedLanes).toEqual([lane.id, `${lane.id}:completed`]);

  const later = harness({
    pipelines: [lane], now: NOW + 61 * MINUTE, state: rig.written.at(-1)!,
    openPullRequests: [{ number: 2076, title: "phone loading states", headRefName: "pipeline/skeletons-transitions", createdAt: FINISHED_PR_CREATED, updatedAt: new Date(NOW - MINUTE).toISOString() }],
  });
  const second = await runSeatTickCheck(PROJECT, later.deps);
  expect(second!.verdict).toBe("quiet");
  expect(later.sent).toHaveLength(0);
});

test("a PR opened after a finished lane released its delivery head belongs to the active lane (#2081)", async () => {
  const branch = "pipeline/shared-delivery-head";
  const rig = harness({
    pipelines: [
      { ...FINISHED_LANE[0]!, branch: "pipeline/old-internal", deliveryBranch: branch },
      { id: "pipeline_new", state: "running", branch: "pipeline/new-internal", deliveryBranch: branch,
        createdAt: new Date(NOW - 90 * MINUTE).toISOString(), movedAt: new Date(NOW - MINUTE).toISOString() },
    ],
    state: OVERDUE,
    openPullRequests: [{ number: 2090, title: "new lane work", headRefName: branch,
      createdAt: new Date(NOW - 30 * MINUTE).toISOString(), updatedAt: new Date(NOW - MINUTE).toISOString() }],
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(rig.sent[0]!.text).not.toContain("#2090");
});

test("a PR opened after completion still belongs to the finished lane when its head was not reused (#2081)", async () => {
  const branch = "pipeline/unchanged-delivery-head";
  const rig = harness({
    pipelines: [{ ...FINISHED_LANE[0]!, branch: "pipeline/internal-lane", deliveryBranch: branch }],
    state: OVERDUE,
    openPullRequests: [{ number: 2091, title: "late PR for finished work", headRefName: branch,
      createdAt: new Date(NOW - 30 * MINUTE).toISOString(), updatedAt: new Date(NOW - MINUTE).toISOString() }],
  });
  expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "wake", reasons: ["unmerged-pr"] });
});

test("a running lane taking over an existing PR keeps its finished predecessor from waking the seat (#2081)", async () => {
  const branch = "pipeline/shared-delivery-head";
  const rig = harness({
    pipelines: [
      { ...FINISHED_LANE[0]!, branch: "pipeline/old-internal", deliveryBranch: branch, deliveryPr: 2092 },
      { id: "pipeline_new", state: "running", branch: "pipeline/new-internal", deliveryBranch: branch, deliveryPr: 2092,
        createdAt: new Date(NOW - 90 * MINUTE).toISOString(), movedAt: new Date(NOW - MINUTE).toISOString() },
    ],
    state: OVERDUE,
    openPullRequests: [{ number: 2092, title: "shared PR now owned by the running lane", headRefName: branch,
      createdAt: FINISHED_PR_CREATED, updatedAt: new Date(NOW - MINUTE).toISOString() }],
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(rig.sent[0]!.text).not.toContain("#2092");
});

/* And the merge is what silences it, with nothing else to turn off. */
test("once the pull request is merged the same project owes nothing again", async () => {
  const rig = harness({
    pipelines: FINISHED_LANE,
    tasks: [{ id: "task_b2", status: "inbox" }],
    state: OVERDUE,
    openPullRequests: [],
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet", detail: "no eligible interval agenda: unparented workers and inbox cards alone do not qualify" });
  expect(rig.sent).toEqual([]);

  /* And with the board empty behind it too — one finished lane and nothing
     else — the same merge leaves a project with no wake owed at all. */
  const bare = harness({
    pipelines: FINISHED_LANE,
    state: { ...OVERDUE, lastProposalAt: new Date(NOW - MINUTE).toISOString() },
    openPullRequests: [],
  });
  expect(await runSeatTickCheck(PROJECT, bare.deps)).toMatchObject({ verdict: "quiet" });
  expect(bare.sent).toEqual([]);
});

test("a lane the archive has taken still wakes the seat over its open pull request", async () => {
  const rig = harness({
    pipelines: [],
    archivedPipelines: ARCHIVED_LANE,
    state: OVERDUE,
    openPullRequests: [{
      number: 1289,
      title: "wake on a merge that is waiting",
      headRefName: "topic-merge-queue",
      createdAt: "2026-08-22T10:00:00.000Z",
      updatedAt: "2026-08-28T11:30:00.000Z",
    }],
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["unmerged-pr"], items: 1 });
  expect(rig.sent[0]!.text).toContain("pull request #1289 left open by a lane that finished");
});

test("and once that pull request merges the same project goes quiet", async () => {
  const rig = harness({
    pipelines: [],
    archivedPipelines: ARCHIVED_LANE,
    state: { ...OVERDUE, lastProposalAt: new Date(NOW - MINUTE).toISOString() },
    openPullRequests: [],
  });
  expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "quiet" });
  expect(rig.sent).toEqual([]);
});

/* ------------------------------------------------------------------------- *
 * A `gh` that could not answer is journaled and retried, never spent.
 * ------------------------------------------------------------------------- */

test("a GitHub failure is journaled as an error rather than published as quiet", async () => {
  const rig = harness({
    pipelines: FINISHED_LANE,
    tasks: [{ id: "task_b2", status: "inbox" }],
    state: OVERDUE,
    pullRequestsUnavailable: "command-failed",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "error", reasons: [], items: 0 });
  expect(record!.detail).toContain("command-failed");
  expect(rig.sent).toEqual([]);
  /* The stamp and the guard are exactly where the previous check left them, so
     the hourly budget is intact and the next check asks again. */
  expect(rig.written.at(-1)!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
  expect(rig.written.at(-1)!.wakesWithoutChange).toEqual({});
  expect(rig.written.at(-1)!.quietSince).toBeNull();
});

test("the check after the failure asks again, and wakes as soon as GitHub answers", async () => {
  const failed = harness({ pipelines: FINISHED_LANE, state: OVERDUE, pullRequestsUnavailable: "timed-out" });
  expect(await runSeatTickCheck(PROJECT, failed.deps)).toMatchObject({ verdict: "error" });

  /* The next check reads the row the failed one wrote — the wake stamp it did
     not move — and the wake is still due. */
  const recovered = harness({
    pipelines: FINISHED_LANE,
    state: failed.written.at(-1)!,
    openPullRequests: [{
      number: 1289,
      title: "wake on a merge that is waiting",
      headRefName: "topic-merge-queue",
      createdAt: FINISHED_PR_CREATED,
      updatedAt: "2026-08-28T11:30:00.000Z",
    }],
  });
  expect(await runSeatTickCheck(PROJECT, recovered.deps)).toMatchObject({ verdict: "wake", reasons: ["unmerged-pr"] });
});

/* The lane event goes out (#1298), and the wake it goes out on says what the
   check could not see. Withholding it was the four-hour silence: the event had
   nothing to do with GitHub, and the seat heard about neither. */
test("a lane event still wakes the seat while GitHub is unreadable, and the wake names the gap", async () => {
  const rig = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, eventsThrough: 12 },
    events: [terminalEvent(44)],
    pullRequestsUnavailable: "malformed-output",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["lane-event"], items: 1 });
  /* The journal line carries the gap beside the reason, so an hour that ran on
     one blind source reads back as exactly that. */
  expect(record!.detail).toContain("malformed-output");
  expect(rig.sent[0]!.text).toContain("Evidence unavailable:");
  expect(rig.sent[0]!.text).toContain("pull-requests: the open pull requests of this project's finished lanes could not be read (malformed-output)");
  /* And the reason that rests on the unreadable source is not among them: an
     empty answer nobody could read names no pull request. */
  expect(record!.reasons).not.toContain("unmerged-pr");
});

/* The acceptance case (#1298), end to end: a parked lane, a pull-request
   source that cannot be read, and a seat that used to hear nothing at all. */
test("a parked lane and an unreadable pull-request source produce a wake naming both", async () => {
  const parked = [{ id: "pipeline_p1", state: "paused", createdAt: "2026-08-28T09:00:00.000Z", movedAt: "2026-08-28T09:30:00.000Z" }];
  const first = harness({
    pipelines: [...parked, ...FINISHED_LANE],
    state: OVERDUE,
    pullRequestsUnavailable: "command-failed",
  });
  /* The first check is the one that establishes the stall; a lane between two
     attempts is never called stuck, so this one wakes on the interval instead
     and the parked lane is remembered for the next. */
  expect(await runSeatTickCheck(PROJECT, first.deps)).toMatchObject({ verdict: "wake" });
  expect(first.written.at(-1)!.stalledSeen).toEqual(["pipeline_p1"]);

  const rig = harness({
    pipelines: [...parked, ...FINISHED_LANE],
    state: { ...first.written.at(-1)!, ...OVERDUE },
    pullRequestsUnavailable: "command-failed",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["stalled"] });
  expect(rig.sent[0]!.text).toContain("pipeline_p1");
  expect(rig.sent[0]!.text).toContain("Evidence unavailable:");
});

/* The same case with the failure arriving the way production produced it: `gh`
   itself throwing, through the real seam and the real parse, rather than a
   classified result the test picked. Twenty-three checks reported `error` while
   these two lanes stood parked; the wake below is what the seat should have
   been getting all along. */
test("a gh that throws beside a parked lane still wakes the seat, and names what it could not see", async () => {
  const parked = [{ id: "pipeline_p1", state: "paused", createdAt: "2026-08-28T09:00:00.000Z", movedAt: "2026-08-28T09:30:00.000Z" }];
  const run: GithubRunner = async () => { throw new Error("gh: could not authenticate"); };
  const first = harness({ pipelines: [...parked, ...FINISHED_LANE], state: OVERDUE, githubRun: run });
  await runSeatTickCheck(PROJECT, first.deps);
  expect(first.written.at(-1)!.stalledSeen).toEqual(["pipeline_p1"]);

  const rig = harness({
    pipelines: [...parked, ...FINISHED_LANE],
    state: { ...first.written.at(-1)!, ...OVERDUE },
    githubRun: run,
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["stalled"] });
  /* The reason that stands names the parked lane … */
  expect(rig.sent[0]!.text).toContain("pipeline_p1");
  /* … the wake says which evidence it could not read … */
  expect(rig.sent[0]!.text).toContain("Evidence unavailable:");
  expect(rig.sent[0]!.text).toContain("command-failed");
  /* … and the reason that rested on the failed source is not among them. */
  expect(record!.reasons).not.toContain("unmerged-pr");
  /* Nothing about the failed read was recorded as quiet. */
  expect(rig.written.at(-1)!.quietSince).toBeNull();
});

/* The three ways `gh` itself fails, each carried through the real seam and the
   real parse, each alongside a lane event that would otherwise have woken the
   seat. Each wakes on the reason that stands, names the gap it could not read,
   raises no `unmerged-pr`, and is asked again on the next check. */
test("a thrown command, a timeout and unusable output each name their gap and are asked again", async () => {
  const killed = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
  const failures: { name: string; gap: string; run: GithubRunner }[] = [
    { name: "thrown command", gap: "command-failed", run: async () => { throw new Error("gh: command not found"); } },
    { name: "timeout", gap: "timed-out", run: async () => { throw killed; } },
    /* A nonempty answer whose only row names no head branch: the shape that
       used to arrive as a successful empty list. */
    { name: "unusable output", gap: "malformed-output", run: async () => JSON.stringify([{ number: 1289, title: "no head" }]) },
  ];

  for (const failure of failures) {
    let asked = 0;
    const run: GithubRunner = async (args) => {
      asked += 1;
      return failure.run(args);
    };
    const rig = harness({
      pipelines: [...OPEN_LANE, ...FINISHED_LANE],
      state: { ...OVERDUE, eventsThrough: 12, wakesWithoutChange: { "lane-event": 1 }, lastWakeFingerprint: "fp-0" },
      events: [terminalEvent(44)],
      githubRun: run,
    });

    const record = await runSeatTickCheck(PROJECT, rig.deps);
    expect(`${failure.name}: ${record!.verdict}`).toBe(`${failure.name}: wake`);
    expect(`${failure.name}: ${record!.reasons.join(",")}`).toBe(`${failure.name}: lane-event`);
    expect(record!.detail).toContain(failure.gap);
    expect(rig.sent[0]!.text).toContain(failure.gap);
    expect(rig.written.at(-1)!.quietSince).toBeNull();
    /* The run of failures is on the row, and it is a fresh one: a source that
       has only just stopped answering is retried at every check. */
    expect(rig.written.at(-1)!.pullRequestGap).toMatchObject({ gap: failure.gap, attempts: 1, reported: false });
    expect(asked).toBe(1);

    /* The next check reads the row the failed one wrote and asks `gh` again,
       rather than waiting out an hour on one failure. */
    await runSeatTickCheck(PROJECT, harness({
      pipelines: [...OPEN_LANE, ...FINISHED_LANE],
      state: { ...rig.written.at(-1)!, ...OVERDUE },
      events: [terminalEvent(44)],
      githubRun: run,
    }).deps);
    expect(`${failure.name}: asked ${asked}`).toBe(`${failure.name}: asked 2`);
  }
});

/* The standing outage, put where an operator looks (#1298). Every one of the
   twenty-three failures was journaled, and the journal is not what anyone was
   reading — the operator read the board, and the board said nothing. */
test("a source unreadable since before the wake interval is carded once, and the row remembers", async () => {
  const gap = {
    gap: "command-failed" as const,
    since: new Date(NOW - 4 * 60 * MINUTE).toISOString(),
    lastAttemptAt: new Date(NOW - 61 * MINUTE).toISOString(),
    attempts: 23,
    reported: false,
  };
  const rig = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, pullRequestGap: gap },
    pullRequestsUnavailable: "command-failed",
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  const carded = rig.cards.find((entry) => entry.card.kind === "source-unreadable");
  expect(carded?.card.ref).toBe("seat-tick-source-pull-requests");
  expect(carded?.card.detail).toContain("command-failed, 24 attempt(s)");
  expect(rig.written.at(-1)!.pullRequestGap).toMatchObject({ reported: true, attempts: 24, since: gap.since });

  /* And the next check says nothing further: one card per outage, whatever the
     tick then does about it. */
  const again = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...rig.written.at(-1)!, ...OVERDUE },
    pullRequestsUnavailable: "command-failed",
  });
  await runSeatTickCheck(PROJECT, again.deps);
  expect(again.cards.filter((entry) => entry.card.kind === "source-unreadable")).toEqual([]);
});

/* The report is remembered only once it EXISTS (#1298). The controller catches
   a failed card write on purpose — one board file nobody can write is not a
   reason to stop ticking — and the row it then persisted said the operator had
   been told. That suppressed the one report the outage owes for as long as the
   outage lasted, which is the whole failure this card was added to end. */
test("a card write that fails leaves the outage unreported, and the next check reports it", async () => {
  const gap = standingGap();
  const blocked = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, pullRequestGap: gap },
    pullRequestsUnavailable: "command-failed",
    cardWrite: "throws",
  });
  await runSeatTickCheck(PROJECT, blocked.deps);
  /* The card was attempted and the check carried on — the wake still went out
     over the reason that does not rest on the failed source. */
  expect(blocked.cards.filter((entry) => entry.card.kind === "source-unreadable")).toHaveLength(1);
  expect(blocked.sent).toHaveLength(1);
  /* And the row says what is true: nobody has been told. */
  expect(blocked.written.at(-1)!.pullRequestGap).toMatchObject({ reported: false, attempts: 24, since: gap.since });

  /* A board that refuses the create rather than throwing is the same fact
     arriving as a return value, and is remembered the same way. */
  const refused = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, pullRequestGap: blocked.written.at(-1)!.pullRequestGap! },
    pullRequestsUnavailable: "command-failed",
    cardWrite: "refused",
  });
  await runSeatTickCheck(PROJECT, refused.deps);
  expect(refused.written.at(-1)!.pullRequestGap).toMatchObject({ reported: false });

  /* The retry: the same outage, a board that accepts the write, and only now
     does the row remember having said it. */
  const retried = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, pullRequestGap: refused.written.at(-1)!.pullRequestGap! },
    pullRequestsUnavailable: "command-failed",
  });
  await runSeatTickCheck(PROJECT, retried.deps);
  const carded = retried.cards.find((entry) => entry.card.kind === "source-unreadable");
  expect(carded?.card.detail).toContain(`${gap.since.slice(0, 16).replace("T", " ")} UTC`);
  expect(retried.written.at(-1)!.pullRequestGap).toMatchObject({ reported: true, since: gap.since });

  /* And having been reported once, it is not reported again. */
  const settled = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, pullRequestGap: retried.written.at(-1)!.pullRequestGap! },
    pullRequestsUnavailable: "command-failed",
  });
  await runSeatTickCheck(PROJECT, settled.deps);
  expect(settled.cards.filter((entry) => entry.card.kind === "source-unreadable")).toEqual([]);
});

/* Through the real card writer, because the defect lives in the receipt rather
   than in the decision: every outage of one source shares the card's `ref`, so
   a second outage replayed the FIRST outage's create receipt and wrote nothing
   — onto a board whose first card the operator had since completed. The row
   then remembered a report that exists nowhere. */
test("a second outage of the same source is carded again after the first card was completed", async () => {
  const project = `source-outage-${crypto.randomUUID().slice(0, 8)}`;
  const tasksFile = path.join(SANDBOX, "state", "tasks.json");
  const { loadTasks } = await import("@/lib/tasks/store");
  const readCards = (): { text: string; status: string }[] => loadTasks(tasksFile)
    .filter((task) => task.project === project).map((task) => ({ text: task.text, status: task.status }));
  const lanes = [...OPEN_LANE, ...FINISHED_LANE].map((lane) => ({ ...lane, project }));
  const outage = (gap: ReturnType<typeof standingGap>) => harness({
    pipelines: lanes,
    state: { ...OVERDUE, pullRequestGap: gap },
    pullRequestsUnavailable: "command-failed",
    settings: defaultSeatTickSettings(project),
  });

  const first = outage(standingGap());
  await runSeatTickCheck(project, { ...first.deps, ensureCard: undefined });
  expect(readCards()).toHaveLength(1);
  expect(readCards()[0]!.text).toContain("Seat tick cannot read one of its evidence sources");
  expect(first.written.at(-1)!.pullRequestGap).toMatchObject({ reported: true });

  /* The operator reads it and closes it. */
  const { mutateTasks } = await import("@/lib/tasks/store");
  mutateTasks((tasks) => ({
    tasks: tasks.map((task) => task.project === project ? { ...task, status: "done" as const } : task),
    result: undefined,
  }), tasksFile);

  /* An interval later the standing source is asked again and answers, which is
     what ends the run — and leaves the next outage a run of its own. */
  const recovered = harness({
    pipelines: lanes,
    state: {
      ...OVERDUE,
      pullRequestGap: { ...first.written.at(-1)!.pullRequestGap!, lastAttemptAt: new Date(NOW - 61 * MINUTE).toISOString() },
    },
    openPullRequests: [],
    settings: defaultSeatTickSettings(project),
  });
  await runSeatTickCheck(project, { ...recovered.deps, ensureCard: undefined });
  expect(recovered.written.at(-1)!.pullRequestGap).toBeNull();
  expect(readCards().map((card) => card.status)).toEqual(["done"]);

  /* And the second outage is put in front of the operator, rather than
     replaying the receipt of a card they have already dealt with. */
  const second = standingGap({ since: new Date(NOW - 2 * 60 * MINUTE).toISOString(), attempts: 11 });
  const later = outage(second);
  await runSeatTickCheck(project, { ...later.deps, ensureCard: undefined });
  const cards = readCards();
  expect(cards).toHaveLength(2);
  const open = cards.filter((card) => card.status !== "done");
  expect(open).toHaveLength(1);
  expect(open[0]!.text).toContain(`${second.since.slice(0, 16).replace("T", " ")} UTC`);
  expect(later.written.at(-1)!.pullRequestGap).toMatchObject({ reported: true, since: second.since });
});

/* The other edge of that table, through the same seam. Exactly the empty array
   is the answer a check may go quiet on, so the refusal above must not grow
   into refusing it: a parse that read `[]` as output nobody can attribute
   would leave every project whose pull requests have all merged in a permanent
   error, which is the same confusion of an answer with a failure, running the
   other way. */
test("the empty array is the one gh answer that still earns quiet", async () => {
  const rig = harness({
    pipelines: FINISHED_LANE,
    tasks: [{ id: "task_b2", status: "inbox" }],
    state: OVERDUE,
    githubRun: async () => "[]",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet", detail: "no eligible interval agenda: unparented workers and inbox cards alone do not qualify" });
  expect(rig.sent).toEqual([]);
  /* And the row records the quiet, which is the claim an error never makes. */
  expect(rig.written.at(-1)!.quietSince).toBe(new Date(NOW).toISOString());

  /* One usable row beside it, off the same seam and the same parse: the answer
     that is not empty wakes, so the quiet above came from the answer and not
     from a seam that had stopped reporting anything. */
  const open = harness({
    pipelines: FINISHED_LANE,
    tasks: [{ id: "task_b2", status: "inbox" }],
    state: OVERDUE,
    githubRun: async () => JSON.stringify([
      { number: 1289, title: "wake on a merge that is waiting", headRefName: "topic-merge-queue", createdAt: FINISHED_PR_CREATED, updatedAt: "2026-08-28T11:30:00.000Z" },
    ]),
  });
  expect(await runSeatTickCheck(PROJECT, open.deps)).toMatchObject({ verdict: "wake", reasons: ["unmerged-pr"] });
  expect(open.sent[0]!.text).toContain("pull request #1289 left open by a lane that finished");
});

/* The incident's own failure mode (#1465): a send the delivery layer refuses
   before reserving anything — the 409 when the seat cannot be resumed, the 503
   when no host owns it — leaves no record under the key and no operation to
   ask. The attempt is kept under its key, and the next check re-dispatches the
   SAME frozen payload under the SAME key: a same-identity recovery the layer's
   per-key reservation keeps from ever producing a second copy (proved below
   against the real registry), never a replacement. Kept without that, the
   attempt deferred every later wake behind it for ever. Every case asks the
   PRODUCTION `wakeState` over the isolated registry. */
test("a send the layer refused without a record is re-dispatched under its original key by the next check (#1465)", async () => {
  for (const refusal of [
    { ok: false as const, outcome: "failed" as const, error: "the conversation cannot be resumed", status: 409 },
    { ok: false as const, outcome: "failed" as const, error: "structured delivery ownership is unavailable", status: 503 },
  ]) {
    const fixture = childFixture(`refused-${refusal.status}`);
    setAgentRegistryForTests(fixture.registry);
    const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
    fixture.seed();
    const rig = childRig(fixture, { realWakeState: true, delivery: refusal });
    const record = await runSeatTickCheck(fixture.project, rig.deps);
    expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "failed" } });
    expect(rig.sent).toHaveLength(1);
    expect(rig.journal.map((line) => line.verdict)).toEqual(["wake"]);
    /* Kept under its key with its frozen payload; nothing credited, no stamp. */
    const outstanding = fixture.row().outstandingWake!;
    expect(outstanding).toMatchObject({ clientMessageId: record!.delivery!.clientMessageId, operationId: null, text: rig.sent[0]!.text, preparedAt: new Date(fixture.now).toISOString() });
    expect(fixture.row()).toMatchObject({ lastWakeAt: ago(fixture, 61), harvestedChildren: [] });
    expect(fixture.acknowledged()).toEqual([]);
    expect(rig.cards).toEqual([]);

    /* The next check: the record affirms it holds nothing under the key, so the
       same payload goes out under the same key — and lands on the ORIGINAL plan. */
    const next = childRig(fixture, { realWakeState: true, now: fixture.now + 5 * MINUTE, deliverWith: async (message) => {
      fixture.registry.holdDelivery(message.conversationId as never, message.text, message.clientMessageId, "text", [], null, {});
      return { ok: true, target: "structured", outcome: "delivered", structured: true };
    } });
    const retried = await runSeatTickCheck(fixture.project, next.deps);
    expect(next.sent).toHaveLength(1);
    expect(next.sent[0]).toMatchObject({ clientMessageId: outstanding.clientMessageId, text: outstanding.text, conversationId: fixture.seat.conversationId });
    expect(next.journal[0]).toMatchObject({ verdict: "landed", delivery: { clientMessageId: outstanding.clientMessageId, outcome: "landed" } });
    expect(next.journal[0]!.detail).toContain("re-dispatched under its original key");
    expect(fixture.row()).toMatchObject({ outstandingWake: null, lastWakeAt: new Date(fixture.now + 5 * MINUTE).toISOString() });
    expect(fixture.acknowledged()).toEqual([child.id]);
    /* And the check itself, its landing credited, has nothing else to raise. */
    expect(retried).toMatchObject({ verdict: "quiet" });
    setAgentRegistryForTests(null);
  }
});

/* The recovery above is safe only because the delivery layer reserves one
   delivery per key. This proves that contract against the real registry, for
   every state the first attempt can be in when the same key comes back with
   the same payload: nothing here ever creates a second reservation, and a
   changed payload under a live key is refused outright. */
test("the delivery layer holds one reservation per client message id, whatever became of the first attempt (#1465)", () => {
  const fixture = childFixture("same-key-contract");
  const seat = fixture.seat.conversationId as never;
  const rows = () => Object.values(fixture.registry.readOnlySnapshot().heldDeliveries);
  const hold = (key: string, text = "wake text", operation = {}) => fixture.registry.holdDelivery(seat, text, key, "text", [], null, operation);

  /* In flight: the same key replays the same reservation. */
  const first = hold("seat-tick:contract:1");
  expect(hold("seat-tick:contract:1")).toMatchObject({ id: first.id, state: first.state });
  expect(rows().filter((row) => row.clientMessageId === "seat-tick:contract:1")).toHaveLength(1);
  /* A changed payload under a live key is refused, never delivered beside it. */
  expect(() => hold("seat-tick:contract:1", "a different wake")).toThrow();

  /* Delivered: the same key answers with the delivered record. */
  const delivered = hold("seat-tick:contract:2", "wake text", { operationId: "op-contract-2", kind: "send", policy: "queue" });
  fixture.registry.recordDeliveryOutcome(delivered.id, "delivered", null, "delivered");
  expect(hold("seat-tick:contract:2", "wake text", { operationId: "op-contract-2", kind: "send", policy: "queue" })).toMatchObject({ id: delivered.id, state: "delivered" });
  expect(rows().filter((row) => row.clientMessageId === "seat-tick:contract:2")).toHaveLength(1);

  /* Ended unverified — the host took it and died: the same key is absorbed by
     the record that may have arrived, and nothing is re-armed. */
  const unverified = hold("seat-tick:contract:3", "wake text", { operationId: "op-contract-3", kind: "send", policy: "queue" });
  fixture.registry.recordDeliveryOutcome(unverified.id, "failed", "the host took it and died", "unverified");
  expect(hold("seat-tick:contract:3", "wake text", { operationId: "op-contract-3", kind: "send", policy: "queue" })).toMatchObject({ id: unverified.id, state: "failed" });
  expect(rows().filter((row) => row.clientMessageId === "seat-tick:contract:3")).toHaveLength(1);

  /* Proven lost — fenced before actuation: the same key re-arms the same
     reservation rather than adding one. */
  const lost = hold("seat-tick:contract:4", "wake text", { operationId: "op-contract-4", kind: "send", policy: "queue" });
  fixture.registry.recordDeliveryOutcome(lost.id, "failed", "fenced before actuation", "lost");
  expect(hold("seat-tick:contract:4", "wake text", { operationId: "op-contract-4", kind: "send", policy: "queue" })).toMatchObject({ id: lost.id, state: "assigned" });
  expect(rows().filter((row) => row.clientMessageId === "seat-tick:contract:4")).toHaveLength(1);

  /* Nothing under the key: a fresh reservation, exactly one. */
  expect(rows().filter((row) => row.clientMessageId === "seat-tick:contract:5")).toHaveLength(0);
  hold("seat-tick:contract:5");
  expect(rows().filter((row) => row.clientMessageId === "seat-tick:contract:5")).toHaveLength(1);
});

/* A refusal that began actuating, or one the record still holds, is not that
   proof: the record's answer wins and the attempt is kept. */
test("a refusal the record contradicts keeps the attempt (#1465)", async () => {
  const fixture = childFixture("refused-but-held");
  setAgentRegistryForTests(fixture.registry);
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture, {
    realWakeState: true,
    deliverWith: async (message) => {
      /* The layer reserved the key and queued the send, then answered a refusal
         the caller could not tell from a plain one. */
      fixture.registry.holdDelivery(message.conversationId as never, message.text, message.clientMessageId, "text", [], null, { operationId: "op-held-1", kind: "send", policy: "queue" });
      return { ok: false, outcome: "failed", error: "the control channel closed", status: 409 };
    },
  });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "failed" } });
  expect(fixture.row().outstandingWake).toMatchObject({ clientMessageId: record!.delivery!.clientMessageId });
  expect(rig.journal.map((line) => line.verdict)).toEqual(["wake"]);
  /* The record holds it, so the next check re-dispatches nothing. */
  const next = childRig(fixture, { realWakeState: true, now: fixture.now + 5 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, next.deps)).toMatchObject({ delivery: { clientMessageId: record!.delivery!.clientMessageId, outcome: "deferred-outstanding" } });
  expect(next.sent).toEqual([]);
});


test("autonomy overlay is full on the first landed wake, compact later, and full after rotation", async () => {
  const { applySeatTickSettingsChange } = await import("./seatTickSettings");
  const applied = applySeatTickSettingsChange(defaultSeatTickSettings(PROJECT), { autonomy: { enabled: true } }, { at: new Date(NOW).toISOString(), actor: { kind: "gateway", conversationId: null, project: null, seatEpoch: null } });
  if (!applied.ok) throw new Error(applied.error);
  const options = { pipelines: OPEN_LANE, state: OVERDUE, settings: applied.settings, now: NOW };
  const rig = harness(options);
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent[0]!.text).toContain("decide all questions, open forms and variants");
  expect(rig.written.at(-1)!.autonomyShown).toBe(`${applied.settings.autonomy!.startedAt}:${applied.settings.autonomy!.updatedAt}`);
  options.now += 61 * MINUTE;
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent[1]!.text).toContain("rules from episode");
  expect(rig.sent[1]!.text).not.toContain("decide all questions");
  rig.seat = { ...rig.seat!, conversationId: SUCCESSOR, seatEpoch: rig.seat!.seatEpoch + 1 };
  options.now += 61 * MINUTE;
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent.at(-1)!.text).toContain("decide all questions, open forms and variants");
});

test("autonomy idle gathers issues and two unchanged landed wakes stop searching", async () => {
  const { applySeatTickSettingsChange } = await import("./seatTickSettings");
  const applied = applySeatTickSettingsChange(defaultSeatTickSettings(PROJECT), { autonomy: { enabled: true } }, { at: new Date(NOW).toISOString(), actor: { kind: "gateway", conversationId: null, project: null, seatEpoch: null } });
  if (!applied.ok) throw new Error(applied.error);
  const options = { pipelines: [], settings: applied.settings, now: NOW };
  const rig = harness(options);
  for (let i = 0; i < 2; i++) {
    expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "wake", reasons: ["autonomy-idle"] });
    expect(rig.sent[i]!.text).toContain("#1245 the native seat tick");
    options.now += 61 * MINUTE;
  }
  expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "quiet" });
  expect(rig.sent).toHaveLength(2);
  expect(rig.cards.some(entry => entry.card.kind === "retry-guard")).toBe(true);
  options.now += 9 * 60 * MINUTE;
  const restarted = applySeatTickSettingsChange(options.settings, { autonomy: { enabled: true } }, { at: new Date(options.now).toISOString(), actor: { kind: "gateway", conversationId: null, project: null, seatEpoch: null } });
  if (!restarted.ok) throw new Error(restarted.error);
  options.settings = { ...restarted.settings, autonomyHistory: restarted.settings.autonomyHistory?.map(episode => ({ ...episode, reportAt: new Date(options.now).toISOString() })) };
  for (let i = 0; i < 2; i++) {
    expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "wake" });
    options.now += 61 * MINUTE;
  }
  expect(rig.sent).toHaveLength(4);
  expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "quiet" });
});

test("expiry removes the overlay and requests one end report even with wakes switched off", async () => {
  const { applySeatTickSettingsChange } = await import("./seatTickSettings");
  const at = new Date(NOW).toISOString();
  const actor = { kind: "gateway" as const, conversationId: null, project: null, seatEpoch: null };
  const on = applySeatTickSettingsChange(defaultSeatTickSettings(PROJECT), { autonomy: { enabled: true } }, { at, actor });
  if (!on.ok) throw new Error(on.error);
  const off = applySeatTickSettingsChange(on.settings, { enabled: false, reason: "Operator returned" }, { at: new Date(NOW + MINUTE).toISOString(), actor });
  if (!off.ok) throw new Error(off.error);
  const options = { pipelines: OPEN_LANE, settings: off.settings, now: NOW + MINUTE };
  const rig = harness(options);
  expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "wake", reasons: ["autonomy-ended"], items: 0 });
  expect(rig.sent[0]!.text).toContain(`key autonomy:${at}`);
  expect(rig.sent[0]!.text).not.toContain("Full autonomy until");
  options.now += MINUTE;
  expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "quiet" });
  expect(rig.sent).toHaveLength(1);
  options.settings = { ...off.settings, autonomy: { ...off.settings.autonomy!, reportAt: new Date(options.now).toISOString() } };
  options.now += 61 * MINUTE;
  expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "quiet" });
});

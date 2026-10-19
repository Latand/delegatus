import { OPEN_LANE, OVERDUE } from "./seatTickController.fixture";
import { describe, expect, test, fs, path, spawn, SANDBOX, RESTORE, SESSIONS, reconcileSeatTick, runSeatTickCheck, startSeatTick, DEFAULT_SEAT_TICK_POLICY, defaultSeatTickSettings, readSeatTickState, writeSeatTickState, FileRuntimeEventStore, statePath, AgentRegistry, setAgentRegistryForTests, emptyLaunchProfile, PROJECT, NOW, MINUTE, pipelineRecord, harness, outstandingWake, childFixture, childRig, ago, agendaOf, idleWakeRig, finishIdleWorker } from "./seatTickController.fixture";
import type { AgentLivenessRecord } from "./seatTickController.fixture";


// Real context reader, registry, seat command, board and bridge. The controller
// owns a fake clock; process launch is the only rotation effect replaced.
describe("seat auto-rotation through production seams", () => {
  const AT = "2026-10-09T03:00:00.000Z";
  const TS = Date.parse(AT);
  async function fixture(run: (f: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>, tokens: number | null = 720_000, enabled = true, history = false) {
    const previous = { LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_CLAUDE_HOME: process.env.LLV_CLAUDE_HOME, LLV_VIEWER_CONTROL_URL: process.env.LLV_VIEWER_CONTROL_URL };
    const dir = fs.mkdtempSync(path.join(SANDBOX, "auto-case-"));
    process.env.LLV_STATE_DIR = path.join(dir, "state");
    process.env.LLV_CLAUDE_HOME = path.join(dir, "legacy-claude");
    process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
    try { await run(await makeFixture(dir, tokens, enabled, history)); }
    finally {
      setAgentRegistryForTests(null);
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }
  async function makeFixture(dir: string, tokens: number | null, enabled: boolean, history: boolean) {
    const { createManagedClaudeAccount } = await import("@/lib/accounts/claude");
    const { BINDINGS_SOURCE } = await import("@/lib/accounts/accountsStore");
    const { seedAccountSource } = await import("@/lib/accounts/accountsStoreFixture");
    const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } = await import("@/lib/orchestrator/seats");
    const { executeOrchestratorRotation, productionSeatCommandDependencies } = await import("@/lib/orchestrator/seatCommand");
    const { defaultSeatTickSources } = await import("./seatTickSources");
    const { writeSeatTickSettings, readSeatTickSettings } = await import("./seatTickSettings");
    const { readBridgeReportLog } = await import("@/lib/bridge/store");
    const { loadTasks } = await import("@/lib/tasks/store");
    const account = createManagedClaudeAccount("Account A");
    fs.writeFileSync(path.join(account.home, ".credentials.json"), "{}", { mode: 0o600 });
    seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 1, bindings: [{ engine: "claude", accountId: account.id, project: PROJECT, createdAt: AT }] });
    const transcript = path.join(account.projectsDir, "fixture", `${crypto.randomUUID()}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true }); fs.writeFileSync(transcript, "");
    function appendUsage(count: number, target = transcript) {
      fs.appendFileSync(target, JSON.stringify({ type: "assistant", timestamp: AT, message: { role: "assistant", model: "opus", stop_reason: "end_turn",
        usage: { input_tokens: count, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, content: [{ type: "text", text: "Work is complete." }] } }) + "\n");
    }
    if (tokens !== null) { fs.appendFileSync(transcript, JSON.stringify({ type: "user", timestamp: AT, message: { role: "user", content: "Report the board" } }) + "\n"); appendUsage(tokens); }
    else fs.appendFileSync(transcript, JSON.stringify({ type: "user", timestamp: AT, message: { role: "user", content: "x".repeat(6 * 1024 * 1024) } }) + "\n");
    const registryPath = path.join(dir, "registry.json");
    const registry = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "sqlite" });
    registry.setEngineRouting("claude", account.id);
    const now = Date.now();
    registry.recordQuotaObservation({ engine: "claude", accountId: account.id, authenticated: true, authCheckedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), bootId: "rotation-fixture",
      limits: { session: { usedPercent: 5, resetsAt: Math.floor(now / 1000) + 3600 }, weekly: null, plan: "max", capturedAt: Math.floor(now / 1000) }, provenance: { source: "live", reason: null, staleSince: null } });
    const conversation = registry.ensureConversation("claude", transcript, null);
    let clock = TS;
    let busy = false;
    const profile = emptyLaunchProfile({ cwd: dir, model: "opus" });
    function turn(value: boolean | "unknown") {
      busy = value === true;
      registry.reconcileConversations([{ engine: "claude", path: transcript, accountId: account.id, launchProfile: profile,
        turn: { state: value === "unknown" ? "unknown" : value ? "busy" : "idle", source: value ? "tool" : "assistant", terminalAt: value ? null : new Date(clock).toISOString() }, observedAt: new Date(clock).toISOString() }]);
    }
    turn(false); setAgentRegistryForTests(registry);
    beginOrchestratorSeatIntent({ project: PROJECT, mandate: "Own the board and report results." + (history ? "\n\n## Rotation history\nPrior decisions" : ""), engine: "claude", model: "opus", clientRequestId: "seed_rotation_fixture", mode: "spawn", now: AT });
    completeOrchestratorSeatIntent({ project: PROJECT, clientRequestId: "seed_rotation_fixture", conversationId: conversation.id, path: transcript, now: AT });
    const original = orchestratorSeatFor(PROJECT).active!;
    writeSeatTickSettings(PROJECT, { ...defaultSeatTickSettings(PROJECT), monitorPrompt: "Keep reporting owed work", ...(enabled ? {
      autoRotate: { enabled: true, thresholdPercent: 60, updatedAt: AT, setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null }, why: null },
    } : {}) });
    const settingsBefore = JSON.stringify(readSeatTickSettings(PROJECT));
    let spawnStatus = 200;
    const spawns: Record<string, unknown>[] = [];
    const command: import("@/lib/orchestrator/seatCommand").SeatCommandDependencies = {
      ...productionSeatCommandDependencies,
      spawn: async body => {
        spawns.push(body);
        if (spawnStatus !== 200) return { status: spawnStatus, body: { ok: false, error: "fixture spawn refused" } };
        const successorPath = path.join(account.projectsDir, "fixture", `${crypto.randomUUID()}.jsonl`);
        fs.writeFileSync(successorPath, "");
        const successor = registry.ensureConversation("claude", successorPath, null);
        registry.reconcileConversations([{ engine: "claude", path: successorPath, accountId: account.id, launchProfile: profile,
          turn: { state: "idle", source: "assistant", terminalAt: new Date(clock).toISOString() }, observedAt: new Date(clock).toISOString() }]);
        return { status: 200, body: { ok: true, conversationId: successor.id, path: successorPath } };
      },
      now: () => new Date(clock).toISOString(),
    };
    const rig = harness({ registry, now: clock });
    const defaults = defaultSeatTickSources();
    rig.deps.sources!.seatFor = orchestratorSeatFor;
    rig.deps.sources!.settings = readSeatTickSettings;
    rig.deps.sources!.seatContextUsage = defaults.seatContextUsage;
    rig.deps.sources!.seatTurnOutcome = defaults.seatTurnOutcome;
    rig.deps.sources!.now = () => clock;
    rig.deps.sources!.liveness = async () => busy ? [{ conversationId: original.conversationId, lifecycle: "running", reason: "host_alive_turn_active", turnState: "busy" } as AgentLivenessRecord] : [];
    rig.deps.readState = readSeatTickState; rig.deps.writeState = writeSeatTickState;
    rig.deps.reconcileSeat = () => null; delete rig.deps.ensureCard;
    rig.deps.seatAutoRotation = { rotate: (body, _deps, actor, admission) => executeOrchestratorRotation(body, command, actor, admission) };
    const cards = () => loadTasks(statePath("tasks.json")).filter(t => (t.details ?? "").includes("monitor-ref: seat-auto-rotation"));
    const reports = () => readBridgeReportLog().reports;
    return { rig, original, spawns, command, settingsBefore, appendUsage, turn, cards, reports, registry, registryPath,
      active: () => orchestratorSeatFor(PROJECT).active!, settings: () => readSeatTickSettings(PROJECT), state: () => readSeatTickState(PROJECT),
      advance: (minutes: number) => { clock += minutes * MINUTE; }, refuse: (status: number) => { spawnStatus = status; },
      check: () => runSeatTickCheck(PROJECT, rig.deps), rotate: executeOrchestratorRotation };
  }
  test("idle reported usage rotates through the normal command once, preserving handoff, lineage and project settings", () => fixture(async f => {
    const record = await f.check();
    expect(f.spawns).toHaveLength(1); const successor = f.active();
    expect(successor.seatEpoch).toBe(f.original.seatEpoch + 1);
    expect(successor.predecessorConversationId).toBe(f.original.conversationId);
    expect(successor.intent.clientRequestId).toStartWith("seat-autorotate-");
    expect(successor.mandate).toContain("Own the board and report results.");
    expect(successor.mandate).toContain("conversation_messages");
    expect(successor.mandate).toContain(f.original.conversationId!);
    expect(JSON.stringify(f.settings())).toBe(f.settingsBefore);
    expect(f.cards()).toHaveLength(1); expect(f.cards()[0]!.status).toBe("done");
    expect(f.reports()).toHaveLength(1); expect(f.reports()[0]!.class).toBe("status");
    for (const text of [f.cards()[0]!.details!, f.reports()[0]!.body]) {
      expect(text).toContain("72%"); expect(text).toContain("60%"); expect(text).toContain(f.original.conversationId!); expect(text).toContain(successor.conversationId!);
    }
    // The card reads as a title and one sentence in the operator's language
    // (Ukrainian until one is chosen); ids, figures and the marker stay folded.
    expect(f.cards()[0]!.text).toBe("Оркестратора замінено\nКонтекст досяг 60%, тож справи передано новому оркестратору.");
    expect(f.cards()[0]!.details).toMatch(/\n\nmonitor-ref: seat-auto-rotation-[0-9a-f]{32}$/);
    expect(record?.detail).toContain("auto-rotation: rotated");
    for (let i = 0; i < 3; i++) { f.advance(5); await f.check(); }
    expect(f.spawns).toHaveLength(1); expect(f.cards()).toHaveLength(1); expect(f.reports()).toHaveLength(1);
  }));
  test("seat tick launches its successor through the production spawn defer without a request scope", () => fixture(async f => {
    const { productionSpawnCommandDependencies: spawn } = await import("@/lib/agent/spawnCommand");
    const { productionSeatCommandDependencies } = await import("@/lib/orchestrator/seatCommand");
    const original = { ...spawn };
    const env = { ...process.env };
    let launched = false;
    let deferredWork: Promise<void> | undefined;
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const cwd = path.dirname(f.registryPath);
    const account = { engine: "claude" as const, accountId: "rotation-test", kind: "managed" as const,
      home: path.join(cwd, "account"), transcriptRoot: path.join(cwd, "projects"), env: { NODE_ENV: "test" } };
    Object.assign(process.env, { LLV_SPAWN_TRANSPORT: "structured", LLV_STRUCTURED_HOSTS: "1", LLV_RUNTIME_EVENTS: "1", NEXT_PUBLIC_RUNTIME_UI: "1",
      LLV_RUNTIME_HOST_SOCKET: path.join(cwd, "fixture.sock") });
    Object.assign(spawn, {
      registry: () => f.registry,
      engineReadiness: () => "connected",
      assertStructuredRuntime: () => {},
      resolveHealthySpawnAccount: async () => account,
      resolveSpawnAccount: () => account,
      resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
      runtimeHostClient: () => ({}),
      defer: (work: () => Promise<void>) => original.defer(() => {
        deferredWork = work();
        return deferredWork;
      }),
      publishFilesRevision: async () => {},
      spawnStructuredConversation: async (input: Parameters<typeof spawn.spawnStructuredConversation>[0]) => {
        const successorPath = path.join(cwd, "successor.jsonl");
        fs.writeFileSync(successorPath, "");
        f.registry.settleSpawn(input.receipt.launchId, {
          key: { engine: "claude", sessionId: "rotation-successor" }, artifactPath: successorPath,
          cwd, accountId: account.accountId, launchProfile: input.receipt.launchProfile,
          status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
        });
        launched = true;
        finish();
        return { ok: true, target: null, path: successorPath, effectivePermissionMode: "default", launchId: input.receipt.launchId,
          conversationId: input.receipt.conversationId, launched: true, retrySafe: false, initialMessage: "delivered", state: "settled" };
      },
    });
    f.command.spawn = productionSeatCommandDependencies.spawn;
    f.command.engineReadiness = () => "connected";
    f.command.startBoardReport = () => {};
    f.command.stampRegistryIdentity = () => {};
    try {
      await f.check();
      expect(f.state().autoRotation?.lastAttempt).toMatchObject({ state: "rotated" });
      await finished;
      await deferredWork;
      expect(launched).toBe(true);
      expect(f.active().predecessorConversationId).toBe(f.original.conversationId);
      expect(f.active().intent.launchId).toBeTruthy();
      expect(f.active().intent.error).toBeNull();
      expect(f.registry.spawnReceiptForClientAttempt(f.active().intent.clientRequestId)?.state).toBe("completed");
      expect(f.cards().every(card => card.status === "done")).toBe(true);
    } finally {
      await deferredWork?.catch(() => {});
      Object.assign(spawn, original);
      for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
      Object.assign(process.env, env);
    }
  }));
  test("busy seat receives one steer-or-queue nudge at fifteen minutes and rotates only after the turn ends", () => fixture(async f => {
    f.turn(true);
    for (let i = 0; i < 3; i++) { await f.check(); f.advance(5); }
    expect(f.spawns).toHaveLength(0); expect(f.rig.sent).toHaveLength(0);
    await f.check(); f.advance(5); await f.check();
    const nudges = f.rig.sent.filter(m => m.clientMessageId?.startsWith("seat-autorotate-nudge-"));
    expect(nudges).toHaveLength(1); expect(nudges[0]!.policy).toBe("steer-or-queue");
    expect(f.spawns).toHaveLength(0); f.turn(false); await f.check(); expect(f.spawns).toHaveLength(1);
  }));
  test.each(["busy", "unknown"] as const)("stalled seat with %s liveness keeps authority until positive idle evidence", turnState => fixture(async f => {
    f.turn(true);
    f.rig.deps.sources!.liveness = async () => [{ conversationId: f.original.conversationId, lifecycle: "stalled", reason: "host_alive_transcript_silent", turnState } as AgentLivenessRecord];
    await f.check();
    expect(f.active().conversationId).toBe(f.original.conversationId);
    expect(f.spawns).toHaveLength(0);
    expect(f.state().autoRotation?.lastAttempt).toBeUndefined();
    f.turn(false); await f.check();
    expect(f.spawns).toHaveLength(1);
  }));
  test("a large estimate waits until the transcript reports usage", () => fixture(async f => {
    for (let i = 0; i < 3; i++) { expect((await f.check())?.detail).toContain("waiting for a provider-reported figure"); f.advance(5); }
    expect(f.spawns).toHaveLength(0); f.appendUsage(720_000); await f.check(); expect(f.spawns).toHaveLength(1);
  }, null));
  test("failures keep the incumbent, report once per epoch and retry after the persisted cooldown", () => fixture(async f => {
    f.refuse(500); await f.check();
    expect(f.active().conversationId).toBe(f.original.conversationId); expect(f.cards()).toHaveLength(1); expect(f.cards()[0]!.status).toBe("inbox");
    expect(f.cards()[0]!.text).toMatch(/^Ротація не вдалася\nПоточний оркестратор працює далі\. Наступна спроба після \d{2}:\d{2}\.$/);
    expect(f.cards()[0]!.details).toContain("fixture spawn refused"); expect(f.cards()[0]!.details).toContain(f.original.conversationId!);
    expect(f.reports()).toHaveLength(1); expect(f.reports()[0]!.class).toBe("failed");
    f.advance(59); await f.check(); expect(f.spawns).toHaveLength(1);
    // Recreate the controller dependencies over the same SQLite row.
    await runSeatTickCheck(PROJECT, { ...f.rig.deps, sources: { ...f.rig.deps.sources! } }); expect(f.spawns).toHaveLength(1);
    f.advance(1); await f.check(); expect(f.spawns).toHaveLength(2); expect(f.cards()).toHaveLength(1); expect(f.reports()).toHaveLength(1);
    f.advance(60); f.refuse(200); await f.check(); expect(f.spawns).toHaveLength(3);
    expect(f.cards()).toHaveLength(2); expect(f.cards().every(c => c.status === "done")).toBe(true);
    expect(f.reports()).toHaveLength(2); expect(f.state().autoRotation?.lastAttempt?.state).toBe("rotated");
  }));
  test.each(["usage read", "handoff digest"])("a turn starting during %s defers automatic replacement until completion", seam => fixture(async f => {
    if (seam === "usage read") {
      const read = f.rig.deps.sources!.seatContextUsage!;
      f.rig.deps.sources!.seatContextUsage = id => { f.turn(true); return read(id); };
    } else {
      f.command.summarizeHandoffs = async () => { f.turn(true); return { kind: "fallback", reason: "unavailable" }; };
    }
    await f.check();
    expect(f.active().conversationId).toBe(f.original.conversationId);
    expect(f.spawns).toHaveLength(0);
    expect(f.cards()).toHaveLength(0); expect(f.reports()).toHaveLength(0);
    expect(f.state().autoRotation?.lastAttempt?.state).toBe("pending");
    // A deferral consumes no failure or cooldown: the next idle tick retries.
    f.rig.deps.sources!.seatContextUsage = (await import("./seatTickSources")).defaultSeatTickSources().seatContextUsage;
    f.command.summarizeHandoffs = async () => ({ kind: "fallback", reason: "unavailable" });
    f.turn(false); await f.check();
    expect(f.spawns).toHaveLength(1);
    expect(f.state().autoRotation?.lastAttempt?.state).toBe("rotated");
  }, 720_000, true, seam === "handoff digest"));
  test("off by default reads no usage and keeps the ordinary controller journal identical", () => fixture(async f => {
    let reads = 0;
    f.rig.deps.sources!.seatContextUsage = () => { reads++; throw new Error("off must not read usage"); };
    const actual = await f.check(); expect(reads).toBe(0); expect(f.spawns).toHaveLength(0); expect(f.cards()).toHaveLength(0); expect(f.reports()).toHaveLength(0);
    const ordinary = harness({ seat: { conversationId: f.original.conversationId!, seatEpoch: f.original.seatEpoch, path: f.original.path }, now: TS });
    const baseline = await runSeatTickCheck(PROJECT, ordinary.deps);
    expect(actual?.detail).toBe(baseline?.detail);
  }, 860_000, false));
  test("a lost outcome write recovers the accepted key and finishes a refused card without a second rotation", () => fixture(async f => {
    let lose = true;
    f.rig.deps.writeState = (project, state) => {
      if (lose && state.autoRotation?.lastAttempt?.state === "rotated") { lose = false; throw new Error("fixture lost checkpoint"); }
      writeSeatTickState(project, state);
    };
    await f.check(); expect(f.spawns).toHaveLength(1); expect(f.state().autoRotation?.lastAttempt?.state).toBe("pending");
    f.rig.deps.ensureCard = () => false;
    await f.check(); expect(f.state().autoRotation?.lastAttempt).toMatchObject({ state: "rotated", told: { report: true, card: false } });
    expect(f.reports()).toHaveLength(1); expect(f.cards()).toHaveLength(0);
    delete f.rig.deps.ensureCard;
    await f.check(); await f.check();
    expect(f.spawns).toHaveLength(1); expect(f.reports()).toHaveLength(1); expect(f.cards()).toHaveLength(1); expect(f.cards()[0]!.status).toBe("done");
  }));
  test("wakes off withholds the busy nudge and still permits idle automatic rotation", () => fixture(async f => {
    const { writeSeatTickSettings } = await import("./seatTickSettings");
    writeSeatTickSettings(PROJECT, { ...f.settings(), enabled: false, reason: "operator paused wakes" });
    f.turn(true); await f.check(); f.advance(15); await f.check();
    expect(f.rig.sent).toHaveLength(0); expect(f.spawns).toHaveLength(0);
    f.turn(false); await f.check(); expect(f.spawns).toHaveLength(1);
  }));
  test("a provisional successor rollback is reported once and its failure card stays open until disabled", () => fixture(async f => {
    const { abandonStillbornOrchestratorSeat } = await import("@/lib/orchestrator/seats");
    const { writeSeatTickSettings } = await import("./seatTickSettings");
    f.command.spawn = async () => ({ status: 202, body: { ok: true, accepted: true, launched: false, state: "accepted", conversationId: "conversation_rotation_pending", launchId: "launch_rotation_pending" } });
    await f.check(); const key = f.active().intent.clientRequestId;
    expect(f.state().autoRotation?.lastAttempt?.state).toBe("rotated");
    const privatePath = path.join(process.env.HOME!, "private", "launch-fixture.txt");
    expect(abandonStillbornOrchestratorSeat({ project: PROJECT, clientRequestId: key, error: `fixture asynchronous launch failure ${privatePath}` })?.restored?.conversationId).toBe(f.original.conversationId);
    await f.check(); await f.check();
    expect(f.state().autoRotation?.lastAttempt?.state).toBe("failed"); expect(f.cards()).toHaveLength(1); expect(f.cards()[0]!.status).toBe("inbox");
    expect(f.reports().map(r => r.class)).toEqual(["status", "failed"]);
    expect(f.reports()[1]!.body).not.toContain(privatePath);
    writeSeatTickSettings(PROJECT, { ...f.settings(), autoRotate: { ...f.settings().autoRotate!, enabled: false } });
    await f.check(); await f.check(); expect(f.cards()[0]!.status).toBe("done");
  }));
  test("a manual rotation winning between decision and command supersedes the automatic attempt", () => fixture(async f => {
    f.rig.deps.seatAutoRotation = { rotate: async (body, _deps, actor, admission) => {
      await f.rotate({ project: PROJECT, clientRequestId: "manual_rotation_fixture", handoffNotes: "operator requested" }, f.command);
      return f.rotate(body, f.command, actor, admission);
    } };
    await f.check(); expect(f.spawns).toHaveLength(1); expect(f.state().autoRotation?.lastAttempt?.state).toBe("superseded");
    expect(f.cards()).toHaveLength(0); expect(f.reports()).toHaveLength(0);
  }));
  test("an update-held launch replays its own pending intent and key at the next safe check", () => fixture(async f => {
    const spawn = f.command.spawn;
    let held = true;
    const keys: unknown[] = [];
    f.command.spawn = async (...args) => {
      keys.push(args[0].clientAttemptId);
      if (held) return { status: 409, body: { code: "AUTO_UPDATE_DRAIN", error: "fixture update hold" } };
      return spawn(...args);
    };
    await f.check();
    expect(f.state().autoRotation?.lastAttempt?.state).toBe("pending");
    expect(f.active().conversationId).toBe(f.original.conversationId);
    expect(f.cards()).toHaveLength(0); expect(f.reports()).toHaveLength(0);
    f.advance(5); held = false; await f.check();
    expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
    expect(f.spawns).toHaveLength(1); expect(f.state().autoRotation?.lastAttempt?.state).toBe("rotated");
    expect(f.cards()).toHaveLength(1); expect(f.reports()).toHaveLength(1);
  }));
  test.each(["busy", "unknown"] as const)("an update-held attempt waits on stalled/%s before replay", turnState => fixture(async f => {
    const spawn = f.command.spawn;
    f.command.spawn = async () => ({ status: 409, body: { code: "AUTO_UPDATE_DRAIN", error: "fixture update hold" } });
    await f.check();
    const key = f.state().autoRotation!.lastAttempt!.id;
    f.command.spawn = spawn; f.turn(true);
    f.rig.deps.sources!.liveness = async () => [{ conversationId: f.original.conversationId, lifecycle: "stalled", reason: "host_alive_transcript_silent", turnState } as AgentLivenessRecord];
    await f.check();
    expect(f.spawns).toHaveLength(0); expect(f.active().conversationId).toBe(f.original.conversationId);
    expect(f.state().autoRotation?.lastAttempt).toMatchObject({ id: key, state: "pending" });
    f.turn(false); await f.check();
    expect(f.spawns).toHaveLength(1); expect(f.state().autoRotation?.lastAttempt).toMatchObject({ id: key, state: "rotated" });
  }));
  test("positive idle liveness corrects a stale busy registry turn at admission", () => fixture(async f => {
    f.turn(true);
    f.rig.deps.sources!.liveness = async () => [{ conversationId: f.original.conversationId, lifecycle: "waiting", reason: "host_alive_turn_idle", turnState: "idle" } as AgentLivenessRecord];
    await f.check();
    expect(f.spawns).toHaveLength(1); expect(f.state().autoRotation?.lastAttempt?.state).toBe("rotated");
  }));
  test("a turn starting while spawn is awaited keeps incumbent authority and reports one failed replacement", () => fixture(async f => {
    const spawn = f.command.spawn;
    f.command.spawn = async (...args) => { const result = await spawn(...args); f.turn(true); return result; };
    await f.check();
    expect(f.active().conversationId).toBe(f.original.conversationId);
    expect(f.state().autoRotation?.lastAttempt?.state).toBe("failed");
    expect(f.reports()).toHaveLength(1);
    await f.check(); expect(f.spawns).toHaveLength(1); expect(f.reports()).toHaveLength(1);
  }));
  test("panel reconciliation during spawn preserves a predecessor that started a turn", () => fixture(async f => {
    const { reconcileOrchestratorSeatLaunch } = await import("@/lib/orchestrator/seatCommand");
    const spawn = f.command.spawn;
    f.command.spawn = async (...args) => {
      const result = await spawn(...args);
      f.turn(true);
      f.command.launchSettlement = () => ({ kind: "settled", conversationId: String(result.body.conversationId), path: String(result.body.path), launchId: null });
      await reconcileOrchestratorSeatLaunch(PROJECT, f.command);
      expect(f.active().conversationId).toBe(f.original.conversationId);
      return result;
    };
    await f.check();
    expect(f.active().conversationId).toBe(f.original.conversationId);
    expect(f.state().autoRotation?.lastAttempt?.state).toBe("failed");
    expect(f.state().autoRotation?.lastAttempt?.error).toContain("busy or unknown");
    expect(f.reports()).toHaveLength(1);
    await f.check(); expect(f.spawns).toHaveLength(1); expect(f.reports()).toHaveLength(1);
  }));
  test.each(["busy", "unknown", "idle"] as const)("a fresh process reconciles a lost automatic request with a %s predecessor", state => fixture(async f => {
    const spawnSuccessor = f.command.spawn;
    let settled!: Record<string, unknown>;
    let resume!: () => void;
    let ready!: () => void;
    const launched = new Promise<void>(resolve => { ready = resolve; });
    const lostAnswer = new Promise<void>(resolve => { resume = resolve; });
    f.command.spawn = async (...args) => {
      const result = await spawnSuccessor(...args);
      settled = result.body;
      ready();
      await lostAnswer;
      return result;
    };
    // Leave only the pending checkpoint on disk, as with a request lost at launch.
    let loseOutcome = state !== "idle";
    f.rig.deps.writeState = (project, row) => {
      if (loseOutcome && row.autoRotation?.lastAttempt?.state === "failed") { loseOutcome = false; throw new Error("fixture lost outcome checkpoint"); }
      writeSeatTickState(project, row);
    };
    const checking = f.check();
    await launched;
    try {
      f.turn(state === "unknown" ? "unknown" : state === "busy");
      const child = spawn(process.execPath, ["-e", `
        const { AgentRegistry, setAgentRegistryForTests } = await import("./src/lib/agent/registry");
        const { reconcileOrchestratorSeatLaunch, productionSeatCommandDependencies } = await import("./src/lib/orchestrator/seatCommand");
        setAgentRegistryForTests(new AgentRegistry(process.env.FIXTURE_REGISTRY, undefined, undefined, { sqliteMode: "sqlite" }));
        const result = JSON.parse(process.env.FIXTURE_SETTLEMENT);
        await reconcileOrchestratorSeatLaunch("viewer", { ...productionSeatCommandDependencies,
          now: () => process.env.FIXTURE_AT,
          launchSettlement: () => ({ kind: "settled", conversationId: result.conversationId, path: result.path, launchId: null }) });
      `], { cwd: process.cwd(), env: { ...process.env, FIXTURE_REGISTRY: f.registryPath, FIXTURE_SETTLEMENT: JSON.stringify(settled), FIXTURE_AT: AT }, stdio: ["ignore", "pipe", "pipe"] });
      const errors: Buffer[] = [];
      child.stdout!.resume(); child.stderr!.on("data", data => errors.push(data));
      const exitCode = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
      expect({ exitCode, stderr: Buffer.concat(errors).toString() }).toEqual({ exitCode: 0, stderr: "" });
      expect(f.active().conversationId).toBe(state === "idle" ? String(settled.conversationId) : f.original.conversationId);
    } finally { resume(); await checking; }
    await runSeatTickCheck(PROJECT, { ...f.rig.deps, sources: { ...f.rig.deps.sources! } });
    expect(f.spawns).toHaveLength(1);
    expect(f.state().autoRotation?.lastAttempt?.state).toBe(state === "idle" ? "rotated" : "failed");
    expect(f.reports()).toHaveLength(1);
    await f.check(); expect(f.reports()).toHaveLength(1);
  }));
  test.each([
    ["turn", "rotated"], ["turn", "failed"], ["update", "rotated"], ["update", "failed"],
  ] as const)("a %s-held attempt executed after an hour keeps a full cooldown after %s, including restart", (hold, outcome) => fixture(async f => {
    const read = f.rig.deps.sources!.seatContextUsage!;
    const spawnSuccessor = f.command.spawn;
    if (hold === "turn") f.rig.deps.sources!.seatContextUsage = id => { f.turn(true); return read(id); };
    else f.command.spawn = async () => ({ status: 409, body: { code: "AUTO_UPDATE_DRAIN", error: "fixture update hold" } });
    await f.check();
    const attemptId = f.state().autoRotation!.lastAttempt!.id;
    expect(f.spawns).toHaveLength(0);
    f.rig.deps.sources!.seatContextUsage = read;
    f.command.spawn = spawnSuccessor;
    f.advance(65); f.turn(false);
    if (outcome === "failed") f.refuse(500);
    await f.check();
    expect(f.spawns).toHaveLength(1);
    expect(f.state().autoRotation?.lastAttempt).toMatchObject({ id: attemptId, state: outcome, startedAt: new Date(TS + 65 * MINUTE).toISOString() });
    if (outcome === "rotated") f.appendUsage(720_000, f.active().path!);
    f.advance(5);
    await runSeatTickCheck(PROJECT, { ...f.rig.deps, sources: { ...f.rig.deps.sources! } });
    expect(f.spawns).toHaveLength(1);
    const retryAt = new Date(TS + 125 * MINUTE).toISOString();
    if (outcome === "failed") {
      expect(f.reports()[0]!.body).toContain(retryAt);
      const { seatTickSettingsAnswer, autoRotationFailureAnswer } = await import("./seatTickSettingsAnswer");
      expect(seatTickSettingsAnswer(PROJECT, false, { kind: "gateway", conversationId: null, project: null, seatEpoch: null }).autoRotate?.lastAttempt?.nextAttemptAt).toBe(retryAt);
      expect(autoRotationFailureAnswer(PROJECT).lastAttempt?.nextAttemptAt).toBe(retryAt);
    }
    const child = spawn(process.execPath, ["-e", `
      const { readSeatTickState } = await import("./src/lib/monitor/seatTickState");
      const { autoRotationStep } = await import("./src/lib/monitor/seatAutoRotation");
      const { orchestratorSeatFor } = await import("./src/lib/orchestrator/seats");
      const { readSeatTickSettings, effectiveSeatTickSettings } = await import("./src/lib/monitor/seatTickSettings");
      const now = Number(process.env.FIXTURE_NOW);
      const seat = orchestratorSeatFor("viewer").active;
      const decision = autoRotationStep({ settings: effectiveSeatTickSettings(readSeatTickSettings("viewer"), now, 3600000),
        seat: { ...seat, turn: "idle" }, pendingSeat: false, state: readSeatTickState("viewer"),
        usage: { engine: "claude", model: "opus", tokens: 720000, windowTokens: 1000000, estimated: false },
        now, drainHeld: false, authIncidentOpen: false });
      console.log(JSON.stringify({ kind: decision.kind, detail: decision.detail }));
    `], { cwd: process.cwd(), env: { ...process.env, FIXTURE_NOW: String(TS + 70 * MINUTE) }, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout!.on("data", data => stdout.push(data)); child.stderr!.on("data", data => stderr.push(data));
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    expect({ code, stderr: Buffer.concat(stderr).toString() }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(Buffer.concat(stdout).toString())).toEqual({ kind: "wait", detail: `cooldown until ${retryAt}` });
    f.advance(54); await f.check(); expect(f.spawns).toHaveLength(1);
    f.advance(1); await f.check(); expect(f.spawns).toHaveLength(2);
  }));
});

test("a new terminal child wakes an idle seat on its first check despite a recent wake (#2346)", async () => {
  for (const checkMinutes of [5, 1]) {
    const f = childFixture("first-check");
    let clock = f.now;
    const child = f.spawn({ title: "worker", turn: "busy", host: "live" });
    f.seed({ lastWakeAt: new Date(clock + MINUTE).toISOString() });
    clock += 2 * MINUTE;
    finishIdleWorker(f, child, clock);
    const finishedAt = clock;
    clock += (checkMinutes === 5 ? 3 : 1) * MINUTE;
    const rig = idleWakeRig(f, () => clock);
    rig.deps.policy = { ...DEFAULT_SEAT_TICK_POLICY, checkIntervalMs: checkMinutes * MINUTE };
    const record = await runSeatTickCheck(f.project, rig.deps);
    expect(record!.verdict).toBe("wake");
    expect(record!.reasons).toContain("child-terminal");
    expect(clock - finishedAt).toBeLessThanOrEqual(checkMinutes * MINUTE);
    expect(f.acknowledged()).toEqual([child.id]);
    clock += checkMinutes * MINUTE;
    expect((await runSeatTickCheck(f.project, rig.deps))!.reasons).not.toContain("child-terminal");
  }
});


test("an idle seat keeps its five-minute cadence for unchanged running children and lanes (#2346)", async () => {
  for (const work of ["child", "lane"] as const) {
    const f = childFixture(`cadence-${work}`);
    let clock = f.now;
    const child = work === "child" ? f.spawn({ title: "worker", turn: "busy", host: "live" }) : null;
    f.seed();
    const rig = idleWakeRig(f, () => clock);
    if (child) rig.deps.sources!.liveness = async ({ conversationId }) => conversationId === child.id
      ? [{ conversationId, lifecycle: "running", reason: "host_alive_turn_active", turnState: "busy" } as never] : [];
    else rig.deps.sources!.pipelines = () => [pipelineRecord({ id: "running-lane", project: f.project,
      state: "running", createdAt: new Date(f.now - MINUTE).toISOString(), movedAt: null })] as never;
    for (let check = 0; check < 6; check++) {
      const record = await runSeatTickCheck(f.project, rig.deps);
      expect(record!.verdict).toBe("wake");
      expect(record!.reasons).toContain("interval");
      expect(rig.sent.at(-1)!.text).toContain(work === "child" ? "worker" : "running-lane");
      expect(f.row().outstandingWake).toBeNull();
      clock += 5 * MINUTE;
    }
    expect(rig.cards.filter(entry => entry.card.kind === "retry-guard")).toEqual([]);
    expect(f.acknowledged()).toEqual([]);
  }
});


test("quiet unparented and cold-inbox work explains interval eligibility in settings and the board (#2346)", async () => {
  const { seatTickSettingsAnswer } = await import("./seatTickSettingsAnswer");
  for (const work of ["unparented", "inbox"] as const) {
    const f = childFixture(`excluded-${work}`);
    const clock = f.now;
    if (work === "unparented") f.spawn({ title: "unparented worker", turn: "busy", host: "live", parent: null });
    f.seed();
    const rig = idleWakeRig(f, () => clock);
    const settings = { ...defaultSeatTickSettings(f.project), wakeIntervalMinutes: 5, reason: "work check", updatedAt: new Date(clock).toISOString() };
    rig.deps.sources!.settings = () => settings;
    if (work === "inbox") rig.deps.sources!.tasks = () => [{ id: "cold-card", project: f.project, status: "inbox",
      text: "operator triage", placement: "unplaced", assignments: [], createdAt: new Date(clock).toISOString(),
      updatedAt: new Date(clock).toISOString() }] as never;
    const record = await runSeatTickCheck(f.project, rig.deps);
    expect(record!.verdict).toBe("quiet");
    expect(rig.sent).toEqual([]);
    expect(record!.detail).toContain("no eligible interval agenda");
    const answer = seatTickSettingsAnswer(f.project, false, { kind: "operator" } as never, {
      now: () => clock, settings: () => settings, readState: () => f.row(), records: () => rig.journal,
      policy: () => DEFAULT_SEAT_TICK_POLICY,
    });
    expect(JSON.stringify(answer)).toContain("unparented workers");
    expect(answer.cardText).toMatch(/unparented workers|без батьківського зв’язку/);
  }
});


test("a read and acted-on child is described by delivered-wake acknowledgement (#2346)", async () => {
  const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
  const f = childFixture("handled-outcome");
  let clock = f.now;
  const child = f.spawn({ title: "worker", turn: "busy", host: "live" });
  clock += MINUTE;
  finishIdleWorker(f, child, clock);
  f.seed();
  setAgentRegistryForTests(f.registry);
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
  f.spawn({ title: "follow-up after passing review", turn: "busy", host: "live" });
  expect(f.acknowledged()).toEqual([]);
  const rig = idleWakeRig(f, () => clock);
  expect((await runSeatTickCheck(f.project, rig.deps))!.reasons).toContain("child-terminal");
  expect(rig.sent[0]!.text).not.toContain("outcome unharvested");
  expect(rig.sent[0]!.text).toContain("not yet announced by a delivered seat-tick wake");
  expect(rig.sent[0]!.text).toContain("Reading the transcript alone does not acknowledge");
  expect(f.acknowledged()).toContain(child.id);
  clock += 5 * MINUTE;
  expect((await runSeatTickCheck(f.project, rig.deps))!.reasons).not.toContain("child-terminal");
});


test("a deploy admitted before a lost reply still wakes its idle seat exactly once (#2346)", async () => {
  const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
  const { seatDeploymentsFor } = await import("@/lib/orchestrator/seatDeployments");
  const f = childFixture("lost-deploy-reply");
  let clock = f.now;
  f.seed();
  const rig = idleWakeRig(f, () => clock);
  const revision = "a".repeat(40);
  const key = `lost-reply-${crypto.randomUUID()}`;
  let admissions = 0;
  const status = { deploymentId: `deploy-${crypto.randomUUID()}`, idempotencyKey: key,
    requestedRevision: revision, revision, phase: "building", terminal: false,
    error: null, updatedAt: new Date(clock).toISOString() };
  const binding = viewerMcpBindings(undefined, { post: async () => {
    admissions++;
    throw new Error("Viewer control did not reconnect after 2 attempts");
  } }, {
    callerAttribution: () => ({ kind: "manager", conversationId: f.seat.conversationId, role: null }),
    callerProject: () => f.project, viewerProjects: () => [f.project],
    authorizedSeats: () => [{ ...f.seat, project: f.project }],
    findDeploymentByIdempotencyKey: async (originalKey: string) => {
      expect(originalKey).toBe(key);
      return status;
    },
  } as never);
  await expect(binding.deploy_exact_sha({ revision, clientRequestId: key })).rejects.toThrow("Viewer control did not reconnect");
  status.phase = "succeeded";
  status.terminal = true;
  clock += MINUTE;
  rig.deps.sources!.seatDeployments = seatDeploymentsFor;
  rig.deps.sources!.deployment = () => ({ state: "ok", value: status }) as never;
  const record = await runSeatTickCheck(f.project, rig.deps);
  expect(record!.reasons).toContain("deploy-settled");
  expect(rig.sent).toHaveLength(1);
  clock += 5 * MINUTE;
  expect((await runSeatTickCheck(f.project, rig.deps))!.reasons).not.toContain("deploy-settled");
  expect(admissions).toBe(1);
});


test("a matching busy deploy records its seat and delivers the deploy-settled wake once", async () => {
  const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
  const { seatDeploymentsFor } = await import("@/lib/orchestrator/seatDeployments");
  const f = childFixture("matching-busy-deploy");
  let clock = f.now;
  f.seed();
  const rig = idleWakeRig(f, () => clock);
  const revision = "e".repeat(40);
  const status = { deploymentId: "same-sha-building", revision, phase: "building", terminal: false,
    error: null, updatedAt: new Date(clock).toISOString() };
  const binding = viewerMcpBindings(undefined, { post: async () => ({
    state: "busy", deploymentId: status.deploymentId, revision,
  }) }, {
    callerAttribution: () => ({ kind: "manager", conversationId: f.seat.conversationId, role: null }),
    callerProject: () => f.project, viewerProjects: () => [f.project],
    authorizedSeats: () => [{ ...f.seat, project: f.project }],
  } as never);
  expect(await binding.deploy_exact_sha({ revision, clientRequestId: "join-same-sha" }))
    .toMatchObject({ state: "accepted", deploymentId: status.deploymentId, wakeOnSettle: true });
  rig.deps.sources!.seatDeployments = seatDeploymentsFor;
  rig.deps.sources!.deployment = () => ({ state: "ok", value: status }) as never;
  status.phase = "succeeded";
  status.terminal = true;
  clock += MINUTE;
  expect((await runSeatTickCheck(f.project, rig.deps))!.reasons).toContain("deploy-settled");
  expect(rig.sent).toHaveLength(1);
  clock += 5 * MINUTE;
  expect((await runSeatTickCheck(f.project, rig.deps))!.reasons).not.toContain("deploy-settled");
  expect(rig.sent).toHaveLength(1);
});

test("a fresh controller recovers pending original-key deployments without borrowing another admission (#2346)", async () => {
  const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
  const { seatDeploymentsFor } = await import("@/lib/orchestrator/seatDeployments");
  for (const reply of ["lost", "busy", "refused"] as const) {
    const f = childFixture(`pending-deploy-${reply}`);
    let clock = f.now;
    f.seed();
    idleWakeRig(f, () => clock);
    const revision = "b".repeat(40);
    const key = `pending-${crypto.randomUUID()}`;
    const status = { deploymentId: `deploy-${crypto.randomUUID()}`, idempotencyKey: key,
      requestedRevision: revision, revision, phase: "succeeded", terminal: true,
      error: null, updatedAt: new Date(clock).toISOString() };
    let admissions = 0;
    const binding = viewerMcpBindings(undefined, { post: async () => {
      admissions++;
      if (reply === "lost") throw new Error("Viewer control did not reconnect");
      return { state: reply, deploymentId: status.deploymentId, revision: reply === "busy" ? "c".repeat(40) : revision };
    } }, {
      callerAttribution: () => ({ kind: "manager", conversationId: f.seat.conversationId, role: null }),
      callerProject: () => f.project, viewerProjects: () => [f.project],
      authorizedSeats: () => [{ ...f.seat, project: f.project }],
      findDeploymentByIdempotencyKey: async () => { throw new Error("lookup unavailable"); },
    } as never);
    if (reply === "lost") await expect(binding.deploy_exact_sha({ revision, clientRequestId: key })).rejects.toThrow("did not reconnect");
    else expect((await binding.deploy_exact_sha({ revision, clientRequestId: key })).wakeOnSettle).toBe(false);
    expect(seatDeploymentsFor(f.seat.conversationId)).toEqual([]);
    const fresh = idleWakeRig(f, () => clock);
    fresh.deps.sources!.seatDeployments = seatDeploymentsFor;
    fresh.deps.sources!.deployment = () => ({ state: "ok", value: status }) as never;
    for (const lookup of ["unavailable", "unknown", "different-key", "different-sha", "accepted"] as const) {
      fresh.deps.sources!.deploymentByKey = async originalKey => {
        expect(originalKey).toBe(key);
        if (lookup === "unavailable") throw new Error("ledger offline");
        if (lookup === "unknown") return null;
        return { ...status, idempotencyKey: lookup === "different-key" ? "another-request" : key,
          requestedRevision: lookup === "different-sha" ? "c".repeat(40) : revision } as never;
      };
      const result = await runSeatTickCheck(f.project, fresh.deps);
      if (reply === "lost" && lookup === "accepted") expect(result!.reasons).toContain("deploy-settled");
      else expect(result!.reasons).not.toContain("deploy-settled");
      clock += 5 * MINUTE;
    }
    const other = childFixture("foreign-seat");
    other.seed();
    const foreign = idleWakeRig(other, () => clock);
    foreign.deps.sources!.seatDeployments = seatDeploymentsFor;
    foreign.deps.sources!.deploymentByKey = async () => status as never;
    foreign.deps.sources!.deployment = () => ({ state: "ok", value: status }) as never;
    expect((await runSeatTickCheck(other.project, foreign.deps))!.reasons).not.toContain("deploy-settled");
    const restarted = idleWakeRig(f, () => clock);
    restarted.deps.sources!.seatDeployments = seatDeploymentsFor;
    restarted.deps.sources!.deploymentByKey = async () => status as never;
    restarted.deps.sources!.deployment = () => ({ state: "ok", value: status }) as never;
    expect((await runSeatTickCheck(f.project, restarted.deps))!.reasons).not.toContain("deploy-settled");
    expect(f.row().announcedDeploys ?? []).toEqual(reply === "lost" ? [status.deploymentId] : []);
    expect(fresh.sent).toHaveLength(reply === "lost" ? 1 : 0);
    expect(admissions).toBe(1);
  }
});


test("the independent timer delivers a finished child while the seat has no operator turns (#2346)", async () => {
  const { seatTickIdle } = await import("./seatTickController");
  const f = childFixture("idle-timer");
  let clock = f.now;
  const child = f.spawn({ title: "worker", turn: "busy", host: "live" });
  f.seed();
  const rig = idleWakeRig(f, () => clock);
  rig.deps.sources!.activeSeats = () => [f.project];
  rig.deps.ownsTraffic = () => true;
  rig.deps.recordSuccessions = () => [];
  rig.deps.sources!.liveness = async ({ conversationId }) => conversationId === child.id
    ? [{ conversationId, lifecycle: "running", reason: "host_alive_turn_active", turnState: "busy" } as never] : [];
  let callback!: () => void;
  let interval = 0;
  const drainSweep = async () => {
    for (let count = 0; !seatTickIdle() && count < 1000; count++) await new Promise<void>(resolve => setImmediate(resolve));
    expect(seatTickIdle()).toBe(true);
  };
  expect(startSeatTick({ policy: DEFAULT_SEAT_TICK_POLICY, recordSuccessions: () => [],
    handoffHeld: () => false, drainHeld: () => false,
    scheduleInterval: (run, delay) => { callback = run; interval = delay; return setInterval(() => {}, 1_000_000_000); },
    sweep: () => reconcileSeatTick(rig.deps), log: () => {},
  })).toBe(true);
  await drainSweep();
  expect(rig.sent).toHaveLength(1);
  const wakeAt = clock;
  clock += MINUTE;
  finishIdleWorker(f, child, clock);
  clock = wakeAt + interval;
  callback();
  await drainSweep();
  expect(rig.sent).toHaveLength(2);
  expect(rig.journal.at(-1)!.reasons).toContain("child-terminal");
});


test("delivered task obligations cannot hide a running child's recurring interval (#2346)", async () => {
  const f = childFixture("mixed-cadence");
  let clock = f.now;
  const child = f.spawn({ title: "worker", turn: "busy", host: "live" });
  f.seed();
  const rig = idleWakeRig(f, () => clock);
  rig.deps.sources!.liveness = async ({ conversationId }) => conversationId === child.id
    ? [{ conversationId, lifecycle: "running", reason: "host_alive_turn_active", turnState: "busy" } as never] : [];
  rig.deps.sources!.tasks = () => [{ id: "assigned-card", project: f.project, status: "assigned", text: "ready work",
    placement: "unplaced", assignments: [], createdAt: new Date(f.now).toISOString(), updatedAt: new Date(f.now).toISOString() }] as never;
  expect((await runSeatTickCheck(f.project, rig.deps))!.reasons).toContain("unstarted-task");
  for (let check = 0; check < 5; check++) {
    clock += 5 * MINUTE;
    const record = await runSeatTickCheck(f.project, rig.deps);
    expect(record!.reasons).toEqual(["interval"]);
    expect(rig.sent.at(-1)!.text).toContain("worker");
    expect(agendaOf(rig.sent.at(-1)!.text).join("\n")).not.toContain("assigned-card");
  }
});


test("recurring lane reminders leave room for lanes not yet shown (#2346)", async () => {
  const f = childFixture("cadence-pages");
  let clock = f.now;
  f.seed();
  const rig = idleWakeRig(f, () => clock);
  const lanes = Array.from({ length: 7 }, (_, i) => pipelineRecord({ id: `live-lane-${i}`, project: f.project,
    state: "running", createdAt: new Date(f.now - MINUTE).toISOString(), movedAt: null }));
  rig.deps.sources!.pipelines = () => lanes as never;
  const shown = new Set<string>();
  for (let check = 0; check < 2; check++) {
    const record = await runSeatTickCheck(f.project, rig.deps);
    expect(record!.reasons).toEqual(["interval"]);
    for (const item of agendaOf(rig.sent.at(-1)!.text)) {
      const id = /\[pipeline\] (\S+)/.exec(item)?.[1];
      if (id) shown.add(id);
    }
    clock += 5 * MINUTE;
  }
  expect(shown).toEqual(new Set(lanes.map(lane => lane.id)));
});

test("rule outcomes reach the report during a seat check without needing an operator wake", async () => {
  const rig = harness({ pipelines: [] });
  const reported: Array<{ project: string; at: string }> = [];
  rig.deps.sources!.recordRuleReports = (project, at) => { reported.push({ project, at }); };
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(reported).toEqual([{ project: PROJECT, at: new Date(NOW).toISOString() }]);
});


test.each(["closed-idle", "newer-turn", "newer-provider", "newer-prompt", "unowned-gap", "owner-mismatch", "epoch-mismatch", "cursor-ahead", "sequence-gap", "unreadable-ledger", "unknown-owner"] as const)(
  "a recovered idle writer wakes its settled deploy before timeout and once across controller restart: %s", async control => {
    const f = childFixture("recovered-deploy-seat");
    const { claudeProjectRoots } = await import("@/lib/accounts/claude");
    const isolatedRoots = [SANDBOX, path.dirname(RESTORE.HOME!)];
    const scannerRoot = claudeProjectRoots().find(root => isolatedRoots.some(isolated => root.startsWith(isolated + path.sep)));
    expect(scannerRoot).toBeDefined();
    const seatPath = path.join(scannerRoot!, path.basename(f.dir), `${crypto.randomUUID()}.jsonl`);
    fs.mkdirSync(path.dirname(seatPath), { recursive: true });
    const rooted = f.registry.ensureConversation("claude", seatPath, null);
    f.seat = { conversationId: rooted.id, seatEpoch: 7, path: seatPath };
    f.seed({ lastWakeAt: ago(f, 6) });
    setAgentRegistryForTests(f.registry);
    const { livenessProbe } = await import("@/lib/agent/accountLiveness");
    const startIdentity = livenessProbe().processIdentity(process.pid);
    expect(startIdentity).not.toBeNull();
    const sessionId = f.registry.conversation(f.seat.conversationId as never)!.generations.at(-1)!.id;
    const at = ago(f, 5);
    fs.writeFileSync(f.seat.path!, [
      { type: "assistant", uuid: "deploy-call", timestamp: at, message: { role: "assistant", content: [{ type: "tool_use", id: "deploy-tool", name: "create_pipeline", input: {} }] } },
      { type: "user", uuid: "deploy-result", timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "deploy-tool", content: "x".repeat(150 * 1024) }] } },
      // The predecessor stopped journaling; native frames continued before recovery.
      { type: "attachment", uuid: "deploy-gap-attachment", parentUuid: "deploy-result", timestamp: new Date(Date.parse(at) + 1).toISOString(), attachment: { type: "total_tokens_reminder" } },
      { type: "assistant", uuid: "deploy-gap-thinking", parentUuid: "deploy-gap-attachment", timestamp: new Date(Date.parse(at) + 2_000).toISOString(), message: { role: "assistant", content: [{ type: "thinking", thinking: "continue" }] } },
      { type: "assistant", uuid: "deploy-gap-call", parentUuid: "deploy-gap-thinking", timestamp: new Date(Date.parse(at) + 19_000).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id: "deploy-tool-two", name: "create_pipeline", input: {} }] } },
      { type: "user", uuid: "deploy-gap-result", parentUuid: "deploy-gap-call", timestamp: new Date(Date.parse(at) + 20_000).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "deploy-tool-two", content: "created" }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    f.registry.reconcileConversations([{ engine: "claude", path: f.seat.path!, accountId: null, launchProfile: emptyLaunchProfile({ cwd: f.cwd, title: "seat" }),
      turn: { state: "busy", source: "assistant", terminalAt: null }, observedAt: at }]);
    f.registry.upsert({
      key: { engine: "claude", sessionId }, artifactPath: f.seat.path!, cwd: f.cwd, accountId: null,
      status: "idle", host: null, claimEpoch: 3,
      claimOwner: `structured-host:${JSON.stringify({ pid: process.pid, startIdentity })}`, pendingAction: null,
      structuredHost: { kind: "claude-broker", endpoint: "fixture:seat", process: { pid: process.pid, startIdentity },
        writerClaimEpoch: 3, eventCursor: 5, protocolVersion: null, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    });
    const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
    ledger.append(sessionId, { kind: "turn-started", turnId: "old-turn", seq: 1 });
    ledger.append(sessionId, { kind: "item", turnId: "old-turn", phase: "completed", item: { type: "assistant", uuid: "deploy-call", timestamp: at }, seq: 2 });
    ledger.append(sessionId, { kind: "item", turnId: "old-turn", phase: "completed", item: { type: "user", uuid: "deploy-result", timestamp: at }, seq: 3 });
    ledger.append(sessionId, { kind: "turn-ended", turnId: "old-turn", status: "error", seq: 4 });
    ledger.append(sessionId, { kind: "session-status", status: "idle", seq: 5 });
    const entry = structuredClone(Object.values(f.registry.readOnlySnapshot().entries).find(row => row.artifactPath === f.seat.path)!);
    // Mutate through the actual registry so source gathering observes the fence.
    if (control === "newer-turn") { ledger.append(sessionId, { kind: "turn-started", turnId: "new-turn", seq: 6 }); entry!.structuredHost!.eventCursor = 6; }
    if (control === "newer-provider" || control === "newer-prompt") fs.appendFileSync(f.seat.path!, JSON.stringify({
      type: control === "newer-provider" ? "assistant" : "user", uuid: "later-work", parentUuid: "deploy-gap-result", timestamp: ago(f, 1),
      message: { role: control === "newer-provider" ? "assistant" : "user", content: [{ type: "text", text: "continue" }] },
    }) + "\n");
    if (control === "unowned-gap") fs.writeFileSync(f.seat.path!, fs.readFileSync(f.seat.path!, "utf8").replace('"parentUuid":"deploy-gap-thinking"', '"parentUuid":"other-turn"'));
    if (control === "owner-mismatch") entry!.claimOwner = `structured-host:${JSON.stringify({ pid: process.pid, startIdentity: "old-writer" })}`;
    if (control === "epoch-mismatch") entry!.structuredHost!.writerClaimEpoch = 2;
    if (control === "cursor-ahead") entry!.structuredHost!.eventCursor = 6;
    if (control === "unknown-owner") entry!.claimOwner = `structured-host:${JSON.stringify({ pid: process.pid, startIdentity: null })}`;
    const ledgerPath = statePath("structured-host-events", `${encodeURIComponent(sessionId)}.jsonl`);
    if (control === "sequence-gap") fs.writeFileSync(ledgerPath, fs.readFileSync(ledgerPath, "utf8").replace('"seq":3', '"seq":9'));
    if (control === "unreadable-ledger") fs.appendFileSync(ledgerPath, "invalid-record\n");
    if (control !== "closed-idle") f.registry.upsert(entry!);
    const { defaultSeatTickSources } = await import("./seatTickSources");
    const production = defaultSeatTickSources();
    const activity = await production.liveness({ reconcileStructuredIdle: true, conversationId: f.seat.conversationId,
      stallAfterMs: DEFAULT_SEAT_TICK_POLICY.stallAfterMs, limit: 1 });
    expect(activity).toHaveLength(1);
    expect(activity[0]!.turnState).toBe(control === "closed-idle" ? "idle" : "busy");
    const deploys = { seatDeployments: [{ deploymentId: "deploy-recovered", conversationId: f.seat.conversationId }],
      deployments: { "deploy-recovered": { phase: "succeeded", terminal: true, revision: "abcdef1234" } } };
    const rig = () => {
      const r = childRig(f, deploys);
      r.deps.sources!.seatDeployments = () => [{ ...deploys.seatDeployments[0]!, project: f.project, revision: "abcdef1234", requestedAt: ago(f, 10) }];
      r.deps.sources!.deployment = () => ({ state: "ok", value: { deploymentId: "deploy-recovered", error: null, updatedAt: ago(f, 2), ...deploys.deployments["deploy-recovered"] } }) as never;
      // A fresh source/controller reads the persisted gap and wake accounting.
      r.deps.sources!.liveness = defaultSeatTickSources().liveness;
      return r;
    };
    const first = rig();
    const result = await runSeatTickCheck(f.project, first.deps);
    if (control !== "closed-idle") {
      expect(result!.verdict).toBe("skipped");
      expect(first.sent).toHaveLength(0);
      expect(f.row().announcedDeploys ?? []).not.toContain("deploy-recovered");
      return;
    }
    expect(result!.verdict).toBe("wake");
    expect(result!.reasons).toContain("deploy-settled");
    expect(first.sent).toHaveLength(1);
    const restarted = rig();
    expect((await runSeatTickCheck(f.project, restarted.deps))!.reasons).not.toContain("deploy-settled");
    expect(restarted.sent).toHaveLength(0);
  },
);


test("a seat check awaits report production and retains the same ordered wake", async () => {
  const baseline = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const expected = await runSeatTickCheck(PROJECT, baseline.deps);
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  rig.deps.sources!.recordRuleReports = async () => { entered(); await held; };
  let settled = false;
  const running = runSeatTickCheck(PROJECT, rig.deps).finally(() => { settled = true; });
  await ready;
  expect(settled).toBe(false);
  expect(rig.sent).toEqual([]);
  release();
  const actual = await running;
  expect({ verdict: actual?.verdict, reasons: actual?.reasons, items: actual?.items, deferred: actual?.deferred })
    .toEqual({ verdict: expected?.verdict, reasons: expected?.reasons, items: expected?.items, deferred: expected?.deferred });
  expect(rig.sent.map(row => row.text)).toEqual(baseline.sent.map(row => row.text));
});

test("an asynchronous report failure leaves the wake unsent and records its cause", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  rig.deps.sources!.recordRuleReports = async () => { throw new Error("report source refused"); };
  expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "error", detail: expect.stringContaining("report source refused") });
  expect(rig.sent).toEqual([]);
});


test("a seat replacement during report production fences the original wake", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  rig.deps.sources!.recordRuleReports = async () => { entered(); await held; };
  const running = runSeatTickCheck(PROJECT, rig.deps);
  await ready;
  rig.seat = { ...rig.seat!, conversationId: "conversation_replacement", seatEpoch: 8 };
  release();
  await running;
  expect(rig.sent).toEqual([]);
});

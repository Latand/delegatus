import { expect, test } from "bun:test";
import { applySeatTickSettingsChange, defaultSeatTickSettings, type SeatTickSettings, type SeatTickSettingsActor, type SeatTickSettingsChange } from "./seatTickSettings";
import { TURBO_SWITCH_LIMIT, endedTurbo, type TurboAccountReading, type TurboPlanAccount, type TurboSetting } from "./turbo";
import { TURBO_ITEMS_PER_PASS, TURBO_ITEM_DEADLINE_MS, TURBO_MAX_IN_FLIGHT, TURBO_START_SPACING_MS, TurboSweep, type TurboCandidate, type TurboSweepPorts } from "./turboSweep";

const project = "turbo-sweep-fixture";
const at = "2026-10-21T12:00:00.000Z";
const hour = 3_600_000;
const operator: SeatTickSettingsActor = { kind: "gateway", project: null, conversationId: null, seatEpoch: null };
const plan: TurboPlanAccount[] = [
  { accountId: "acct-a", label: "Account A", plan: "promax", tiers: { "gpt-6.1-sol": "ultrafast", "gpt-6-luna": "priority" }, hadCredits: true },
  { accountId: "acct-b", label: "Account B", plan: "pro", tiers: { "gpt-6.1-sol": "priority" }, hadCredits: false },
];

/** A deterministic scheduler: sleeps resolve only when the test advances the clock. */
class Clock {
  t = Date.parse(at);
  private timers: Array<{ at: number; resolve: () => void }> = [];
  now = () => this.t;
  sleep = (ms: number) => new Promise<void>(resolve => { this.timers.push({ at: this.t + ms, resolve }); });
  async flush() { for (let i = 0; i < 50; i += 1) await new Promise<void>(resolve => setImmediate(resolve)); }
  async advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      await this.flush();
      this.timers.sort((left, right) => left.at - right.at);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.t = next.at;
      next.resolve();
    }
    this.t = target;
    await this.flush();
  }
}

const noCredits = (usedPercent = 10): TurboAccountReading => ({ limits: { session: { usedPercent: 5, resetsAt: null }, weekly: { usedPercent, resetsAt: null }, plan: "pro", capturedAt: null,
  credits: { hasCredits: false, balance: null, unlimited: false } }, stale: false });
const withCredits = (usedPercent: number): TurboAccountReading => ({ limits: { session: { usedPercent: 5, resetsAt: null }, weekly: { usedPercent, resetsAt: null }, plan: "promax", capturedAt: null,
  credits: { hasCredits: true, balance: "412", unlimited: false } }, stale: false });

/** The ports of a process that stopped: it can still read, and no write of its lands. */
function stopped(ports: TurboSweepPorts, flag: { dead: boolean }): TurboSweepPorts {
  return { ...ports, update: (...args) => flag.dead ? null : ports.update(...args) };
}

function world(candidates: TurboCandidate[], options: { readings?: Record<string, TurboAccountReading>; hold?: boolean } = {}) {
  const clock = new Clock();
  let row: SeatTickSettings = defaultSeatTickSettings(project);
  const change = (fields: SeatTickSettingsChange) => {
    const result = applySeatTickSettingsChange(row, fields, { actor: operator, at: new Date(clock.now()).toISOString(), turbo: { plan, allowedAccounts: ["acct-a", "acct-b"] } });
    if (!result.ok) throw new Error(result.error);
    row = result.settings;
  };
  const tiers = new Map(candidates.map(candidate => [candidate.conversationId, candidate.tier] as const));
  const live = new Set(candidates.map(candidate => candidate.conversationId));
  const calls: Array<{ conversationId: string; tier: string | null; cut: string; at: number }> = [];
  const stageCalls: Array<{ conversationId: string; tier: string | null; cut: string }> = [];
  const continued: string[] = [];
  const notices: Array<{ key: string; text: string }> = [];
  const restored: Array<{ stageId: string; from: string | null }> = [];
  const gates: Array<() => void> = [];
  let inFlight = 0; let maxInFlight = 0;
  let cut: "cut" | "armed" | "none" = "none";
  const readings = { ...(options.readings ?? {}) };
  const ports: TurboSweepPorts = {
    now: clock.now, sleep: clock.sleep,
    read: () => ({ turbo: endedTurbo(row.turbo, clock.now()), turboHistory: row.turboHistory }),
    update: (_project, startedAt, update) => {
      if (row.turbo?.startedAt === startedAt) { row = { ...row, turbo: update(row.turbo) }; return row.turbo!; }
      const index = row.turboHistory?.findIndex(item => item.startedAt === startedAt) ?? -1;
      if (index < 0) return null;
      const history = [...row.turboHistory!]; history[index] = update(history[index]!); row = { ...row, turboHistory: history };
      return history[index]!;
    },
    candidates: async () => candidates,
    liveTier: async conversationId => ({ live: live.has(conversationId), tier: tiers.get(conversationId) ?? null }),
    reading: accountId => readings[accountId] ?? noCredits(),
    setTier: async (conversationId, _operationId, tier, requested) => {
      calls.push({ conversationId, tier, cut: requested, at: clock.now() });
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (options.hold) await new Promise<void>(resolve => gates.push(resolve));
        tiers.set(conversationId, tier);
        return { cut: requested === "none" ? "none" : cut };
      } finally { inFlight -= 1; }
    },
    cutState: () => "cut",
    cancelCut: async () => {},
    continueConversation: async (conversationId, key) => { continued.push(`${conversationId}|${key}`); },
    stageTier: async (stage, tier, requested) => { stageCalls.push({ conversationId: stage.conversationId, tier, cut: requested }); tiers.set(stage.conversationId, tier); return { ok: true }; },
    stageState: async () => ({ state: "committed" }),
    restoreStageDefinition: async (stage, from) => { restored.push({ stageId: stage.stageId, from }); },
    notify: async (_project, key, text) => { notices.push({ key, text }); return { delivered: true }; },
  };
  return { clock, ports, change, calls, stageCalls, continued, notices, restored, gates, readings, live, tiers,
    row: () => row, turbo: () => row.turbo as TurboSetting, maxInFlight: () => maxInFlight, setCut: (value: typeof cut) => { cut = value; } };
}

const agent = (id: number, extra: Partial<TurboCandidate> = {}): TurboCandidate => ({ conversationId: `conversation_${id}`, accountId: "acct-a", model: "gpt-6.1-sol", tier: null, ...extra });

test("more conversations than the history limit all accelerate and return in bounded passes", async () => {
  const count = TURBO_SWITCH_LIMIT + 7;
  const w = world(Array.from({ length: count }, (_, i) => agent(i)));
  w.change({ turbo: { enabled: true } });
  let sweep = new TurboSweep(w.ports);
  const drain = async () => {
    for (let i = 0; i < Math.ceil(count / TURBO_ITEMS_PER_PASS); i += 1) {
      const before = w.calls.length;
      const pass = sweep.kick(project);
      await w.clock.advance(TURBO_ITEMS_PER_PASS * TURBO_START_SPACING_MS);
      await pass;
      expect(w.calls.length - before).toBeLessThanOrEqual(TURBO_ITEMS_PER_PASS);
    }
  };
  await drain();
  expect(w.calls).toHaveLength(count);
  expect([...w.tiers.values()].every(tier => tier === "ultrafast")).toBe(true);
  w.change({ turbo: { enabled: false } });
  sweep = new TurboSweep(w.ports);
  await drain();
  expect(w.calls).toHaveLength(count * 2);
  expect(w.calls.slice(count).every(call => call.cut === "none")).toBe(true);
  expect([...w.tiers.values()].every(tier => tier === null)).toBe(true);
  expect(w.turbo().revertedAt).toBeDefined();
});

test("a new Turbo run waits for an older return so it captures the original tier", async () => {
  const w = world([agent(1)]);
  w.ports.candidates = async () => [agent(1, { tier: w.tiers.get("conversation_1") ?? null })];
  w.change({ turbo: { enabled: true } });
  await new TurboSweep(w.ports).kick(project);
  w.change({ turbo: { enabled: false } });
  await w.clock.advance(1);
  w.change({ turbo: { enabled: true } });
  await new TurboSweep({ ...w.ports, setTier: async () => { throw new Error("return temporarily unavailable"); } }).kick(project);
  expect(w.turbo().switches).toEqual([]);
  const resumed = new TurboSweep(w.ports).kick(project);
  await w.clock.advance(10_000); await resumed;
  expect(w.turbo().switches[0]!.from).toBeNull();
  expect(w.tiers.get("conversation_1")).toBe("ultrafast");
});

test("an armed cut whose process-local receipt was lost resumes from its recorded turn evidence", async () => {
  const w = world([agent(1)]);
  w.change({ turbo: { enabled: true } });
  await new TurboSweep(w.ports).kick(project);
  w.ports.update(project, at, episode => ({ ...episode, switches: episode.switches.map(row => ({ ...row, state: "armed", cutTurnId: "turn-cut" })) }));
  const ports: TurboSweepPorts = { ...w.ports, cutState: (_operation, _conversation, turnId) => turnId === "turn-cut" ? "cut" : "unknown" };
  await new TurboSweep(ports).kick(project);
  await w.clock.flush();
  expect(w.continued).toHaveLength(1);
  expect(w.turbo().switches[0]!.state).toBe("switched");
});

test("after restart an already-continued cut returns even when its host is gone, then a new episode plans", async () => {
  const w = world([agent(1)]);
  w.change({ turbo: { enabled: true } });
  await new TurboSweep(w.ports).kick(project);
  w.ports.update(project, at, episode => ({ ...episode, switches: episode.switches.map(row => ({
    ...row, state: "switched", cutTurnId: "turn-cut",
  })) }));
  w.live.delete("conversation_1");
  w.ports.cutState = () => "unknown";
  w.ports.candidates = async () => [];
  w.change({ turbo: { enabled: false } });
  await new TurboSweep(w.ports).kick(project);
  expect(w.turbo().switches[0]!.state).toBe("reverted");
  expect(w.turbo().revertedAt).toBeDefined();

  w.change({ turbo: { enabled: true } });
  await new TurboSweep(w.ports).kick(project);
  expect(w.turbo().noticeOn?.deliveredAt).toBeDefined();
  expect(w.turbo().switches).toEqual([]);
});

test("turning Turbo off keeps an in-flight boundary cut owed until it settles, then continues once", async () => {
  const w = world([agent(1)]);
  let cutState: "armed" | "cut" = "armed";
  w.ports.setTier = async (conversationId, _operationId, tier, cut, _authorize, _expected, beforeCut) => {
    w.calls.push({ conversationId, tier, cut, at: w.clock.now() });
    w.tiers.set(conversationId, tier);
    if (cut === "boundary") await beforeCut?.("turn-cut");
    return { cut: cut === "none" ? "none" : "armed" };
  };
  w.ports.cutState = () => cutState;
  w.ports.cancelCut = async () => {};
  w.change({ turbo: { enabled: true } });
  await new TurboSweep(w.ports).kick(project);
  expect(w.turbo().switches[0]!.state).toBe("armed");
  w.change({ turbo: { enabled: false } });
  await new TurboSweep(w.ports).kick(project);
  expect(w.turbo().switches[0]!.state).toBe("reverting");
  expect(w.turbo().revertedAt).toBeUndefined();
  expect(w.continued).toHaveLength(0);
  cutState = "cut";
  await new TurboSweep(w.ports).kick(project);
  expect(w.turbo().switches[0]!.state).toBe("reverted");
  expect(w.turbo().revertedAt).toBeDefined();
  expect(w.continued).toHaveLength(1);
});

test("an offline stage returns its saved profile and definition before its next host resumes", async () => {
  const w = world([agent(1, { stage: { pipelineId: "pipeline-offline", stageId: "build", attempt: 1, definitionTier: null, switchOpen: false } })]);
  w.change({ turbo: { enabled: true } });
  await new TurboSweep(w.ports).kick(project);
  w.change({ turbo: { enabled: false } });
  const ports: TurboSweepPorts = { ...w.ports,
    liveTier: async id => ({ live: true, hosted: false, tier: w.tiers.get(id) ?? null }),
    stageTier: async () => ({ ok: false, reason: "no held native host" }),
  };
  await new TurboSweep(ports).kick(project);
  expect(w.tiers.get("conversation_1")).toBeNull();
  expect(w.calls.at(-1)?.cut).toBe("none");
  expect(w.restored).toEqual([{ stageId: "build", from: null }]);
  expect(w.turbo().switches[0]!.state).toBe("reverted");
});

test("expiry reconciles an applying switch whose tier landed before its acknowledgement was lost", async () => {
  const w = world([agent(1, { tier: "default" })]);
  w.change({ turbo: { enabled: true, hours: 1 } });
  await new TurboSweep(w.ports).kick(project);
  w.ports.update(project, at, episode => ({ ...episode, switches: episode.switches.map(row => ({ ...row, state: "applying" })) }));
  await w.clock.advance(2 * hour);
  const restarted = new TurboSweep(w.ports);
  const pass = restarted.kick(project);
  await w.clock.advance(10_000); await pass;
  expect(w.tiers.get("conversation_1")).toBe("default");
  expect(w.turbo().switches[0]!.state).toBe("reverted");
});

test("a refused revert stays pending across restart and is retried without interrupting", async () => {
  const w = world([agent(1)]);
  w.change({ turbo: { enabled: true } });
  await new TurboSweep(w.ports).kick(project);
  w.change({ turbo: { enabled: false } });
  await new TurboSweep({ ...w.ports, setTier: async () => { throw new Error("host temporarily unavailable"); } }).kick(project);
  expect(w.turbo().switches[0]!.state).toBe("reverting");
  expect(w.turbo().revertedAt).toBeUndefined();
  await new TurboSweep(w.ports).kick(project);
  expect(w.tiers.get("conversation_1")).toBeNull();
  expect(w.calls.at(-1)!.cut).toBe("none");
  expect(w.turbo().revertedAt).toBeDefined();
});

test("a queued switch rechecks the credit margin after waiting for its start slot", async () => {
  const w = world([agent(1), agent(2)], { readings: { "acct-a": withCredits(50) } });
  w.change({ turbo: { enabled: true } });
  const pass = new TurboSweep(w.ports).kick(project);
  await w.clock.flush();
  expect(w.calls).toHaveLength(1);
  w.readings["acct-a"] = withCredits(91);
  await w.clock.advance(10_000); await pass;
  expect(w.calls.filter(call => call.cut !== "none")).toHaveLength(1);
});

test("the native echoed tier is tracked so off still restores the original speed", async () => {
  const w = world([agent(1, { tier: "default" })]);
  const ports = { ...w.ports, setTier: async (id: string, _operation: string, tier: string | null, cut: "boundary" | "none") => {
    const appliedTier = cut === "boundary" ? "priority" : tier;
    w.tiers.set(id, appliedTier);
    return { cut: "none" as const, appliedTier };
  } };
  const sweep = new TurboSweep(ports);
  w.change({ turbo: { enabled: true } });
  await sweep.kick(project);
  expect(w.turbo().switches[0]!.appliedTier).toBe("priority");
  w.change({ turbo: { enabled: false } });
  const returned = sweep.kick(project);
  await w.clock.advance(10_000); await returned;
  expect(w.tiers.get("conversation_1")).toBe("default");
});

test("a settings write that waits for admission rechecks expiry before native dispatch", async () => {
  const w = world([agent(1)]);
  w.change({ turbo: { enabled: true } });
  const update = w.ports.update;
  const sweep = new TurboSweep({ ...w.ports, update: async (...args) => {
    const result = await update(...args);
    if (result?.switches.some(row => row.state === "applying")) w.change({ turbo: { enabled: false } });
    return result;
  } });
  await sweep.kick(project);
  expect(w.calls).toHaveLength(0);
});

test("switches run off the request path: never more than 3 in flight, at least 2 s apart, idle first; one seat notice", async () => {
  const w = world(Array.from({ length: 8 }, (_, i) => agent(i, { busy: i % 2 === 0 })), { hold: true });
  w.change({ turbo: { enabled: true } });
  const sweep = new TurboSweep(w.ports);
  const pass = sweep.kick(project);
  for (let round = 0; round < 12; round += 1) {
    await w.clock.advance(TURBO_START_SPACING_MS);
    while (w.gates.length) w.gates.shift()!();
  }
  await w.clock.advance(TURBO_START_SPACING_MS);
  await pass;
  expect(w.maxInFlight()).toBeLessThanOrEqual(TURBO_MAX_IN_FLIGHT);
  const starts = w.calls.map(call => call.at);
  for (let i = 1; i < starts.length; i += 1) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(TURBO_START_SPACING_MS);
  expect(w.calls).toHaveLength(8);
  expect(w.calls.map(call => Number(call.conversationId.split("_")[1]) % 2)).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
  expect(w.calls.every(call => call.tier === "ultrafast" && call.cut === "boundary")).toBe(true);
  expect(w.turbo().switches.every(row => row.state === "switched")).toBe(true);
  expect(w.notices).toHaveLength(1);
  expect(w.notices[0]!.key).toBe(`turbo:${at}:on`);
  expect(w.notices[0]!.text).toContain("Switching 8 live Codex conversation(s)");
});

test("an item that does not settle within 120 s is failed «timed out», and its slot is released", async () => {
  const w = world([agent(1), agent(2)], { hold: true });
  w.change({ turbo: { enabled: true } });
  const sweep = new TurboSweep(w.ports);
  const pass = sweep.kick(project);
  await w.clock.advance(TURBO_ITEM_DEADLINE_MS + TURBO_START_SPACING_MS + 10);
  await pass;
  expect(w.turbo().switches.map(row => [row.state, row.reason])).toEqual([["failed", "timed out"], ["failed", "timed out"]]);
  expect(sweep.inFlight()).toBe(0);
});

test("every skip class is recorded with its reason; the seat changes speed without a cut; a cut turn is continued once", async () => {
  const w = world([
    agent(1, { legacy: true }),
    agent(2, { accountId: "acct-z" }),
    agent(3, { model: "gpt-daybreak-blue-latest" }),
    agent(4, { stage: { pipelineId: "p", stageId: "s", attempt: 1, definitionTier: null, switchOpen: true } }),
    agent(5, { tier: "ultrafast" }),
    agent(6, { accountId: "acct-b", tier: "priority" }),
    agent(7, { seat: true }),
    agent(8),
  ]);
  w.setCut("cut");
  w.change({ turbo: { enabled: true } });
  const sweep = new TurboSweep(w.ports);
  const pass = sweep.kick(project);
  await w.clock.advance(10 * TURBO_START_SPACING_MS);
  await pass;
  const reasons = Object.fromEntries(w.turbo().switches.map(row => [row.conversationId, `${row.state}: ${row.reason ?? ""}`]));
  expect(reasons).toMatchObject({
    conversation_1: expect.stringContaining("skipped: legacy terminal launch"),
    conversation_2: expect.stringContaining("skipped: its account is not an allowed Codex account"),
    conversation_3: expect.stringContaining("skipped: its account offers no faster tier"),
    conversation_4: expect.stringContaining("skipped: another runtime switch is open"),
    conversation_5: expect.stringContaining("skipped: already at this speed"),
    conversation_6: expect.stringContaining("skipped: already at this speed"),
    conversation_7: expect.stringContaining("switched: seat"),
    conversation_8: "switched: ",
  });
  expect(w.calls.find(call => call.conversationId === "conversation_7")!.cut).toBe("none");
  expect(w.continued).toEqual([`conversation_8|turbo:${at}:conversation_8:continue`]);
});

test("off returns each switched conversation to its own previous tier from its next turn, cutting nothing; stages too", async () => {
  const w = world([agent(1, { tier: "default" }), agent(2, { accountId: "acct-b", tier: null }),
    agent(3, { stage: { pipelineId: "p", stageId: "build", attempt: 2, definitionTier: "priority", switchOpen: false }, tier: "priority" })]);
  w.change({ turbo: { enabled: true } });
  const sweep = new TurboSweep(w.ports);
  let pass = sweep.kick(project);
  await w.clock.advance(10 * TURBO_START_SPACING_MS); await pass;
  expect(w.stageCalls).toEqual([{ conversationId: "conversation_3", tier: "ultrafast", cut: "boundary" }]);
  w.change({ turbo: { enabled: false } });
  pass = sweep.kick(project);
  await w.clock.advance(10 * TURBO_START_SPACING_MS); await pass;
  const reverts = w.calls.filter(call => call.cut === "none");
  expect(reverts.map(call => [call.conversationId, call.tier])).toEqual([["conversation_1", "default"], ["conversation_2", null]]);
  expect(w.stageCalls.at(-1)).toEqual({ conversationId: "conversation_3", tier: "priority", cut: "none" });
  expect(w.turbo().switches.every(row => row.state === "reverted")).toBe(true);
  expect(w.turbo().revertedAt).toBeDefined();
  expect(w.notices.map(notice => notice.key)).toEqual([`turbo:${at}:on`, `turbo:${at}:off`]);
  expect(w.notices[1]!.text).toContain("put back");
  expect(sweep.pending(project)).toBe(false);
});

test("a conversation whose speed changed since, or that ended, is left alone on off; a retried stage gets its definition back", async () => {
  const w = world([agent(1), agent(2), agent(3, { stage: { pipelineId: "p", stageId: "build", attempt: 1, definitionTier: null, switchOpen: false } })]);
  w.change({ turbo: { enabled: true } });
  const sweep = new TurboSweep(w.ports);
  let pass = sweep.kick(project);
  await w.clock.advance(10 * TURBO_START_SPACING_MS); await pass;
  w.tiers.set("conversation_1", "priority");
  w.live.delete("conversation_2");
  w.live.delete("conversation_3");
  w.change({ turbo: { enabled: false } });
  pass = sweep.kick(project);
  await w.clock.advance(10 * TURBO_START_SPACING_MS); await pass;
  expect(w.calls.filter(call => call.cut === "none")).toHaveLength(0);
  expect(w.restored).toEqual([{ stageId: "build", from: null }]);
  const reasons = Object.fromEntries(w.turbo().switches.map(row => [row.conversationId, row.reason]));
  expect(reasons.conversation_1).toContain("changed since, so it is kept");
  expect(reasons.conversation_2).toContain("no longer live");
});

test("state survives a restart: applying rows are re-queued; after expiry a new process never raises and reverts instead", async () => {
  const w = world([agent(1), agent(2), agent(3)], { hold: true });
  w.change({ turbo: { enabled: true, hours: 1 } });
  const firstProcess = { dead: false };
  void new TurboSweep(stopped(w.ports, firstProcess)).kick(project);
  await w.clock.advance(TURBO_START_SPACING_MS);
  w.gates.shift()!();
  await w.clock.flush();
  // The Viewer stops here: one switched, one applying (its call lost), one queued.
  expect(w.turbo().switches.map(row => row.state)).toEqual(["switched", "applying", "queued"]);
  firstProcess.dead = true;
  const restarted = new TurboSweep({ ...w.ports, setTier: async (conversationId, operationId, tier, cut) => {
    w.calls.push({ conversationId, tier, cut, at: w.clock.now() }); w.tiers.set(conversationId, tier); return { cut: "none" }; } });
  let pass = restarted.kick(project);
  await w.clock.advance(10 * TURBO_START_SPACING_MS); await pass;
  expect(w.turbo().switches.map(row => row.state)).toEqual(["switched", "switched", "switched"]);
  expect(w.notices).toHaveLength(1);

  // Expiry while stopped: the next process reverts and raises nothing.
  const late = world([agent(1), agent(2)], { hold: true });
  late.change({ turbo: { enabled: true, hours: 1 } });
  const lateProcess = { dead: false };
  void new TurboSweep(stopped(late.ports, lateProcess)).kick(project);
  await late.clock.advance(TURBO_START_SPACING_MS);
  late.gates.shift()!();
  await late.clock.flush();
  expect(late.turbo().switches.map(row => row.state)).toEqual(["switched", "applying"]);
  lateProcess.dead = true;
  await late.clock.advance(2 * hour);
  const raisesBefore = late.calls.filter(call => call.cut !== "none").length;
  const after = new TurboSweep({ ...late.ports, setTier: async (conversationId, _operation, tier, cut) => {
    late.calls.push({ conversationId, tier, cut, at: late.clock.now() }); late.tiers.set(conversationId, tier); return { cut: "none" }; } });
  pass = after.kick(project);
  await late.clock.advance(10 * TURBO_START_SPACING_MS); await pass;
  expect(late.calls.filter(call => call.cut !== "none").length).toBe(raisesBefore);
  expect(late.turbo().switches.map(row => row.state)).toEqual(["reverted", "reverted"]);
  expect(late.notices.at(-1)!.text).toContain("Turbo ended (expired");
});

test("credit rule: without approval a credit-holding account is returned at 90 %; the approved account keeps paying", async () => {
  const w = world([agent(1), agent(2, { accountId: "acct-b" })], { readings: { "acct-a": withCredits(50), "acct-b": noCredits() } });
  w.change({ turbo: { enabled: true } });
  const sweep = new TurboSweep(w.ports);
  let pass = sweep.kick(project);
  await w.clock.advance(10 * TURBO_START_SPACING_MS); await pass;
  expect(w.turbo().switches.map(row => row.state)).toEqual(["switched", "switched"]);
  w.readings["acct-a"] = withCredits(91);
  pass = sweep.kick(project);
  await w.clock.advance(10 * TURBO_START_SPACING_MS); await pass;
  const a = w.turbo().switches.find(row => row.accountId === "acct-a")!;
  expect(a).toMatchObject({ state: "reverted" });
  expect(a.reason).toContain("91 %");
  expect(w.calls.at(-1)).toMatchObject({ conversationId: "conversation_1", tier: null, cut: "none" });
  expect(w.turbo().held?.["acct-a"]).toBeDefined();
  expect(w.turbo().switches.find(row => row.accountId === "acct-b")!.state).toBe("switched");

  const paid = world([agent(1)], { readings: { "acct-a": withCredits(50) } });
  paid.change({ turbo: { enabled: true, credits: true, creditAccounts: ["acct-a"] } });
  const paidSweep = new TurboSweep(paid.ports);
  pass = paidSweep.kick(project);
  await paid.clock.advance(10 * TURBO_START_SPACING_MS); await pass;
  paid.readings["acct-a"] = withCredits(99.5);
  pass = paidSweep.kick(project);
  await paid.clock.advance(10 * TURBO_START_SPACING_MS); await pass;
  expect(paid.turbo().switches[0]!.state).toBe("switched");
  // Withdrawing the approval returns it to the no-credit rule.
  paid.change({ turbo: { credits: false } });
  pass = paidSweep.kick(project);
  await paid.clock.advance(10 * TURBO_START_SPACING_MS); await pass;
  expect(paid.turbo().switches[0]!.state).toBe("reverted");
});

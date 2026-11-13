import { expect, test, harness, RECENT, reconcileSeatTick, startSeatTick, stopSeatTick, DEFAULT_SEAT_TICK_POLICY, spawn } from "./seatTickController.fixture";
import type { DeadlineScheduler } from "@/lib/deadline";
import { seatTickWorkDetail } from "./seatTickWork";

function virtualClock() {
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const scheduler: DeadlineScheduler = {
    setTimeout: (run, delay) => { const id = ++next; timers.set(id, { at: now + delay, run }); return id; },
    clearTimeout: handle => { timers.delete(handle as number); },
  };
  return { now: () => now, scheduler, timers, advance(delta: number) {
    now += delta;
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.run(); }
  } };
}

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test("an entirely stuck roster reaches all 17 projects within their separate budget envelope", async () => {
  const rig = harness({ state: RECENT });
  const clock = virtualClock();
  const projects = Array.from({ length: 17 }, (_, i) => `stuck-project-${String(i).padStart(2, "0")}`);
  Object.assign(rig.deps, { ownsTraffic: () => true, recordSuccessions: () => [],
    workClock: clock.now, workScheduler: clock.scheduler, workBudgetMs: 75_000,
    curation: null, release: null, maintenance: null });
  rig.deps.sources!.prepareRead = async () => { clock.advance(75_000); return new Promise<void>(() => {}); };
  const records = await reconcileSeatTick(rig.deps, projects);
  expect(records.map(row => row.project)).toEqual(projects);
  expect(records.every(row => row.verdict === "error")).toBe(true);
  expect(clock.now()).toBe(17 * 75_000);
  expect(clock.timers.size).toBe(0);
  expect(rig.sent).toHaveLength(0);
});

test("17 projects with five-second loop stalls charge only the stuck project's deadline", async () => {
  const rig = harness({ state: RECENT });
  const clock = virtualClock();
  const projects = Array.from({ length: 17 }, (_, i) => `queue-project-${String(i).padStart(2, "0")}`);
  let current = "", entered!: () => void;
  const started: { project: string; at: number }[] = [];
  Object.assign(rig.deps, { ownsTraffic: () => true, recordSuccessions: () => [],
    workClock: clock.now, workScheduler: clock.scheduler, workBudgetMs: 75_000,
    workStarted: (work: { project: string; started: number }) => {
      current = work.project; started.push({ project: work.project, at: work.started });
    }, curation: null, release: null, maintenance: null });
  rig.deps.sources!.activeSeats = () => projects;
  // prepareRead is reached after opening awaits. On the concurrent baseline,
  // all scopes already exist when these synchronous five-second stalls run.
  rig.deps.sources!.prepareRead = async () => {
    if (seatTickWorkDetail()?.startsWith(`project=${projects[0]};`)) { entered(); return new Promise<void>(() => {}); }
    clock.advance(5_000);
  };
  for (let pass = 0; pass < 3; pass++) {
    const before = clock.now();
    const stuckEntered = new Promise<void>(resolve => { entered = resolve; });
    const sweep = reconcileSeatTick(rig.deps);
    try {
      await stuckEntered;
      await turn();
      const waitingStarts = started.length;
      // Repeated resumes while the last project waits add no check or failure.
      const callbacks = [reconcileSeatTick(rig.deps, [projects[16]!]), reconcileSeatTick(rig.deps, [projects[16]!])];
      await turn();
      const waitingErrors = rig.journal.filter(row => row.verdict === "error").length;
      clock.advance(75_000);
      const records = await sweep;
      await Promise.all(callbacks);
      expect(records).toHaveLength(17);
      expect(records.filter(row => row.verdict === "error").map(row => row.project)).toEqual([projects[0]!]);
      expect(waitingStarts).toBe(pass * 17 + 1);
      expect(waitingErrors).toBe(pass);
      expect(started.slice(pass * 17).map(row => row.project)).toEqual(projects);
      expect(started[pass * 17 + 1]!.at).toBe(before + 75_000);
      expect(current).toBe(projects[16]!);
      expect(rig.sent).toHaveLength(0);
      expect(clock.timers.size).toBe(0);
    } finally { stopSeatTick(); await sweep; }
  }
  expect(rig.cards.filter(row => row.card.kind === "check-errors" && row.card.state === "open").map(row => row.project)).toEqual([projects[0]!]);
});

test.each([false, true])("queued curation chooses after refreshed projects with its own bound; stuck=%s", async stuck => {
  const rig = harness({ state: RECENT });
  const clock = virtualClock();
  const projects = ["curation-project-a", "curation-project-b", "curation-project-c"];
  let choices = 0, choiceRows = 0, entered!: () => void, isCurrent: (() => boolean) | undefined;
  const launched = new Promise<void>(resolve => { entered = resolve; });
  Object.assign(rig.deps, { ownsTraffic: () => true, recordSuccessions: () => [],
    workClock: clock.now, workScheduler: clock.scheduler, workBudgetMs: 75_000,
    release: null, maintenance: null, curation: {
      reconcile: async () => null,
      launchIfDue: async (input: { sweepIsCurrent?: () => boolean }) => {
        choices++;
        isCurrent = input.sweepIsCurrent;
        choiceRows = rig.journal.length;
        entered();
        return stuck ? new Promise<null>(() => {}) : null;
      },
    } });
  rig.deps.sources!.activeSeats = () => projects;
  const sweep = reconcileSeatTick(rig.deps);
  try {
    await launched;
    if (stuck) clock.advance(75_000);
    const records = await sweep;
    expect(choices).toBe(1);
    expect(choiceRows).toBe(3);
    expect(records.filter(row => row.verdict === "error")).toHaveLength(0);
    expect(clock.timers.size).toBe(0);
    if (stuck) expect(isCurrent!()).toBe(false);
    expect(rig.sent).toHaveLength(0);
  } finally { stopSeatTick(); await sweep; }
});

test("stopping withdraws the queued generation before a replacement starts", async () => {
  const rig = harness({ state: RECENT });
  const clock = virtualClock();
  let entered!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const started: string[] = [];
  Object.assign(rig.deps, { ownsTraffic: () => true, recordSuccessions: () => [],
    workClock: clock.now, workScheduler: clock.scheduler,
    workStarted: (work: { project: string }) => { started.push(work.project); },
    curation: null, release: null, maintenance: null });
  rig.deps.sources!.prepareRead = async () => { entered(); return new Promise<void>(() => {}); };
  const old = reconcileSeatTick(rig.deps, ["generation-a", "generation-b"]);
  await preparing;
  stopSeatTick();
  rig.deps.sources!.prepareRead = async () => {};
  const replacement = reconcileSeatTick(rig.deps, ["replacement"]);
  await Promise.all([old, replacement]);
  expect(started).toEqual(["generation-a", "replacement"]);
  expect(clock.timers.size).toBe(0);
  expect(rig.sent).toHaveLength(0);
});

test("a stuck shared curator recovery cannot spend every queued project's budget", async () => {
  const rig = harness({ state: RECENT });
  const clock = virtualClock();
  let entered!: () => void, last!: () => void;
  const recovering = new Promise<void>(resolve => { entered = resolve; });
  const rosterDone = new Promise<void>(resolve => { last = resolve; });
  let recoveries = 0, choices = 0;
  const append = rig.deps.appendRecord!;
  Object.assign(rig.deps, { ownsTraffic: () => true, recordSuccessions: () => [],
    workClock: clock.now, workScheduler: clock.scheduler, workBudgetMs: 75_000,
    appendRecord: (row: Parameters<typeof append>[0]) => { append(row); if (rig.journal.length === 3) last(); },
    release: null, maintenance: null, curation: {
      reconcile: async () => { recoveries++; entered(); return new Promise<null>(() => {}); },
      launchIfDue: async () => { choices++; return null; },
    } });
  const sweep = reconcileSeatTick(rig.deps, ["recovery-a", "recovery-b", "recovery-c"]);
  try {
    await recovering;
    clock.advance(75_000);
    await rosterDone;
    await turn();
    clock.advance(75_000);
    const records = await sweep;
    expect(records.filter(row => row.verdict === "error").map(row => row.project)).toEqual(["recovery-a"]);
    expect(recoveries).toBe(1);
    expect(choices).toBe(0);
    expect(clock.timers.size).toBe(0);
    expect(rig.sent).toHaveLength(0);
  } finally { stopSeatTick(); await sweep; }
});

test("a restarted process admits the complete roster with fresh queue and pass guards", async () => {
  for (let generation = 0; generation < 2; generation++) {
    const child = spawn(process.execPath, ["test", "--timeout=20000", import.meta.path, "--test-name-pattern", "^(17 projects|ticks skip)"], {
      env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject); child.once("exit", resolve);
      });
      expect({ code, output }).toMatchObject({ code: 0 });
      expect(output).toContain("2 pass");
      expect(output).toContain("0 fail");
    } finally { clearTimeout(timeout); }
  }
});

test("ticks skip a running pass without accumulating another pass", async () => {
  let poll!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let passes = 0;
  startSeatTick({ policy: DEFAULT_SEAT_TICK_POLICY, recordSuccessions: () => [],
    handoffHeld: () => false, drainHeld: () => false, log: () => {},
    scheduleInterval: run => { poll = run; return { unref() {} } as never; },
    sweep: async () => { passes++; await held; } });
  try {
    for (let tick = 0; tick < 20; tick++) poll();
    expect(passes).toBe(1);
    release();
    await turn();
    expect(passes).toBe(1);
    poll();
    await turn();
    expect(passes).toBe(2);
  } finally { release(); stopSeatTick(); await turn(); }
});

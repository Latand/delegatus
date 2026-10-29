import { expect, test, fs, path, spawn, SANDBOX, harness, PROJECT, NOW, MINUTE, OPEN_LANE, OVERDUE, runSeatTickCheck, WALL_DATE, emptySeatTickState, writeSeatTickState, Database, statePath, outstandingWake } from "./seatTickController.fixture";
import { appendSeatTickRecord, readSeatTickRecords } from "./journalStore";
import { seatTickCheckErrorAlarm } from "./seatTickWatchdog";
import { seatTickSettingsAnswer } from "./seatTickSettingsAnswer";
import { seatTickDiagnostics } from "./seatTickDiagnostics";
import { loadTasks } from "@/lib/tasks/store";
import * as taskStore from "@/lib/tasks/store";
import { spyOn } from "bun:test";
import { createTask } from "@/lib/tasks/commands";

test.each([0, 500])("healthy checks never enumerate a board with %s unrelated tasks to close an error notice", async count => {
  const rig = harness({ pipelines: [], state: { lastProposalAt: new Date(NOW).toISOString() } });
  rig.deps.ensureCard = undefined;
  const board = statePath("tasks.json"), prior = taskStore.loadTasksFile(board);
  const tasks = Array.from({ length: count }, (_, index) => {
    const created = createTask([], { project: "unrelated", text: "Unrelated board work", placement: "unplaced" }, [], {
      id: () => `unrelated-${index}`, now: () => new Date(NOW).toISOString(),
    });
    if (!created.ok) throw new Error(created.error);
    return created.task;
  });
  taskStore.saveTasksFile({ ...prior, tasks }, board);
  // Warm the real board reader before observing calls from routine checks.
  taskStore.loadTasksForList(statePath("tasks.json"));
  const reads = spyOn(taskStore, "loadTasksForList");
  try {
    for (let index = 0; index < 3; index++) {
      expect((await runSeatTickCheck(PROJECT, rig.deps))?.verdict).toBe("quiet");
    }
    expect(reads).not.toHaveBeenCalled();
  } finally { reads.mockRestore(); taskStore.saveTasksFile(prior, board); }
});

const restartRoot = process.env.LLV_CHECK_ALARM_ROOT;
const mode = process.env.LLV_CHECK_ALARM_MODE;
const project = PROJECT;

test.skipIf(!restartRoot)("check alarm subprocess", async () => {
  process.env.LLV_STATE_DIR = path.join(restartRoot!, "state");
  const delivery = mode?.startsWith("delivery-");
  const now = NOW + (mode === "delivery-before" ? -1 : mode === "delivery-after" ? MINUTE : mode === "delivery-landed" ? 2 * MINUTE : 0);
  globalThis.Date = new Proxy(WALL_DATE, {
    construct(target, args) { return Reflect.construct(target, args.length ? args : [now]); },
    get(target, key, receiver) { return key === "now" ? () => now : Reflect.get(target, key, receiver); },
  });
  const rig = harness({ stateFile: path.join(restartRoot!, "tick.json"), state: OVERDUE, pipelines: OPEN_LANE, now });
  rig.deps.workClock = () => 0;
  rig.deps.appendRecord = appendSeatTickRecord;
  rig.deps.readRecords = (key, limit) => readSeatTickRecords(limit, undefined, key);
  rig.deps.ensureCard = undefined;
  if (mode === "error-refused-card") rig.deps.ensureCard = () => false;
  if (mode === "healthy-refused-close") rig.deps.ensureCard = (_project, card) => card.kind !== "check-errors";
  if (mode === "healthy-after-retention") rig.deps.readRecords = () => [];
  if (mode === "reconcile-error") {
    rig.deps.sources!.wakeState = async () => "uncertain";
    rig.deps.sources!.tasks = () => { throw new Error("fixture task source unavailable"); };
  } else if (delivery) {
    rig.deps.sources!.wakeState = async () => mode === "delivery-landed" ? "landed" : "retained";
    const settings = rig.deps.sources!.settings;
    rig.deps.sources!.settings = key => ({ ...settings(key), wakeIntervalMinutes: 10 });
  } else if (!mode?.startsWith("healthy")) rig.deps.sources!.prepareRead = async () => { throw new Error("fixture source unavailable"); };
  const reads = mode === "healthy-after-close" ? spyOn(taskStore, "loadTasksForList") : null;
  try {
    const result = await runSeatTickCheck(project, rig.deps);
    expect(result?.verdict).toBe(mode === "delivery-landed" || mode === "healthy-after-retention" || mode === "healthy-after-close" ? "quiet" : mode?.startsWith("healthy") || delivery ? "wake" : "error");
    if (reads) expect(reads).not.toHaveBeenCalled();
  } finally { reads?.mockRestore(); }
});

async function restart(root: string, mode: string, budgetMs = 30_000) {
  const child = spawn(process.execPath, ["test", "--timeout=60000", import.meta.path, "--test-name-pattern", "^check alarm subprocess$"], {
    env: { ...process.env, LLV_CHECK_ALARM_ROOT: root, LLV_CHECK_ALARM_MODE: mode }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-16_000); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-16_000); });
  const timer = setTimeout(() => child.kill("SIGKILL"), budgetMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    expect({ code, output }).toMatchObject({ code: 0 });
  } finally { clearTimeout(timer); }
}

test.skipIf(!!restartRoot)("three failed checks across process restarts raise one durable alarm, and recovery closes it", async () => {
  const root = fs.mkdtempSync(path.join(SANDBOX, "check-alarm-"));
  writeSeatTickState(project, { ...emptySeatTickState(), ...OVERDUE, seatEpoch: 7, accounting: undefined }, path.join(root, "tick.json"));
  const cards = () => loadTasks(path.join(root, "state", "tasks.json")).filter(task => task.project === project && task.text.includes("monitor-ref: seat-tick-check-errors"));
  for (let index = 0; index < 2; index++) {
    await restart(root, "error");
    expect(cards()).toHaveLength(0);
  }
  await restart(root, "error");
  expect(cards()).toHaveLength(1);
  const card = cards()[0]!;
  expect(card.status).not.toBe("done");
  expect(card.text).toContain("fixture source unavailable");
  await restart(root, "error");
  expect(cards()).toEqual([card]);
  const journal = readSeatTickRecords(3, path.join(root, "state", "seat-tick", "runs.ndjson"), project);
  const ports = { now: () => NOW, records: () => journal };
  const answer = seatTickSettingsAnswer(project, false, { kind: "gateway", project: null, conversationId: null, seatEpoch: null }, ports);
  const diagnostic = await seatTickDiagnostics(project, 1, ports);
  expect(answer.checkErrorAlarm?.detail).toContain("fixture source unavailable");
  expect(diagnostic.checkErrorAlarm).toEqual(answer.checkErrorAlarm);
  expect(diagnostic.journal).toHaveLength(1);
  await restart(root, "healthy");
  expect(cards()).toHaveLength(1);
  expect(cards()[0]).toMatchObject({ id: card.id, status: "done" });
  await restart(root, "healthy-after-close");
  expect(cards()[0]).toMatchObject({ id: card.id, status: "done" });
  for (let index = 0; index < 2; index++) {
    await restart(root, "error");
    expect(cards()[0]!.status).toBe("done");
  }
  await restart(root, "error");
  expect(cards()).toHaveLength(1);
  expect(cards()[0]).toMatchObject({ id: card.id, status: "inbox" });
});

test.skipIf(!!restartRoot)("closing a check-error episode survives restart, and a fresh episode retries a refused card", async () => {
  const root = fs.mkdtempSync(path.join(SANDBOX, "closed-check-alarm-"));
  writeSeatTickState(project, { ...emptySeatTickState(), ...OVERDUE, seatEpoch: 7, accounting: undefined }, path.join(root, "tick.json"));
  const board = path.join(root, "state", "tasks.json");
  const cards = () => loadTasks(board).filter(task => task.text.includes("monitor-ref: seat-tick-check-errors"));
  for (let index = 0; index < 3; index++) await restart(root, "error");
  const first = cards()[0]!;
  expect(first.status).toBe("inbox");
  const { patchTask } = await import("@/lib/tasks/commands");
  taskStore.mutateTasksFile(({ tasks }) => {
    const closed = patchTask(tasks, first.id, { status: "done" });
    if (!closed.ok) throw new Error(closed.error);
    return { state: { tasks: closed.tasks, recentCreates: [] }, result: true };
  }, board);
  await restart(root, "error");
  expect(cards()).toHaveLength(1);
  expect(cards()[0]!.status).toBe("done");
  await restart(root, "healthy");
  for (let index = 0; index < 3; index++) await restart(root, "error-refused-card");
  expect(cards()[0]!.status).toBe("done");
  await restart(root, "error");
  expect(cards()).toHaveLength(1);
  expect(cards()[0]).toMatchObject({ id: first.id, status: "inbox" });
});

test("a successful check breaks the durable error streak", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  rig.deps.sources!.prepareRead = async () => { throw new Error("fixture source unavailable"); };
  for (let index = 0; index < 2; index++) await runSeatTickCheck(PROJECT, rig.deps);
  expect(seatTickCheckErrorAlarm(rig.journal)).toBeNull();
  rig.deps.sources!.prepareRead = async () => {};
  await runSeatTickCheck(PROJECT, rig.deps);
  rig.deps.sources!.prepareRead = async () => { throw new Error("fixture source unavailable"); };
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(seatTickCheckErrorAlarm(rig.journal)).toBeNull();
});

test.skipIf(!!restartRoot)("a refused close survives restart after error records leave retention", async () => {
  const root = fs.mkdtempSync(path.join(SANDBOX, "close-debt-"));
  const filename = path.join(root, "tick.json");
  writeSeatTickState(project, { ...emptySeatTickState(), ...OVERDUE, seatEpoch: 7, accounting: undefined }, filename);
  const cards = () => loadTasks(path.join(root, "state", "tasks.json")).filter(task => task.text.includes("monitor-ref: seat-tick-check-errors"));
  for (let check = 0; check < 3; check++) await restart(root, "error");
  expect(cards()).toHaveLength(1);
  await restart(root, "healthy-refused-close");
  expect(cards()[0]!.status).not.toBe("done");
  await restart(root, "healthy-after-retention");
  expect(cards()[0]!.status).toBe("done");
});

test("the watchdog survives a check deadline and retries refused board admission", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  let instant = 0;
  Object.assign(rig.deps, { workClock: () => instant, workBudgetMs: 800 });
  rig.deps.sources!.prepareRead = async () => { instant += MINUTE; };
  let calls = 0;
  rig.deps.ensureCard = (_project, card) => {
    if (card.kind !== "check-errors") return true;
    calls++;
    expect(card.state).toBe("open");
    if (calls === 1) throw new Error("fixture board unavailable");
    return true;
  };
  for (let index = 0; index < 4; index++) expect((await runSeatTickCheck(PROJECT, rig.deps))?.verdict).toBe("error");
  expect(calls).toBe(2);
  expect(rig.sent).toHaveLength(0);
});

test.skipIf(!!restartRoot)("a parent-held writer cannot block the check process and its alarm retries after restart", async () => {
  const root = fs.mkdtempSync(path.join(SANDBOX, "alarm-writer-"));
  writeSeatTickState(project, { ...emptySeatTickState(), ...OVERDUE, seatEpoch: 7, accounting: undefined }, path.join(root, "tick.json"));
  const board = path.join(root, "state", "tasks.json");
  await restart(root, "error");
  await restart(root, "error");
  loadTasks(board);
  const writer = new Database(path.join(root, "state", "state.sqlite"));
  writer.exec("BEGIN IMMEDIATE");
  try {
    // This parent keeps the lock until the real check process has exited.
    await restart(root, "error", 10_000);
    expect(loadTasks(board).some(task => task.text.includes("monitor-ref: seat-tick-check-errors"))).toBe(false);
  } finally { writer.exec("ROLLBACK"); writer.close(); }
  await restart(root, "error");
  expect(loadTasks(board).filter(task => task.text.includes("monitor-ref: seat-tick-check-errors"))).toHaveLength(1);
});


test.skipIf(!!restartRoot)("reconciliation rows preserve the failed-check alarm across process restarts", async () => {
  const root = fs.mkdtempSync(path.join(SANDBOX, "interleaved-alarm-"));
  writeSeatTickState(project, { ...emptySeatTickState(), ...OVERDUE, seatEpoch: 7, accounting: undefined,
    outstandingWake: outstandingWake() }, path.join(root, "tick.json"));
  const cards = () => loadTasks(path.join(root, "state", "tasks.json"))
    .filter(task => task.project === project && task.text.includes("monitor-ref: seat-tick-check-errors"));
  for (let index = 0; index < 3; index++) {
    await restart(root, "reconcile-error");
    expect(cards()).toHaveLength(index === 2 ? 1 : 0);
  }
  const card = cards()[0]!;
  expect(card.status).toBe("inbox");
  expect(card.text).toContain("fixture task source unavailable");
  const journal = readSeatTickRecords(500, path.join(root, "state", "seat-tick", "runs.ndjson"), project);
  expect(journal.map(record => record.verdict)).toEqual(["uncertain", "error", "uncertain", "error", "uncertain", "error"]);
  const ports = { now: () => NOW, records: () => journal };
  const answer = seatTickSettingsAnswer(project, false, { kind: "gateway", project: null, conversationId: null, seatEpoch: null }, ports);
  expect(answer.checkErrorAlarm?.detail).toContain("fixture task source unavailable");
  expect((await seatTickDiagnostics(project, 1, ports)).checkErrorAlarm).toEqual(answer.checkErrorAlarm);
  await restart(root, "reconcile-error");
  expect(cards()).toEqual([card]);
  await restart(root, "healthy");
  expect(cards()).toHaveLength(1);
  expect(cards()[0]).toMatchObject({ id: card.id, status: "done" });
  for (let index = 0; index < 2; index++) {
    await restart(root, "reconcile-error");
    expect(cards()[0]!.status).toBe("done");
  }
  await restart(root, "reconcile-error");
  expect(cards()).toHaveLength(1);
  expect(cards()[0]).toMatchObject({ id: card.id, status: "inbox" });
});


test("only completed checks reset the error streak", () => {
  const error = { schemaVersion: 1 as const, at: new Date(NOW).toISOString(), project, seatEpoch: 7,
    verdict: "error" as const, reasons: [], items: 0, deferred: 0, eventsThrough: 0, delivery: null, detail: "source unavailable" };
  const reconciliations = (["uncertain", "landed", "dropped", "revoked", "retired"] as const).map(verdict => ({ ...error, verdict }));
  expect(seatTickCheckErrorAlarm([error, ...reconciliations, error, ...reconciliations, error])).not.toBeNull();
  for (const verdict of ["quiet", "wake", "proactive", "no-seat", "skipped", "refused"] as const) {
    expect(seatTickCheckErrorAlarm([error, error, { ...error, verdict }, ...reconciliations, error])).toBeNull();
  }
});


test.skipIf(!!restartRoot)("the fifteen-minute delivery alarm survives restarts at its boundary and closes on landing", async () => {
  const root = fs.mkdtempSync(path.join(SANDBOX, "delivery-alarm-"));
  const file = path.join(root, "tick.json");
  const wake = outstandingWake({ preparedAt: new Date(NOW - 15 * MINUTE).toISOString(),
    dispatch: { token: "alarm", state: "returned" } });
  writeSeatTickState(project, { ...emptySeatTickState(), ...OVERDUE, seatEpoch: 7,
    outstandingWake: wake, accounting: undefined }, file);
  const cards = () => loadTasks(path.join(root, "state", "tasks.json"))
    .filter(task => task.project === project && task.text.includes("monitor-ref: seat-tick-wake-unresolved"));
  await restart(root, "delivery-before");
  expect(cards()).toHaveLength(1);
  const standingId = cards()[0]!.id;
  expect(cards()[0]!.text).not.toContain("delivery alarm");
  await restart(root, "delivery-at");
  expect(cards()).toHaveLength(1);
  const card = cards()[0]!;
  expect(card.id).toBe(standingId);
  expect(card.status).toBe("inbox");
  expect(card.text).toContain("delivery alarm");
  expect(card.text).toContain(wake.clientMessageId);
  expect(card.text).toContain("ageMs=900000");
  await restart(root, "delivery-after");
  expect(cards()).toHaveLength(1);
  expect(cards()[0]!.id).toBe(card.id);
  expect(cards()[0]!.text).toContain("ageMs=960000");
  await restart(root, "delivery-landed");
  expect(cards()).toHaveLength(1);
  expect(cards()[0]).toMatchObject({ id: card.id, status: "done" });
});

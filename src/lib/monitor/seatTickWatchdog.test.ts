import { expect, test, fs, path, spawn, SANDBOX, harness, PROJECT, NOW, MINUTE, OPEN_LANE, OVERDUE, runSeatTickCheck, WALL_DATE, emptySeatTickState, writeSeatTickState, Database, statePath } from "./seatTickController.fixture";
import { appendSeatTickRecord, readSeatTickRecords } from "./journalStore";
import { seatTickCheckErrorAlarm } from "./seatTickWatchdog";
import { seatTickSettingsAnswer } from "./seatTickSettingsAnswer";
import { seatTickDiagnostics } from "./seatTickDiagnostics";
import { loadTasks } from "@/lib/tasks/store";

const restartRoot = process.env.LLV_CHECK_ALARM_ROOT;
const mode = process.env.LLV_CHECK_ALARM_MODE;
const project = PROJECT;

test.skipIf(!restartRoot)("check alarm subprocess", async () => {
  process.env.LLV_STATE_DIR = path.join(restartRoot!, "state");
  globalThis.Date = new Proxy(WALL_DATE, {
    construct(target, args) { return Reflect.construct(target, args.length ? args : [NOW]); },
    get(target, key, receiver) { return key === "now" ? () => NOW : Reflect.get(target, key, receiver); },
  });
  const rig = harness({ stateFile: path.join(restartRoot!, "tick.json"), state: OVERDUE, pipelines: OPEN_LANE });
  rig.deps.workClock = () => 0;
  rig.deps.appendRecord = appendSeatTickRecord;
  rig.deps.readRecords = (key, limit) => readSeatTickRecords(limit, undefined, key);
  rig.deps.ensureCard = undefined;
  if (mode !== "healthy") rig.deps.sources!.prepareRead = async () => { throw new Error("fixture source unavailable"); };
  const result = await runSeatTickCheck(project, rig.deps);
  expect(result?.verdict).toBe(mode === "healthy" ? "wake" : "error");
});

async function restart(root: string, mode: string) {
  const child = spawn(process.execPath, ["test", import.meta.path, "--test-name-pattern", "^check alarm subprocess$"], {
    env: { ...process.env, LLV_CHECK_ALARM_ROOT: root, LLV_CHECK_ALARM_MODE: mode }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-16_000); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-16_000); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
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
  for (let index = 0; index < 2; index++) {
    await restart(root, "error");
    expect(cards()[0]!.status).toBe("done");
  }
  await restart(root, "error");
  expect(cards()).toHaveLength(1);
  expect(cards()[0]).toMatchObject({ id: card.id, status: "inbox" });
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

test("an alarm blocked by the real state writer yields before release and retries next check", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  rig.deps.sources!.prepareRead = async () => { throw new Error("fixture source unavailable"); };
  rig.deps.ensureCard = undefined;
  await runSeatTickCheck(PROJECT, rig.deps);
  await runSeatTickCheck(PROJECT, rig.deps);
  const board = statePath("tasks.json");
  loadTasks(board);
  const writer = new Database(statePath("state.sqlite"));
  writer.exec("BEGIN IMMEDIATE");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const checking = runSeatTickCheck(PROJECT, rig.deps);
  try {
    const result = await Promise.race([
      checking,
      new Promise<"parent-deadline">((resolve) => { timer = setTimeout(() => resolve("parent-deadline"), 10_000); }),
    ]);
    expect(result).not.toBe("parent-deadline");
    expect(result).toMatchObject({ verdict: "error" });
    expect(loadTasks(board).some(task => task.text.includes("monitor-ref: seat-tick-check-errors"))).toBe(false);
  } finally {
    clearTimeout(timer);
    writer.exec("ROLLBACK");
    writer.close();
    await checking;
  }
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(loadTasks(board).filter(task => task.text.includes("monitor-ref: seat-tick-check-errors"))).toHaveLength(1);
});

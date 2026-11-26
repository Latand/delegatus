import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { NextRequest } from "next/server";
import { fs, path, SANDBOX, NOW, MINUTE, harness, runSeatTickCheck } from "./seatTickController.fixture";
import { ensureLegatusProject } from "@/lib/orchestrator/legatusSeat";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { POST as messagePOST } from "@/app/api/orchestrator/message/route";
import { PUT as settingsPUT } from "@/app/api/monitor/seat-tick/settings/route";
import { conversationHostPOST } from "@/app/api/conversation-host/handlers";
import { productionDomainDependencies, viewerMcpBindings } from "@/lib/mcp/bindings";
import { publishPrototype } from "@/lib/prototypeReview/store";
import { questions } from "@/lib/prototypeReview/questionnaire.fixture";
import { loadTasks, saveTasks } from "@/lib/tasks/store";
import { initializeStateCollectionsAsync } from "@/lib/state/sqliteStateStore";
import { readSeatTickSettings, defaultSeatTickSettings } from "./seatTickSettings";
import { acknowledgeSeatAgenda, legatusMessageReceipt, pendingSeatAgenda, recordOperatorLaunch } from "./seatAgenda";

const DESTINATION = "agenda-destination";
const LEGATUS = "conversation_legatus_fixture";
const WORKER = "conversation_agenda_destination";
const AT = new Date(NOW).toISOString();

function designate(project: string, conversationId: string) {
  const clientRequestId = `designate-${conversationId}`;
  beginOrchestratorSeatIntent({ project, conversationId, clientRequestId, mandate: "Review the agenda", mode: "existing", now: AT });
  const result = completeOrchestratorSeatIntent({ project, conversationId, clientRequestId, path: null, now: AT });
  if (result.kind !== "activated") throw new Error("fixture seat could not be designated");
  return { ...result.seat, conversationId };
}

async function isolated(run: (project: string) => Promise<void>, useFileState = false) {
  const previous = process.env.LLV_STATE_DIR;
  if (!useFileState) process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(SANDBOX, "legatus-"));
  setCallerConversationResolverForTests(() => LEGATUS);
  try { await run(ensureLegatusProject()); }
  finally {
    process.env.LLV_STATE_DIR = previous;
    setCallerConversationResolverForTests(null);
  }
}

function request(pathname: string, method: "POST" | "PUT", body: object) {
  return new NextRequest(`http://localhost${pathname}`, {
    method, body: JSON.stringify(body),
    headers: { host: "localhost", "x-llv-spawn-capability": "a".repeat(43) },
  });
}

function withAgenda(rig: ReturnType<typeof harness>) {
  rig.deps.sources!.seatAgenda = pendingSeatAgenda;
  rig.deps.sources!.acknowledgeAgenda = acknowledgeSeatAgenda;
  return rig;
}

test("a designated Legatus writes an attributed schedule history row through HTTP", () => isolated(async project => {
  const seat = designate(project, LEGATUS);
  const write = (body: object) => settingsPUT(request("/api/monitor/seat-tick/settings?view=summary", "PUT", { project: DESTINATION, ...body }));
  expect((await write({ wakeIntervalMinutes: 17, reason: "Attend to the current backlog" })).status).toBe(200);
  expect(readSeatTickSettings(DESTINATION)).toMatchObject({
    wakeIntervalMinutes: 17, reason: null,
    legatusScheduleHistory: [{ wakeIntervalMinutes: 17, why: "Attend to the current backlog",
      by: { kind: "legatus", project, conversationId: LEGATUS, seatEpoch: seat.seatEpoch } }],
  });
  const before = readSeatTickSettings(DESTINATION);
  expect((await write({ wakeIntervalMinutes: 25, monitorPrompt: "Overwrite the destination note" })).status).toBe(400);
  expect(readSeatTickSettings(DESTINATION)).toEqual(before);
  const own = await settingsPUT(request("/api/monitor/seat-tick/settings?view=summary", "PUT", { project, wakeIntervalMinutes: 4 }));
  expect(own.status).toBe(400);
  expect((await own.json()).error).toContain("5 minutes");

  const tick = viewerMcpBindings(undefined, undefined, {
    ...productionDomainDependencies,
    callerAttribution: () => ({ kind: "agent", conversationId: LEGATUS, role: "legatus" }),
  }).seat_tick_settings!;
  const report = await tick({ project, clientRequestId: "legatus-own-read" });
  expect(report.defaultWakeIntervalMinutes).toBe(30);
  setCallerConversationResolverForTests(() => WORKER);
  expect((await write({ wakeIntervalMinutes: 19, reason: "New timing", actor: { kind: "legatus" } })).status).toBe(200);
  expect(readSeatTickSettings(DESTINATION).setBy?.kind).toBe("agent");
  expect(readSeatTickSettings(DESTINATION).legatusScheduleHistory).toHaveLength(1);
}));

test("a Legatus direct send to a project seat enters the same agenda", () => isolated(async project => {
  designate(project, LEGATUS);
  designate(DESTINATION, WORKER);
  const response = await conversationHostPOST(request("/api/conversation-host", "POST", {
    conversationId: WORKER, clientMessageId: "legatus-conversation-send", text: "Check the destination backlog",
  }));
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ ok: true, outcome: "queued" });
  expect(pendingSeatAgenda(DESTINATION, 10)).toMatchObject([{ text: "Check the destination backlog", urgent: 0 }]);
}));

test("malformed action fields cannot route a Legatus text send around the seat agenda", () => isolated(async project => {
  designate(project, LEGATUS);
  designate(DESTINATION, WORKER);
  for (const action of [null, "unsupported-action"]) {
    const response = await conversationHostPOST(request("/api/conversation-host", "POST", {
      conversationId: WORKER, clientMessageId: `malformed-action-${String(action)}`, text: "Bypass the agenda", action,
    }));
    expect(response.status).toBe(400);
  }
  expect(pendingSeatAgenda(DESTINATION, 10)).toEqual([]);
}));

test("an ordinary Legatus message waits for the destination's wake and an urgent one queues as its wake", () => isolated(async project => {
  designate(project, LEGATUS);
  const destination = designate(DESTINATION, WORKER);
  const send = async (clientMessageId: string, text: string, urgent: boolean) => {
    const response = await messagePOST(request("/api/orchestrator/message", "POST", { project: DESTINATION, clientMessageId, text, urgent }));
    expect(response.status).toBe(202);
    return await response.json() as { operationId: string };
  };
  const options: Parameters<typeof harness>[0] = { seat: destination, turn: "busy",
    seatActivity: { lifecycle: "running" }, now: NOW + 65 * MINUTE,
    settings: defaultSeatTickSettings(DESTINATION) };
  const rig = withAgenda(harness(options));
  const ordinary = await send("ordinary-message", "Review the approved plan.", false);
  expect(await send("ordinary-message", "Review the approved plan.", false)).toEqual(ordinary);
  expect((await runSeatTickCheck(DESTINATION, rig.deps))?.verdict).toBe("skipped");
  expect(rig.sent).toHaveLength(0);
  expect(legatusMessageReceipt(ordinary.operationId)?.state).toBe("queued");

  const urgent = await send("urgent-message", "Review the release hold.", true);
  options.delivery = { ok: true, target: "structured", outcome: "queued", structured: true, operationId: "fixture-urgent" };
  await runSeatTickCheck(DESTINATION, rig.deps);
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]).toMatchObject({ policy: "queue", origin: { role: "legatus", conversationId: LEGATUS } });
  expect(rig.sent[0]!.text).toContain("Review the release hold.");
  expect(legatusMessageReceipt(urgent.operationId)?.state).toBe("queued");
  options.wakeState = "landed";
  await runSeatTickCheck(DESTINATION, rig.deps);
  expect(rig.sent).toHaveLength(1);
  expect(legatusMessageReceipt(urgent.operationId)?.state).toBe("delivered");
  expect(legatusMessageReceipt(ordinary.operationId)?.state).toBe("queued");

  options.turn = "idle";
  options.now! += 60 * MINUTE;
  options.delivery = { ok: true, target: "structured", outcome: "delivered", structured: true };
  await runSeatTickCheck(DESTINATION, rig.deps);
  expect(rig.sent).toHaveLength(2);
  expect(rig.sent[1]!.text).toContain("Review the approved plan.");
}));

test("forms from different projects and an operator launch coalesce behind one Legatus wake", () => isolated(async project => {
  const seat = designate(project, LEGATUS);
  const formInput = { clientRequestId: "choose-release", title: "Choose next steps", questions };
  const source = { conversationId: WORKER };
  const taskId = "task-agenda-form";
  saveTasks([{ id: taskId, project: "another-project", status: "inbox", placement: "unplaced", text: "Review next steps",
    assignments: [], createdAt: AT, updatedAt: AT }]);
  const taskRound = await publishPrototype(formInput, taskId, source);
  const seatRound = await publishPrototype({ ...formInput, clientRequestId: "choose-layout" }, null, source, DESTINATION);
  expect((await publishPrototype(formInput, taskId, source)).id).toBe(taskRound.id);
  await recordOperatorLaunch(DESTINATION, WORKER);
  await recordOperatorLaunch(DESTINATION, WORKER);
  expect(pendingSeatAgenda(project, 10).map(row => row.kind)).toEqual(["legatus-question", "legatus-question", "operator-launch"]);

  const stateFile = path.join(process.env.LLV_STATE_DIR!, "legatus-tick.json");
  const options: Parameters<typeof harness>[0] = { seat, stateFile, now: NOW + MINUTE,
    settings: defaultSeatTickSettings(project), delivery: { ok: true, target: "structured", outcome: "queued", structured: true, operationId: "fixture-legatus" } };
  const check = () => {
    const rig = withAgenda(harness(options));
    return runSeatTickCheck(project, rig.deps).then(record => ({ rig, record }));
  };
  const first = await check();
  expect(first.record?.reasons).toEqual(["legatus-question", "operator-launch"]);
  expect(first.rig.sent).toHaveLength(1);
  expect(first.rig.sent[0]!.text).toContain(taskRound.id);
  expect(first.rig.sent[0]!.text).toContain(seatRound.id);
  expect(first.rig.sent[0]!.text).toContain(WORKER);
  expect((await check()).rig.sent).toHaveLength(0);

  options.wakeState = "landed";
  expect((await check()).rig.sent).toHaveLength(0);
  expect(pendingSeatAgenda(project, 10)).toEqual([]);
  options.now! += 29 * MINUTE;
  expect((await check()).rig.sent).toHaveLength(0);
  options.now! += MINUTE;
  expect((await check()).record?.reasons).toEqual(["interval"]);
}, true));

test("reopening a completed task creates one new waiting-form episode", () => isolated(async project => {
  const taskId = "task-reopened-form";
  saveTasks([{ id: taskId, project: "another-project", status: "inbox", placement: "unplaced", text: "Review the reopened form",
    assignments: [], createdAt: AT, updatedAt: AT }]);
  const round = await publishPrototype({ clientRequestId: "reopen-form", title: "Choose a path", questions }, taskId, { conversationId: WORKER });
  expect(pendingSeatAgenda(project, 10)).toHaveLength(1);

  const legacy = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
  try {
    legacy.exec("DROP TRIGGER IF EXISTS seat_agenda_form_update_episode; CREATE TRIGGER seat_agenda_form_update AFTER UPDATE OF value_json ON state_rows BEGIN SELECT 1; END");
  } finally { legacy.close(); }
  await initializeStateCollectionsAsync(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), []);

  const waiting = loadTasks()[0]!;
  const doneAt = new Date(Date.parse(round.createdAt) + 60_000).toISOString();
  saveTasks([{ ...waiting, status: "done", doneAt, updatedAt: doneAt }]);
  expect(pendingSeatAgenda(project, 10)).toEqual([]);

  const completed = loadTasks()[0]!;
  const reopened = { ...completed, status: "inbox" as const, updatedAt: new Date(Date.parse(round.createdAt) + 120_000).toISOString() };
  delete reopened.doneAt;
  saveTasks([reopened]);
  const episode = pendingSeatAgenda(project, 10);
  expect(episode).toHaveLength(1);
  expect(episode[0]).toMatchObject({ kind: "legatus-question", ref: round.id, task_id: taskId });
  const reopenedAgain = loadTasks()[0]!;
  saveTasks([reopenedAgain]);
  expect(pendingSeatAgenda(project, 10).map(row => row.id)).toEqual(episode.map(row => row.id));
}, true));

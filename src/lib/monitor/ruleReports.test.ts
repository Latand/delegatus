import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendBridgeReports, readBridgeReportLog, resolveBridgeAsks } from "@/lib/bridge/store";
import { openBridgeAsks } from "@/lib/bridge/asks";
import { reportCardRefs } from "@/lib/bridge/reportCardRefs";
import { readProjectReportLog } from "@/lib/bridge/reportLog";
import { bridgeQuestionsForProject } from "@/lib/bridge/service";
import { parseMaintenanceReport } from "@/lib/boardMaintenance/text";
import type { MaintenanceRun } from "@/lib/boardMaintenance/types";
import type { HeldDelivery } from "@/lib/accounts/migration/contracts";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import { ruleReports, type RuleReportInput } from "./ruleReports";

const originalStateDir = process.env.LLV_STATE_DIR;
let stateRoot: string;
beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rule-reports-"));
  process.env.LLV_STATE_DIR = path.join(stateRoot, "state");
});
afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

const at = "2026-10-09T12:00:00Z";
const base: RuleReportInput = { project: "repo-fixture", seatConversationId: "conversation_seat", locale: "uk", at,
  tasks: [], pipelines: [], deliveries: [], maintenance: [], dismissals: [], deliveryProject: () => "repo-fixture", deliveryLost: () => true };
const delivery = (state: HeldDelivery["state"], origin: "agent" | "operator" = "agent") => ({ id: `delivery-${state}-${origin}`,
  state, command: { origin: { kind: origin } }, error: "target retired" } as HeldDelivery);

test("rule 1: a resolved rule writes one completed row with card links and never opens a decision", () => {
  const lane = { id: "pipeline-fixed", project: base.project, task: "Ліміт задач", taskIds: ["aabbccdd"], state: "completed", lastPassedCommit: "b".repeat(40),
    merge: { state: "merged", mergedAt: at, prNumber: 42 }, stages: [{ id: "review", onFail: { to: "fix" } }],
    runs: [{ stageId: "review", attempts: [{ n: 1, state: "failed", budgetSpent: true }] },
      { stageId: "fix", attempts: [{ n: 2, state: "passed", activatedBy: { stageId: "review", attempt: 1, edge: "fail", budgetSpent: true } }] }] } as unknown as Pipeline;
  const reports = ruleReports({ ...base, pipelines: [lane] });
  expect(reports).toHaveLength(1);
  expect(reports[0]!.class).toBe("completed");
  expect(reports[0]!.body).toContain("#42");
  expect(reportCardRefs(reports[0]!.body!, new Map([["aabbccdd", "task"]]))).toEqual([{ id: "aabbccdd", kind: "task" }]);
  const ready = ruleReports({ ...base, pipelines: [{ ...lane, merge: undefined, closedAt: at }] });
  expect(ready).toHaveLength(1);
  expect(ready[0]).toMatchObject({ key: "rule:budget-ready:pipeline-fixed", class: "completed", at });
  expect(reportCardRefs(ready[0]!.body!, new Map([["aabbccdd", "task"]]))).toEqual([{ id: "aabbccdd", kind: "task" }]);
  appendBridgeReports(ready);
  expect(appendBridgeReports(ready).skipped).toBe(1);
  appendBridgeReports(reports);
  expect(appendBridgeReports(reports).skipped).toBe(1);
  appendBridgeReports([{ key: "real-choice", at, class: "question", body: "Коли переносити домен?", project: base.project,
    origin: { kind: "manager", conversationId: base.seatConversationId, role: "orchestrator" }, targetSeatConversationId: base.seatConversationId }]);
  const asks = openBridgeAsks(readBridgeReportLog(), { now: new Date(at), canonicalConversationId: id => id });
  expect(asks.get(base.seatConversationId)?.map(ask => ask.id)).toEqual(["real-choice"]);
});

test("rule 4: only proven final agent non-delivery is reported; held, uncertain and successful messages stay quiet", () => {
  const reports = ruleReports({ ...base, deliveries: [delivery("held"), delivery("assigned"), delivery("delivery-uncertain"), delivery("delivered"), delivery("failed"), delivery("failed", "operator")] });
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ key: "rule:delivery-unsent:delivery-failed-agent", class: "completed" });
  expect(ruleReports({ ...base, deliveries: [delivery("failed")], deliveryLost: () => false })).toEqual([]);
});

const assignedTask = (id: string, conversationId: string, project = base.project) => ({
  id, project, text: "Assigned work", assignments: [{ conversationId }, { conversationId }],
} as BoardTask);

for (const locale of ["uk", "en"] as const) {
  test(`rule 4: ordinary non-delivery text links the recipient's cards in the stored log (${locale})`, () => {
    const recipient = "conversation_worker";
    const tasks = [assignedTask("aabbccdd", recipient), assignedTask("eeff0011", recipient),
      assignedTask("11223344", recipient, "repo-other"), assignedTask("55667788", "conversation_other")];
    const input = { ...base, locale, tasks, deliveries: [{ ...delivery("failed"), conversationId: recipient } as HeldDelivery] };
    const reports = ruleReports(input);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.body).toContain("target retired");
    appendBridgeReports(reports);
    expect(appendBridgeReports(ruleReports({ ...input, at: "2026-10-09T12:01:00Z" })).skipped).toBe(1);
    const page = readProjectReportLog({ project: base.project }, { knownCards: () => new Map(tasks.map(task => [task.id, "task" as const])),
      questions: inProject => bridgeQuestionsForProject(inProject, { now: new Date(at) }) });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ class: "completed", cards: [{ id: "aabbccdd", kind: "task" }, { id: "eeff0011", kind: "task" }] });
    expect(page.questions.open).toEqual([]);
    expect(openBridgeAsks(readBridgeReportLog(), { now: new Date(at), canonicalConversationId: id => id }).size).toBe(0);
  });

  test(`rule 1: a seat-resolved ordinary question links its seat card and replays once (${locale})`, () => {
    const tasks = [assignedTask("aabbccdd", base.seatConversationId), assignedTask("eeff0011", base.seatConversationId, "repo-other"),
      assignedTask("11223344", "conversation_other")];
    const by = { kind: "manager" as const, conversationId: base.seatConversationId, role: "orchestrator" };
    appendBridgeReports([{ key: "release-window", at, class: "question", body: "Which release window should we use?",
      project: base.project, origin: by, targetSeatConversationId: base.seatConversationId }]);
    const question = readBridgeReportLog().reports[0]!;
    const dependencies = { knownCards: () => new Map(tasks.map(task => [task.id, "task" as const])),
      questions: (inProject: (project: string) => boolean) => bridgeQuestionsForProject(inProject, { now: new Date(at) }) };
    expect(readProjectReportLog({ project: base.project }, dependencies).questions.open).toEqual([question.seq]);
    resolveBridgeAsks([question.seq], { by, at });
    const input = { ...base, locale, tasks, bridgeLog: readBridgeReportLog() };
    const reports = ruleReports(input);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.body).toContain(question.body);
    appendBridgeReports(reports);
    expect(appendBridgeReports(ruleReports({ ...input, bridgeLog: readBridgeReportLog() })).skipped).toBe(1);
    const page = readProjectReportLog({ project: base.project }, dependencies);
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]).toMatchObject({ class: "completed", cards: [{ id: "aabbccdd", kind: "task" }] });
    expect(page.questions.open).toEqual([]);
    expect(page.questions.resolved).toEqual([{ seq: question.seq, at }]);
    expect(openBridgeAsks(readBridgeReportLog(), { now: new Date(at), canonicalConversationId: id => id }).size).toBe(0);
    const legacy = { ...question, origin: undefined };
    expect(ruleReports({ ...input, bridgeLog: { ...input.bridgeLog, reports: [legacy] } })[0]!.body).toContain("aabbccdd");
  });
}

test("unassigned outcomes preserve their text without borrowing unrelated cards", () => {
  const by = { kind: "manager" as const, conversationId: base.seatConversationId, role: "orchestrator" };
  const tasks = [assignedTask("aabbccdd", "conversation_unrelated")];
  const reports = ruleReports({ ...base, tasks, deliveries: [{ ...delivery("failed"), conversationId: "conversation_missing" } as HeldDelivery],
    bridgeLog: { reports: [{ seq: 7, project: base.project, body: "Which release window should we use?", origin: by } as never], resolvedAsks: [{ seq: 7, at, by }] } });
  expect(reports).toHaveLength(2);
  expect(reports.every(row => !row.body!.includes("aabbccdd"))).toBe(true);
  expect(reports[0]!.body).toBe("Повідомлення агента не доставлено: target retired");
  expect(reports[1]!.body).toBe("Оркестратор зняв вирішене питання: Which release window should we use?");
});

test("rule 5: routine maintenance goes to the report; a blocking choice retains its attention entry", () => {
  const log = parseMaintenanceReport("attention: aabbccdd | Daily digest completed | keep | review schedule\nattention: ddeeffaa | Choose a release window | weekend | Monday | waits: schedule deployment");
  expect(log.leftAlone).toEqual([{ taskId: "aabbccdd", reason: "Daily digest completed" }]);
  expect(log.attention).toEqual([{ taskId: "ddeeffaa", text: "Choose a release window", options: ["weekend", "Monday"], nextStep: "schedule deployment" }]);
  const run = { runId: "maintenance-run", project: base.project, taskId: "maintenance-card", state: "succeeded", endedAt: at, log, counts: { tasks: 1 } } as MaintenanceRun;
  expect(ruleReports({ ...base, maintenance: [run] })[0]).toMatchObject({ class: "completed", body: expect.stringContaining("aabbccdd: Daily digest completed") });
});

test("rule 1: seat-cleared waits are completed reports linked to their cards", () => {
  const task = { id: "aabbccdd", project: base.project, text: "Resolved question", assignments: [{ conversationId: "conversation_worker", path: "/fixture/worker.jsonl" }] } as never;
  const lane = { id: "pipeline-hidden", project: base.project, taskIds: ["aabbccdd"], dismissedAt: at, dismissedBy: { kind: "manager" } } as unknown as Pipeline;
  const by = { kind: "manager" as const, conversationId: base.seatConversationId, role: "orchestrator" };
  const dismissals: RuleReportInput["dismissals"] = [
    { kind: "conversation", subject: "conversation_worker", conversationId: "conversation_worker", path: null, reason: null, reasonId: null, at, by },
    { kind: "prototype", subject: "prototype:review-round", taskId: "aabbccdd", conversationId: null, path: null, reason: null, reasonId: null, at, by },
  ];
  const reports = ruleReports({ ...base, tasks: [task], pipelines: [lane], dismissals,
    bridgeLog: { reports: [{ seq: 7, project: base.project, body: "aabbccdd: select the release window" } as never],
      resolvedAsks: [{ seq: 7, at, by }, { seq: 8, at, by: { kind: "operator" } }] } });
  expect(reports).toHaveLength(4);
  expect(reports.every(row => row.class === "completed" && row.body?.includes("aabbccdd"))).toBe(true);
  expect(ruleReports({ ...base, tasks: [task], dismissals: dismissals.map(row => ({ ...row, by: { kind: "operator", surface: "desktop" } })) })).toEqual([]);
});

import { expect, test } from "bun:test";
import { appendBridgeReports, readBridgeReportLog } from "@/lib/bridge/store";
import { openBridgeAsks } from "@/lib/bridge/asks";
import { reportCardRefs } from "@/lib/bridge/reportCardRefs";
import { parseMaintenanceReport } from "@/lib/boardMaintenance/text";
import type { MaintenanceRun } from "@/lib/boardMaintenance/types";
import type { HeldDelivery } from "@/lib/accounts/migration/contracts";
import type { Pipeline } from "@/lib/pipelines/types";
import { ruleReports, type RuleReportInput } from "./ruleReports";

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

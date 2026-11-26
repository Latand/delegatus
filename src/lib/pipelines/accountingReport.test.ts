import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { createTask, patchTask } from "@/lib/tasks/commands";
import { taskRevision } from "@/lib/tasks/revision";
import type { BoardTask } from "@/lib/tasks/types";
import { buildPipeline } from "./store";
import { accountingReport } from "./accountingReport";
import { storedAccountingReport } from "../../../scripts/accounting-report";
import type { PipelineStageAttempt } from "./types";

const at = (ms: number) => new Date(ms).toISOString();
function task(id: string, created: number, links: Record<string, string> = {}): BoardTask {
  const result = createTask([], { project: "fixture", text: "Deliver change", placement: "unplaced",
    accounting: { criteria: "The recorded example succeeds", taskClass: { size: "small" } } }, [], { now: () => at(created), id: () => id });
  if (!result.ok) throw new Error(result.error);
  Object.assign(result.task.accounting!, links);
  return result.task;
}
function accept(task: BoardTask, accepted: number): BoardTask {
  const result = patchTask([task], task.id, { accept: { evidence: "The example succeeds" }, expectedProject: "fixture", expectedRevision: taskRevision(task) }, at(accepted));
  if (!result.ok) throw new Error(result.error);
  return result.task;
}
const period = { from: at(1000), to: at(10000), asOf: at(15000) };
test("calendar and cohort count original acceptances once and retain all related lanes", () => {
  const old = accept(task("old", 500), 6000), cohort = accept(task("cohort", 3000), 11000);
  const child = accept(task("child", 4000, { originalTaskId: "cohort" }), 5000);
  const defect = accept(task("defect", 4500, { correctsTaskId: "old" }), 7000);
  const open = task("open", 5000);
  open.accounting!.holds.push({ kind: "operator", since: at(6000), endedAt: null });
  const lane = buildPipeline({ id: "lane", task: "Deliver change", taskIds: ["child"], project: "fixture", repoDir: "/repo", stages: [], srcPath: null, srcConversationId: null, now: at(12000) });
  const rows = [old, cohort, child, defect, open];
  const report = accountingReport(rows, [lane, lane], period);
  expect(report.calendar.acceptedTaskIds).toEqual(["old"]);
  expect(report.cohort.acceptedTaskIds).toEqual(["cohort"]);
  expect(report.calendar.p50ReadyToAcceptedMs).toBe(5500);
  expect(report.cohort.p90ReadyToAcceptedMs).toBe(8000);
  expect(report.cohort.lanes.map(lane => lane.id)).toEqual(["lane"]);
  expect(report.calendar.holds.operator).toBe(1);
  expect(report.cohort.remainder).toContainEqual({ taskId: "open", ageMs: 10000, readyAgeMs: 10000, holdKnown: true, hold: "operator" });
  expect(accountingReport([...rows].reverse(), [lane], period)).toEqual(report);
});
test("calendar work clips measured spans to the period; missing repeat causes stay unknown", () => {
  const root = task("original", 2000);
  const lane = buildPipeline({ id: "lane", task: "Deliver change", taskIds: [root.id], project: "fixture", repoDir: "/repo", stages: [], srcPath: null, srcConversationId: null, now: at(2000) });
  const spans = [{ kind: "model" as const, start: 500, end: 11000 }, { kind: "tools" as const, start: 4000, end: 6000 }];
  lane.runs = [{ stageId: "build", attempts: [
    { n: 1, startedAt: at(500), completedAt: at(11000), accounting: { admittedAt: at(200), startedAt: at(500), repeatReason: null, spans, time: null } },
    { n: 2, startedAt: at(12000), completedAt: at(13000) },
    { n: 3, startedAt: at(14000), completedAt: at(15000), accounting: { admittedAt: at(13000), startedAt: at(14000), repeatReason: "review-finding", time: null } },
  ] as PipelineStageAttempt[] }];
  const report = accountingReport([root], [lane], period);
  expect(report.calendar.attempts[0]!.time).toMatchObject({ intervalMs: 9000, modelMs: 7000, toolsMs: 2000, unknownMs: 0 });
  expect(report.cohort.repeatReasons).toEqual({ repeated: 2, unknown: 1, unknownShare: .5 });
  expect(report.cohort.attempts[0]!.waitBeforeStartMs).toBe(300);
  expect(report.cohort.attempts[1]!.time).toMatchObject({ unknownMs: 1000, modelMs: null });
});
test("stored report reads a coherent database snapshot alone, including archived lanes and receipt rows", async () => {
  const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "accounting-report-")), "state.sqlite");
  const db = new Database(filename);
  db.exec("CREATE TABLE state_rows(collection TEXT,row_key TEXT,value_json TEXT)");
  const root = accept(task("original", 2000), 15000);
  const lane = buildPipeline({ id: "lane", task: "Deliver change", taskIds: [root.id], project: "fixture", repoDir: "/repo", stages: [], srcPath: null, srcConversationId: null, now: at(3000) });
  const put = db.query("INSERT INTO state_rows VALUES(?,?,?)");
  put.run("tasks", "t:original", JSON.stringify(root));
  put.run("tasks", "r:receipt", JSON.stringify({ clientRequestId: "create", taskId: root.id }));
  put.run("pipelines_archive", lane.id, JSON.stringify(lane)); db.close();
  const expected = accountingReport([root], [lane], period);
  expect(storedAccountingReport(filename, period.from, period.to, period.asOf)).toEqual(expected);
  expect(expected.cohort.acceptedOriginalTasks).toBe(1);
  expect(expected.cohort.remainder).toHaveLength(0);
  const child = Bun.spawn([process.execPath, "scripts/accounting-report.ts", filename, period.from, period.to, period.asOf], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, errors }).toEqual({ code: 0, errors: "" });
  expect(JSON.parse(output)).toEqual(expected);
});
test("invalid report bounds refuse instead of fabricating a period", () => {
  expect(() => accountingReport([], [], { ...period, to: period.from })).toThrow("invalid report period");
  expect(() => accountingReport([], [], { ...period, asOf: period.from })).toThrow("invalid report period");
});

test("cohort cutoff clips work and excludes later attempts, starts and corrections", () => {
  const root = task("original", 2000);
  const bounds = { from: at(1000), to: at(9000), asOf: at(10000) };
  const lane = buildPipeline({ id: "lane", task: "Deliver change", taskIds: [root.id], project: "fixture", repoDir: "/repo", stages: [], srcPath: null, srcConversationId: null, now: at(2000) });
  lane.runs = [{ stageId: "build", attempts: [
    { n: 1, startedAt: at(3000), completedAt: null, accounting: { admittedAt: at(2000), startedAt: at(3000), repeatReason: null,
      spans: [{ kind: "tools", start: 4000, end: 20000 }], time: null } },
    { n: 2, startedAt: null, completedAt: null, accounting: { admittedAt: at(9000), startedAt: null, repeatReason: "unknown", time: null } },
  ] as PipelineStageAttempt[] }];
  const correction = task("correction", 6000, { correctsTaskId: root.id });
  const before = accountingReport([root, correction], [lane], bounds);
  expect(before.cohort.attempts[0]!.time).toMatchObject({ intervalMs: 7000, toolsMs: 6000, unknownMs: 1000 });
  expect(before.cohort.attempts[1]).toMatchObject({ startedAt: null, waitBeforeStartMs: null, time: { intervalMs: null, unknownMs: null } });
  const first = lane.runs[0]!.attempts[0]!;
  first.completedAt = at(20000);
  first.accounting!.time = { intervalMs: 17000, modelMs: null, toolsMs: 16000, checkQueueMs: null, checkRunnerMs: null, unknownMs: 1000, toleranceMs: 0 };
  lane.runs[0]!.attempts[1]!.startedAt = at(21000);
  lane.runs[0]!.attempts[1]!.accounting!.startedAt = at(21000);
  lane.runs[0]!.attempts.push({ n: 3, startedAt: at(22000), completedAt: at(23000) } as PipelineStageAttempt);
  const laterCorrection = task("later-correction", 21000, { correctsTaskId: root.id });
  const boundaryCorrection = task("boundary-correction", 10000, { correctsTaskId: root.id });
  expect(accountingReport([root, correction, laterCorrection, boundaryCorrection], [lane], bounds)).toEqual(before);
  expect(before.cohort.repeatReasons).toEqual({ repeated: 1, unknown: 1, unknownShare: 1 });
  expect(before.cohort.corrections).toEqual([{ taskId: correction.id, correctsTaskId: root.id }]);
});

test("an admitted attempt without a start keeps its unknown execution boundary", () => {
  const root = task("original", 2000);
  const lane = buildPipeline({ id: "lane", task: "Deliver change", taskIds: [root.id], project: "fixture", repoDir: "/repo", stages: [], srcPath: null, srcConversationId: null, now: at(2000) });
  lane.runs = [{ stageId: "build", attempts: [{ n: 1, startedAt: null, completedAt: at(8000),
    accounting: { admittedAt: at(3000), startedAt: null, repeatReason: null, time: null } } as PipelineStageAttempt] }];
  const report = accountingReport([root], [lane], period);
  for (const view of [report.calendar, report.cohort]) expect(view.attempts[0]!.time.intervalMs).toBeNull();
});


test("class aggregation uses the first lane declaration made before acceptance", () => {
  const created = createTask([], { project: "fixture", text: "Deliver change", placement: "unplaced", accounting: { criteria: "The example succeeds" } }, [], { now: () => at(2000), id: () => "original" });
  if (!created.ok) throw new Error(created.error);
  const root = accept(created.task, 8000);
  const lane = (id: string, created: number, size: string) => buildPipeline({ id, task: "Deliver change", taskIds: [root.id],
    taskClass: { size, money: false, access: true, dataMigration: null }, project: "fixture", repoDir: "/repo", stages: [], srcPath: null, srcConversationId: null, now: at(created) });
  const first = lane("first", 3000, "small"), later = lane("later", 4000, "large"), retrospective = lane("after", 9000, "large");
  expect(accountingReport([root], [later, retrospective, first], period).calendar.classes[0]!.declaredClass.size).toBe("small");
  expect(accountingReport([root], [retrospective], period).calendar.classes[0]!.declaredClass.size).toBeNull();
});

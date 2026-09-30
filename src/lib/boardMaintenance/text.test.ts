import { afterEach, expect, test } from "bun:test";
import { claim, sandbox, NOW } from "./testFixture";
import { maintenanceBrief, maintenanceCardText, parseMaintenanceReport, maintenanceItemLabel } from "./text";
let held: ReturnType<typeof sandbox>;
afterEach(() => held?.restore());
test("brief reads previous card summary, changes, questions and left-alone evidence", () => {
  held = sandbox(); const run = claim();
  const previous = { ...run, state: "succeeded" as const, log: { ...run.log, changes: [{ at: run.claimedAt, taskId: "aabbccdd", tool: "update_task" as const, fields: ["status"], statusFrom: "assigned" as const, statusTo: "inbox" as const }], attention: [{ taskId: "aabbccdd", text: "Choose", options: ["keep", "split"] }], leftAlone: [{ taskId: "ddeeffaa", reason: "open lane" }] } };
  const params = { run, previous, previousCardText: "Earlier summary", seatTaskIds: [], productionLine: "fixture", evidence: [], openCount: 0, now: NOW };
  const brief = maintenanceBrief(params);
  for (const phrase of ["Earlier summary", "assigned → inbox", "Choose | keep | split", "open lane", "Confirm every decision from current state"]) expect(brief).toContain(phrase);
  expect(maintenanceBrief({ ...params, previous: null })).toContain("No earlier run");
});
test("report parses bounded attention and left lines, rejects malformed ids", () => {
  const parsed = parseMaintenanceReport("attention: aabbccdd | Choose | keep | split\nleft: ddeeffaa | open lane\nattention: bad | missing\nVerdict: pass");
  expect(parsed.attention).toEqual([{ taskId: "aabbccdd", text: "Choose", options: ["keep", "split"] }]); expect(parsed.leftAlone).toHaveLength(1); expect(parsed.verdict).toBe("pass");
  expect(parseMaintenanceReport(Array.from({ length: 45 }, () => `attention: aabbccdd | ${"x".repeat(500)}`).join("\n")).attention).toHaveLength(40);
});
test("card texts for both locales and states, item label bounded", () => {
  held = sandbox(); const run = claim();
  expect(maintenanceCardText("uk", run, "UTC")).toContain("Обслуговування дошки — 30.09 12:00");
  expect(maintenanceCardText("en", run, "UTC")).toContain("Board maintenance");
  const done = { ...run, state: "succeeded" as const, endedAt: run.claimedAt };
  expect(maintenanceCardText("uk", done)).toContain("Нічого не потребує"); expect(maintenanceCardText("en", done)).toContain("Done");
  const failed = { ...run, state: "failed" as const, failure: { kind: "no-account" as const, detail: "fixture" } };
  expect(maintenanceCardText("uk", failed)).toContain("немає доступного акаунта"); expect(maintenanceCardText("en", failed)).toContain("Failed");
  done.log.attention = Array.from({ length: 40 }, () => ({ taskId: "aabbccdd", text: "x".repeat(300), options: ["a", "b"] })); expect(maintenanceItemLabel(done).length).toBeLessThanOrEqual(1200);
});

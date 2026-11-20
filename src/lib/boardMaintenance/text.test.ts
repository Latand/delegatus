import { afterEach, expect, test } from "bun:test";
import { claim, sandbox, NOW } from "./testFixture";
import { maintenanceBrief, maintenanceCardText, parseMaintenanceReport, maintenanceItemLabel } from "./text";
let held: ReturnType<typeof sandbox>;
afterEach(() => held?.restore());
test("brief reads previous card summary, changes, questions and left-alone evidence", () => {
  held = sandbox(); const run = claim();
  const previous = { ...run, state: "succeeded" as const, log: { ...run.log, changes: [{ at: run.claimedAt, taskId: "aabbccdd", tool: "update_task" as const, fields: ["status"], statusFrom: "assigned" as const, statusTo: "inbox" as const }], attention: [{ taskId: "aabbccdd", text: "Choose", options: ["keep", "split"], nextStep: "start implementation" }], leftAlone: [{ taskId: "ddeeffaa", reason: "open lane" }] } };
  const params = { run, previous, previousCardText: "Earlier summary", seatTaskIds: [], productionLine: "fixture", mergeOnReview: false, evidence: [], openCount: 0, now: NOW };
  const brief = maintenanceBrief(params);
  for (const phrase of ["Earlier summary", "assigned → inbox", "Choose | keep | split", "open lane"]) expect(brief).toContain(phrase);
  expect(maintenanceBrief({ ...params, previous: null })).toContain("No earlier run");
});
for (const mergeOnReview of [true, false]) test(`production brief preserves Done with mergeOnReview ${mergeOnReview ? "on" : "off"}`, () => {
  held = sandbox();
  const brief = maintenanceBrief({ run: claim(), previous: null, previousCardText: null, seatTaskIds: [], productionLine: "deployment unread", mergeOnReview, evidence: [], openCount: 0, now: NOW });
  const production = brief.split("\n").find(line => line.startsWith("Production:"))!;
  expect(production).toContain(`Project mergeOnReview: ${mergeOnReview ? "on" : "off"}`);
  expect(production).toContain(mergeOnReview ? "all pull requests merged means Done" : "an open task in a project that ships by deploy stays open");
});
test("report parses bounded attention, seat and left lines and rejects malformed ids", () => {
  const parsed = parseMaintenanceReport("attention: aabbccdd | Choose | keep | split | waits: start implementation\nleft: ddeeffaa | open lane\nattention: bad | missing\nVerdict: pass");
  expect(parsed.attention).toEqual([{ taskId: "aabbccdd", text: "Choose", options: ["keep", "split"], nextStep: "start implementation" }]); expect(parsed.leftAlone).toHaveLength(1); expect(parsed.verdict).toBe("pass");
  expect(parseMaintenanceReport(Array.from({ length: 45 }, () => `attention: aabbccdd | ${"x".repeat(500)} | keep | split | waits: start implementation`).join("\n")).attention).toHaveLength(40);
  const handed = parseMaintenanceReport([
    "seat: invalid | clearing | resume",
    "seat: aabbccdd | missing action",
    "seat: aabbccdd | lane settled | check the running build",
    ...Array.from({ length: 205 }, (_, i) => `seat: ${(i + 1).toString(16).padStart(8, "0")} | ${"r".repeat(301)} | ${"a".repeat(301)}`),
  ].join("\n"));
  expect(handed.leftAlone).toEqual([]);
  expect(handed.seat).toHaveLength(200);
  expect(handed.seat[0]).toEqual({ taskId: "aabbccdd", reason: "lane settled", action: "check the running build" });
  expect(handed.seat[1]).toEqual({ taskId: "00000001", reason: "r".repeat(300), action: "a".repeat(300) });
});
test("card texts for both locales and states, item label bounded", () => {
  held = sandbox(); const run = claim();
  expect(maintenanceCardText("uk", run, "UTC")).toContain("30.09 12:00 · Обслуговування дошки");
  expect(maintenanceCardText("en", run, "UTC")).toContain("Board maintenance");
  const done = { ...run, state: "succeeded" as const, endedAt: run.claimedAt };
  expect(maintenanceCardText("uk", done)).toContain("Нічого не потребує"); expect(maintenanceCardText("en", done)).toContain("Done");
  const failed = { ...run, state: "failed" as const, failure: { kind: "no-account" as const, detail: "fixture" } };
  expect(maintenanceCardText("uk", failed)).toContain("немає доступного акаунта"); expect(maintenanceCardText("en", failed)).toContain("Failed: no Codex account is available for this project.");
  expect(maintenanceCardText("en", failed)).not.toContain("no-account");
  const onClaude = { ...failed, failure: { ...failed.failure, engine: "claude" as const } };
  expect(maintenanceCardText("en", onClaude)).toContain("Failed: no Claude account is available for this project.");
  expect(maintenanceCardText("uk", onClaude)).toContain("немає доступного акаунта Claude");
  const decision = { ...run, state: "failed" as const, failure: { kind: "needs-decision" as const, detail: "Cannot read the forge without operator access." } };
  expect(maintenanceCardText("uk", decision)).toContain("Cannot read the forge without operator access.");
  expect(maintenanceCardText("en", decision)).toContain("Cannot read the forge without operator access.");
  done.log.attention = Array.from({ length: 40 }, () => ({ taskId: "aabbccdd", text: "x".repeat(300), options: ["a", "b"] })); expect(maintenanceItemLabel(done).length).toBeLessThanOrEqual(1200);
  const handoff = { taskId: "ddeeffaa", reason: "Lane settled", action: "Check the running build" };
  for (const runWithHandoff of [done, failed]) {
    const label = maintenanceItemLabel({ ...runWithHandoff, log: { ...runWithHandoff.log, seat: [handoff] } });
    expect(label).toContain("ddeeffaa: Lane settled — Check the running build");
    expect(label.length).toBeLessThanOrEqual(3500);
  }
  const six = { ...done, log: { ...done.log, seat: Array.from({ length: 6 }, (_, i) => ({ taskId: `task-${i + 1}`, reason: "Lane settled", action: `Retry step ${i + 1} ${"detail ".repeat(28)}` })) } };
  const rendered = maintenanceItemLabel(six);
  expect(rendered).toContain("task-6: Lane settled — Retry step 6");
  expect(rendered).toContain("detail ".repeat(28));
});

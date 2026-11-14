import { auditFixture } from "./testFixture";
import fs from "node:fs";
import { auditRequestKey } from "./audit";
import { afterEach, expect, test } from "bun:test";
import { claim, sandbox, NOW } from "./testFixture";
import { maintenanceAuditPreview, maintenanceBrief, maintenanceCardText, parseMaintenanceReport, maintenanceItemLabel } from "./text";
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
test("report parses bounded attention and left lines, rejects malformed ids", () => {
  const parsed = parseMaintenanceReport("attention: aabbccdd | Choose | keep | split | waits: start implementation\nleft: ddeeffaa | open lane\nattention: bad | missing\nVerdict: pass");
  expect(parsed.attention).toEqual([{ taskId: "aabbccdd", text: "Choose", options: ["keep", "split"], nextStep: "start implementation" }]); expect(parsed.leftAlone).toHaveLength(1); expect(parsed.verdict).toBe("pass");
  expect(parseMaintenanceReport(Array.from({ length: 45 }, () => `attention: aabbccdd | ${"x".repeat(500)} | keep | split | waits: start implementation`).join("\n")).attention).toHaveLength(40);
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
});


test("audit final requires an exact whole manifest and preserves both requests in the denominator", () => {
  held = sandbox(); const run = claim(); const audit = auditFixture(run);
  const occurrence = audit.occurrences[0];
  const rows = [0, 1].map(index => ({ key: auditRequestKey(occurrence.key, index), occurrence: occurrence.key, requestIndex: index, at: occurrence.at, request: `request ${index} | український текст`, outcome: index === 0 ? "done" : "unverified", taskId: null, code: "observed", merge: "observed", install: "unread", acceptance: "unread", checkedAt: run.claimedAt, next: "read", dueAt: null, dueTz: null, mutation: null }));
  const manifest = { version: 1, runId: run.runId, revision: audit.revision, lower: audit.window.lower, upper: audit.window.upper, rows: 2, occurrences: [{ key: occurrence.key, requests: 2, nextIndex: 2 }] };
  const final = [...rows.map(row => `audit-row: ${JSON.stringify(row)}`), `audit-manifest: ${JSON.stringify(manifest)}`, "Verdict: pass"].join("\n");
  const parsed = parseMaintenanceReport(final, audit).audit!;
  expect(parsed.error).toBeNull(); expect(parsed.rows).toHaveLength(2); expect(parsed.complete).toBe(false);
  expect(parsed.window.sources[0].from).toEqual({ seq: 1, requestIndex: 1 });
  for (const invalid of ["Verdict: pass", final.replace(run.runId, "foreign-run"), final.replace('"rows":2', '"rows":3'), final.replace('"nextIndex":2', '"nextIndex":1'), final.slice(0, -45), final.replace("\nVerdict: pass", ""), final + '\naudit-row: {}', final + '\naudit-future: {}', final.replace('"requestIndex":1', '"requestIndex":0')]) expect(parseMaintenanceReport(invalid, audit).audit!.error).not.toBeNull();
  const completed = final.replace('"unverified"', '"cancelled"');
  expect(parseMaintenanceReport(completed, audit).audit).toMatchObject({ complete: true, error: null });
  audit.unread[occurrence.source] = { seq: occurrence.seq, requestIndex: 0 };
  const frozen = structuredClone(audit);
  const continuation = parseMaintenanceReport(completed, audit).audit!;
  expect(continuation.window.sources[0].from).toEqual({ seq: occurrence.seq, requestIndex: 2 });
  expect(audit).toEqual(frozen);
});

test("audit uses UTF8 limits and refuses 201 whole rows, oversized fields and unknown fields", () => {
  held = sandbox(); const run = claim(); const audit = auditFixture(run); const o = audit.occurrences[0];
  const row = { key: auditRequestKey(o.key, 0), occurrence: o.key, requestIndex: 0, at: o.at, request: "request", outcome: "done", taskId: null, code: "", merge: "", install: "", acceptance: "", checkedAt: run.claimedAt, next: "", dueAt: null, dueTz: null, mutation: null };
  const manifest = { version: 1, runId: run.runId, revision: 1, lower: audit.window.lower, upper: audit.window.upper, rows: 1, occurrences: [{ key: o.key, requests: 1, nextIndex: 1 }] };
  const final = (value: unknown) => `audit-row: ${JSON.stringify(value)}\naudit-manifest: ${JSON.stringify(manifest)}\nVerdict: pass`;
  expect(parseMaintenanceReport(final({ ...row, request: "я".repeat(301) }), audit).audit!.error).toBe("malformed-audit-record");
  expect(parseMaintenanceReport(final({ ...row, extra: true }), audit).audit!.error).not.toBeNull();
  for (const count of [200, 201]) {
    const text = Array.from({ length: count }, (_, i) => `audit-row: ${JSON.stringify({ ...row, request: "я".repeat(300), requestIndex: i })}`).join("\n");
    expect(text.length).toBeLessThan(Buffer.byteLength(text));
    expect(parseMaintenanceReport(text, audit).audit!.error).toBe("final-transport-budget");
  }
  expect(parseMaintenanceReport(final({ ...row, outcome: "filed", taskId: "missing", mutation: { key: row.key, state: "readback" } }), audit).audit!.error).toBe("task-effect-unverified");
});


test("audit preview has equal counts in both locales and announcement leaves coverage untouched", () => {
  held = sandbox(); const run = claim(); const audit = auditFixture(run);
  const log = { ...run.log, audit: { version: 1 as const, rows: [], manifest: null, complete: false, error: null, window: audit.window } };
  const before = structuredClone(log);
  expect(maintenanceAuditPreview("uk", log)).toContain("0: 0/0/0/0/0");
  expect(maintenanceAuditPreview("en", log)).toContain("0: 0/0/0/0/0");
  for (const locale of ["uk", "en"] as const) expect(maintenanceCardText(locale, { ...run, state: "succeeded", log })).toContain(maintenanceAuditPreview(locale, log));
  expect(maintenanceItemLabel({ ...run, state: "succeeded", log })).toContain("partial coverage");
  expect(log).toEqual(before);
});

test("a replaced source cannot advance coverage from a valid old final", () => {
  held = sandbox(); const run = claim(); const audit = auditFixture(run);
  const source = audit.window.sources[0];
  fs.renameSync(source.path!, source.path + ".original");
  fs.writeFileSync(source.path!, "replacement\n");
  const manifest = { version: 1, runId: run.runId, revision: audit.revision, lower: audit.window.lower, upper: audit.window.upper, rows: 0, occurrences: audit.occurrences.map(o => ({ key: o.key, requests: 0, nextIndex: 0 })) };
  const parsed = parseMaintenanceReport(`audit-manifest: ${JSON.stringify(manifest)}\nVerdict: pass`, audit).audit!;
  expect(parsed.complete).toBe(false);
  expect(parsed.window.sources[0]).toMatchObject({ complete: false, gap: "artifact-replaced", from: null });
});

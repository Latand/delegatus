import { afterEach, expect, test } from "bun:test";
import { claim, sandbox, NOW, PROJECT, SEAT } from "./testFixture";
import { claimMaintenanceRun, patchMaintenanceRun, readMaintenanceRun, previousMaintenanceRun, recordMaintenanceChange, maintenanceRunForConversation, maintenanceRunIdForConversation, maintenanceRuns } from "./store";
import { MAINTENANCE_LOG_ENTRY_LIMIT } from "./types";
let held: ReturnType<typeof sandbox>;
afterEach(() => held?.restore());
const attempt = (now: number) => claimMaintenanceRun({ project: PROJECT, now, intervalHours: 3, seat: SEAT, repoDir: "/fixtures/repository" });
test("once per interval, including a live run beyond the interval", () => {
  held = sandbox(); const run = claim();
  expect(attempt(NOW + 4 * 3600000)).toEqual({ claimed: false, reason: "live" });
  patchMaintenanceRun(run.runId, { launchedAt: new Date(NOW).toISOString(), state: "succeeded", endedAt: new Date(NOW).toISOString() });
  for (const delta of [0, 60000, 2 * 3600000 + 59 * 60000]) expect(attempt(NOW + delta)).toEqual({ claimed: false, reason: "interval" });
  const next = attempt(NOW + 3 * 3600000); expect(next.claimed).toBe(true);
  if (next.claimed) expect(next.run.runId).not.toBe(run.runId);
});
test("fresh process reopens durable claim after restart", async () => {
  held = sandbox(); const run = claim(); patchMaintenanceRun(run.runId, { launchedAt: new Date(NOW).toISOString(), state: "succeeded" });
  const child = Bun.spawn([process.execPath, "src/lib/boardMaintenance/store.sqliteChild.ts", String(NOW)], { env: { ...process.env, LLV_STATE_DIR: held.dir }, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0); expect(JSON.parse(await new Response(child.stdout).text())).toMatchObject({ claimed: false, reason: "interval" });
});
test("two processes admit exactly one claim in the same slot", async () => {
  held = sandbox();
  const children = [1, 2].map(() => Bun.spawn([process.execPath, "src/lib/boardMaintenance/store.sqliteChild.ts", String(NOW)], { env: { ...process.env, LLV_STATE_DIR: held.dir }, stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(children.map(async child => { const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); return { output, error, code }; }));
  for (const result of results) expect(result.code, result.error).toBe(0);
  expect(results.map(r => JSON.parse(r.output)).filter(r => r.claimed).length).toBe(1);
});
test("continuity reads newest ended run before current, including its full durable log", () => {
  held = sandbox(); const first = claim();
  recordMaintenanceChange(first.runId, { at: first.claimedAt, taskId: "aabbccdd", tool: "update_task", fields: ["status"], statusFrom: "assigned", statusTo: "inbox" });
  patchMaintenanceRun(first.runId, { state: "succeeded", log: { ...readMaintenanceRun(first.runId)!.log, attention: [{ taskId: "aabbccdd", text: "Choose next step", options: ["keep", "split"] }], leftAlone: [{ taskId: "ddeeffaa", reason: "open pipeline" }] } });
  const next = claim(NOW + 3 * 3600000);
  const previous = previousMaintenanceRun(PROJECT, next.runId)!;
  expect(previous.runId).toBe(first.runId); expect(previous.log.changes).toHaveLength(1); expect(previous.log.attention[0].options).toEqual(["keep", "split"]); expect(previous.log.leftAlone[0].reason).toBe("open pipeline");
});
test("log storage bound never caps writes, and ended runs reject changes", () => {
  held = sandbox(); const run = claim();
  for (let i = 0; i < MAINTENANCE_LOG_ENTRY_LIMIT + 5; i++) recordMaintenanceChange(run.runId, { at: run.claimedAt, taskId: `task-${i}`, tool: "update_task", fields: ["text"] });
  const stored = readMaintenanceRun(run.runId)!;
  expect(stored.counts.writes).toBe(MAINTENANCE_LOG_ENTRY_LIMIT + 5); expect(stored.counts.tasks).toBe(MAINTENANCE_LOG_ENTRY_LIMIT + 5); expect(stored.log.omittedChanges).toBe(5);
  patchMaintenanceRun(run.runId, { state: "failed" }); recordMaintenanceChange(run.runId, { at: run.claimedAt, taskId: "later", tool: "create_task", fields: [] });
  expect(readMaintenanceRun(run.runId)!.counts).toEqual(stored.counts);
});
test("retention prunes run history but keeps the terminal conversation fence", () => {
  held = sandbox(); const first = claim(); patchMaintenanceRun(first.runId, { conversationId: "fixture-worker", state: "succeeded" });
  for (let i = 1; i <= 10; i++) { const run = claim(NOW + i * 3 * 3600000); patchMaintenanceRun(run.runId, { state: "succeeded" }); }
  expect(readMaintenanceRun(first.runId)).toBeNull(); expect(maintenanceRunForConversation("fixture-worker")).toBeNull();
  expect(maintenanceRunIdForConversation("fixture-worker")).toBe(first.runId);
  expect(maintenanceRuns(PROJECT)).toHaveLength(10);
});


test("audit checkpoint survives pruning and rejects a stale controller revision atomically", async () => {
  held = sandbox(); const run = claim();
  const { auditFixture } = await import("./testFixture");
  const { saveMaintenanceAuditLaunch, settleMaintenanceAudit, readMaintenanceProject } = await import("./store");
  const audit = auditFixture(run); const body = { prompt: JSON.stringify(audit) };
  expect(saveMaintenanceAuditLaunch(run.runId, audit, body, () => false)).toBeNull();
  expect(readMaintenanceProject(PROJECT)?.audit).toBeUndefined();
  const saved = saveMaintenanceAuditLaunch(run.runId, audit, body)!;
  expect(saved.audit).toEqual(audit);
  expect(saveMaintenanceAuditLaunch(run.runId, audit, { prompt: "replacement" })).toBeNull();
  const log = { ...saved.log, audit: { version: 1 as const, rows: [], manifest: { version: 1 as const, runId: run.runId, revision: 1, lower: audit.window.lower, upper: audit.window.upper, rows: 0, occurrences: [] }, complete: false, error: null, window: { ...audit.window, sources: audit.window.sources.map(s => ({ ...s, from: { seq: 1, requestIndex: 1 } })) } } };
  expect(settleMaintenanceAudit(saved, { state: "succeeded", log }, () => false)).toBeNull();
  expect(readMaintenanceProject(PROJECT)?.audit?.revision).toBe(1);
  expect(readMaintenanceRun(run.runId)?.state).toBe("launching");
  expect(settleMaintenanceAudit(saved, { state: "succeeded", log })).not.toBeNull();
  expect(settleMaintenanceAudit(saved, { state: "succeeded", log })).toBeNull();
  for (let i = 1; i <= 12; i++) { const next = claim(NOW + i * 3 * 3600000); patchMaintenanceRun(next.runId, { state: "failed" }); }
  const state = readMaintenanceProject(PROJECT)!.audit!;
  expect(state).toMatchObject({ revision: 2, through: null, window: { upper: audit.window.upper } });
  expect(state.window!.sources[0].from).toEqual({ seq: 1, requestIndex: 1 });
  const child = Bun.spawn([process.execPath, "-e", `import {readMaintenanceProject} from './src/lib/boardMaintenance/store'; process.stdout.write(JSON.stringify(readMaintenanceProject('${PROJECT}')?.audit))`], { env: { ...process.env, LLV_STATE_DIR: held.dir }, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text(); expect(await child.exited).toBe(0); expect(JSON.parse(output)).toEqual(state);
});


test("two real controller processes commit one audit revision and terminal result", async () => {
  held = sandbox(); const run = claim();
  const { auditFixture } = await import("./testFixture");
  const { saveMaintenanceAuditLaunch, readMaintenanceProject } = await import("./store");
  const audit = auditFixture(run);
  saveMaintenanceAuditLaunch(run.runId, audit, { prompt: JSON.stringify(audit) });
  const fs = await import("node:fs"); const path = await import("node:path");
  const final = path.join(held.dir, "final.txt");
  fs.writeFileSync(final, `audit-manifest: ${JSON.stringify({ version: 1, runId: run.runId, revision: 1, lower: audit.window.lower, upper: audit.window.upper, rows: 0, occurrences: audit.occurrences.map(o => ({ key: o.key, requests: 0, nextIndex: 0 })) })}\nVerdict: pass`);
  const children = [1, 2].map(() => Bun.spawn([process.execPath, "src/lib/boardMaintenance/store.sqliteChild.ts", String(NOW), "audit-settle", run.runId, final], { env: { ...process.env, LLV_STATE_DIR: held.dir }, stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(children.map(async child => { const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); return { output, error, code }; }));
  for (const result of results) expect(result.code, result.error).toBe(0);
  expect(results.map(r => JSON.parse(r.output)).filter(Boolean)).toHaveLength(1);
  expect(readMaintenanceProject(PROJECT)?.audit).toMatchObject({ revision: 2, through: audit.window.upper, window: null });
});

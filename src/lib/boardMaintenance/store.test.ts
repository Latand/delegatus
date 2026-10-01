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
  const results = await Promise.all(children.map(async child => { const output = await new Response(child.stdout).text(); expect(await child.exited).toBe(0); return JSON.parse(output); }));
  expect(results.filter(r => r.claimed).length).toBe(1);
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

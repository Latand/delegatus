import { afterEach, expect, test } from "bun:test";
import { seatTickDecision, seatTickWakeCommitPlan, seatTickWakeCommit } from "@/lib/monitor/seatTick";
import { seatTickStateForEpoch } from "@/lib/monitor/seatTickState";
import { claim, sandbox, input, NOW } from "./testFixture";
let held: ReturnType<typeof sandbox>;
afterEach(() => held?.restore());
test("one maintenance wake item, credited only on landing, survives seat rotation", () => {
  held = sandbox(); const run = { ...claim(), state: "succeeded" as const, endedAt: new Date(NOW).toISOString() };
  run.counts.tasks = 9; run.counts.writes = 14; run.log.attention = [{ taskId: "aabbccdd", text: "Choose", options: ["keep", "split"] }];
  const before = { ...input(), settledMaintenance: [run] };
  const decision = seatTickDecision(before); expect(decision.verdict.kind).toBe("wake");
  if (decision.verdict.kind !== "wake") throw new Error("wake expected");
  expect(decision.verdict.reasons.some(r => r.kind === "maintenance-settled")).toBe(true);
  const items = decision.verdict.items.filter(item => item.kind === "maintenance"); expect(items).toHaveLength(1); expect(items[0].label).toContain("9 task(s)"); expect(items[0].label).toContain("Choose");
  const plan = seatTickWakeCommitPlan(decision.verdict, { fingerprint: before.changeFingerprint, eventsThrough: 0 })!; expect(plan.announcedMaintenance).toEqual([run.runId]);
  expect(seatTickDecision(before).verdict.kind).toBe("wake");
  const landed = seatTickWakeCommit(decision.state, plan, NOW);
  const rotated = seatTickStateForEpoch(landed, 2);
  expect(rotated.announcedMaintenance).toEqual([run.runId]);
  const after = seatTickDecision({ ...before, now: NOW + 4 * 3600000, state: rotated });
  if (after.verdict.kind === "wake") expect(after.verdict.items.filter(item => item.kind === "maintenance")).toHaveLength(0);
});

test("failed maintenance wake keeps partial counts and bounded question/options and credits once", () => {
  held = sandbox(); const run = { ...claim(), taskId: "maintenance-card", state: "failed" as const, endedAt: new Date(NOW).toISOString(), failure: { kind: "needs-decision" as const, detail: "A long failure detail" } };
  run.counts.tasks = 1; run.counts.writes = 1; run.log.attention = [{ taskId: "aabbccdd", text: "Choose next step", options: ["keep", "split"] }];
  const before = { ...input(), settledMaintenance: [run] }; const decision = seatTickDecision(before);
  if (decision.verdict.kind !== "wake") throw new Error("wake expected");
  const item = decision.verdict.items.find(candidate => candidate.kind === "maintenance")!;
  expect(item.id).toBe("maintenance-card"); expect(item.label).toContain("1 task(s)"); expect(item.label).toContain("1 write(s)");
  expect(item.label).toContain("Choose next step"); expect(item.label).toContain("keep / split");
  const plan = seatTickWakeCommitPlan(decision.verdict, { fingerprint: before.changeFingerprint, eventsThrough: 0 })!;
  const landed = seatTickWakeCommit(decision.state, plan, NOW);
  const after = seatTickDecision({ ...before, state: seatTickStateForEpoch(landed, 2), now: NOW + 4 * 3600000 });
  if (after.verdict.kind === "wake") expect(after.verdict.items.filter(candidate => candidate.kind === "maintenance")).toHaveLength(0);
});

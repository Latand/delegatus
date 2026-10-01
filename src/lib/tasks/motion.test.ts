import { expect, test } from "bun:test";
import { taskMotion, type TaskMotionFacts } from "./motion";
import type { TaskHold } from "./types";

const NOW = Date.parse("2026-10-02T10:00:00Z");
const facts: TaskMotionFacts = { status: "assigned", working: 0, needsYou: false, inFlight: false, pipelines: [] };
const hold = (kind: TaskHold["kind"], extra: Partial<TaskHold> = {}): TaskHold => ({ kind, note: "After capacity is free", since: "2026-10-01T10:00:00.000Z", by: "agent", ...extra });

test("needs you wins, live work beats a hold, and provisioning is live", () => {
  expect(taskMotion({ ...facts, working: 2, needsYou: true }, NOW).key).toBe("needs-you");
  expect(taskMotion({ ...facts, hold: hold("operator") }, NOW).key).toBe("needs-you");
  expect(taskMotion({ ...facts, working: 1, hold: hold("worker") }, NOW)).toMatchObject({ key: "working", holdStillSet: true });
  expect(taskMotion({ ...facts, inFlight: true }, NOW).key).toBe("working");
  expect(taskMotion({ ...facts, pipelines: [{ state: "provisioning" }] }, NOW).key).toBe("working");
});

test("queued holds wait, an overdue postponement stops, and only paused active pipelines imply a wait", () => {
  for (const kind of ["worker", "resource", "limit", "task", "pr", "issue", "external"] as const) expect(taskMotion({ ...facts, hold: hold(kind) }, NOW).key).toBe("waiting");
  expect(taskMotion({ ...facts, hold: hold("postponed", { until: "2026-10-02T09:00:00.000Z" }) }, NOW)).toMatchObject({ key: "stopped", due: true });
  expect(taskMotion({ ...facts, hold: hold("postponed", { until: "2026-10-02T11:00:00.000Z" }) }, NOW).key).toBe("waiting");
  expect(taskMotion({ ...facts, hold: hold("unstated") }, NOW).key).toBe("stopped");
  expect(taskMotion({ ...facts, pipelines: [{ state: "paused", pausedAt: "2026-10-01T10:00:00Z" }, { state: "closed" }] }, NOW)).toMatchObject({ key: "waiting", reason: "paused", since: "2026-10-01T10:00:00Z" });
  expect(taskMotion({ ...facts, pipelines: [{ state: "running" }, { state: "paused" }] }, NOW).key).toBe("stopped");
  expect(taskMotion({ ...facts, status: "inbox" }, NOW).key).toBe("not-started");
  expect(taskMotion({ ...facts, status: "done" }, NOW).key).toBe("done");
});

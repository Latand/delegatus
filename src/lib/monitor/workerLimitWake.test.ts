import { expect, test } from "bun:test";
import { seatTickProposalMessage, seatTickWakeMessage } from "./report";

test("current worker guidance survives a truncated wake", () => {
  const input = { project: "one", reasons: [], items: [{ kind: "task" as const, id: "one", label: "a board sentence ".repeat(400) }], deferred: 0, signals: [], monitorPrompt: "brief", operatorInstructions: "x".repeat(1000) };
  const body = seatTickWakeMessage({ ...input, workers: { limit: 8, source: "machine", machine: 8, running: 7 } });
  expect(body).toContain("Worker limit here: 8 (the machine default)");
  expect(body).toContain("Running here now: 7.");
  expect(body.length).toBeLessThanOrEqual(4000);
  expect(body).toContain("…");
  expect(seatTickWakeMessage({ ...input, workers: { limit: 10, source: "project", machine: 8, running: 9 } })).toContain("this project's own; machine default 8");
});

test("a proactive wake carries the same current worker guidance", () => {
  const body = seatTickProposalMessage({ project: "one", issues: [], signals: [], items: 0, slot: "one",
    workers: { limit: 64, source: "project", machine: 8, running: 7 } });
  expect(body).toContain("Worker limit here: 64 (this project's own; machine default 8)");
  expect(body).toContain("Running here now: 7.");
  expect(body.length).toBeLessThanOrEqual(4000);
});

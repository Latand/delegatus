import { expect, test } from "bun:test";
import { probeQuiet, type QuietPorts } from "./quiet";
import type { Snapshot } from "./types";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const snapshot = { busy: null, processes: { web: { state: "healthy" }, runtimeHost: { state: "healthy" } } } as Snapshot;

function ports(turn = "idle", host = "hosted", cursor = "pending", ageMinutes = 11): QuietPorts {
  return {
    runtimeSnapshot: async () => ({ sessions: [{ turn, host }] }) as Awaited<ReturnType<QuietPorts["runtimeSnapshot"]>>,
    pipelines: () => [{ state: "running", cursor: { state: cursor } }] as unknown as ReturnType<QuietPorts["pipelines"]>,
    presence: () => [{ lastInteractionAt: NOW - ageMinutes * 60_000 }] as unknown as ReturnType<QuietPorts["presence"]>,
  };
}

test("live turns and transitioning hosts block either restart", async () => {
  for (const turn of ["running", "interrupt_requested"]) expect((await probeQuiet(snapshot, ports(turn), NOW)).quiet).toBe(false);
  for (const host of ["registering", "recovering"]) expect((await probeQuiet(snapshot, ports("idle", host), NOW)).quiet).toBe(false);
  for (const host of ["hosted", "unhosted", "dead"]) expect((await probeQuiet(snapshot, ports("unknown", host), NOW)).quiet).toBe(true);
});

test("active pipeline stages and recent operator input block", async () => {
  for (const cursor of ["spawning", "running", "reviewing", "committing"]) expect((await probeQuiet(snapshot, ports("idle", "hosted", cursor), NOW)).blockers.stages).toBe(1);
  expect((await probeQuiet(snapshot, ports("idle", "hosted", "pending", 9), NOW)).quiet).toBe(false);
  expect((await probeQuiet(snapshot, ports("idle", "hosted", "pending", 11), NOW)).quiet).toBe(true);
});

test("an unreadable runtime snapshot fails closed", async () => {
  const p = ports();
  p.runtimeSnapshot = async () => { throw new Error("socket unavailable"); };
  expect(await probeQuiet(snapshot, p, NOW)).toMatchObject({ quiet: false, blockers: { unreadable: "socket unavailable" } });
});

test("a pending restart or a launcher still starting blocks; closed stages do not", async () => {
  const p = ports();
  p.pipelines = () => [{ state: "closed", cursor: { state: "running" } }] as unknown as ReturnType<QuietPorts["pipelines"]>;
  expect((await probeQuiet(snapshot, p, NOW)).quiet).toBe(true);
  expect((await probeQuiet({ ...snapshot, busy: "restart-web" }, p, NOW)).blockers.busy).toBe(true);
  expect((await probeQuiet({ ...snapshot, processes: { ...snapshot.processes, web: { ...snapshot.processes.web, state: "starting" } } }, p, NOW)).quiet).toBe(false);
});

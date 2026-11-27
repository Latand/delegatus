import { expect, test, runSeatTickCheck, PROJECT, NOW, MINUTE, harness, OVERDUE } from "./seatTickController.fixture";
import { seatTickMachineLine } from "./seatTickSources";
import { seatTickWakeMessage } from "./report";
import { observeMemoryPressure, memoryThresholds, type MemoryReading } from "@/lib/state/memoryPressure";

const GIB = 1024 ** 3;
const reading = (swapGib: number, tmpBytes: number): MemoryReading => ({
  ram: { usedBytes: 20 * GIB, totalBytes: 64 * GIB },
  swap: { usedBytes: swapGib * GIB, totalBytes: 32 * GIB },
  tmp: { usedBytes: tmpBytes, totalBytes: 32 * GIB, tmpfs: true, view: "own" },
});
const sweep = { at: "2026-11-26T09:58:00.000Z", summary: "", stray: { maxAgeHours: 12, removed: 3, removedBytes: 2.5e9, agentLedger: 2, deferred: 1 } };

test("the machine line names RAM, swap, the tmpfs /tmp and what the last sweep removed", () => {
  const calm = observeMemoryPressure(reading(4, 1e9), null, "2026-11-26T10:00:00Z", memoryThresholds({}));
  expect(seatTickMachineLine(null, sweep as never)).toBeNull();
  expect(seatTickMachineLine(calm, null)).toBe("Machine memory: RAM 20.0 GiB of 64.0 GiB used; swap 4.0 GiB of 32.0 GiB (13%); /tmp 0.9 GiB in tmpfs of 32.0 GiB.");
  expect(seatTickMachineLine(calm, sweep as never)).toEndWith(" Last temp sweep at 2026-11-26T09:58:00.000Z: removed 3 stray directories older than 12 h from /tmp and /var/tmp (2.50 GB), 1 deferred.");
  expect(seatTickMachineLine(calm, { ...sweep, stray: { ...sweep.stray, removed: 1 } } as never)).toContain("removed 1 stray directory older");
  // A sweep record without stray counts (an older helper) adds nothing.
  expect(seatTickMachineLine(calm, { at: sweep.at, summary: "" } as never)).toBe(seatTickMachineLine(calm, null));
});

test("the machine line rides the reserved tail, so a long agenda never cuts it", () => {
  const machine = "Machine memory: RAM 20.0 GiB of 64.0 GiB used; swap 29.0 GiB of 32.0 GiB (91%); /tmp 7.7 GiB in tmpfs of 32.0 GiB.";
  const input = { project: "one", reasons: [], items: [{ kind: "task" as const, id: "one", label: "a board sentence ".repeat(400) }], deferred: 0, signals: [], monitorPrompt: "brief",
    workers: { limit: 8, source: "machine", machine: 8, running: 7 } };
  const body = seatTickWakeMessage({ ...input, machine });
  expect(body.length).toBeLessThanOrEqual(4000);
  expect(body).toContain("…");
  expect(body).toContain(machine);
  expect(seatTickWakeMessage(input)).not.toContain("Machine memory");
  // With a report ledger large enough to shorten the note, the line and the worker limit both stay.
  const reportLines = Array.from({ length: 30 }, (_, n) => `key lane:fixture-${n}:completed — report the finished fixture lane ${n}`);
  const ledgered = seatTickWakeMessage({ ...input, machine, reportLines, monitorPrompt: "note ".repeat(200) });
  expect(ledgered).toContain(machine);
  expect(ledgered).toContain("Worker limit here: 8");
  for (const line of reportLines) expect(ledgered).toContain(line);
});

test("a seat wake carries the machine line, and a pressure episode is one agenda item until it ends", async () => {
  const rig = harness({ state: OVERDUE });
  let now = NOW;
  rig.deps.sources!.now = () => now;
  rig.deps.sources!.workerAsks = async () => [{ id: "parked-build", key: "lane:parked-build:decision",
    label: "Repair exporter: resolve the failed build", sinceMs: NOW - 120 * MINUTE,
    seatOwnedLane: { id: "parked-build", title: "Repair exporter", reason: "decision: build failed", sinceMs: NOW - 120 * MINUTE } }];
  let pressure = observeMemoryPressure(reading(29, 8.3e9), null, new Date(NOW).toISOString(), memoryThresholds({}));
  rig.deps.sources!.memoryPressure = () => pressure;
  rig.deps.sources!.tempSweep = () => sweep as never;

  expect((await runSeatTickCheck(PROJECT, rig.deps))?.verdict).toBe("wake");
  const first = rig.sent.at(-1)!.text;
  expect(first).toContain("Machine memory: RAM 20.0 GiB of 64.0 GiB used; swap 29.0 GiB of 32.0 GiB (91%)");
  expect(first).toContain("removed 3 stray directories");
  expect(first).toContain("Memory pressure: RAM 20.0 GiB");

  // The next wake, same episode, still shows the line but not the item again.
  now = NOW + 60 * MINUTE;
  pressure = observeMemoryPressure(reading(28, 8.3e9), pressure, new Date(now).toISOString(), memoryThresholds({}));
  expect((await runSeatTickCheck(PROJECT, rig.deps))?.verdict).toBe("wake");
  const second = rig.sent.at(-1)!.text;
  expect(second).toContain("swap 28.0 GiB of 32.0 GiB");
  expect(second).not.toContain("Memory pressure: RAM");

  // A failed reading leaves the line out and the wake intact.
  now = NOW + 120 * MINUTE;
  rig.deps.sources!.memoryPressure = () => { throw new Error("meminfo unreadable"); };
  expect((await runSeatTickCheck(PROJECT, rig.deps))?.verdict).toBe("wake");
  expect(rig.sent.at(-1)!.text).not.toContain("Machine memory");
});

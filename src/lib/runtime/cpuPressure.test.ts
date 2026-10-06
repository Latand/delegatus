import { expect, test } from "bun:test";

import { CpuPressureGate, cpuPressureHoldDetail, cpuPressurePolicy, DEFAULT_CPU_PRESSURE_POLICY, isCpuPressureDetail, parseCpuPressure, waitForCpuPressure } from "./cpuPressure";

function gate(samples: (number | null | Error)[]) {
  let now = 0;
  const gate = new CpuPressureGate(DEFAULT_CPU_PRESSURE_POLICY, {
    sample: () => { const next = samples.shift(); if (next instanceof Error) throw next; return next ?? null; },
    now: () => now,
  });
  return { gate, at: (ms: number) => { now = ms; return gate.check(); } };
}

test("reads some avg10 from the kernel's pressure file", () => {
  expect(parseCpuPressure("some avg10=60.05 avg60=19.53 avg300=21.35 total=50459107463\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n")).toBe(60.05);
  expect(parseCpuPressure("full avg10=3.00 avg60=0.00 avg300=0.00 total=0\n")).toBeNull();
  expect(parseCpuPressure("")).toBeNull();
});

test("holds at 20%, releases only after ten seconds below 10%, and defers visibly after 120 s", () => {
  const { at } = gate([5, 25, 15, 9, 12, 9, 9, 9, 30]);
  expect(at(0)).toBeNull();
  expect(at(1_000)).toMatchObject({ since: 1_000, avg10: 25, deferred: false });
  expect(at(2_000)).not.toBeNull(); // 15%: between the thresholds keeps the hold
  expect(at(3_000)).not.toBeNull(); // 9%: the release window starts
  expect(at(8_000)).not.toBeNull(); // 12%: the window restarts
  expect(at(9_000)).not.toBeNull();
  expect(at(18_000)).not.toBeNull(); // nine seconds below
  expect(at(19_000)).toBeNull(); // ten seconds below
  const held = at(200_000)!;
  expect(held).toMatchObject({ since: 200_000, deferred: false });
  expect(cpuPressureHoldDetail(held)).toBe("stage start held for CPU pressure since 1970-01-01T00:03:20.000Z (avg10 30% ≥ 20%)");
});

test("the deferred reason appears after the admission budget and stays stable", () => {
  const { at } = gate([40, 50, 45]);
  const first = at(0)!;
  expect(at(119_000)!.deferred).toBe(false);
  const deferred = at(120_000)!;
  expect(deferred.deferred).toBe(true);
  expect(cpuPressureHoldDetail(deferred)).toBe(cpuPressureHoldDetail({ ...first, deferred: true }));
  expect(cpuPressureHoldDetail(deferred)).toStartWith("stage start deferred by CPU pressure: held since 1970-01-01T00:00:00.000Z (avg10 40% ≥ 20%)");
});

test("a failed sample admits: the scope quotas still bound the work", () => {
  const { at } = gate([50, null, new Error("EACCES"), 50]);
  expect(at(0)).not.toBeNull();
  expect(at(1_000)).toBeNull();
  expect(at(2_000)).toBeNull();
  expect(at(3_000)).toMatchObject({ since: 3_000 });
});

test("operator settings tune or turn off the thresholds", () => {
  expect(cpuPressurePolicy({})).toEqual(DEFAULT_CPU_PRESSURE_POLICY);
  expect(cpuPressurePolicy({ DELEGATUS_CPU_PRESSURE: "off" })).toBeNull();
  expect(cpuPressurePolicy({ LLV_CPU_PRESSURE: "off" })).toBeNull();
  expect(cpuPressurePolicy({ LLV_CPU_PRESSURE_HOLD: "35" })).toMatchObject({ holdAt: 35 });
  expect(cpuPressurePolicy({ DELEGATUS_CPU_PRESSURE_HOLD: "40", DELEGATUS_CPU_PRESSURE_RELEASE: "60" })).toMatchObject({ holdAt: 40, releaseBelow: 40 });
  expect(cpuPressurePolicy({ DELEGATUS_CPU_PRESSURE_HOLD: "x" })).toMatchObject({ holdAt: 20 });
});

test("a waiting start reports each reason once, names its subject and resolves on admission", async () => {
  let now = 0;
  const samples = [50, 50, 50, 5, 5];
  const gate = new CpuPressureGate(DEFAULT_CPU_PRESSURE_POLICY, { sample: () => { now += 60_000; return samples.shift() ?? 5; }, now: () => now });
  const reasons: string[] = [];
  expect(await waitForCpuPressure(gate, { subject: "update-build", onReason: (reason) => reasons.push(reason), pollMs: 1 })).toBe(true);
  expect(reasons).toHaveLength(2);
  expect(reasons[0]).toStartWith("update-build held for CPU pressure since ");
  expect(reasons[1]).toStartWith("update-build deferred by CPU pressure: held since ");
  expect(isCpuPressureDetail(reasons[1], "update-build")).toBe(true);
  expect(isCpuPressureDetail(reasons[1], "setup")).toBe(false);
  expect(await waitForCpuPressure(null, { subject: "x", onReason: () => { throw new Error("no reason without a gate"); } })).toBe(true);
});

test("an aborted wait answers false and starts nothing", async () => {
  const gate = new CpuPressureGate(DEFAULT_CPU_PRESSURE_POLICY, { sample: () => 90, now: Date.now });
  const abort = new AbortController();
  const waiting = waitForCpuPressure(gate, { subject: "update-install", onReason: () => {}, signal: abort.signal, pollMs: 60_000 });
  abort.abort();
  expect(await waiting).toBe(false);
});

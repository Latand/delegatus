import { expect, test } from "bun:test";
import { DEFAULT_CPU_PRESSURE_POLICY } from "./cpuPressure";
import { GateCpuPressure, GATE_LOAD_PER_CPU_LIMIT } from "./gateCpuPressure";

function fixture() {
  let now = 0, psi: number | null = 30, load = 0;
  const gate = new GateCpuPressure(DEFAULT_CPU_PRESSURE_POLICY, {
    now: () => now, pressure: async () => psi, loadPerCpu: () => load,
  });
  return { gate, at: (time: number) => { now = time; }, psi: (value: number | null) => { psi = value; }, load: (value: number) => { load = value; } };
}

test("measured pressure holds beyond ten minutes and releases only after a sustained low sample", async () => {
  const f = fixture();
  const reason = await f.gate.check();
  expect(reason).toContain("measured CPU pressure");
  f.at(600_001);
  expect(await f.gate.check()).toBe(reason);
  f.psi(19); f.at(610_000);
  expect(await f.gate.check()).toBe(reason);
  f.psi(20); f.at(619_999);
  expect(await f.gate.check()).toBe(reason);
  f.psi(19); f.at(620_000);
  expect(await f.gate.check()).toBe(reason);
  f.at(630_000);
  expect(await f.gate.check()).toBeNull();
});

test("missing PSI uses measured load per CPU including its exact threshold", async () => {
  const f = fixture(); f.psi(null);
  for (const load of [GATE_LOAD_PER_CPU_LIMIT, 1, 4]) {
    f.load(load);
    expect(await f.gate.check()).toContain("measured CPU load below 0.75 per CPU");
  }
  f.load(GATE_LOAD_PER_CPU_LIMIT - 0.001);
  expect(await f.gate.check()).toBeNull();
});

test("unreadable and malformed measurements wait; a recovered measurement admits", async () => {
  const f = fixture();
  for (const psi of [null, NaN, Infinity]) {
    f.psi(psi); f.load(NaN);
    expect(await f.gate.check()).toBe("Waiting for a readable CPU pressure or load sample");
    f.load(0);
    expect(await f.gate.check()).toBeNull();
  }
  const gate = new GateCpuPressure(DEFAULT_CPU_PRESSURE_POLICY, {
    now: () => 0, pressure: async () => { throw new Error("unreadable"); }, loadPerCpu: () => { throw new Error("unavailable"); },
  });
  expect(await gate.check()).toContain("readable CPU pressure or load sample");
});

test("off skips measurement; a pending sample yields to other work", async () => {
  const off = new GateCpuPressure(null, { now: () => 0, pressure: async () => { throw new Error("must not read"); }, loadPerCpu: () => NaN });
  expect(await off.check()).toBeNull();
  let resolve!: (sample: number) => void;
  const gate = new GateCpuPressure(DEFAULT_CPU_PRESSURE_POLICY, {
    now: () => 0, pressure: () => new Promise<number>(done => { resolve = done; }), loadPerCpu: () => NaN,
  });
  const pending = gate.check();
  await new Promise<void>(done => setTimeout(done, 0));
  resolve(0);
  expect(await pending).toBeNull();
});

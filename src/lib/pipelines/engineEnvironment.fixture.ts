import { afterAll, expect, spyOn } from "bun:test";
import fs from "node:fs";
import { setMachineCpuPressureForTests } from "@/lib/runtime/cpuPressure";
import type { SelfUpdateService } from "@/lib/selfUpdate/service";

// These integration tests supply their own hosts and load samples. Pin the
// fallback paths too, before the engine's module graph is evaluated.
const names = ["RUNTIME_HOST_SOCKET", "VIEWER_CONTROL_URL", "VIEWER_CONTROL_TOKEN", "VIEWER_PORT", "TOKEN",
  "STATE_OWNER", "AGENT_REGISTRY_SQLITE", "SPAWN_CAPABILITY", "LAUNCHER_RECORD"];
const saved = new Map<string, string | undefined>();
saved.set("DELEGATUS_STATE_DIR", process.env.DELEGATUS_STATE_DIR);
delete process.env.DELEGATUS_STATE_DIR;
for (const name of names) for (const prefix of ["LLV_", "DELEGATUS_"]) {
  const key = prefix + name;
  saved.set(key, process.env[key]);
  delete process.env[key];
}
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
setMachineCpuPressureForTests(null);

const readFile = fs.readFileSync;
let cpuReads = 0;
export const guardedReadFile = ((...args: Parameters<typeof fs.readFileSync>) => {
  if (String(args[0]) === "/proc/pressure/cpu") {
    cpuReads++;
    throw new Error("Engine tests must inject their CPU sample");
  }
  return readFile(...args);
}) as typeof fs.readFileSync;
// Keep this as an ordinary wrapper. Bun reuses a nested spy for this method,
// whose mockRestore() would otherwise restore the native reader and remove the
// CPU guard for the remainder of the suite.
fs.readFileSync = guardedReadFile;
export function assertCpuReadGuardSurvivesSpyRestoration() {
  expect(fs.readFileSync).toBe(guardedReadFile);
  const readsBeforeProbe = cpuReads;
  expect(() => fs.readFileSync("/proc/pressure/cpu", "utf8")).toThrow("Engine tests must inject their CPU sample");
  expect(cpuReads).toBe(readsBeforeProbe + 1);
  cpuReads = readsBeforeProbe;
}
afterAll(() => {
  fs.readFileSync = readFile;
  setMachineCpuPressureForTests(undefined);
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  expect(cpuReads).toBe(0);
});

/** startAuto launches a tick without returning it. Await that exact call so
    later observations cannot race an earlier snapshot under CPU contention. */
export async function startAutoAndSettle(service: SelfUpdateService, onStarted: () => void = () => {}) {
  const tick = spyOn(service, "autoTick");
  try {
    service.startAuto();
    onStarted();
    expect(tick).toHaveBeenCalledTimes(1);
    await tick.mock.results[0]!.value;
  } finally { tick.mockRestore(); }
}

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GateTasks, gateTaskFailure, gateTaskResult, gateTaskDiagnostics, warnGateTaskFallback } from "./gate-tasks";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-tasks-")); roots.push(root);
  const write = (file: string, value: string) => fs.writeFileSync(path.join(root, file), value);
  write("pids.max", "256\n"); write("pids.current", "12\n"); write("pids.peak", "37\n"); write("pids.events", "max 0\n");
  return { root, write, tasks: new GateTasks(root) };
}

test("verifies kernel enforcement and retains its peak after collection", () => {
  const { root, tasks } = fixture();
  expect(tasks.verify(256)).toBe("limited");
  fs.rmSync(root, { recursive: true });
  expect(tasks.sample()).toEqual({ max: "256", peak: 37, peakSource: "kernel", denied: 0 });
  expect(gateTaskResult("owned.service", tasks.snapshot)).toContain("pids.peak=37 pids.max=256 pids.events:max=0");
});

test("a denial stays named after the command exits or the monitor restarts", () => {
  const { root, tasks, write } = fixture();
  tasks.sample();
  write("pids.current", "1\n"); write("pids.events", "max 2\n");
  expect(tasks.sample().denied).toBe(2);
  const restarted = new GateTasks(root).sample();
  expect(restarted.denied).toBe(2);
  expect(gateTaskFailure("owned.service", restarted)).toBe("GATE_TASK_LIMIT_REACHED: task limit reached in owned.service (pids.max=256, pids.events:max=2)");
});

test("old kernels retain a labelled sampled peak", () => {
  const { root, write, tasks } = fixture(); fs.unlinkSync(path.join(root, "pids.peak"));
  tasks.sample(); write("pids.current", "2\n");
  expect(tasks.sample().peak).toBe(12);
  expect(gateTaskResult("owned.service", tasks.snapshot)).toContain("pids.peak=12 (sampled lower bound)");
});

test("missing controller warns once across nested environments and keeps execution available", () => {
  const { root } = fixture(); const absent = path.join(root, "no-controller");
  expect(new GateTasks(absent).verify(256)).toBe("unavailable");
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" }, warnings: string[] = [];
  warnGateTaskFallback("no pids controller", env, line => warnings.push(line));
  warnGateTaskFallback("no user manager", { ...env }, line => warnings.push(line));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("no pids controller");
});

for (const max of ["max", "512", "garbage"]) test(`refuses an unenforced or malformed limit: ${max}`, () => {
  const { tasks, write } = fixture(); write("pids.max", max);
  expect(() => tasks.verify(256)).toThrow();
});
test("an unreadable denial counter cannot silently authorize execution", () => {
  const { root, tasks, write } = fixture();
  write("pids.events", "unexpected 0\n"); expect(() => tasks.verify(256)).toThrow("pids.events:max");
  fs.unlinkSync(path.join(root, "pids.events")); expect(() => tasks.verify(256)).toThrow("pids.events:max");
});

test("the comparator reads every producer result and preserves the outer unit's reason", () => {
  for (const snapshot of [
    { max: "256", peak: 37, peakSource: "kernel" as const, denied: 0 },
    { max: "256", peak: 256, peakSource: "sampled" as const, denied: 2 },
    { max: null, peak: null, peakSource: "sampled" as const, denied: 0 },
  ]) {
    const output = `${gateTaskResult("nested.service", snapshot)}\n${gateTaskFailure("nested.service", snapshot)}\n${gateTaskResult("outer.service", snapshot)}\n`;
    expect(gateTaskDiagnostics(output).peak).toBe(gateTaskResult("outer.service", snapshot).replace("gate-slot: ", ""));
    expect(gateTaskDiagnostics(output).failure).toBeNull();
    const failed = output + gateTaskFailure("outer.service", snapshot);
    expect(gateTaskDiagnostics(failed).failure).toBe(gateTaskFailure("outer.service", snapshot));
  }
  expect(gateTaskDiagnostics("portable fallback")).toEqual({ peak: null, failure: null });
});

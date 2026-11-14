import { expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import { cpuInheritedWaitMs, cpuWaitBudget, cpuWaitElapsed } from "./cpuAdmissionBudget";
import { realExec } from "../workflows/provision";

test("bounded wait observations stop at their entry limit and retain interval union accounting", () => {
  const budget = cpuWaitBudget({ NODE_ENV: "test" });
  try {
    fs.writeFileSync(`${budget.directory}/one.json`, JSON.stringify({ start: 100, end: 300 }));
    fs.writeFileSync(`${budget.directory}/two.json`, JSON.stringify({ start: 200, end: 400 }));
    expect(cpuWaitElapsed(budget.directory, 500, 2)).toBe(300);
    expect(() => cpuWaitElapsed(budget.directory, 500, 1)).toThrow("observation bound");
    expect(cpuWaitElapsed(budget.directory, 500, 2)).toBe(300);
  } finally { budget.close(); }
});

test.each(["{", JSON.stringify({ start: 300, end: 200 })])("unknown wait accounting is rejected: %s", row => {
  const budget = cpuWaitBudget({ NODE_ENV: "test" });
  try {
    fs.writeFileSync(`${budget.directory}/unknown.json`, row);
    expect(() => cpuWaitElapsed(budget.directory, 500)).toThrow();
  } finally { budget.close(); }
});

test("oversized wait markers are rejected before their payload is read", () => {
  const budget = cpuWaitBudget({ NODE_ENV: "test" });
  const file = `${budget.directory}/large.json`;
  try {
    fs.writeFileSync(file, JSON.stringify({ start: 1, end: 2, padding: "x".repeat(128 * 1024) }));
    const read = spyOn(fs, "readSync");
    try {
      expect(() => cpuWaitElapsed(budget.directory)).toThrow("byte observation bound");
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  } finally { budget.close(); }
});

test("parallel waits count their union; ended waits still extend the next check", () => {
  const budget = cpuWaitBudget({ NODE_ENV: "test" });
  const dir = JSON.parse(budget.env.LLV_CPU_WAIT_ROOTS!)[0];
  try {
    fs.writeFileSync(`${dir}/one.json`, JSON.stringify({ start: 100, end: 300 }));
    fs.writeFileSync(`${dir}/two.json`, JSON.stringify({ start: 200, end: 400 }));
    fs.writeFileSync(`${dir}/three.json`, JSON.stringify({ start: 450, end: 500 }));
    expect(cpuWaitElapsed(dir, 500)).toBe(350);
    const nested = cpuWaitBudget(budget.env);
    try { expect(cpuInheritedWaitMs(nested.env)).toBe(0); }
    finally { nested.close(); }
    expect(cpuInheritedWaitMs(budget.env)).toBe(350);
  } finally { budget.close(); }
});

test("a caller's finite command timeout excludes gate waiting and still stops execution", async () => {
  const script = 'import { reportCpuWait } from "./src/lib/runtime/cpuAdmissionBudget"; const end = reportCpuWait(); await Bun.sleep(800); end(); await Bun.sleep(Number(process.argv[1]));';
  const pass = await realExec(process.execPath, ["-e", script, "30"], process.cwd(), undefined, { timeoutMs: 400 });
  expect(pass.code, pass.stderr).toBe(0);
  const fail = await realExec(process.execPath, ["-e", script, "800"], process.cwd(), undefined, { timeoutMs: 400 });
  expect(fail.code).toBeNull();
  expect(fail.stderr).toStartWith("command timed out after 400ms");
}, 10_000);

test("cancellation remains immediate during an excluded wait", async () => {
  const signal = new AbortController();
  const script = 'import { reportCpuWait } from "./src/lib/runtime/cpuAdmissionBudget"; reportCpuWait(); await Bun.sleep(10000);';
  const command = realExec(process.execPath, ["-e", script], process.cwd(), undefined, { signal: signal.signal, timeoutMs: 500 });
  await Bun.sleep(150); signal.abort();
  const result = await command;
  expect(result.code).toBeNull();
  expect(result.stderr).toStartWith("command cancelled");
}, 5_000);

test("corrupt wait accounting expires an owned command through cleanup instead of escaping its timer", async () => {
  const script = 'import fs from "node:fs"; import path from "node:path"; const root = JSON.parse(process.env.LLV_CPU_WAIT_ROOTS).at(-1); fs.writeFileSync(path.join(root, "corrupt.json"), "{"); await Bun.sleep(2000);';
  const result = await realExec(process.execPath, ["-e", script], process.cwd(), undefined, { timeoutMs: 300 });
  expect(result.code).toBeNull();
  expect(result.stderr).toStartWith("command timed out after 300ms");
}, 5_000);

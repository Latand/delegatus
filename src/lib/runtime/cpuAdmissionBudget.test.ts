import { expect, test } from "bun:test";
import fs from "node:fs";
import { cpuWaitBudget, cpuWaitElapsed } from "./cpuAdmissionBudget";
import { realExec } from "../workflows/provision";

test("parallel waits count their union; ended waits still extend the next check", () => {
  const budget = cpuWaitBudget({ NODE_ENV: "test" });
  const dir = JSON.parse(budget.env.LLV_CPU_WAIT_ROOTS!)[0];
  try {
    fs.writeFileSync(`${dir}/one.json`, JSON.stringify({ start: 100, end: 300 }));
    fs.writeFileSync(`${dir}/two.json`, JSON.stringify({ start: 200, end: 400 }));
    fs.writeFileSync(`${dir}/three.json`, JSON.stringify({ start: 450, end: 500 }));
    expect(cpuWaitElapsed(dir, 500)).toBe(350);
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

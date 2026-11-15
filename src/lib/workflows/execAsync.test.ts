import { expect, spyOn, test } from "bun:test";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

import { realExec } from "./provision";
import * as cpuBudget from "@/lib/runtime/cpuAdmissionBudget";

test("the production executor yields while an external command is in flight", async () => {
  let readRan = false;
  const read = new Promise<void>((resolve) => setTimeout(() => { readRan = true; resolve(); }, 10));
  const result = await realExec("sh", ["-c", "sleep 0.15; printf observed"], os.tmpdir());
  expect(readRan).toBe(true);
  expect(result).toMatchObject({ code: 0, stdout: "observed" });
  await read;
});

test.each(["deadline", "cancellation"] as const)("the executor closes its owned process tree and preserves an independent child: %s", async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "executor-owned-"));
  const marker = path.join(root, "pids");
  const abort = new AbortController();
  // Delay shell startup past the old 500ms deadline. Expiry is released only
  // after both owned PIDs exist; the real timer is covered separately below.
  const shell = path.join(root, "sh");
  fs.writeFileSync(shell, '#!/bin/sh\n/bin/sleep 0.75\nexec /bin/sh "$@"\n', { mode: 0o700 });
  let expire: (() => void) | undefined;
  let timerClosed = false;
  const timer = spyOn(cpuBudget, "cpuBudgetTimer").mockImplementation((_ms, _waited, callback) => {
    expire = callback;
    return () => { timerClosed = true; };
  });
  const sentinel = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  const command = realExec(shell, ["-c", 'echo "$$" > "$OWNED_PIDS"; sleep 30 & echo "$!" >> "$OWNED_PIDS"; wait'], root,
    { OWNED_PIDS: marker }, { signal: abort.signal, timeoutMs: 500 });
  try {
    for (let n = 0; n < 400 && (!fs.existsSync(marker) || fs.readFileSync(marker, "utf8").trim().split(/\s+/).length < 2); n++) await Bun.sleep(10);
    expect(fs.existsSync(marker), "the owned shell must report readiness").toBe(true);
    const pids = fs.readFileSync(marker, "utf8").trim().split(/\s+/).map(Number);
    expect(pids).toHaveLength(2);
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(pids.map(alive)).toEqual([true, true]);
    expect(timer).toHaveBeenCalledTimes(1);
    expect(timer.mock.calls[0][0]).toBe(500);
    expect(expire).toBeDefined();
    if (mode === "cancellation") abort.abort();
    else expire!();
    expect(await command).toMatchObject({ code: null, signal: "SIGKILL", stderr: mode === "deadline" ? "command timed out after 500ms" : "command cancelled" });
    expect(timerClosed).toBe(true);
    for (let n = 0; n < 200 && pids.some(alive); n++) await Bun.sleep(10);
    expect(pids.map(alive)).toEqual([false, false]);
    expect(alive(sentinel.pid)).toBe(true);
    expect(sentinel.exitCode).toBeNull();
  } finally {
    abort.abort(); await command;
    timer.mockRestore();
    sentinel.kill(); await sentinel.exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("timeouts and output bounds terminate external commands", async () => {
  expect(await realExec("sh", ["-c", "sleep 30"], os.tmpdir(), undefined, { timeoutMs: 30 }))
    .toMatchObject({ code: null, stderr: "command timed out after 30ms" });
  const overflow = await realExec("sh", ["-c", "while true; do printf 1234567890; done"], os.tmpdir(), undefined, { maxOutputBytes: 128 });
  expect(overflow.code).toBeNull();
  expect(overflow.stderr).toContain("command output exceeded its byte limit");
  expect(Buffer.byteLength(overflow.stdout)).toBeLessThanOrEqual(128);
});

test("a command that cannot launch returns a failure", async () => {
  expect((await realExec("missing-command-for-executor-test", [], os.tmpdir())).code).toBeNull();
});

test("byte-preserving stdout keeps Git path bytes within their original output limit", async () => {
  const result = await realExec(process.execPath, ["-e", "process.stdout.write(Buffer.from([195,40,255]))"], os.tmpdir(), undefined,
    { stdoutEncoding: "latin1", maxOutputBytes: 3 });
  expect(result.code).toBe(0);
  expect(Buffer.from(result.stdout, "latin1")).toEqual(Buffer.from([195, 40, 255]));
});

test("pre-cancelled execution starts no child", async () => {
  const abort = new AbortController(); abort.abort();
  const result = await realExec(process.execPath, ["-e", "process.stdout.write('started')"], os.tmpdir(), undefined, { signal: abort.signal });
  expect(result).toMatchObject({ code: null, stdout: "", stderr: "command cancelled" });
});

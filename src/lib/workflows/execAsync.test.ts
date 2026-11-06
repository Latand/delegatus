import { expect, test } from "bun:test";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

import { realExec } from "./provision";

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
  const sentinel = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  const command = realExec("sh", ["-c", 'echo "$$" > "$OWNED_PIDS"; sleep 30 & echo "$!" >> "$OWNED_PIDS"; wait'], root,
    { OWNED_PIDS: marker }, { signal: abort.signal, timeoutMs: mode === "deadline" ? 500 : 5_000 });
  try {
    for (let n = 0; n < 400 && (!fs.existsSync(marker) || fs.readFileSync(marker, "utf8").trim().split(/\s+/).length < 2); n++) await Bun.sleep(10);
    const pids = fs.readFileSync(marker, "utf8").trim().split(/\s+/).map(Number);
    expect(pids).toHaveLength(2);
    if (mode === "cancellation") abort.abort();
    expect(await command).toMatchObject({ code: null, signal: "SIGKILL", stderr: mode === "deadline" ? "command timed out after 500ms" : "command cancelled" });
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let n = 0; n < 200 && pids.some(alive); n++) await Bun.sleep(10);
    expect(pids.map(alive)).toEqual([false, false]);
    expect(alive(sentinel.pid)).toBe(true);
    expect(sentinel.exitCode).toBeNull();
  } finally {
    abort.abort(); await command;
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

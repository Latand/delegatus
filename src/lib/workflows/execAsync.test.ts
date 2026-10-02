import { expect, test } from "bun:test";
import os from "node:os";

import { realExec } from "./provision";

test("the production executor yields while an external command is in flight", async () => {
  let readRan = false;
  const read = new Promise<void>((resolve) => setTimeout(() => { readRan = true; resolve(); }, 10));
  const result = await realExec("sh", ["-c", "sleep 0.15; printf observed"], os.tmpdir());
  expect(readRan).toBe(true);
  expect(result).toMatchObject({ code: 0, stdout: "observed" });
  await read;
});

test("cancellation closes an owned child and its inherited pipes", async () => {
  const abort = new AbortController();
  const command = realExec("sh", ["-c", "sleep 30 & wait"], os.tmpdir(), undefined, { signal: abort.signal });
  setTimeout(() => abort.abort(), 30);
  expect(await command).toMatchObject({ code: null, stderr: "command cancelled" });
});

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

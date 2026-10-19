import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { encodedPowerShellCommand, resetWindowsSnapshotForTests, windowsBackend, WINDOWS_PROCESS_SNAPSHOT_SCRIPT, type WindowsSnapshotCommandResult } from "./windows";
import { windowsProcessCwd } from "./windowsCwd";
import { normalizeWindowsCwd, parseWindowsProcessSnapshot, snapshotEntries } from "./windowsSnapshot";
import { windowsProcessIdentity } from "./windowsIdentity";
import { requireWindowsSnapshot } from "../../../scripts/verify-windows-snapshot";

/*
 * The live half of the Windows backend. Everything here talks to the running
 * operating system, so off win32 the cases skip and prove nothing — which is
 * why `platform-tests.yml` runs a step that fails when the runner is not
 * Windows before it runs this file. A silent skip would leave the job green and
 * the backend unexecuted, which is the failure mode issue #1256 shipped on the
 * macOS side.
 */

const windows = process.platform === "win32";
const SANDBOX = windows ? fs.mkdtempSync(path.join(os.tmpdir(), "llv-windows-proc-")) : "";
const children: Array<{ kill(): void; exited: Promise<unknown> }> = [];

afterAll(async () => {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  /* Windows will not remove a directory that is still some process's working
     directory, and a terminated child releases it only once it is reaped. */
  await Promise.all(children.map((child) => child.exited.catch(() => undefined)));
  try {
    if (SANDBOX) fs.rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    /* teardown, not an assertion: the runner's temp root goes with the job */
  }
});

/** A Bun child that idles in `cwd` until it is killed, with a known pid. */
function idleChild(cwd: string, extra: string[] = []): { pid: number; kill(): void; exited: Promise<unknown> } {
  fs.mkdirSync(cwd, { recursive: true });
  const child = Bun.spawn(
    [process.execPath, "-e", "setInterval(() => {}, 1000)", ...extra],
    { cwd, stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  );
  const handle = { pid: child.pid, kill: () => child.kill(), exited: child.exited };
  children.push(handle);
  return handle;
}

async function untilVisible(pid: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    resetWindowsSnapshotForTests();
    if (windowsBackend.readArgv(pid).length > 0) return;
    await Bun.sleep(250);
  }
  throw new Error(`the Win32_Process snapshot never listed pid ${pid}`);
}

test("the PowerShell script is handed over as an encoded command, not as quoting", () => {
  /* Pure: no layer between here and PowerShell — Node's Windows argument
     quoting, CreateProcess, PowerShell's own re-parse — can reinterpret the
     script when it travels as base64 UTF-16LE. */
  const encoded = encodedPowerShellCommand(WINDOWS_PROCESS_SNAPSHOT_SCRIPT);
  expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(WINDOWS_PROCESS_SNAPSHOT_SCRIPT);
  expect(WINDOWS_PROCESS_SNAPSHOT_SCRIPT).toContain("Get-CimInstance Win32_Process");
  expect(WINDOWS_PROCESS_SNAPSHOT_SCRIPT).toContain("ToFileTimeUtc()");
});

test("the backend reports no open-handle holders instead of guessing", () => {
  /* Windows has no shipped handle enumeration here. What degrades is stated in
     the README: liveness comes from mtime and attribution from argv. */
  const visits: string[] = [];
  windowsBackend.scanFdTargetsUnder("C:\\anything", (target) => visits.push(target));
  windowsBackend.scanFdTargetsFor(["C:\\anything"], (target) => visits.push(target));
  expect(visits).toEqual([]);
  expect(windowsBackend.pidHoldsPath(1, "C:\\anything")).toBe(false);
  expect(windowsBackend.pidWritesPath(1, "C:\\anything")).toBe(false);
  expect(windowsBackend.readEnvVar(1, "PATH")).toBeNull();
});

test.if(windows)("the snapshot lists this process with a parsed argv", async () => {
  await untilVisible(process.pid);
  const listed = windowsBackend.listProcesses().find((entry) => entry.pid === process.pid);
  expect(listed).toBeDefined();
  expect(path.basename(listed!.argv[0] ?? "").toLowerCase()).toContain("bun");
  expect(listed!.tty).not.toBe(0);
}, 30_000);

test.if(windows)("identity is stable for a live pid, differs between two children, and vanishes with them", async () => {
  const first = idleChild(path.join(SANDBOX, "identity-a"));
  const second = idleChild(path.join(SANDBOX, "identity-b"));

  const firstIdentity = windowsProcessIdentity(first.pid);
  const secondIdentity = windowsProcessIdentity(second.pid);
  expect(firstIdentity).toBeString();
  expect(secondIdentity).toBeString();
  expect(windowsProcessIdentity(first.pid)).toBe(firstIdentity!);
  /* Two processes started moments apart must not share a token, or the fence
     and every kill path would accept one in place of the other. */
  expect(firstIdentity).not.toBe(secondIdentity!);
  expect(windowsBackend.pidAlive(first.pid)).toBe(true);

  first.kill();
  await first.exited;
  /* `pidAlive` is `process.kill(pid, 0)`; on Windows libuv answers the
     existence question without terminating anything, and this is the assertion
     that proves it — the process must read as gone, and this test process must
     still be running afterwards. */
  const deadline = Date.now() + 10_000;
  while (windowsBackend.pidAlive(first.pid) && Date.now() < deadline) await Bun.sleep(100);
  expect(windowsBackend.pidAlive(first.pid)).toBe(false);
  expect(windowsProcessIdentity(first.pid)).toBeNull();

  second.kill();
}, 30_000);

test.if(windows)("a child's working directory is read out of its own process parameters", async () => {
  /* `agentProcesses` drops every process whose cwd is null, so this read is
     what makes a running `claude` visible on Windows at all. The directory name
     carries a space, which is the shape a real profile path has. */
  const requested = path.join(SANDBOX, "cwd probe");
  fs.mkdirSync(requested, { recursive: true });
  const cwd = fs.realpathSync.native(requested);
  const child = idleChild(cwd);
  await untilVisible(child.pid);

  /* The raw DosPath carries a trailing separator the rest of the codebase never
     writes, which is what `normalizeWindowsCwd` exists to strip. Compared
     case-insensitively too: NTFS preserves case but does not distinguish it, so
     the path the kernel reports need not match the case it was created with. */
  const raw = windowsProcessCwd(child.pid);
  expect(raw).toBeString();
  expect(normalizeWindowsCwd(raw!)?.toLowerCase()).toBe(cwd.toLowerCase());
  expect(windowsBackend.readCwd(child.pid)?.toLowerCase()).toBe(cwd.toLowerCase());
  child.kill();
}, 40_000);

test.if(windows)("the parent map links a child to this process", async () => {
  const child = idleChild(path.join(SANDBOX, "lineage"));
  await untilVisible(child.pid);

  expect(windowsBackend.ppidMap().get(child.pid)).toBe(process.pid);
  expect(windowsBackend.readPpid(child.pid)).toBe(process.pid);
  child.kill();
}, 40_000);

test.if(windows)("memory and CPU are reported for a live pid, and memory for the host", async () => {
  await untilVisible(process.pid);
  const memory = windowsBackend.processMemory([process.pid]).get(process.pid);
  expect(memory?.rssBytes ?? 0).toBeGreaterThan(0);
  expect(memory?.swapBytes).toBe(0);

  /* Unlike macOS, Windows counts per-process CPU in the snapshot already taken,
     so the liveness verdict gets a reading rather than "no evidence". */
  const cpuMs = windowsBackend.processCpuMs(process.pid);
  expect(cpuMs).not.toBeNull();
  expect(cpuMs!).toBeGreaterThanOrEqual(0);
  expect(windowsBackend.processCpuMs(-1)).toBeNull();

  const system = windowsBackend.systemMemory();
  expect(system?.ramTotal ?? 0).toBeGreaterThan(0);
  expect(system!.ramAvailable).toBeGreaterThan(0);
  expect(system!.ramAvailable).toBeLessThanOrEqual(system!.ramTotal);
}, 30_000);

describe("platform verifier snapshot retries", () => {
  const goodCsv = '"ProcessId","ParentProcessId","CommandLine"\r\n'
    + [10, 11, 12, 13, 14].map(pid => `"${pid}","10","bun.exe"`).join("\r\n");
  const good: WindowsSnapshotCommandResult = { stdout: goodCsv, stderr: "", status: 0, signal: null, error: null };
  const empty: WindowsSnapshotCommandResult = { ...good, stdout: "", stderr: "CIM query unavailable\r\n" };

  function harness(commands: WindowsSnapshotCommandResult[]) {
    const waits: number[] = [];
    const logs: string[] = [];
    const timeouts: number[] = [];
    let calls = 0;
    const result = requireWindowsSnapshot({
      attempt: timeoutMs => {
        timeouts.push(timeoutMs);
        const command = commands[Math.min(calls++, commands.length - 1)]!;
        const data = parseWindowsProcessSnapshot(command.error ? "" : command.stdout);
        return { command, listed: snapshotEntries(data, () => null, 1) };
      },
      sleep: async ms => { waits.push(ms); },
      log: line => { logs.push(line); },
    });
    return { result, waits, logs, timeouts, calls: () => calls };
  }

  test("a good first snapshot needs no retry or diagnostic", async () => {
    const run = harness([good]);
    expect((await run.result).map(row => row.pid)).toEqual([10, 11, 12, 13, 14]);
    expect(run.calls()).toBe(1);
    expect(run.waits).toEqual([]);
    expect(run.logs).toEqual([]);
  });

  test.each([1, 2])("%i empty attempts then good takes fresh snapshots with short backoff", async count => {
    const run = harness([...Array.from({ length: count }, () => empty), good]);
    expect((await run.result).length).toBe(5);
    expect(run.calls()).toBe(count + 1);
    expect(run.timeouts).toEqual(Array.from({ length: count + 1 }, () => 30_000));
    expect(run.waits).toEqual([250, 500].slice(0, count));
    expect(run.logs).toHaveLength(count);
    for (const [index, line] of run.logs.entries()) {
      expect(line).toBe(`Win32_Process snapshot attempt ${index + 1}/3 failed: ${JSON.stringify({ reason: "PowerShell exited successfully; the parsed snapshot is empty", timeoutMs: 30_000, ...empty, processes: 0 })}`);
    }
  });

  test("a cold-start timeout is named and can recover on a fresh attempt", async () => {
    const timeout = { ...empty, status: null, signal: "SIGTERM", error: "ETIMEDOUT: powershell.exe" };
    const run = harness([timeout, good]);
    expect((await run.result).length).toBe(5);
    expect(run.calls()).toBe(2);
    expect(run.timeouts).toEqual([30_000, 30_000]);
    expect(run.logs[0]).toContain('"reason":"PowerShell snapshot timed out after 30000 ms"');
    expect(run.logs[0]).toContain('"error":"ETIMEDOUT: powershell.exe"');
  });

  test("persistent timeouts fail with a timeout diagnosis", async () => {
    const run = harness([{ ...empty, status: null, error: "ETIMEDOUT: powershell.exe" }]);
    await expect(run.result).rejects.toThrow("snapshot failed after 3 attempts: PowerShell snapshot timed out after 30000 ms");
    expect(run.calls()).toBe(3);
  });

  test.each([
    ["always empty", empty],
    ["missing CSV column", { ...good, stdout: '"WrongColumn"\r\n"10"' }],
    ["header only", { ...good, stdout: '"ProcessId"\r\n' }],
    ["wrong encoding", { ...good, stdout: Buffer.from(goodCsv, "utf16le").toString("utf8") }],
    ["too few processes", { ...good, stdout: '"ProcessId"\r\n"10"' }],
    ["nonzero exit with parseable output", { ...good, status: 1, stderr: "query failed" }],
    ["missing PowerShell", { ...empty, status: null, error: "ENOENT: powershell.exe" }],
    ["timeout with partial output", { ...good, status: null, signal: "SIGTERM", error: "ETIMEDOUT: powershell.exe" }],
    ["signal with parseable output", { ...good, status: null, signal: "SIGTERM" }],
  ] satisfies [string, WindowsSnapshotCommandResult][])("%s fails hard after three attempts with all raw evidence", async (_name, command) => {
    const run = harness([command]);
    await expect(run.result).rejects.toThrow("snapshot failed after 3 attempts:");
    expect(run.calls()).toBe(3);
    expect(run.waits).toEqual([250, 500]);
    expect(run.timeouts).toEqual([30_000, 30_000, 30_000]);
    expect(run.logs).toHaveLength(3);
    for (const [index, line] of run.logs.entries()) {
      expect(line.startsWith(`Win32_Process snapshot attempt ${index + 1}/3 failed: `)).toBe(true);
      expect(JSON.parse(line.slice(line.indexOf("{")))).toMatchObject(command);
      expect(line.split("\n")).toHaveLength(1);
    }
  });
});

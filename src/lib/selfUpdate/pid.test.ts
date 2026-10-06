import { afterEach, expect, test } from "bun:test";

import { windowsStartIdentities, windowsStartIdentity } from "../../../bin/windows-process-identity.mjs";
import { forgetStartIdentities, IDENTITY_MEMORY_MS, primeStartIdentities, readStartIdentity, rememberedStartIdentity, sameProcess } from "./pid";

/* On Windows an identity is read by starting PowerShell, and the Update
   surface takes a snapshot every few seconds while any tab is open. This file
   runs on the native Windows job, so it imports nothing beyond the reader;
   the snapshot itself is counted in snapshotIdentity.test.ts. */
const FILETIME = "133000000000000000";
afterEach(() => forgetStartIdentities());

/* Answers the way powershell.exe does, for one PID or for a list. */
function shell(alive: (pid: number) => boolean = () => true) {
  const scripts: string[] = [];
  const run = ((_command: string, args: string[]) => {
    const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1]!, "base64").toString("utf16le");
    scripts.push(script);
    const list = /@\(([0-9,]+)\)/.exec(script)?.[1];
    if (list) return { status: 0, stdout: list.split(",").map(Number).filter(alive).map(pid => `${pid}:${FILETIME}`).join("\r\n") + "\r\n" };
    const pid = Number(/GetProcessById\((\d+)\)/.exec(script)?.[1]);
    return alive(pid) ? { status: 0, stdout: FILETIME } : { status: 1, stdout: "" };
  }) as never;
  return { run, scripts };
}

test("one PowerShell start answers for every PID of a record", () => {
  const { run, scripts } = shell(pid => pid !== 30);
  const identities = windowsStartIdentities([10, 20, 30, 20, -1, 1.5], run);
  expect(scripts).toHaveLength(1);
  expect([...identities]).toEqual([[10, `10:${FILETIME}`], [20, `20:${FILETIME}`]]);
  expect(identities.get(10)).toBe(readStartIdentity(10, "win32", run)!);
  // An answer for a PID nobody asked about, or one out of range, is dropped.
  expect([...windowsStartIdentities([10], (() => ({ status: 0, stdout: `11:${FILETIME}\n10:1\n` })) as never)]).toEqual([]);
  // PowerShell exits 1 when the last PID of the list is the one that is gone;
  // what it wrote for the others stands. A shell that never started wrote nothing.
  expect([...windowsStartIdentities([10, 30], (() => ({ status: 1, stdout: `10:${FILETIME}\r\n` })) as never)]).toEqual([[10, `10:${FILETIME}`]]);
  expect([...windowsStartIdentities([10], (() => ({ status: null, stdout: null, error: new Error("ENOENT") })) as never)]).toEqual([]);
  expect([...windowsStartIdentities([10], (() => { throw new Error("spawn failed"); }) as never)]).toEqual([]);
  expect([...windowsStartIdentities([], run)]).toEqual([]);
});

test("an identity that was read is remembered for a short while", () => {
  const { run, scripts } = shell();
  primeStartIdentities([10, 20, null, 30], "win32", run, 1_000);
  expect(scripts).toHaveLength(1);
  for (const pid of [10, 20, 30]) expect(rememberedStartIdentity(pid, "win32", run, 2_000)).toBe(`${pid}:${FILETIME}`);
  primeStartIdentities([10, 20, 30], "win32", run, 1_000 + IDENTITY_MEMORY_MS - 1);
  expect(scripts).toHaveLength(1);
  // After that it is read again, and so is a PID nobody read yet.
  expect(rememberedStartIdentity(10, "win32", run, 1_000 + IDENTITY_MEMORY_MS)).toBe(`10:${FILETIME}`);
  expect(rememberedStartIdentity(40, "win32", run, 2_000)).toBe(`40:${FILETIME}`);
  expect(scripts).toHaveLength(3);
  // A remembered identity that differs from the one a record names is read
  // again: the PID may have a new owner.
  expect(rememberedStartIdentity(20, "win32", run, 3_000, `20:${FILETIME}`)).toBe(`20:${FILETIME}`);
  expect(scripts).toHaveLength(3);
  expect(rememberedStartIdentity(20, "win32", run, 3_000, "20:133000000000000999")).toBe(`20:${FILETIME}`);
  expect(scripts).toHaveLength(4);
  // Linux reads /proc and starts nothing.
  primeStartIdentities([process.pid], "linux", run, 9_000);
  expect(scripts).toHaveLength(4);
});

/* The real shell, where there is one: the list read answers what the single
   read answers, which is what the launcher wrote into its record. */
if (process.platform === "win32") test("PowerShell answers a list of PIDs with what it answers for each", async () => {
  const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)"]);
  try {
    // Windows PIDs are multiples of four, so this one names no process.
    const absent = 999_999;
    const identities = windowsStartIdentities([process.pid, child.pid, absent]);
    expect(identities.get(process.pid)).toMatch(/^\d+:\d{18,19}$/);
    expect(identities.get(process.pid)).toBe(windowsStartIdentity(process.pid)!);
    expect(identities.get(child.pid)).toBe(windowsStartIdentity(child.pid)!);
    expect(identities.has(absent)).toBe(false);
    primeStartIdentities([process.pid, child.pid]);
    expect(sameProcess({ pid: child.pid, startIdentity: identities.get(child.pid)! })).toBe(true);
    expect(sameProcess({ pid: child.pid, startIdentity: `${child.pid}:133000000000000000` })).toBe(false);
  } finally { child.kill(); await child.exited; }
}, 60_000);

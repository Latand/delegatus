import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { procBackend } from "@/lib/proc";
import { startLeaderExitedChild, startUnreapedChild } from "@/lib/testing/unreapedChild";

import {
  captureProcessIdentity,
  sameRecordedProcessIdentity,
  processIdentityMayRun,
  processIdentityProvenDead,
  processIdentityStatus,
  systemBootEpoch,
  type ProcessIdentityProbe,
} from "./processIdentity";

function probe(overrides: Partial<ProcessIdentityProbe> = {}): ProcessIdentityProbe {
  return {
    pidAlive: () => true,
    processIdentity: (pid) => `${pid}:start`,
    bootEpoch: () => "boot-current",
    processExited: () => false,
    ...overrides,
  };
}

test("a matching pid and start token from an earlier boot is provably dead", () => {
  expect(processIdentityStatus({
    pid: 42,
    startIdentity: "42:start",
    bootEpoch: "boot-earlier",
  }, probe())).toBe("dead");
});

test("a recycled pid with a different start token is provably dead", () => {
  expect(processIdentityStatus({
    pid: 42,
    startIdentity: "42:earlier",
    bootEpoch: "boot-current",
  }, probe())).toBe("dead");
});

test("a complete matching identity is verified alive", () => {
  expect(processIdentityStatus({
    pid: 42,
    startIdentity: "42:start",
    bootEpoch: "boot-current",
  }, probe())).toBe("alive");
});

test("a legacy identity with no boot epoch stays unverified while its pid matches", () => {
  expect(processIdentityStatus({ pid: 42, startIdentity: "42:start" }, probe())).toBe("unverified");
});

test("an unreadable live pid stays outside proven-dead authority", () => {
  const identity = { pid: 42, startIdentity: "42:start", bootEpoch: "boot-current" };
  expect(processIdentityProvenDead(identity, probe({ processIdentity: () => null }))).toBeFalse();
});

test("an absent pid is proven dead", () => {
  const identity = { pid: 42, startIdentity: "42:start", bootEpoch: "boot-current" };
  expect(processIdentityProvenDead(identity, probe({ pidAlive: () => false }))).toBeTrue();
});

test("capture records pid, start token, and boot epoch together", () => {
  expect(captureProcessIdentity(42, probe())).toEqual({
    pid: 42,
    startIdentity: "42:start",
    bootEpoch: "boot-current",
  });
});

test.skipIf(process.platform !== "linux")("the Linux boot epoch binds the current pid namespace", () => {
  const namespace = fs.readlinkSync("/proc/self/ns/pid");
  expect(systemBootEpoch()).toContain(`pidns:${namespace}`);
});

test("an exited, unreaped process can no longer run however its identity reads (#2967)", () => {
  const identity = { pid: 42, startIdentity: "42:start", bootEpoch: "boot-current" };
  expect(processIdentityMayRun(identity, probe({ processExited: () => true }))).toBeFalse();
  /* A pid held in state Z cannot belong to another process, so a recorded
     identity that cannot be verified is not running there either. */
  expect(processIdentityMayRun({ pid: 42, startIdentity: null }, probe({ processExited: () => true }))).toBeFalse();
});

test("may-run keeps unknown state and pid reuse fenced (#2967)", () => {
  const identity = { pid: 42, startIdentity: "42:start", bootEpoch: "boot-current" };
  expect(processIdentityMayRun(identity, probe())).toBeTrue();
  /* An unreadable stat answers no exit state, so the process may still run. */
  expect(processIdentityMayRun(identity, probe({ processIdentity: () => null }))).toBeTrue();
  expect(processIdentityMayRun({ pid: 42, startIdentity: "42:start" }, probe())).toBeTrue();
  expect(processIdentityMayRun({ ...identity, startIdentity: "42:earlier" }, probe())).toBeFalse();
  expect(processIdentityMayRun(identity, probe({ pidAlive: () => false }))).toBeFalse();
});

test.skipIf(process.platform !== "linux")("a real unreaped child reads exited and cannot run, beside its live parent (#2967)", async () => {
  const fixture = await startUnreapedChild();
  try {
    /* The kernel evidence the gate used to read: the pid and its start token
       survive the exit, so the identity verdict alone still says alive. */
    expect(procBackend.pidAlive(fixture.zombie.pid)).toBeTrue();
    expect(procBackend.processExited(fixture.zombie.pid)).toBeTrue();
    expect(processIdentityStatus(fixture.zombie)).toBe("alive");
    expect(processIdentityMayRun(fixture.zombie)).toBeFalse();
    expect(processIdentityMayRun(fixture.parentIdentity)).toBeTrue();
  } finally {
    await fixture.stop();
  }
});

const python = Bun.which("python3");

test.skipIf(process.platform !== "linux")("a captured zombie with legacy or missing identity evidence cannot hold a worktree (#2967)", async () => {
  const fixture = await startUnreapedChild();
  try {
    for (const identity of [
      { pid: fixture.zombie.pid, startIdentity: fixture.zombie.startIdentity },
      { pid: fixture.zombie.pid, startIdentity: null, bootEpoch: null },
    ]) {
      expect(processIdentityStatus(identity)).toBe("unverified");
      expect(processIdentityMayRun(identity)).toBeFalse();
    }
    expect(processIdentityMayRun({ pid: fixture.parentIdentity.pid, startIdentity: null })).toBeTrue();
    expect(procBackend.pidAlive(fixture.zombie.pid)).toBeTrue();
  } finally {
    await fixture.stop();
  }
});

test.skipIf(process.platform !== "linux" || !python)("a live process whose main thread exited still may run while its other thread writes (#2967)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leader-exited-"));
  const output = path.join(directory, "writes.txt");
  const fixture = await startLeaderExitedChild(python!, output);
  try {
    /* The leader alone reads Z; a thread of the same process is still running. */
    expect(fs.readFileSync(`/proc/${fixture.identity.pid}/stat`, "utf8")).toMatch(/\) Z /);
    expect(procBackend.processExited(fixture.identity.pid)).toBeFalse();
    expect(processIdentityMayRun(fixture.identity)).toBeTrue();
    const before = fs.readFileSync(output, "utf8").length;
    const deadline = Date.now() + 5_000;
    while (fs.readFileSync(output, "utf8").length <= before) {
      if (Date.now() >= deadline) throw new Error("the surviving thread stopped writing");
      await Bun.sleep(20);
    }
    expect(processIdentityMayRun(fixture.identity)).toBeTrue();
  } finally {
    await fixture.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("recorded equality distinguishes boot-aware and legacy expectations", () => {
  for (const startIdentity of [null, "start"]) {
    for (const bootEpoch of [undefined, null, "boot-current", "boot-earlier"]) {
      const current = { pid: 42, startIdentity, bootEpoch };
      expect(sameRecordedProcessIdentity(current, { pid: 42, startIdentity })).toBe(true);
      expect(sameRecordedProcessIdentity(current, { pid: 43, startIdentity })).toBe(false);
      expect(sameRecordedProcessIdentity(current, { pid: 42, startIdentity: "other" })).toBe(false);
      expect(sameRecordedProcessIdentity(current, { pid: 42, startIdentity, bootEpoch: "boot-current" })).toBe(bootEpoch === "boot-current");
      expect(sameRecordedProcessIdentity(current, { pid: 42, startIdentity, bootEpoch: null })).toBe(bootEpoch === null);
    }
  }
});

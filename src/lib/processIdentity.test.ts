import { expect, test } from "bun:test";
import fs from "node:fs";

import { procBackend } from "@/lib/proc";
import { startUnreapedChild } from "@/lib/testing/unreapedChild";

import {
  captureProcessIdentity,
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

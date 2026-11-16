import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import { observeAgentProcess } from "./process";

test("legacy claims stay unverified while boot-bound local identities detect PID reuse", () => {
  const identity = captureProcessIdentity(process.pid);
  expect(observeAgentProcess({ pid: identity.pid, startIdentity: identity.startIdentity })).toBe("unverified");
  if (process.platform === "linux") expect(observeAgentProcess({ pid: identity.pid, startIdentity: "earlier-start" })).toBe("unverified");
  expect(observeAgentProcess(identity)).toBe("alive");
  expect(observeAgentProcess({ ...identity, startIdentity: "earlier-start" })).toBe("dead");
});

for (const refusal of ["none", "foreign-proc", "namespace-other", "namespace-denied", "stat-denied"] as const) {
  test.skipIf(process.platform !== "linux")(`legacy missing PID proof: ${refusal}`, () => {
    const pid = 2_147_483_647;
    // Prime the boot cache before altering proc observations.
    captureProcessIdentity(process.pid);
    const stat = fs.statSync.bind(fs), link = fs.readlinkSync.bind(fs);
    const links = spyOn(fs, "readlinkSync").mockImplementation(((pathname: fs.PathLike) => {
      if (pathname === "/proc/self" && refusal === "foreign-proc") return String(process.pid + 1);
      if (pathname === "/proc/self/ns/pid" && refusal === "namespace-other") return "pid:[0]";
      if (pathname === "/proc/self/ns/pid" && refusal === "namespace-denied") throw Object.assign(new Error("denied"), { code: "EACCES" });
      return link(pathname);
    }) as typeof fs.readlinkSync);
    const stats = spyOn(fs, "statSync").mockImplementation(((pathname: fs.PathLike) => {
      if (pathname === `/proc/${pid}`) throw Object.assign(new Error("fixture"), { code: refusal === "stat-denied" ? "EACCES" : "ENOENT" });
      return stat(pathname);
    }) as typeof fs.statSync);
    try {
      expect(observeAgentProcess({ pid, startIdentity: "fixture-owner" })).toBe("unverified");
      expect(observeAgentProcess({ pid, startIdentity: "fixture-owner", bootEpoch: identityBoot() })).toBe(refusal === "none" ? "dead" : "unverified");
    } finally { stats.mockRestore(); links.mockRestore(); }
  });
}

function identityBoot(): string { return captureProcessIdentity(process.pid).bootEpoch!; }

for (const procError of ["ENOENT", "ESRCH"] as const) {
  for (const signalResult of ["success", "EPERM", "EACCES", "unknown", "ESRCH"] as const) {
    test.skipIf(process.platform !== "linux")(`hidden boot-bound owner: proc=${procError}, kill0=${signalResult}`, () => {
      const identity = captureProcessIdentity(process.pid);
      const stat = fs.statSync.bind(fs);
      const hidden = spyOn(fs, "statSync").mockImplementation(((pathname: fs.PathLike) => {
        if (pathname === `/proc/${identity.pid}`) throw Object.assign(new Error("hidden"), { code: procError });
        return stat(pathname);
      }) as typeof fs.statSync);
      const signal = spyOn(process, "kill").mockImplementation((pid, value) => {
        expect(pid).toBe(identity.pid); expect(value).toBe(0);
        if (signalResult !== "success") throw Object.assign(new Error("fixture probe"), { code: signalResult });
        return true;
      });
      try {
        expect(observeAgentProcess(identity)).toBe(signalResult === "ESRCH" ? "dead" : "unverified");
        expect(signal).toHaveBeenCalledTimes(1);
        // Missing legacy namespace proof never reaches even a signal-zero probe.
        expect(observeAgentProcess({ pid: identity.pid, startIdentity: identity.startIdentity })).toBe("unverified");
        expect(signal).toHaveBeenCalledTimes(1);
      } finally { signal.mockRestore(); hidden.mockRestore(); }
    });
  }
}

test.skipIf(process.platform !== "linux")("a visible proc directory with an unreadable start token protects the owner", () => {
  const identity = captureProcessIdentity(process.pid);
  const unreadable = spyOn(procBackend, "processIdentity").mockReturnValue(null);
  const missing = spyOn(procBackend, "pidAlive").mockReturnValue(false);
  try { expect(observeAgentProcess(identity)).toBe("unverified"); }
  finally { missing.mockRestore(); unreadable.mockRestore(); }
});

test.skipIf(process.platform !== "linux")("exit between the proc directory and start token reads requires independent ESRCH", () => {
  const identity = captureProcessIdentity(process.pid);
  const unreadable = spyOn(procBackend, "processIdentity").mockReturnValue(null);
  const signal = spyOn(process, "kill").mockImplementation((pid, value) => {
    expect(pid).toBe(identity.pid); expect(value).toBe(0);
    throw Object.assign(new Error("fixture exited"), { code: "ESRCH" });
  });
  try { expect(observeAgentProcess(identity)).toBe("dead"); }
  finally { signal.mockRestore(); unreadable.mockRestore(); }
});

test.skipIf(process.platform !== "linux")("epoch-bound live owners stay unverified when proc access is denied", () => {
  const identity = captureProcessIdentity(process.pid);
  const stat = fs.statSync.bind(fs);
  const denied = spyOn(fs, "statSync").mockImplementation(((pathname: fs.PathLike) => {
    if (pathname === `/proc/${process.pid}`) throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
    return stat(pathname);
  }) as typeof fs.statSync);
  try { expect(observeAgentProcess(identity)).toBe("unverified"); }
  finally { denied.mockRestore(); }
});

import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { observeAgentProcess } from "./process";

test("legacy claims use readable same-namespace proc evidence and detect PID reuse", () => {
  const identity = captureProcessIdentity(process.pid);
  expect(observeAgentProcess({ pid: identity.pid, startIdentity: identity.startIdentity })).toBe("alive");
  expect(observeAgentProcess({ pid: identity.pid, startIdentity: "earlier-start" })).toBe("dead");
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
      expect(observeAgentProcess({ pid, startIdentity: "fixture-owner" })).toBe(refusal === "none" ? "dead" : "unverified");
      expect(observeAgentProcess({ pid, startIdentity: "fixture-owner", bootEpoch: identityBoot() })).toBe(refusal === "none" ? "dead" : "unverified");
    } finally { stats.mockRestore(); links.mockRestore(); }
  });
}

function identityBoot(): string { return captureProcessIdentity(process.pid).bootEpoch!; }

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

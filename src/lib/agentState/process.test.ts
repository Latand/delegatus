import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { observeAgentProcess } from "./process";

test("legacy claims never prove a present owner dead, including PID reuse", () => {
  const identity = captureProcessIdentity(process.pid);
  expect(observeAgentProcess({ pid: identity.pid, startIdentity: identity.startIdentity })).toBe("unverified");
  expect(observeAgentProcess({ pid: identity.pid, startIdentity: "earlier-start" })).toBe("unverified");
});

for (const refusal of ["none", "foreign-proc", "namespace-other", "namespace-denied", "stat-denied", "probe-denied", "probe-live"] as const) {
  test.skipIf(process.platform !== "linux")(`legacy missing PID proof: ${refusal}`, () => {
    const pid = 2_147_483_647;
    // Prime the boot cache before altering proc observations.
    captureProcessIdentity(process.pid);
    const stat = fs.statSync.bind(fs), link = fs.readlinkSync.bind(fs), kill = process.kill.bind(process);
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
    const probe = spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target === pid && signal === 0) {
        if (refusal === "probe-live") return true;
        throw Object.assign(new Error("fixture"), { code: refusal === "probe-denied" ? "EPERM" : "ESRCH" });
      }
      return kill(target, signal);
    });
    try {
      expect(observeAgentProcess({ pid, startIdentity: "fixture-owner" })).toBe("unverified");
    } finally { probe.mockRestore(); stats.mockRestore(); links.mockRestore(); }
  });
}

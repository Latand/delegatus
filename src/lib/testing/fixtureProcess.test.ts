import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import { fixtureReport, ownFixtureTree, stopFixtureProcess, stopFixtureTree } from "./fixtureProcess";

test("fixture tree cleanup never signals an exited root's old group", async () => {
  const child = ownFixtureTree(spawn(process.execPath, ["-e", ""], { stdio: "ignore", detached: true }));
  await new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
  const signal = spyOn(process, "kill");
  try { await stopFixtureTree(child); expect(signal).not.toHaveBeenCalled(); }
  finally { signal.mockRestore(); }
}, 3_000);

test("fixture tree cleanup refuses a reused start token before sending any signal", async () => {
  const child = ownFixtureTree(spawn("/bin/sleep", ["30"], { stdio: "ignore" }));
  const original = procBackend.processIdentity.bind(procBackend);
  const probe = spyOn(procBackend, "processIdentity").mockImplementation(pid => pid === child.pid ? "reused" : original(pid));
  const signal = spyOn(process, "kill");
  try { await stopFixtureTree(child); expect(signal).not.toHaveBeenCalled(); }
  finally { signal.mockRestore(); probe.mockRestore(); await stopFixtureProcess(child); }
}, 3_000);

test("fixture tree cleanup reaps descendants within its bound and preserves a same-argv bystander", async () => {
  const script = "sleep 30 & echo '{\"ready\":true}'; wait";
  const child = ownFixtureTree(spawn("/bin/sh", ["-c", script], { stdio: ["ignore", "pipe", "ignore"], detached: true }));
  const identity = captureProcessIdentity(child.pid!);
  const bystander = ownFixtureTree(spawn("/bin/sh", ["-c", script], { stdio: ["ignore", "pipe", "ignore"], detached: true }));
  const other = captureProcessIdentity(bystander.pid!);
  try {
    await Promise.all([fixtureReport(child, "owned tree", [], 1_000), fixtureReport(bystander, "bystander", [], 1_000)]);
    const descendants = [...procBackend.ppidMap()].filter(([, parent]) => parent === child.pid).map(([pid]) => captureProcessIdentity(pid));
    expect(descendants.length).toBeGreaterThan(0);
    await stopFixtureTree(child, 1_500);
    expect(processIdentityStatus(identity)).toBe("dead");
    for (const descendant of descendants) expect(processIdentityStatus(descendant) !== "alive" || procBackend.processExited(descendant.pid)).toBe(true);
    expect(processIdentityStatus(other)).toBe("alive");
    await stopFixtureTree(child);
    expect(processIdentityStatus(other)).toBe("alive");
  } finally { await stopFixtureTree(child); await stopFixtureTree(bystander); }
}, 5_000);

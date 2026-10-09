import { expect, spyOn, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import { fixtureReport, ownFixtureTree, signalFixtureIdentity, stopFixtureIdentity, stopFixtureProcess, stopFixtureTree } from "./fixtureProcess";

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

for (const signal of ["SIGTERM", "SIGKILL"] as const) test(`recorded identity ${signal} refuses a changed boot epoch`, async () => {
  const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  const identity = captureProcessIdentity(child.pid!);
  try {
    expect(signalFixtureIdentity({ ...identity, bootEpoch: "another-boot" }, signal)).toBe(false);
    expect(processIdentityStatus(identity)).toBe("alive");
    await stopFixtureIdentity({ ...identity, bootEpoch: "another-boot" });
    expect(processIdentityStatus(identity)).toBe("alive");
  } finally { await stopFixtureProcess(child); }
}, 3_000);

test("identity cleanup escalates a TERM-resistant child and preserves a same-argv bystander", async () => {
  const script = "trap '' TERM; echo '{\"ready\":true}'; exec sleep 30";
  const child = spawn("/bin/sh", ["-c", script], { stdio: ["ignore", "pipe", "ignore"] });
  const bystander = spawn("/bin/sh", ["-c", script], { stdio: ["ignore", "pipe", "ignore"] });
  const identity = captureProcessIdentity(child.pid!);
  const other = captureProcessIdentity(bystander.pid!);
  try {
    await Promise.all([fixtureReport(child, "identity child", [], 1_000), fixtureReport(bystander, "identity bystander", [], 1_000)]);
    await stopFixtureIdentity(identity, 1_500);
    expect(processIdentityStatus(identity)).toBe("dead");
    expect(processIdentityStatus(other)).toBe("alive");
  } finally { await stopFixtureProcess(child); await stopFixtureProcess(bystander); }
}, 5_000);

test.skipIf(process.platform !== "linux")("actual recycled PID with identical argv survives every shared teardown path", () => {
  const program = `
import { spawn } from "node:child_process";
import fs from "node:fs";
import { captureProcessIdentity, processIdentityStatus } from ${JSON.stringify(new URL("../processIdentity.ts", import.meta.url).pathname)};
import { ownFixtureTree, signalFixtureIdentity, stopFixtureIdentity, stopFixtureTree, stopFixtureProcess } from ${JSON.stringify(new URL("./fixtureProcess.ts", import.meta.url).pathname)};
const old = ownFixtureTree(spawn("/bin/sleep", ["30"], { stdio: "ignore" }));
const identity = captureProcessIdentity(old.pid);
await stopFixtureProcess(old);
await Bun.sleep(30);
fs.writeFileSync("/proc/sys/kernel/ns_last_pid", String(old.pid - 1));
const bystander = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
const other = captureProcessIdentity(bystander.pid);
try {
  if (other.pid !== identity.pid || other.startIdentity === identity.startIdentity) throw new Error("PID was not actually recycled");
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (signalFixtureIdentity(identity, signal)) throw new Error("historical identity was signalled");
  }
  await stopFixtureIdentity(identity);
  await stopFixtureTree(old);
  await stopFixtureProcess(old);
  old.kill("SIGKILL");
  if (processIdentityStatus(other) !== "alive") throw new Error("recycled same-argv bystander was killed");
  console.log("recycled PID survived identity, tree, process and handle cleanup");
} finally { await stopFixtureProcess(bystander); }
if (processIdentityStatus(other) !== "dead") throw new Error("namespace probe left a survivor");
`;
  const result = spawnSync("unshare", ["-Urpf", "--mount-proc", process.execPath, "-e", program], { encoding: "utf8", timeout: 5_000 });
  // Linux gates that cannot create a user/PID namespace must report the gap;
  // this machine's private namespace exercises real reuse without host writes.
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("recycled PID survived");
}, 7_000);


test("a stalled owned report reaps its child tree and preserves a same-argv bystander", async () => {
  const script = "sleep 30 & wait";
  const child = ownFixtureTree(spawn("/bin/sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] }));
  const bystander = ownFixtureTree(spawn("/bin/sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] }));
  const other = captureProcessIdentity(bystander.pid!);
  try {
    const deadline = Date.now() + 500;
    let descendants: ReturnType<typeof captureProcessIdentity>[] = [];
    while (!descendants.length && Date.now() < deadline) {
      descendants = [...procBackend.ppidMap()].filter(([, parent]) => parent === child.pid).map(([pid]) => captureProcessIdentity(pid));
      if (!descendants.length) await Bun.sleep(10);
    }
    expect(descendants.length).toBeGreaterThan(0);
    await expect(fixtureReport(child, "stalled child tree", [], 100)).rejects.toThrow("stalled child tree did not report within 100ms");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    for (const identity of descendants) expect(processIdentityStatus(identity) !== "alive" || procBackend.processExited(identity.pid)).toBe(true);
    expect(processIdentityStatus(other)).toBe("alive");
  } finally {
    await stopFixtureTree(child); await stopFixtureTree(bystander);
  }
}, 3_000);

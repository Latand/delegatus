import { spawn } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readStartIdentity } from "./self-update-supervisor.mjs";
import { ApplyController } from "../src/lib/selfUpdate/apply";
import { checkoutDeployments } from "../src/lib/selfUpdate/deployments";

const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exit = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGKILL"); await exit;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each(["expiry", "stale identity", "new owner", "healthy"])("the rollback guard respects recorded custody: %s", async scenario => {
  const root = mkdtempSync(path.join(tmpdir(), "rollback-guard-")); roots.push(root);
  const owner = spawn(process.execPath, ["--bun", "-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); children.push(owner);
  const ownerExit = new Promise(resolve => owner.once("exit", resolve));
  const peer = spawn(process.execPath, ["--bun", "-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); children.push(peer);
  const ownerIdentity = readStartIdentity(owner.pid!), peerIdentity = readStartIdentity(peer.pid!);
  expect(ownerIdentity).not.toBeNull(); expect(peerIdentity).not.toBeNull();
  const paths = { request: path.join(root, "request-install.json"), trial: path.join(root, "trial-install.json"),
    record: path.join(root, "launcher-install.json"), releasePointer: path.join(root, "release-install.json") };
  const target = "b".repeat(40), requestId = "owned-switch";
  const at = "2026-11-05T05:25:40.047Z";
  const apply = { requestId, target, releasePointer: paths.releasePointer, rollbackPointer: null,
    state: "switching", rolledBack: false, startedAt: at, switchedAt: at, deploymentId: "guard-deploy" };
  writeFileSync(path.join(root, "apply.json"), JSON.stringify(apply));
  writeFileSync(path.join(root, "deployments.json"), JSON.stringify([{ deploymentId: "guard-deploy", idempotencyKey: "guard-request", phase: "host-handoff", terminal: false, revisionNumber: 1, error: null }]));
  writeFileSync(paths.trial, JSON.stringify({ requestId, target, state: "rolled-back", rollbackPointer: null,
    previousEntry: path.join(root, "bin/cli.mjs"), rollbackDeadlineAt: 0 }));
  mkdirSync(path.join(root, "bin"));
  const processEntry = scenario === "healthy" ? { state: "healthy", pid: peer.pid, startIdentity: peerIdentity } : { state: "starting", pid: null, startIdentity: null };
  const priorOwner = { pid: owner.pid, startIdentity: ownerIdentity };
  const record = { launcher: { ...(scenario === "new owner" ? { pid: peer.pid, startIdentity: peerIdentity } : priorOwner), state: scenario === "healthy" ? "healthy" : "starting" },
    web: processEntry, runtimeHost: processEntry, updatedAt: at };
  writeFileSync(paths.record, JSON.stringify(record));
  // A foreign hold is never this guard's to release, including on refusal.
  writeFileSync(path.join(root, "auto-drain.json"), JSON.stringify({ id: "foreign-hold" }));
  const plan = { paths, requestId, target, pid: owner.pid, identity: scenario === "stale identity" ? `${ownerIdentity}-stale` : ownerIdentity,
    recordOwner: priorOwner, installRoot: root, deadline: scenario === "healthy" ? Date.parse(at) + 1 : 0 };
  const guard = spawn(process.execPath, ["--bun", path.resolve("bin/launcher-rollback-guard.mjs"), Buffer.from(JSON.stringify(plan)).toString("base64")],
    { stdio: ["ignore", "ignore", "pipe"] }); children.push(guard);
  let output = ""; guard.stderr!.on("data", chunk => { output += String(chunk); });
  const exit = await Promise.race([new Promise(resolve => guard.once("exit", resolve)), Bun.sleep(3000).then(() => "unresolved")]);
  expect(exit).toBe(0);
  expect(peer.exitCode).toBeNull(); expect(peer.signalCode).toBeNull();
  if (scenario === "expiry") {
    expect(output).toContain("launcher startup refused");
    const cold = new ApplyController(root);
    expect(cold.current).toMatchObject({ state: "failed", detail: "The launcher rollback exceeded its 10 minute deadline" });
    expect(checkoutDeployments(root)[0]).toMatchObject({ phase: "failed", terminal: true });
    expect(await Promise.race([ownerExit, Bun.sleep(1000).then(() => "unresolved")])).toBeNull();
    expect(owner.signalCode).toBe("SIGKILL");
  } else {
    expect(new ApplyController(root).current?.state).toBe("switching");
    expect(owner.exitCode).toBeNull(); expect(owner.signalCode).toBeNull();
  }
  expect(JSON.parse(readFileSync(path.join(root, "auto-drain.json"), "utf8")).id).toBe("foreign-hold");
});

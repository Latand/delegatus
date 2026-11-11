import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { ApplyController } from "../src/lib/selfUpdate/apply";
import { checkoutDeployments } from "../src/lib/selfUpdate/deployments";
import { activeDrain } from "../src/lib/selfUpdate/drain";
import { isAlive, readStartIdentity } from "../src/lib/selfUpdate/pid";
import { harness, runSeatTickCheck, PROJECT, CONVERSATION, NOW } from "../src/lib/monitor/seatTickController.fixture";
import { availablePort, children, install, readRecord, registerSelfUpdateCleanup, release, pointerFile, served, socketAnswers, start, until } from "./__fixtures__/cli-self-update";

registerSelfUpdateCleanup();

test("startup bounds synchronous Git probes before the launcher watchdog exists", async () => {
  const fixture = install();
  const shim = path.join(fixture.root, "slow-git"); mkdirSync(shim, { recursive: true });
  const executable = path.join(shim, "git");
  writeFileSync(executable, "#!/bin/sh\nexec /bin/sleep 30\n"); chmodSync(executable, 0o700);
  fixture.env.PATH = `${shim}${path.delimiter}${fixture.env.PATH}`;
  const started = Date.now();
  const running = await start(fixture);
  expect(Date.now() - started).toBeLessThan(12_000);
  expect(await served(running.port)).toBe(fixture.checkout);
  expect(readRecord(fixture.state).launcher.state).toBe("healthy");
}, 15_000);

test.each([false, true])("a cold launcher preserves a timely completed switch after the original deadline, recovery refuses=%s", async refuses => {
  const fixture = install(), running = await start(fixture), before = readRecord(fixture.state);
  const candidate = release(fixture, "timely-completion"), directory = path.dirname(before.requestFile);
  const apply = new ApplyController(directory);
  apply.begin(before as never, candidate.sha, "operator"); apply.patch({ requestId: "timely-switch" });
  writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, checkoutHead: fixture.first })); apply.send(before as never);
  const receiptFile = `${before.requestFile}.result.json`;
  const servedBefore = await until(() => {
    const record = readRecord(fixture.state);
    return record.launcher.state === "healthy" && record.launcher.requestId === "timely-switch" && existsSync(receiptFile) ? record : null;
  });
  const switchedAt = "2026-11-05T05:25:40.047Z", deadline = Date.parse(switchedAt) + 600_000;
  apply.patch({ switchedAt, switchDeadlineAt: deadline });
  const receipt = JSON.parse(readFileSync(receiptFile, "utf8")); receipt.completedAt = new Date(deadline - 1).toISOString();
  writeFileSync(receiptFile, JSON.stringify(receipt));
  let previous: ReturnType<typeof spawn> = running.child;
  let serving = servedBefore;
  for (let boot = 0; boot < 2; boot++) {
    const exited = new Promise(resolve => previous.once("exit", resolve)); previous.kill("SIGKILL"); await exited;
    const previousChildren = [serving.web, serving.runtimeHost].map(entry => ({ pid: entry.pid!, identity: readStartIdentity(entry.pid!) }));
    for (const entry of previousChildren) if (entry.identity && readStartIdentity(entry.pid) === entry.identity) process.kill(entry.pid, "SIGTERM");
    await until(() => previousChildren.every(entry => !isAlive(entry.pid) || readStartIdentity(entry.pid) !== entry.identity), 3000);
    if (boot === 1 && refuses) {
      const adoption = path.join(candidate.dir, "bin/launcher-adoption.mjs");
      writeFileSync(adoption, readFileSync(adoption, "utf8").replace("export async function ensureWebPortFree(", "async function originalEnsureWebPortFree(")
        + "\nexport async function ensureWebPortFree() { await new Promise(() => {}); }\n");
      const budgets = path.join(candidate.dir, "bin/launcher-deadline.mjs");
      writeFileSync(budgets, readFileSync(budgets, "utf8").replace("SWITCH_TIMEOUT_MS = 10 * 60_000", "SWITCH_TIMEOUT_MS = 1000"));
    }
    const replacement = spawn(process.execPath, ["--bun", path.join(candidate.dir, "bin/cli.mjs"), "--no-open", "--port", String(running.port)],
      { cwd: fixture.checkout, env: { ...fixture.env, LLV_LAUNCHER_REEXEC: "1", LLV_LAUNCHER_CHECKOUT: fixture.checkout, LLV_LAUNCHER_INSTALL_ROOT: fixture.checkout }, stdio: "ignore" }); children.add(replacement);
    if (boot === 1 && refuses) {
      const exit = await Promise.race([new Promise(resolve => replacement.once("exit", resolve)), Bun.sleep(4000).then(() => "unresolved")]);
      expect(exit).toBe(75);
      const failed = new ApplyController(directory).current!;
      expect(failed).toMatchObject({ state: "failed", switchCompletedAt: receipt.completedAt });
      expect(failed.detail).toContain("startup exceeded");
      expect(failed.switchOverrun).toBeUndefined();
      expect(activeDrain(path.join(directory, "auto-drain.json"))).toBeNull();
      return;
    }
    serving = await until(() => {
      const record = readRecord(fixture.state);
      return record.launcher.pid === replacement.pid && record.launcher.state === "healthy" && record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
    }, 6000);
    previous = replacement;
    expect(new ApplyController(directory).current?.switchCompletedAt).toBe(receipt.completedAt);
  }
  expect(await served(running.port)).toBe(candidate.dir);
  const cold = new ApplyController(directory);
  expect(cold.observe(serving as never, true)).toBe("done");
  expect(cold.current).toMatchObject({ state: "done", switchDeadlineAt: deadline });
  expect(cold.current?.switchOverrun).toBeUndefined();
  expect(activeDrain(path.join(directory, "auto-drain.json"))).toBeNull();
  expect(JSON.parse(readFileSync(receiptFile, "utf8"))).toEqual(receipt);
}, 25_000);

test("an ordinary launcher start stuck before its children refuses and logs its deadline", async () => {
  const fixture = install(), port = await availablePort();
  const adoption = path.join(fixture.checkout, "bin/launcher-adoption.mjs");
  writeFileSync(adoption, readFileSync(adoption, "utf8").replace("export async function ensureWebPortFree(", "async function originalEnsureWebPortFree(")
    + "\nexport async function ensureWebPortFree() { await new Promise(() => {}); }\n");
  const deadlineModule = path.join(fixture.checkout, "bin/launcher-deadline.mjs");
  if (existsSync(deadlineModule)) writeFileSync(deadlineModule, readFileSync(deadlineModule, "utf8").replace("SWITCH_TIMEOUT_MS = 10 * 60_000", "SWITCH_TIMEOUT_MS = 1000"));
  const child = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin/cli.mjs"), "--no-open", "--port", String(port)],
    { cwd: fixture.checkout, env: fixture.env, stdio: ["ignore", "ignore", "pipe"] }); children.add(child);
  let output = ""; child.stderr!.on("data", chunk => { output += String(chunk); });
  const exit = await Promise.race([new Promise(resolve => child.once("exit", resolve)), Bun.sleep(4000).then(() => "unresolved")]);
  expect(exit).toBe(75);
  expect(output).toContain("launcher startup refused");
  expect(output).toContain("startup exceeded");
}, 10_000);

test("an expired rollback cold start settles its deployment before an ordinary restart", async () => {
  const fixture = install(), port = await availablePort();
  const servingRelease = release(fixture, "expired-rollback-serving");
  const installId = createHash("sha256").update(path.resolve(fixture.checkout)).digest("hex").slice(0, 16);
  const directory = path.join(fixture.state, "self-update"), releasePointer = path.join(directory, `release-${installId}.json`);
  const trialFile = path.join(directory, `trial-${installId}.json`), requestId = "expired-rollback-cold-start";
  const target = "b".repeat(40), deploymentId = "expired-rollback-deploy";
  mkdirSync(directory, { recursive: true });
  writeFileSync(releasePointer, JSON.stringify({ ...servingRelease, checkoutHead: fixture.first }));
  writeFileSync(path.join(directory, "apply.json"), JSON.stringify({ requestId, target, releasePointer, rollbackPointer: null,
    state: "switching", rolledBack: false, startedAt: new Date(NOW).toISOString(), switchedAt: new Date(NOW).toISOString(),
    switchDeadlineAt: 1, launcherPid: 2, launcherIdentity: "fixture-original", deploymentId, trigger: "seat", autoGateId: "owned-gate" }));
  writeFileSync(path.join(directory, "deployments.json"), JSON.stringify([{ deploymentId, idempotencyKey: requestId,
    phase: "host-handoff", terminal: false, error: null, revisionNumber: 1 }]));
  writeFileSync(path.join(directory, "auto-drain.json"), JSON.stringify({ id: requestId, target, persistent: true, until: Number.MAX_SAFE_INTEGER }));
  writeFileSync(path.join(directory, "auto-admission.json"), JSON.stringify({ id: "foreign-admission", until: Number.MAX_SAFE_INTEGER }));
  writeFileSync(trialFile, JSON.stringify({ requestId, target, releasePointer, rollbackPointer: null,
    previousEntry: path.join(fixture.checkout, "bin", "cli.mjs"), state: "rolled-back", rollbackDeadlineAt: 1,
    switchOverrun: "The launcher switch exceeded its 10 minute deadline" }));
  // Hold the watchdog beyond the parent assertion so recovery must settle the
  // persisted expiry before assertStarting can throw.
  const relaunchPath = path.join(fixture.checkout, "bin", "launcher-relaunch.mjs");
  const relaunchSource = readFileSync(relaunchPath, "utf8");
  const heldWatchdog = relaunchSource.replace("Math.max(1, deadline - Date.now())", "60_000");
  if (heldWatchdog === relaunchSource) throw new Error("Could not hold the launcher expiry watchdog in this fixture");
  writeFileSync(relaunchPath, heldWatchdog);
  const preload = path.join(fixture.root, "warm-oom-policy.mjs");
  writeFileSync(preload, `await import(${JSON.stringify(path.join(fixture.checkout, "bin", "oomPolicy.mjs"))});\n`);
  const entry = path.join(fixture.checkout, "bin", "cli.mjs");
  const reexecEnv = { ...fixture.env, LLV_LAUNCHER_REEXEC: "1", LLV_LAUNCHER_INSTALL_ROOT: fixture.checkout, LLV_LAUNCHER_CHECKOUT: fixture.checkout };
  const cold = spawn(process.execPath, ["--bun", "--preload", preload, entry, "--no-open", "--port", String(port)],
    { cwd: fixture.checkout, env: reexecEnv, stdio: ["ignore", "ignore", "pipe"] }); children.add(cold);
  let coldError = "";
  cold.stderr!.on("data", bytes => { coldError = (coldError + String(bytes)).slice(-4096); });
  const exit = await Promise.race([new Promise(resolve => cold.once("exit", resolve)), Bun.sleep(5000).then(() => "unresolved")]);
  if (exit !== 75) throw new Error(`Expired rollback cold start exited ${String(exit)}: ${coldError}`);
  expect(new ApplyController(directory).current).toMatchObject({ state: "failed", rolledBack: false });
  expect(checkoutDeployments(directory)[0]).toMatchObject({ phase: "failed", terminal: true });
  expect(checkoutDeployments(directory)[0]!.error).toContain("rollback exceeded");
  expect(activeDrain(path.join(directory, "auto-drain.json"))).toBeNull();
  expect(JSON.parse(readFileSync(path.join(directory, "auto-admission.json"), "utf8")).id).toBe("foreign-admission");

  const ordinary = spawn(process.execPath, ["--bun", entry, "--no-open", "--port", String(port)],
    { cwd: fixture.checkout, env: reexecEnv, stdio: "ignore" }); children.add(ordinary);
  const healthy = await until(() => {
    const record = readRecord(fixture.state);
    return record.launcher.pid === ordinary.pid && record.launcher.state === "healthy"
      && record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
  }, 8000);
  expect(await served(port)).toBe(servingRelease.dir);
  expect(await socketAnswers(healthy.socket)).toBe(true);
}, 20_000);

test.each([false, true])("a launcher stuck before its children rolls back under the original expiry, cold restart=%s", async coldRestart => {
  const fixture = install();
  const running = await start(fixture);
  const before = readRecord(fixture.state);
  const candidate = release(fixture, "stuck-probe");
  const marker = path.join(fixture.root, "probe-entered");
  const adoption = path.join(candidate.dir, "bin/launcher-adoption.mjs");
  writeFileSync(adoption, readFileSync(adoption, "utf8").replace("export async function ensureWebPortFree(", "async function originalEnsureWebPortFree(") + `
export async function ensureWebPortFree() {
  (await import("node:fs")).writeFileSync(${JSON.stringify(marker)}, String(process.pid));
  await new Promise(() => {});
}
`);
  const directory = path.dirname(before.requestFile);
  const deploymentId = "bounded-switch";
  writeFileSync(path.join(directory, "deployments.json"), JSON.stringify([{
    deploymentId, idempotencyKey: "bounded-switch-request", phase: "building", terminal: false,
    revision: candidate.sha, requestedRevision: candidate.sha, revisionNumber: 1, error: null,
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
  }]));
  const apply = new ApplyController(directory);
  apply.begin(before as never, candidate.sha, "seat", deploymentId);
  apply.patch({ requestId: "bounded-switch-request" });
  writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, checkoutHead: fixture.first }));
  const deadline = Date.now() + 3000;
  apply.patch({ state: "ready", switchDeadlineAt: deadline });
  apply.send(before as never);
  await until(() => existsSync(marker), 2500);
  const trialFile = before.requestFile.replace("request-", "trial-");
  const savedDeadline = JSON.parse(readFileSync(trialFile, "utf8")).switchDeadlineAt;
  if (coldRestart) {
    const exited = new Promise(resolve => running.child.once("exit", resolve));
    running.child.kill("SIGKILL");
    await exited;
    const replacement = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin/cli.mjs"), "--no-open", "--port", String(running.port)],
      { cwd: fixture.checkout, env: fixture.env, stdio: "ignore" });
    children.add(replacement);
  }
  let observedRecord: ReturnType<typeof readRecord> | null = null;
  const after = await until(() => {
    const record = readRecord(fixture.state);
    observedRecord = record;
    return record.launcher.state === "healthy" && (coldRestart || record.launcher.requestId === apply.current!.requestId)
      && record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
  }, coldRestart ? 25_000 : 8000).catch(error => { throw new Error(`${error}\nlast recovery record: ${JSON.stringify(observedRecord)}`); });
  expect(Date.now()).toBeLessThan(deadline + (coldRestart ? 20_000 : 5000));
  expect(savedDeadline).toBe(deadline);
  expect(after.launcher.revision).toBe(fixture.first);
  expect(await served(running.port)).toBe(fixture.checkout);
  expect(await socketAnswers(after.socket)).toBe(true);
  const cold = new ApplyController(directory);
  expect(cold.current).toMatchObject({ switchDeadlineAt: deadline, switchOverrun: "The launcher switch exceeded its 10 minute deadline" });
  expect([null, "failed"]).toContain(cold.observe(after as never, true));
  expect(activeDrain(path.join(directory, "auto-drain.json"))).toBeNull();
  const status = checkoutDeployments(directory)[0]!;
  expect(status).toMatchObject({ terminal: true, error: "The launcher switch exceeded its 10 minute deadline" });
  expect(coldRestart ? ["failed", "rolled-back"] : ["rolled-back"]).toContain(status.phase);

  // The fixture Viewer must be answering before running the production seat
  // tick: no in-Viewer wake can execute during the launcher's outage.
  const rig = harness({ now: NOW + 60_000,
    state: { lastWakeAt: new Date(NOW).toISOString() },
    seatDeployments: [{ conversationId: CONVERSATION, deploymentId }],
    deployments: { [deploymentId]: status },
  });
  const wake = await runSeatTickCheck(PROJECT, rig.deps);
  expect(wake).toMatchObject({ verdict: "wake", delivery: { outcome: "delivered" } });
  expect(wake!.reasons).toContain("deploy-settled");
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]!.text).toContain(status.error!);
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toHaveLength(1);
}, 20_000);

test.each(["exit", "retirement"])("lost %s completion ends the launcher switch within its stop bound", async lost => {
  const fixture = install();
  const candidate = release(fixture, "stop-completion");
  const entry = path.join(fixture.checkout, "bin/cli.mjs");
  let source = readFileSync(entry, "utf8");
  if (lost === "exit") {
    const start = source.indexOf("async function stopChild("), end = source.indexOf("async function stopAll(", start);
    source = source.slice(0, start) + source.slice(start, end).replace('child.once("exit",', 'child.once("lost-exit",') + source.slice(end);
  } else {
    source = source.replace(".catch(() => {}).finally(resolve)", ".catch(() => {}).finally(() => {})");
  }
  writeFileSync(entry, source);
  const deadlineModule = path.join(fixture.checkout, "bin/launcher-deadline.mjs");
  if (existsSync(deadlineModule)) writeFileSync(deadlineModule, readFileSync(deadlineModule, "utf8").replace("STOP_TIMEOUT_MS = 10_000", "STOP_TIMEOUT_MS = 150"));
  const running = await start(fixture);
  const before = readRecord(fixture.state), directory = path.dirname(before.requestFile);
  writeFileSync(path.join(directory, "deployments.json"), JSON.stringify([{
    deploymentId: "stop-deploy", idempotencyKey: "stop-request", phase: "building", terminal: false,
    revisionNumber: 1, error: null,
  }]));
  const apply = new ApplyController(directory);
  apply.begin(before as never, candidate.sha, "operator", "stop-deploy");
  apply.patch({ requestId: "bounded-stop-request" });
  writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, checkoutHead: fixture.first }));
  apply.send(before as never);
  if (lost === "exit") {
    const after = await until(() => {
      const record = readRecord(fixture.state);
      return record.launcher.state === "healthy" && record.launcher.requestId === apply.current!.requestId ? record : null;
    }, 5000);
    expect(await served(running.port)).toBe(fixture.checkout);
    const cold = new ApplyController(directory);
    expect(cold.observe(after as never, true)).toBe("failed");
    expect(cold.current?.detail).toContain("Launcher child");
  } else {
    const exit = await Promise.race([new Promise(resolve => running.child.once("exit", resolve)), Bun.sleep(5000).then(() => "unresolved")]);
    expect(exit).toBe(75);
    expect(new ApplyController(directory).current).toMatchObject({ state: "failed", rolledBack: false });
    expect(checkoutDeployments(directory)[0]).toMatchObject({ phase: "failed", terminal: true });
    expect(checkoutDeployments(directory)[0]!.error).toContain("Viewer retirement timed out");
    expect(activeDrain(path.join(directory, "auto-drain.json"))).toBeNull();
  }
}, 15_000);

test.each(["current", "legacy", "guard unavailable"])("a stalled rollback retains its expiry and refuses without an admission hold, image=%s", async scenario => {
  const legacyImage = scenario !== "current";
  const fixture = install();
  const candidate = release(fixture, "stalled-rollback");
  if (scenario === "guard unavailable") rmSync(path.join(candidate.dir, "bin/launcher-rollback-guard.mjs"), { force: true });
  if (legacyImage) {
    // Model an older entry that writes no deadline capability and never arms
    // the new timer. The candidate's independent guard must survive its exec.
    const relaunchModule = path.join(fixture.checkout, "bin/launcher-relaunch.mjs");
    let source = readFileSync(relaunchModule, "utf8");
    const arm = source.indexOf("  const arm = () => {");
    if (arm >= 0) {
      const end = source.indexOf("  try {\n    const value = JSON.parse", arm);
      source = source.slice(0, arm) + "  const arm = () => {};\n" + source.slice(end);
      source = source.replace("        previousDeadlineCapable: 1,\n", "");
      const acknowledgement = source.indexOf("  // This acknowledgement follows timer installation.");
      if (acknowledgement >= 0) source = source.slice(0, acknowledgement) + source.slice(source.indexOf("  return controller;", acknowledgement));
    }
    writeFileSync(relaunchModule, source);
  }
  const running = await start(fixture);
  const before = readRecord(fixture.state), directory = path.dirname(before.requestFile);
  const marker = path.join(fixture.root, "rollback-entered");
  for (const root of [fixture.checkout, candidate.dir]) {
    const adoption = path.join(root, "bin/launcher-adoption.mjs");
    writeFileSync(adoption, readFileSync(adoption, "utf8").replace("export async function ensureWebPortFree(", "async function originalEnsureWebPortFree(") + `
export async function ensureWebPortFree() {
  (await import("node:fs")).writeFileSync(${JSON.stringify(marker)}, process.cwd());
  await new Promise(() => {});
}
`);
    const deadlineModule = path.join(root, "bin/launcher-deadline.mjs");
    if (existsSync(deadlineModule)) writeFileSync(deadlineModule, readFileSync(deadlineModule, "utf8").replace("ROLLBACK_TIMEOUT_MS = 10 * 60_000", "ROLLBACK_TIMEOUT_MS = 1500"));
  }
  writeFileSync(path.join(directory, "deployments.json"), JSON.stringify([{
    deploymentId: "rollback-deploy", idempotencyKey: "rollback-request", phase: "building", terminal: false,
    revisionNumber: 1, error: null,
  }]));
  const apply = new ApplyController(directory);
  apply.begin(before as never, candidate.sha, "operator", "rollback-deploy");
  apply.patch({ requestId: "bounded-rollback-request" });
  writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, checkoutHead: fixture.first }));
  apply.patch({ switchDeadlineAt: Date.now() + 1500 }); apply.send(before as never);
  if (scenario === "guard unavailable") {
    const exit = await Promise.race([new Promise(resolve => running.child.once("exit", resolve)), Bun.sleep(5000).then(() => "unresolved")]);
    expect(exit).toBe(75);
    expect(new ApplyController(directory).current?.state).toBe("failed");
    expect(checkoutDeployments(directory)[0]!.error).toContain("guard");
    expect(activeDrain(path.join(directory, "auto-drain.json"))).toBeNull();
    return;
  }
  await until(() => existsSync(marker) && readFileSync(marker, "utf8") === fixture.checkout, 6000);
  const trialFile = before.requestFile.replace("request-", "trial-");
  const deadline = JSON.parse(readFileSync(trialFile, "utf8")).rollbackDeadlineAt;
  if (legacyImage) {
    const exit = await Promise.race([new Promise(resolve => running.child.once("exit", resolve)), Bun.sleep(4000).then(() => "unresolved")]);
    expect(exit).toBeNull();
    expect(running.child.signalCode).toBe("SIGKILL");
  } else {
    const exited = new Promise(resolve => running.child.once("exit", resolve)); running.child.kill("SIGKILL"); await exited;
    const replacement = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin/cli.mjs"), "--no-open", "--port", String(running.port)],
      { cwd: fixture.checkout, env: fixture.env, stdio: "ignore" }); children.add(replacement);
    const exit = await Promise.race([new Promise(resolve => replacement.once("exit", resolve)), Bun.sleep(4000).then(() => "unresolved")]);
    expect(exit).toBe(75);
  }
  expect(Date.now()).toBeLessThan(deadline + 1000);
  expect(JSON.parse(readFileSync(trialFile, "utf8")).rollbackDeadlineAt).toBe(deadline);
  expect(new ApplyController(directory).current).toMatchObject({ state: "failed", rolledBack: false });
  expect(checkoutDeployments(directory)[0]).toMatchObject({ phase: "failed", terminal: true });
  expect(checkoutDeployments(directory)[0]!.error).toContain("rollback exceeded");
  expect(checkoutDeployments(directory)[0]!.error).toContain("switch exceeded");
  expect(activeDrain(path.join(directory, "auto-drain.json"))).toBeNull();
}, 15_000);

// Keep the real CLI's --version preflight and its exec transition. Only the
// startup import is faulted, before the successor creates its controller.
function stallStartupImport(entry: string, marker: string) {
  const source = readFileSync(entry, "utf8");
  const seam = 'const tailscale = await import("./tailscale.mjs");';
  expect(source).toContain(seam);
  writeFileSync(entry, source.replace(seam, `if (!process.argv.includes("--version")) await import("./stalled-startup.mjs");\n  ${seam}`));
  writeFileSync(path.join(path.dirname(entry), "stalled-startup.mjs"), `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid }));
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  `);
}

for (const forwarded of [false, true]) {
  test.each(["switch import", "rollback import", "healthy"])(`exec retains its deadline, forwarding owner=${forwarded}, transition=%s`, async transition => {
    const fixture = install();
    const parentSettled = path.join(fixture.root, "parent-startup-settled");
    if (forwarded) {
      const initial = release(fixture, "initial-forwarded-release");
      const pointer = pointerFile(fixture); mkdirSync(path.dirname(pointer), { recursive: true });
      writeFileSync(pointer, JSON.stringify({ ...initial, checkoutHead: fixture.first }));
      const budgets = path.join(fixture.checkout, "bin/launcher-deadline.mjs");
      writeFileSync(budgets, readFileSync(budgets, "utf8").replace(/TERMINAL_BOOTSTRAP_TIMEOUT_MS = [^;]+;/, "TERMINAL_BOOTSTRAP_TIMEOUT_MS = 1000;"));
      const entry = path.join(fixture.checkout, "bin/cli.mjs");
      writeFileSync(entry, readFileSync(entry, "utf8").replace(
        "if (childIsHealthy) { startupSettled = true; return; }",
        `if (childIsHealthy) { startupSettled = true; writeFileSync(${JSON.stringify(parentSettled)}, "settled"); return; }`));
    }
    const running = await start(fixture), before = readRecord(fixture.state);
    if (forwarded) await until(() => existsSync(parentSettled), 4000);
    expect(isAlive(running.child.pid!)).toBe(true);
    const candidate = release(fixture, "exec-deadline-candidate");
    const marker = path.join(fixture.root, "successor-import-entered");
    if (transition === "switch import") stallStartupImport(path.join(candidate.dir, "bin/cli.mjs"), marker);
    if (transition === "rollback import") {
      const prior = forwarded ? JSON.parse(readFileSync(before.releasePointer, "utf8")).dir : fixture.checkout;
      stallStartupImport(path.join(prior, "bin/cli.mjs"), marker);
      const adoption = path.join(candidate.dir, "bin/launcher-adoption.mjs");
      writeFileSync(adoption, readFileSync(adoption, "utf8").replace("export async function ensureWebPortFree(", "async function originalEnsureWebPortFree(")
        + '\nexport async function ensureWebPortFree() { throw new Error("Candidate startup fault"); }\n');
      const budgets = path.join(candidate.dir, "bin/launcher-deadline.mjs");
      writeFileSync(budgets, readFileSync(budgets, "utf8").replace("ROLLBACK_TIMEOUT_MS = 10 * 60_000", "ROLLBACK_TIMEOUT_MS = 1500"));
    }
    const directory = path.dirname(before.requestFile), apply = new ApplyController(directory);
    writeFileSync(path.join(directory, "deployments.json"), JSON.stringify([{
      deploymentId: "exec-deadline-deploy", idempotencyKey: "exec-deadline-key", phase: "building", terminal: false, error: null, revisionNumber: 1,
    }]));
    apply.begin(before as never, candidate.sha, "operator", "exec-deadline-deploy");
    apply.patch({ requestId: "exec-deadline-request", state: "ready", switchDeadlineAt: Date.now() + 2000 });
    writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, checkoutHead: fixture.first }));
    apply.send(before as never);
    if (transition === "healthy") {
      const receiptFile = `${before.requestFile}.result.json`;
      await until(() => existsSync(receiptFile) && JSON.parse(readFileSync(receiptFile, "utf8")).state === "done", 5000);
      const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
      // Cross the original persisted switch deadline, then ask the actual
      // serving generation to answer. No clock reset or second start is used.
      await new Promise(resolve => setTimeout(resolve, Math.max(1, receipt.switchDeadlineAt - Date.now() + 100)));
      expect(isAlive(running.child.pid!)).toBe(true);
      expect(await served(running.port)).toBe(candidate.dir);
      expect(await socketAnswers(before.socket)).toBe(true);
      expect(new ApplyController(directory).observe(readRecord(fixture.state) as never, true)).toBe("done");
      return;
    }
    await until(() => existsSync(marker), 5000);
    expect(JSON.parse(readFileSync(marker, "utf8")).pid).toBe(before.launcher.pid);
    await until(() => new ApplyController(directory).current?.state === "failed", 5000);
    await until(() => !isAlive(before.launcher.pid) && !isAlive(running.child.pid!), 2000);
    const failed = new ApplyController(directory).current!;
    expect(failed.detail).toContain(transition === "switch import" ? "switch exceeded" : "rollback exceeded");
    expect(checkoutDeployments(directory)[0]).toMatchObject({ terminal: true, phase: "failed", error: failed.detail });
    expect(activeDrain(path.join(directory, "auto-drain.json"))).toBeNull();
    expect(isAlive(before.web.pid!)).toBe(false);
    expect(isAlive(before.runtimeHost.pid!)).toBe(false);
    const restored = existsSync(before.releasePointer) ? JSON.parse(readFileSync(before.releasePointer, "utf8")).dir : fixture.checkout;
    expect(restored).not.toBe(candidate.dir);
  }, 20_000);
}

test("an exec guard whose import stays alive without readiness is refused and reaped", async () => {
  const fixture = install(), running = await start(fixture), before = readRecord(fixture.state);
  const candidate = release(fixture, "guard-import-stall");
  const entered = path.join(fixture.root, "candidate-entered");
  stallStartupImport(path.join(candidate.dir, "bin/cli.mjs"), entered);
  const guards = path.join(fixture.root, "guard-pids");
  writeFileSync(path.join(fixture.checkout, "bin/launcher-rollback-guard.mjs"), `
    import { appendFileSync } from "node:fs";
    appendFileSync(${JSON.stringify(guards)}, process.pid + "\\n");
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  `);
  const directory = path.dirname(before.requestFile), apply = new ApplyController(directory);
  writeFileSync(path.join(directory, "deployments.json"), JSON.stringify([{
    deploymentId: "guard-readiness-deploy", idempotencyKey: "guard-readiness-key", phase: "building", terminal: false, error: null, revisionNumber: 1,
  }]));
  apply.begin(before as never, candidate.sha, "operator", "guard-readiness-deploy");
  apply.patch({ state: "ready", switchDeadlineAt: Date.now() + 15_000 });
  writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, checkoutHead: fixture.first }));
  apply.send(before as never);
  await until(() => new ApplyController(directory).current?.state === "failed", 7000);
  await until(() => !isAlive(before.launcher.pid), 2000);
  expect(running.child.exitCode).toBe(75);
  expect(existsSync(entered)).toBe(false);
  expect(checkoutDeployments(directory)[0]!.error).toContain("guard did not become ready");
  const guardPids = readFileSync(guards, "utf8").trim().split("\n").map(Number);
  expect(guardPids).toHaveLength(2);
  await until(() => guardPids.every(pid => !isAlive(pid)), 1000);
  expect(activeDrain(path.join(directory, "auto-drain.json"))).toBeNull();
}, 15_000);

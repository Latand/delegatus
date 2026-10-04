import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { children, cleanTerminalEnv, git, perimeterRemains, protectedInstall, readRecord, registerSelfUpdateCleanup, release, socketAnswers, start, until } from "./__fixtures__/cli-self-update";

/*
 * The cold-recovery matrix of the launcher's self-update, on the install
 * `bin/cli.selfUpdate.integration.test.ts` uses. It is a file of its own
 * because its thirty-six cases take most of the per-file time the local gate
 * allows; every child here is one the test or the CLI started.
 */

registerSelfUpdateCleanup();

test.each([...(["SIGKILL", "SIGTERM", "SIGINT"] as const).flatMap(signal => (["begin", "ready", "pointer", "switching", "pending", "admitting", "consumed", "preflight", "starting", "verified", "settlement", "settled"] as const).map(boundary => [signal, boundary] as const))] as const)("cold recovery retains the real apply across request consumption during load preflight: %s / %s", async (signal, boundary) => {
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { activeDrain } = await import("../src/lib/selfUpdate/drain");
  const { SelfUpdateService } = await import("../src/lib/selfUpdate/service");
  const { isAlive, readStartIdentity } = await import("../src/lib/selfUpdate/pid");
  const { idleUpdate } = await import("../src/lib/selfUpdate/types");
  const { f: fixture, key } = await protectedInstall("checkout", "LLV_TOKEN");
  const admissionMarker = path.join(fixture.root, "admission-entered");
  if (boundary === "admitting") {
    const next = path.join(fixture.checkout, "node_modules", ".bin", "next");
    writeFileSync(next, readFileSync(next, "utf8").replace("fetch(request) {", "async fetch(request) {")
      .replace('if (pathname === "/api/self-update/launcher-admission") return Response.json({ admitted: true });',
        `if (pathname === "/api/self-update/launcher-admission") { (await import("node:fs")).writeFileSync(${JSON.stringify(admissionMarker)}, ""); await Bun.sleep(2000); return Response.json({ admitted: true }); }`));
    git(fixture.checkout, "add", "-f", "."); git(fixture.checkout, "commit", "-m", "bounded admission fixture");
    fixture.first = git(fixture.checkout, "rev-parse", "HEAD");
  }
  if (boundary === "starting") {
    const next = path.join(fixture.checkout, "node_modules", ".bin", "next");
    writeFileSync(next, readFileSync(next, "utf8").replace("const stop = () => {", "const stop = async () => { await Bun.sleep(2000);"));
    git(fixture.checkout, "add", "-f", "."); git(fixture.checkout, "commit", "-m", "bounded child shutdown fixture");
    fixture.first = git(fixture.checkout, "rev-parse", "HEAD");
  }
  const running = await start(fixture);
  const before = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  const { installAction } = await import("../src/lib/selfUpdate/actions");
  const recovery = await installAction({ mode: "unsupported", reason: "no-launcher", record: null, installRoot: fixture.checkout },
    { cgroup: () => "", ready: () => false, env: { ...fixture.env, PORT: String(running.port) } });
  expect(recovery?.id).toBe("start-launcher");
  await perimeterRemains(running.port, key);
  const candidate = release(fixture, "crash-preflight");
  const marker = path.join(candidate.dir, "preflight-entered");
  const entry = path.join(candidate.dir, "bin", "cli.mjs");
  writeFileSync(entry, `if (process.argv.includes("--version")) { (await import("node:fs")).writeFileSync(${JSON.stringify(marker)}, String(process.pid)); await Bun.sleep(2000); }\n` + readFileSync(entry, "utf8").replace(/^#![^\n]*\n/, ""));
  const directory = path.dirname(before.requestFile); const apply = new ApplyController(directory);
  const { beginRestartGate, restartGateFile } = await import("../src/lib/selfUpdate/restartGate");
  const { writeDrain } = await import("../src/lib/selfUpdate/drain");
  const gateId = boundary === "admitting" ? beginRestartGate(restartGateFile(before.requestFile))! : undefined;
  apply.begin(before as never, candidate.sha, gateId ? "auto" : "operator", undefined, { autoGateId: gateId });
  if (gateId) writeDrain(path.join(directory, "auto-drain.json"), { id: apply.current!.requestId, target: candidate.sha,
    since: apply.current!.startedAt, until: Date.now() + 600_000, persistent: true });
  const unpublished = ["begin", "ready", "pointer", "switching"].includes(boundary);
  if (boundary !== "begin" && boundary !== "ready") writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, checkoutHead: fixture.first }));
  if (boundary === "ready") apply.patch({ state: "ready" });
  if (boundary === "switching") {
    // The exact durable send checkpoint before publishLauncherRequest.
    writeDrain(path.join(directory, "auto-drain.json"), { id: apply.current!.requestId, target: candidate.sha,
      since: apply.current!.startedAt, until: Date.now() + 600_000, persistent: true });
    apply.patch({ state: "switching", switchedAt: new Date().toISOString() });
  }
  if (boundary === "pending") process.kill(before.launcher.pid, "SIGSTOP");
  if (!unpublished) apply.send(before as never, gateId);
  const trialFile = path.join(path.dirname(before.requestFile), path.basename(before.requestFile).replace(/^request/, "trial"));
  if (unpublished) {
    expect(existsSync(before.requestFile)).toBe(false); expect(existsSync(trialFile)).toBe(false);
  } else if (boundary === "admitting") {
    await until(() => existsSync(admissionMarker));
    expect(JSON.parse(readFileSync(before.requestFile, "utf8"))).toMatchObject({ requestId: apply.current!.requestId, role: "relaunch", autoGateId: gateId });
    expect(existsSync(trialFile)).toBe(false);
  } else if (["verified", "settlement", "settled"].includes(boundary)) {
    const verified = await until(() => { const r = readRecord(fixture.state); return r.launcher.requestId === apply.current!.requestId
      && r.launcher.state === "healthy" && r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
    await perimeterRemains(running.port, key); expect(await socketAnswers(verified.socket)).toBe(true);
    if (boundary === "settlement") apply.patch({ state: "done" }); // Exact write before releaseAdmission.
    if (boundary === "settled") expect(apply.observe(verified as never, true)).toBe("done");
  } else if (boundary !== "pending") {
    await until(() => existsSync(trialFile) && (boundary === "starting"
      ? JSON.parse(readFileSync(trialFile, "utf8")).state === "starting"
      : boundary === "preflight" || existsSync(marker) && !existsSync(before.requestFile)));
    expect(JSON.parse(readFileSync(trialFile, "utf8"))).toMatchObject({ requestId: apply.current!.requestId, state: boundary === "starting" ? "starting" : "preflight" });
  } else {
    expect(JSON.parse(readFileSync(before.requestFile, "utf8"))).toMatchObject({ requestId: apply.current!.requestId, role: "relaunch" });
    expect(existsSync(trialFile)).toBe(false);
  }
  const atCrash = readRecord(fixture.state);
  const killed = new Promise(resolve => running.child.once("exit", resolve));
  process.kill(atCrash.launcher.pid, signal);
  if (boundary === "pending" && signal !== "SIGKILL") process.kill(before.launcher.pid, "SIGCONT");
  await Promise.race([killed, Bun.sleep(6000).then(() => { throw new Error("Launcher ignored termination at the custody boundary"); })]);
  if (boundary !== "settled") expect(readRecord(fixture.state).launcher).toMatchObject({ pid: before.launcher.pid, startIdentity: before.launcher.startIdentity });
  // A crashed launcher leaves its recorded children. Stop only these fixture
  // PIDs; cold startup then exercises the durable handoff on the same install.
  for (const role of [atCrash.web, atCrash.runtimeHost]) if (role.pid && isAlive(role.pid)) process.kill(role.pid, "SIGTERM");
  await until(() => !isAlive(atCrash.web.pid!) && !isAlive(atCrash.runtimeHost.pid!));
  await Bun.sleep(2200);
  const child = spawn("sh", ["-c", `exec ${recovery!.command!}`], { cwd: fixture.checkout, env: cleanTerminalEnv(fixture), stdio: ["ignore", "ignore", "pipe"] }); children.add(child);
  let recoveryError = "";
  child.stderr!.on("data", bytes => { recoveryError = (recoveryError + bytes.toString()).slice(-4096); });
  const terminalBeforeBoot = boundary === "settlement" || boundary === "settled";
  // The launcher records its children healthy, then the request it settled, in
  // two writes: wait for the second before reading the record.
  const after = await until(() => { const r = readRecord(fixture.state); return r.launcher.pid !== before.launcher.pid && r.web.state === "healthy" && r.runtimeHost.state === "healthy"
    && (terminalBeforeBoot || r.launcher.requestId !== null) ? r : null; })
    .catch(error => { throw new Error(`${String(error)}; cold exit=${child.exitCode}; ${recoveryError.replaceAll(key, "<redacted>")}`); });
  expect(await socketAnswers(after.socket)).toBe(true); await perimeterRemains(running.port, key);
  if (!terminalBeforeBoot) expect(after.launcher.requestId).toBe(apply.current!.requestId);
  const targetServes = signal === "SIGKILL" && boundary === "starting" || ["verified", "settlement", "settled"].includes(boundary);
  expect(after.launcher.revision).toBe(targetServes ? candidate.sha : fixture.first);
  if (boundary !== "settled") expect(activeDrain(path.join(directory, "auto-drain.json"))).not.toBeNull();
  const page = await fetch(`http://127.0.0.1:${running.port}/`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(2000) });
  // SIGKILL cannot write the stop marker. A durable starting trial is allowed
  // to finish its accepted target; handled signals retain their rollback rule.
  const completesTrial = targetServes;
  expect(await page.text()).toBe(completesTrial ? candidate.dir : fixture.checkout);
  const service = new SelfUpdateService({
    now: () => Date.now(), env: fixture.env, dir: directory, remote: "https://example.invalid/project.git", branch: "main", pollMinutes: 60, bun: process.execPath,
    mode: async () => ({ mode: "checkout", reason: null, record: after as never }), check: async () => ({ ok: false, error: "fixture", installed: null }),
    describe: async (_repo, sha) => ({ sha, short: sha.slice(0, 7), version: "", date: "" }), createRunner: () => ({ state: idleUpdate(), restore() {}, logPath: () => "" }) as never,
    requestRestart: () => "unused", processAlive: (pid, identity) => isAlive(pid) && readStartIdentity(pid) === identity, processIdentity: (pid) => readStartIdentity(pid),
    hostHealth: async () => await socketAnswers(after.socket) ? { pid: after.runtimeHost.pid!, startIdentity: readStartIdentity(after.runtimeHost.pid!)!, hostEpoch: 1 } : null,
    requestDeployment: async () => { throw new Error("unused"); }, readDeployment: async () => null, findDeploymentByIdempotencyKey: async () => null,
    releaseTarget: () => null, prepareCheckRepo: async () => { throw new Error("unused"); }, buildEnv: () => ({}), web: { pid: after.web.pid!, port: running.port, startedAt: "" },
  });
  try {
    const snapshot = await service.snapshot();
    expect(snapshot.busy).toBeNull(); expect(new ApplyController(directory).current).toMatchObject({ requestId: apply.current!.requestId, state: completesTrial ? "done" : "failed", rolledBack: !completesTrial });
    expect(activeDrain(path.join(directory, "auto-drain.json"))).toBeNull();
    expect(existsSync(before.releasePointer)).toBe(completesTrial);
    const receipt = JSON.parse(readFileSync(`${before.requestFile}.result.json`, "utf8"));
    expect(receipt).toMatchObject({ requestId: apply.current!.requestId, state: completesTrial ? "done" : "rolled-back" });
    const terminal = readFileSync(path.join(directory, "apply.json"), "utf8");
    const receiptBytes = readFileSync(`${before.requestFile}.result.json`, "utf8");
    if (terminalBeforeBoot) writeDrain(path.join(directory, "auto-drain.json"), { id: "subsequent-owner", target: "c".repeat(40),
      since: new Date().toISOString(), until: Date.now() + 600000, persistent: true });
    await service.snapshot(); expect(readFileSync(path.join(directory, "apply.json"), "utf8")).toBe(terminal);
    expect(readFileSync(`${before.requestFile}.result.json`, "utf8")).toBe(receiptBytes);
    if (terminalBeforeBoot) expect(activeDrain(path.join(directory, "auto-drain.json"))?.id).toBe("subsequent-owner");
  } finally { service.stop(); }
}, 60_000);

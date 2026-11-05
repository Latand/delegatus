/* A trial spans process images. Its durable intent lets the next launcher
   restore the exact previous pointer before replacing itself on failure. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, linkSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { headRevision, probePageAndChunk, readStartIdentity, runtimeHostStartIdentity, TERMINAL_BOOTSTRAP_TIMEOUT_MS } from "./self-update-supervisor.mjs";
import { probeHeadersFrom } from "./internalService.mjs";
import { viewerBootGateKey } from "./viewerGateKey.mjs";
import { assertLauncherAvailable } from "./launcher-adoption.mjs";
import "./envAlias.mjs";
import { releaseLauncherCredentials, restoreLauncherCredentials } from "./launcher-credentials.mjs";
import { lockLauncherStartup } from "./launcher-lock.mjs";
import { SERVICE_UNIT, unitRunsLauncher } from "./launcher-service-proof.mjs";
import { boundedWait, switchDeadline, SWITCH_TIMEOUT_MS, ROLLBACK_TIMEOUT_MS, STOP_TIMEOUT_MS, SWITCH_OVERRUN, writeLauncherRefusal } from "./launcher-deadline.mjs";
import { stopRecorded } from "./launcher-adoption.mjs";

export const LAUNCHER_RELAUNCH_PROTOCOL = "delegatus-launcher-relaunch-v1";

function atomic(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, file);
}

async function guardLegacyRollback(paths, trial, installRoot, owner = { pid: process.pid, identity: readStartIdentity(process.pid) }, recordOwner = undefined) {
  if (recordOwner === undefined) {
    try { recordOwner = JSON.parse(readFileSync(paths.record, "utf8")).launcher; } catch { /* startup may have no record yet */ }
  }
  const plan = { paths, requestId: trial.requestId, target: trial.target, installRoot,
    pid: owner.pid, identity: owner.identity, recordOwner, deadline: trial.rollbackDeadlineAt };
  const child = spawn(process.execPath, [...process.execArgv, join(dirname(fileURLToPath(import.meta.url)), "launcher-rollback-guard.mjs"),
    Buffer.from(JSON.stringify(plan)).toString("base64")], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.off("error", failed); child.off("exit", exited); child.stdout?.destroy();
      if (error) { child.kill("SIGKILL"); reject(error); } else { child.unref(); resolve(); }
    };
    const failed = () => finish(new Error("The rollback deadline guard could not start"));
    const exited = () => finish(new Error("The rollback deadline guard exited before readiness"));
    const timer = setTimeout(() => finish(new Error("The rollback deadline guard did not become ready")), 2000);
    child.once("error", failed); child.once("exit", exited);
    child.stdout?.once("data", data => String(data).trim() === "ready" ? finish() : failed());
  });
}

/* delegatus-terminal-bootstrap-v1: the shown command runs outside either
   launcher. It can catch an entry's import failure and keep the prior
   supervisor alive after reporting a failed upgrade to the terminal. */
async function terminalBootstrap(encoded, nextEntry, args) {
  const plan = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  restoreLauncherCredentials(plan.root);
  const name = basename(plan.requestFile);
  if (!/^request(?:-[^/\\]+)?\.json$/.test(name)) throw new Error("Invalid launcher request filename");
  const directory = dirname(plan.requestFile);
  const trialFile = join(directory, name.replace(/^request/, "trial"));
  const recordFile = join(directory, name.replace(/^request/, "launcher"));
  const applyFile = join(directory, "apply.json");
  const terminalPaths = { record: recordFile, trial: trialFile, request: plan.requestFile, releasePointer: plan.releasePointer };
  const startupLock = lockLauncherStartup(recordFile);
  assertLauncherAvailable({ record: recordFile });
  const read = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
  if (read(plan.releasePointer)?.sha !== plan.target) throw new Error("The selected release changed; no launcher was started.");
  const prior = plan.rollbackPointer === null ? plan.root : readPointer(plan.rollbackPointer)?.dir;
  if (plan.rollbackPointer === undefined || typeof prior !== "string" || !existsSync(join(prior, "bin", "cli.mjs"))) {
    throw new Error("The prior release cannot be verified; no launcher was started.");
  }
  const priorEntry = join(prior, "bin", "cli.mjs");
  if (plan.checkout) {
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: prior, encoding: "utf8", timeout: 2000, killSignal: "SIGKILL" });
    if (head.status !== 0 || head.stdout.trim().slice(0, 7) !== plan.priorRevision) throw new Error("The prior release identity changed; no launcher was started.");
  } else if (read(join(prior, "package.json"))?.version !== plan.priorVersion) throw new Error("The prior package identity changed; no launcher was started.");
  let apply = read(applyFile);
  const owned = apply?.target === plan.target && apply.releasePointer === plan.releasePointer && ["ready", "switching"].includes(apply.state)
    && apply.rollbackPointer === plan.rollbackPointer;
  if (apply && ["building", "ready", "switching"].includes(apply.state) && !owned) throw new Error("Another apply owns this installation.");
  const existing = read(trialFile);
  if (existing && (!owned || existing.requestId !== apply.requestId || existing.target !== plan.target)) throw new Error("Another trial owns this installation.");
  const intent = existing ?? { requestId: owned ? apply.requestId : randomUUID(), target: plan.target,
    rollbackPointer: plan.rollbackPointer, previousEntry: priorEntry, state: "starting", at: new Date().toISOString() };
  // This is the actual operator handoff, with the original request identity
  // when one exists. Persist custody before a candidate may start.
  atomic(trialFile, JSON.stringify(intent) + "\n");
  if (owned) {
    apply = { ...apply, state: "switching", externalRestart: true, switchedAt: apply.switchedAt ?? new Date().toISOString() };
    apply.switchDeadlineAt = switchDeadline(apply);
    atomic(applyFile, JSON.stringify(apply) + "\n");
    atomic(join(directory, "auto-drain.json"), JSON.stringify({ id: intent.requestId, target: intent.target, since: intent.at, until: Date.now() + 600000, persistent: true }) + "\n");
  }
  const restore = () => {
    if (plan.rollbackPointer === null) rmSync(plan.releasePointer, { force: true });
    else atomic(plan.releasePointer, plan.rollbackPointer);
  };
  const scratch = mkdtempSync(join(tmpdir(), "delegatus-terminal-preflight-"));
  let loads;
  try {
    loads = spawnSync(process.execPath, [...process.execArgv, nextEntry, "--version"], { cwd: dirname(dirname(nextEntry)), timeout: 30000, killSignal: "SIGKILL", stdio: "ignore",
      env: { ...process.env, HOME: scratch, XDG_CONFIG_HOME: join(scratch, "config"), XDG_CACHE_HOME: join(scratch, "cache"), LLV_STATE_DIR: scratch, LLV_LAUNCHER_CREDENTIAL_HANDOFF: "0",
        LLV_LAUNCHER_REEXEC: "1", LLV_LAUNCHER_INSTALL_ROOT: plan.root, LLV_LAUNCHER_CHECKOUT: plan.root } }).status === 0;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  const rollback = detail => {
    restore(); atomic(trialFile, JSON.stringify({ ...intent, state: "rolled-back", detail,
      rollbackDeadlineAt: Date.now() + ROLLBACK_TIMEOUT_MS }) + "\n");
  };
  if (!loads) rollback("The replacement launcher failed its load check.");
  startupLock.release();
  const start = entry => {
    const child = spawn(process.execPath, [...process.execArgv, entry, ...args], { cwd: plan.root, detached: true, stdio: "ignore",
      env: { ...process.env, LLV_LAUNCHER_REEXEC: "1", LLV_LAUNCHER_INSTALL_ROOT: plan.root,
        LLV_LAUNCHER_CHECKOUT: plan.root, LLV_LAUNCHER_TRIAL: intent.requestId } });
    child.on("error", () => {}); child.unref(); return child;
  };
  const refusePrior = async (detail, priorChild, identity, trial) => {
    const refused = writeLauncherRefusal(terminalPaths, trial, detail);
    const currentRecord = read(recordFile);
    const ownsRecord = currentRecord?.launcher?.pid === priorChild.pid
      && currentRecord.launcher.startIdentity === identity;
    if (identity && readStartIdentity(priorChild.pid) === identity) {
      try { process.kill(priorChild.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    } else if (!priorChild.killed && priorChild.exitCode === null && priorChild.signalCode === null) {
      priorChild.kill("SIGKILL");
    }
    if (ownsRecord) await Promise.all([
      stopRecorded(currentRecord.web, currentRecord.socket, currentRecord.port, plan.root, plan.releasePointer),
      stopRecorded(currentRecord.runtimeHost, currentRecord.socket),
    ]);
    throw new Error(refused.detail);
  };
  const supervisePrior = async priorChild => {
    priorIdentity = readStartIdentity(priorChild.pid);
    const trial = read(trialFile);
    const previousOwner = read(recordFile)?.launcher;
    try {
      await guardLegacyRollback(terminalPaths, trial, plan.root,
        { pid: priorChild.pid, identity: priorIdentity }, previousOwner);
    } catch (error) {
      await refusePrior(`The prior launcher rollback guard could not start: ${error.message}`,
        priorChild, priorIdentity, trial);
    }
  };
  let child = start(loads ? nextEntry : priorEntry);
  let failed = !loads;
  let startedPrior = !loads;
  let priorIdentity = startedPrior ? readStartIdentity(child.pid) : null;
  if (startedPrior) await supervisePrior(child);
  const key = viewerBootGateKey(process.env);
  const headers = probeHeadersFrom(dirname(directory));
  if (key && !/[^\t\x20-\x7e]/.test(key)) headers.authorization = `Bearer ${key.trim()}`;
  const rollbackExpiry = failed ? read(trialFile)?.rollbackDeadlineAt : null;
  const deadline = Math.min(performance.now() + TERMINAL_BOOTSTRAP_TIMEOUT_MS,
    rollbackExpiry ? performance.now() + Math.max(0, rollbackExpiry - Date.now()) : Infinity);
  while (performance.now() < deadline) {
    const trial = read(trialFile); const record = read(recordFile);
    if (trial?.requestId === intent.requestId && trial.state === "rolled-back") failed = true;
    if (record && record.launcher.pid === child.pid && record.launcher.startIdentity && record.launcher.startIdentity === readStartIdentity(child.pid)
      && (!record.launcher.state || record.launcher.state === "healthy") && record.web.state === "healthy" && record.runtimeHost.state === "healthy"
      && record.web.startIdentity && record.runtimeHost.startIdentity
      && record.web.startIdentity === readStartIdentity(record.web.pid) && record.runtimeHost.startIdentity === readStartIdentity(record.runtimeHost.pid)
      && record.web.revision === record.runtimeHost.revision
      && record.web.revision === (failed ? plan.priorRevision : plan.target.slice(0, 7))
      && (failed || record.launcher.requestId === intent.requestId)) {
      const socketHealthy = await terminalHostHealthy(record);
      if (socketHealthy && await probePageAndChunk(record.port, 5000, headers) === null) {
        if (failed) {
          if (!owned && read(trialFile)?.requestId === intent.requestId) rmSync(trialFile, { force: true });
          console.error("Update failed; the verified prior release is serving under its launcher."); return 1;
        }
        return 0;
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      if (startedPrior) {
        const latest = read(trialFile);
        throw new Error(latest?.refused ? latest.detail : "The prior release could not start; update custody is retained.");
      }
      failed = true; startedPrior = true; rollback("The replacement launcher failed before readiness."); child = start(priorEntry);
      await supervisePrior(child);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (startedPrior) {
    const trial = read(trialFile);
    const detail = trial?.rollbackDeadlineAt && Date.now() >= trial.rollbackDeadlineAt
      ? "The launcher rollback exceeded its 10 minute deadline"
      : "Terminal launcher bootstrap exceeded its deadline";
    await refusePrior(detail, child, priorIdentity, trial);
  }
  throw new Error("Launcher health could not be verified; update custody is retained.");
}
function readPointer(raw) { try { return JSON.parse(raw); } catch { return null; } }

function terminalHostHealthy(record) {
  return new Promise(resolve => {
    const id = randomUUID(); const socket = net.createConnection(record.socket);
    let frame = ""; let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(false), 2000);
    socket.setEncoding("utf8"); socket.once("error", () => finish(false)); socket.once("end", () => finish(false));
    socket.once("connect", () => socket.write(JSON.stringify({ id, method: "runtime-host-health" }) + "\n"));
    socket.on("data", text => {
      frame += text;
      if (frame.length > 65536) return finish(false);
      if (!frame.includes("\n")) return;
      try {
        const response = JSON.parse(frame.slice(0, frame.indexOf("\n"))); const health = response.result;
        finish(response.id === id && response.ok === true && health?.pid === record.runtimeHost.pid
          && !!health.startIdentity && (health.startIdentity === record.runtimeHost.startIdentity
            || health.startIdentity === runtimeHostStartIdentity(record.runtimeHost.pid))
          && (!health.generation?.revision || health.generation.revision.slice(0, 7) === record.runtimeHost.revision));
      } catch { finish(false); }
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--terminal") {
  try { process.exitCode = await terminalBootstrap(process.argv[3], process.argv[4], process.argv.slice(5)); }
  catch (error) { console.error(error instanceof Error ? error.message : "Terminal launcher upgrade failed"); process.exitCode = 1; }
}

/* This helper belongs to the transient recovery unit, so stopping the old
   Viewer cannot interrupt rollback verification or release custody early. */
async function recoverService(file) {
  // The plan is removed on every exit. It holds no credential; it names the
  // custody that does.
  try { await recoverPlannedService(JSON.parse(readFileSync(file, "utf8"))); }
  finally { rmSync(file, { force: true }); }
}
export async function recoverPlannedService(plan, proven = unitRunsLauncher) {
  const name = basename(plan.requestFile);
  if (!/^request(?:-[^/\\]+)?\.json$/.test(name) || !SERVICE_UNIT.test(plan.unit) || typeof plan.root !== "string") throw new Error("Invalid recovery plan");
  const directory = dirname(plan.requestFile);
  // This unit starts with the service manager's environment. An access key
  // the Viewer was given is read from its protected custody; a key file is
  // found through the install's own directories.
  const environment = { ...process.env, ...(plan.context ?? {}), LLV_STATE_DIR: dirname(directory) };
  if (plan.custody) restoreLauncherCredentials(plan.root, Object.assign(environment, { LLV_LAUNCHER_CREDENTIAL_HANDOFF: "1" }));
  const headers = probeHeadersFrom(dirname(directory));
  const key = viewerBootGateKey(environment);
  if (key && !/[^\t\x20-\x7e]/.test(key)) headers.authorization = `Bearer ${key.trim()}`;
  const applyFile = join(directory, "apply.json");
  const trialFile = join(directory, name.replace(/^request/, "trial"));
  const recordFile = join(directory, name.replace(/^request/, "launcher"));
  const read = target => { try { return JSON.parse(readFileSync(target, "utf8")); } catch { return null; } };
  const intent = read(applyFile); const trial = read(trialFile); const owner = read(recordFile);
  if (intent?.requestId !== plan.requestId || intent.state !== "switching" || !intent.externalRestart || intent.trigger !== "operator"
    || trial?.requestId !== intent.requestId || trial.target !== intent.target || trial.rollbackPointer !== intent.rollbackPointer
    || trial.state !== "rolled-back" || owner?.launcher.pid !== intent.launcherPid || owner.launcher.startIdentity !== intent.launcherIdentity
    || readStartIdentity(intent.launcherPid) !== intent.launcherIdentity || existsSync(plan.requestFile)) throw new Error("Recovery ownership changed; custody is retained");
  const restored = () => intent.rollbackPointer === null ? !existsSync(intent.releasePointer)
    : existsSync(intent.releasePointer) && readFileSync(intent.releasePointer, "utf8") === intent.rollbackPointer;
  const revision = intent.rollbackPointer === null ? intent.rollbackHostRevision : readPointer(intent.rollbackPointer)?.sha?.slice(0, 7);
  if (!restored() || !revision || intent.rollbackWebRevision !== intent.rollbackHostRevision) throw new Error("Prior release is unverifiable; custody is retained");
  // A cgroup can name a terminal multiplexer or a terminal emulator just as
  // well: the unit is restarted only on proof that it runs this launcher.
  if (!proven(plan.unit, plan.root, intent.launcherPid)) throw new Error("The service is not proven to run this launcher; custody is retained");
  const restart = spawnSync("systemctl", ["--user", "restart", plan.unit], { timeout: 30_000, stdio: "ignore" });
  if (restart.status !== 0) throw new Error("Service recovery was refused; custody is retained");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const current = read(applyFile); const record = read(recordFile);
    if (current?.requestId !== intent.requestId || current.state !== "switching" || read(trialFile)?.requestId !== intent.requestId
      || !restored() || existsSync(plan.requestFile)) throw new Error("Recovery custody changed before health was proven");
    if (record && record.launcher.startIdentity && record.launcher.startIdentity === readStartIdentity(record.launcher.pid)
      && (record.launcher.pid !== intent.launcherPid || record.launcher.startIdentity !== intent.launcherIdentity)
      && (!record.launcher.state || record.launcher.state === "healthy")
      && record.web.state === "healthy" && record.runtimeHost.state === "healthy"
      && record.web.revision === revision && record.runtimeHost.revision === revision
      && record.web.startIdentity && record.web.startIdentity === readStartIdentity(record.web.pid)
      && record.runtimeHost.startIdentity && record.runtimeHost.startIdentity === readStartIdentity(record.runtimeHost.pid)
      && readFileSync(`/proc/${record.launcher.pid}/cmdline`, "utf8").split("\0").includes(trial.previousEntry)
      && await terminalHostHealthy(record) && await probePageAndChunk(record.port, 5000, headers) === null) {
      // Recheck the durable owner after the awaited health observations.
      const fresh = read(recordFile); const owned = read(applyFile); const heldTrial = read(trialFile);
      if (owned?.requestId !== intent.requestId || owned.state !== "switching" || !restored() || existsSync(plan.requestFile)
        || heldTrial?.requestId !== intent.requestId || heldTrial.state !== "rolled-back"
        || ["launcher", "web", "runtimeHost"].some(role => fresh?.[role]?.pid !== record[role].pid
          || fresh[role].startIdentity !== record[role].startIdentity || readStartIdentity(record[role].pid) !== record[role].startIdentity))
        throw new Error("Recovery owner changed during verification");
      atomic(applyFile, JSON.stringify({ ...current, state: "failed", rolledBack: true, detail: trial.detail }) + "\n");
      const drainFile = join(directory, "auto-drain.json");
      if (read(drainFile)?.id === intent.requestId) rmSync(drainFile, { force: true });
      if (read(trialFile)?.requestId === intent.requestId) rmSync(trialFile, { force: true });
      // The rollback is verified and settled: the handoff's key leaves the disk.
      if (plan.custody) releaseLauncherCredentials(plan.root, environment);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Prior release health is unproven; custody is retained");
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--recover-service") {
  try { await recoverService(process.argv[3]); }
  catch (error) { console.error(error instanceof Error ? error.message : "Service recovery failed"); process.exitCode = 1; }
}

export function createRelaunch({ paths, installRoot, entry, release, servingRelease = () => release, stop, record, args = process.argv.slice(2) }) {
  const trialFile = paths.trial;
  const canExec = process.platform !== "win32" && typeof process.execve === "function";
  let directTrial = false;
  let trial = null;
  let stopping = false;
  let preflightChild = null;
  let watchdog = null;
  let failing = null;
  let expired = false;
  let completedRequestId = null;
  const applyFile = join(dirname(paths.request), "apply.json");
  const rememberOverrun = detail => {
    if (!trial) return;
    trial = { ...trial, switchOverrun: trial.switchOverrun ?? detail };
    atomic(trialFile, `${JSON.stringify(trial)}\n`);
    let apply;
    try { apply = JSON.parse(readFileSync(applyFile, "utf8")); } catch { return; }
    if (apply?.requestId === trial.requestId && apply.target === trial.target && apply.state === "switching") {
      atomic(applyFile, `${JSON.stringify({ ...apply, switchDeadlineAt: trial.switchDeadlineAt,
        switchOverrun: trial.switchOverrun, detail: trial.switchOverrun })}\n`);
    }
  };
  const refuse = detail => {
    if (!trial && completedRequestId) {
      let accepted;
      try { accepted = JSON.parse(readFileSync(applyFile, "utf8")); } catch { /* retain an unreadable owner */ }
      if (accepted?.requestId === completedRequestId && accepted.target === release.sha && accepted.state === "switching") {
        trial = { requestId: accepted.requestId, target: accepted.target, rollbackPointer: accepted.rollbackPointer,
          previousEntry: entry, state: "starting", switchDeadlineAt: accepted.switchDeadlineAt };
      }
    }
    if (trial) { trial = writeLauncherRefusal(paths, trial, detail); detail = trial.detail; }
    console.error(`[self-update] launcher startup refused: ${detail}`);
    process.exit(75);
  };
  const stopAndRefuse = async detail => {
    try { await boundedWait(stop(), 2 * STOP_TIMEOUT_MS, "Launcher child shutdown timed out"); }
    catch (error) { detail = `${detail}: ${error.message}`; }
    refuse(detail);
  };
  const arm = () => {
    clearTimeout(watchdog);
    expired = false;
    const deadline = trial?.state === "rolled-back" ? trial.rollbackDeadlineAt
      : trial ? trial.switchDeadlineAt : Date.now() + SWITCH_TIMEOUT_MS;
    watchdog = setTimeout(() => {
      expired = true;
      const detail = trial?.state === "rolled-back" ? "The launcher rollback exceeded its 10 minute deadline"
        : trial ? SWITCH_OVERRUN : "The launcher startup exceeded its 10 minute deadline";
      if (trial?.state === "rolled-back") { rememberOverrun(detail); void stopAndRefuse(detail); }
      else {
        rememberOverrun(detail);
        console.error(`[self-update] ${detail}; ${trial ? "attempting rollback" : "stopping owned children"}`);
        void controller.failed(detail).then(async recovered => {
          if (!recovered) await stopAndRefuse(detail);
        }).catch(error => refuse(`${detail}: ${error.message}`));
      }
    }, Math.max(1, deadline - Date.now()));
    watchdog.unref();
  };
  try {
    const value = JSON.parse(readFileSync(trialFile, "utf8"));
    if (typeof value.requestId === "string" && typeof value.previousEntry === "string"
      && typeof value.target === "string" && /^[0-9a-f]{40}$/.test(value.target)
      && (value.rollbackPointer === null || typeof value.rollbackPointer === "string")) trial = value;
  } catch { /* No trial on an ordinary start. */ }
  // A receipt may precede the Viewer's settlement, then a cold start may be
  // hours later. That completed switch keeps its original outcome; this boot
  // gets the ordinary startup budget and never replays an expired switch.
  {
    const read = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
    const accepted = read(applyFile), receipt = read(`${paths.request}.result.json`), owner = read(paths.record)?.launcher;
    const completedAt = Date.parse(accepted?.switchCompletedAt ?? receipt?.completedAt ?? "");
    const receiptOwner = receipt?.requestId === accepted?.requestId && receipt?.target === accepted?.target && receipt?.revision === accepted?.target
      && receipt?.state === "done" && receipt?.issuerPid === accepted?.launcherPid && receipt?.issuerIdentity === accepted?.launcherIdentity
      && receipt?.launcherPid === owner?.pid && receipt?.launcherIdentity === owner?.startIdentity;
    const completedTimely = accepted && ["switching", "done"].includes(accepted.state)
      && accepted.releasePointer === paths.releasePointer && release.sha === accepted.target
      && (accepted.switchCompletedAt || receiptOwner)
      && Number.isFinite(completedAt) && completedAt < switchDeadline(accepted)
      && !accepted.switchOverrun && !receipt?.switchOverrun && !trial?.switchOverrun
      && (!trial || trial.requestId === accepted.requestId && trial.target === accepted.target);
    if (completedTimely) {
      if (!accepted.switchCompletedAt) atomic(applyFile, `${JSON.stringify({ ...accepted, switchCompletedAt: receipt.completedAt })}\n`);
      if (trial) rmSync(trialFile, { force: true });
      trial = null;
      completedRequestId = accepted.requestId;
    }
  }
  if (trial?.refused) {
    console.error(`[self-update] previous launcher startup refused: ${trial.detail}`);
    rmSync(trialFile, { force: true }); trial = null;
  }
  // A refused dispatch stopped nothing and owns no transition. Its preflight
  // trial can survive a crash between the refusal receipt and its removal.
  if (trial?.state === "preflight") {
    try {
      const refusal = JSON.parse(readFileSync(`${paths.request}.result.json`, "utf8"));
      if (refusal.requestId === trial.requestId && refusal.state === "rejected") { rmSync(trialFile, { force: true }); trial = null; }
    } catch { /* No refusal: the preflight trial keeps its cold recovery. */ }
  }

  const restore = (pointer) => {
    if (pointer === null) rmSync(paths.releasePointer, { force: true });
    else atomic(paths.releasePointer, pointer);
  };
  const exec = (nextEntry, requestId) => {
    if (stopping) return;
    const safeArgs = args.filter(arg => arg !== "--new-token" && arg !== "--new-operator-token");
    if (!safeArgs.includes("--no-open")) safeArgs.push("--no-open");
    process.chdir(dirname(dirname(nextEntry)));
    // The next image inherits this launcher's settings. A handoff requirement
    // was addressed to the terminal command that started this process and
    // ends with it.
    const inherited = { ...process.env };
    delete inherited.LLV_LAUNCHER_CREDENTIAL_HANDOFF;
    process.execve(process.execPath, [process.execPath, ...process.execArgv, nextEntry, ...safeArgs], {
      ...inherited, LLV_LAUNCHER_REEXEC: "1", LLV_LAUNCHER_CHECKOUT: installRoot, LLV_LAUNCHER_INSTALL_ROOT: installRoot,
      LLV_LAUNCHER_TRIAL: requestId,
    });
    throw new Error("launcher exec returned without replacing the process");
  };
  let pendingRecovery = trial?.state === "preflight" || trial?.state === "starting" && trial.stopped === true;
  if (pendingRecovery) directTrial = true;
  if (!trial && !completedRequestId) {
    const read = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
    const applyFile = join(dirname(paths.request), "apply.json");
    const apply = read(applyFile);
    const receipt = read(`${paths.request}.result.json`);
    // The launcher refused this apply before stopping anything. A cold start
    // already on the target is the transition; on any other image the Viewer
    // settles the refusal, and neither replays a rollback.
    const refused = receipt?.requestId === apply?.requestId && receipt?.state === "rejected";
    const onTarget = release.sha === apply?.target && entry === join(release.dir, "bin", "cli.mjs");
    /* The serving state an apply captured need not match its pointer: a
       checkout whose HEAD moved past the pointer serves that HEAD, and a
       checkout launcher can supervise a release. Such an apply names no prior
       launcher this start could verify. A start that is not the candidate
       itself then serves what the restored pointer selects, by the ordinary
       rule of every start, and the apply ends failed. Refusing to start would
       leave the install down with its hold in place. */
    let unverifiedPrior = false;
    if (apply && ["building", "ready", "switching"].includes(apply.state) && (!refused || onTarget)
      && !apply.rollbackPackage && readPointer(apply.rollbackPointer)?.kind !== "package" && release.sha !== apply.target) {
      const priorPointer = readPointer(apply.rollbackPointer);
      const prior = apply.rollbackPointer === null ? installRoot : priorPointer?.dir;
      const previousSha = typeof prior === "string" ? priorPointer?.sha ?? headRevision(prior) : null;
      unverifiedPrior = typeof prior === "string" && existsSync(join(prior, "bin", "cli.mjs"))
        && (!previousSha || headRevision(prior) !== previousSha
          || apply.rollbackWebRevision !== previousSha.slice(0, 7) || apply.rollbackHostRevision !== previousSha.slice(0, 7));
    }
    if (unverifiedPrior) {
      const request = read(paths.request);
      const pointer = read(paths.releasePointer);
      if (pointer?.sha === apply.target) restore(apply.rollbackPointer);
      atomic(applyFile, JSON.stringify({ ...apply, state: "failed", rolledBack: false, ...(apply.trigger === "auto" ? { admissionRefused: true } : {}),
        detail: "The launcher restarted before the update was applied; the installed release serves" }) + "\n");
      if (request?.requestId === apply.requestId) rmSync(paths.request, { force: true });
      const drainFile = join(dirname(paths.request), "auto-drain.json");
      if (read(drainFile)?.id === apply.requestId) rmSync(drainFile, { force: true });
    } else if (apply && ["building", "ready", "switching"].includes(apply.state) && (!refused || onTarget)) {
      const request = read(paths.request);
      const owner = read(paths.record)?.launcher;
      const receiptOwner = receipt?.requestId === apply.requestId && receipt.target === apply.target
        && ["done", "rolled-back"].includes(receipt.state) && receipt.issuerPid === apply.launcherPid
        && receipt.issuerIdentity === apply.launcherIdentity && receipt.launcherPid === owner?.pid
        && receipt.launcherIdentity === owner?.startIdentity;
      if (typeof apply.requestId !== "string" || !/^[0-9a-f]{40}$/.test(apply.target)
        || apply.releasePointer !== paths.releasePointer || !apply.launcherIdentity
        || !receiptOwner && (owner?.pid !== apply.launcherPid || owner.startIdentity !== apply.launcherIdentity)
        || !(apply.rollbackPointer === null || typeof apply.rollbackPointer === "string")
        || request && (request.role !== "relaunch" || request.requestId !== apply.requestId || request.target !== apply.target
          || request.rollbackPointer !== apply.rollbackPointer || request.requestedAt !== apply.startedAt))
        throw new Error("Cold recovery cannot verify the accepted apply owner; custody is retained.");
      const pointer = read(paths.releasePointer);
      if (pointer && pointer.sha !== apply.target && readFileSync(paths.releasePointer, "utf8") !== apply.rollbackPointer)
        throw new Error("Another release owns the pointer; accepted custody is retained.");
      const priorPointer = readPointer(apply.rollbackPointer);
      const prior = apply.rollbackPointer === null ? installRoot : priorPointer?.dir;
      if (typeof prior !== "string" || !existsSync(join(prior, "bin", "cli.mjs")))
        throw new Error("Cold recovery cannot verify the prior launcher; custody is retained.");
      const previousSha = priorPointer?.sha ?? headRevision(prior);
      let priorEntry = join(prior, "bin", "cli.mjs");
      if (priorPointer?.kind === "package" || apply.rollbackPackage) {
        const version = read(join(prior, "package.json"))?.version;
        if (version !== (priorPointer?.version ?? apply.rollbackPackage?.version))
          throw new Error("Cold recovery cannot verify the prior package; custody is retained.");
      } else if (!previousSha || headRevision(prior) !== previousSha
        || apply.rollbackWebRevision !== previousSha.slice(0, 7) || apply.rollbackHostRevision !== previousSha.slice(0, 7)) {
        // This start is the candidate itself, and the apply names no prior
        // launcher it could verify. The install's own entry is the one every
        // start goes through: it serves what the restored pointer selects.
        priorEntry = join(installRoot, "bin", "cli.mjs");
        if (!existsSync(priorEntry)) throw new Error("Cold recovery cannot verify the prior serving release; custody is retained.");
      }
      // The earliest accepted apply is authoritative even before any request
      // exists. Its real request and original owner bind the recovery trial.
      // A verified rollback receipt already completed the image transition.
      // Starting its prior image must not replay failed() and require another
      // exec or service-manager start (neither exists in a Windows terminal).
      const rolledBack = receiptOwner && receipt.state === "rolled-back"
        && receipt.revision === release.sha && receipt.previousEntry === priorEntry
        && entry === receipt.previousEntry
        && (apply.rollbackPointer === null ? pointer === null
          : readFileSync(paths.releasePointer, "utf8") === apply.rollbackPointer);
      trial = { requestId: apply.requestId, target: apply.target, rollbackPointer: apply.rollbackPointer,
        previousEntry: priorEntry, state: rolledBack ? "rolled-back" : "starting", at: apply.startedAt,
        ...(rolledBack ? { detail: receipt.detail } : {}) };
      atomic(trialFile, JSON.stringify(trial) + "\n");
      const drainFile = join(dirname(paths.request), "auto-drain.json");
      const drain = read(drainFile);
      if (drain && drain.target !== apply.target) throw new Error("Another admission hold owns this installation.");
      if (!drain) atomic(drainFile, JSON.stringify({ id: apply.requestId, target: apply.target,
        since: apply.startedAt, until: Date.now() + 600000, persistent: true }) + "\n");
      const switching = { ...apply, state: "switching", switchedAt: apply.switchedAt ?? new Date().toISOString() };
      switching.switchDeadlineAt = switchDeadline(switching);
      atomic(applyFile, JSON.stringify(switching) + "\n");
      if (request) rmSync(paths.request, { force: true });
      const completed = receipt?.requestId === apply.requestId && receipt.target === apply.target && receipt.state === "done"
        && receiptOwner && receipt.revision === apply.target && release.sha === apply.target;
      const externalReady = apply.externalRestart && apply.state === "ready" && release.sha === apply.target
        && entry === join(release.dir, "bin", "cli.mjs");
      if (refused) rmSync(`${paths.request}.result.json`, { force: true });
      directTrial = true; pendingRecovery = !completed && !externalReady && !rolledBack && !refused;
    }
  }
  if (trial) {
    let apply;
    try { apply = JSON.parse(readFileSync(applyFile, "utf8")); } catch { /* legacy trial */ }
    trial = { ...trial, switchDeadlineAt: Number.isFinite(trial.switchDeadlineAt) ? trial.switchDeadlineAt
      : switchDeadline(apply?.requestId === trial.requestId && apply.switchedAt ? apply : trial),
      ...(trial.state === "rolled-back" ? { rollbackDeadlineAt: trial.rollbackDeadlineAt ?? Date.now() + ROLLBACK_TIMEOUT_MS } : {}) };
    atomic(trialFile, `${JSON.stringify(trial)}\n`);
  }
  const controller = {
    canExec,
    requestStop() {
      stopping = true;
      clearTimeout(watchdog);
      if (trial && trial.state !== "rolled-back") {
        trial = { ...trial, stopped: true };
        try { atomic(trialFile, `${JSON.stringify(trial)}\n`); }
        catch { /* Retain the original trial even if the stop marker cannot persist. */ }
      }
      preflightChild?.kill("SIGKILL");
    },
    isStopping: () => stopping || failing !== null,
    assertStarting() {
      if (stopping || failing || expired) throw new Error("Launcher startup was cancelled");
      if (trial && Date.now() >= (trial.state === "rolled-back" ? trial.rollbackDeadlineAt : trial.switchDeadlineAt)) {
        throw new Error(trial.state === "rolled-back" ? "The launcher rollback exceeded its 10 minute deadline" : SWITCH_OVERRUN);
      }
    },
    retainsCustody: () => trial !== null || existsSync(paths.request),
    hasTrial: () => trial !== null && trial.state !== "rolled-back",
    isReplacementStart: () => trial !== null,
    async recoverPending() {
      if (trial?.state === "rolled-back" && Date.now() >= trial.rollbackDeadlineAt) {
        return stopAndRefuse("The launcher rollback exceeded its 10 minute deadline");
      }
      if (trial && trial.state !== "rolled-back" && Date.now() >= trial.switchDeadlineAt) {
        rememberOverrun(SWITCH_OVERRUN);
        return this.failed(SWITCH_OVERRUN);
      }
      if (pendingRecovery) await this.failed("The launcher stopped before taking the durable update request.");
    },
    /* `readmit` asks the Viewer to admit an automatic request once more. A
       caller that cannot ask leaves an automatic request refused. */
    async begin(request, next, dispatchFence = () => true, readmit = async () => false) {
      if (stopping) return;
      if (!canExec) throw new Error("This interpreter needs a launcher restart to apply an update.");
      const read = file => { try { return readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
      const applyFile = join(dirname(paths.request), "apply.json");
      const settled = () => { const apply = readPointer(read(applyFile)); return apply?.requestId === request.requestId && ["done", "failed"].includes(apply.state); };
      // A request republished by a refusal can outlive the Viewer's settlement.
      if (settled()) return;
      if (next.sha !== request.target || next.dir === release.dir) throw new Error("Relaunch target is not the installed release.");
      const nextEntry = join(next.dir, "bin", "cli.mjs");
      // The Viewer captures this before publishing the new pointer. Older
      // callers can still roll back to the serving directory.
      const previous = servingRelease();
      const rollbackPointer = request.rollbackPointer === null || typeof request.rollbackPointer === "string"
        ? request.rollbackPointer
        : previous.published ? `${JSON.stringify({ sha: previous.sha, dir: previous.dir })}\n` : null;
      const gateFile = join(dirname(paths.request), "auto-admission.json");
      const applyBinding = read(applyFile), gateBinding = request.autoGateId ? read(gateFile) : null;
      const owner = JSON.parse(read(paths.record))?.launcher;
      const acceptedApply = readPointer(applyBinding);
      if (owner?.pid !== process.pid || owner.startIdentity !== readStartIdentity(process.pid)
        || acceptedApply && ["building", "ready", "switching"].includes(acceptedApply.state)
          && (acceptedApply.requestId !== request.requestId || acceptedApply.target !== request.target
            || acceptedApply.launcherPid !== process.pid || acceptedApply.launcherIdentity !== owner.startIdentity)
        || !dispatchFence()) return false;
      const ownerBinding = JSON.stringify(owner);
      let intent = { requestId: request.requestId, target: next.sha, rollbackPointer, previousEntry: entry, state: "preflight", at: new Date().toISOString(),
        previousDeadlineCapable: 1,
        switchDeadlineAt: switchDeadline(acceptedApply?.requestId === request.requestId && acceptedApply.target === request.target ? acceptedApply : {}) };
      try { atomic(trialFile, `${JSON.stringify(intent)}\n`); }
      catch (error) { restore(rollbackPointer); throw error; }
      trial = intent;
      arm();
      directTrial = true;
      // The durable trial takes ownership before the request disappears,
      // including while the load check is running in a separate process.
      try {
        if (JSON.parse(readFileSync(paths.request, "utf8")).requestId === request.requestId) rmSync(paths.request, { force: true });
      } catch { /* A direct caller need not publish a request file. */ }
      const scratch = mkdtempSync(join(tmpdir(), "delegatus-launcher-preflight-"));
      let preflight;
      try {
        preflight = await boundedWait(new Promise(resolve => {
          const child = spawn(process.execPath, [...process.execArgv, nextEntry, "--version"], {
            cwd: next.dir, stdio: "ignore",
            env: { ...process.env, HOME: scratch, XDG_CONFIG_HOME: join(scratch, "config"),
              XDG_CACHE_HOME: join(scratch, "cache"), LLV_STATE_DIR: scratch, LLV_LAUNCHER_CREDENTIAL_HANDOFF: "0",
              LLV_LAUNCHER_REEXEC: "1", LLV_LAUNCHER_CHECKOUT: installRoot },
          });
          preflightChild = child;
          const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
          child.once("error", () => { clearTimeout(timeout); resolve(false); });
          child.once("exit", code => { clearTimeout(timeout); resolve(code === 0); });
        }), 35_000, "The launcher load check did not exit after SIGKILL");
      } finally { preflightChild = null; rmSync(scratch, { recursive: true, force: true }); }
      // Signal handling shares this fence with every image transition. The
      // durable preflight trial remains authoritative for a cold recovery.
      if (stopping || failing || trial?.state !== "preflight") return;
      if (!preflight) {
        restore(rollbackPointer);
        record.set("launcher", { state: "healthy", requestId: request.requestId,
          error: { kind: "fell-back", revision: next.sha.slice(0, 7), detail: "The replacement launcher failed its load check." } });
        rmSync(trialFile, { force: true }); trial = null;
        clearTimeout(watchdog);
        return;
      }
      // The load check can run for half a minute, and work admitted meanwhile
      // is written where only the Viewer reads it. An automatic request is
      // therefore admitted by the Viewer again: its answer is the last awaited
      // read, and the final fence and the starting intent write that follow
      // form one synchronous dispatch boundary. An operator's request carries
      // the operator's own decision and is not asked about again.
      let readmitted = request.autoGateId === undefined;
      if (!readmitted) try { readmitted = await readmit() === true; } catch { /* refused below */ }
      if (stopping || failing || trial?.state !== "preflight") return;
      let currentGate;
      try { currentGate = JSON.parse(read(gateFile)); } catch { /* refused below */ }
      const pending = read(paths.request);
      if (read(applyFile) !== applyBinding || JSON.stringify(JSON.parse(read(paths.record))?.launcher) !== ownerBinding
        || !readmitted
        || read(trialFile) !== `${JSON.stringify(intent)}\n`
        || pending !== null && JSON.parse(pending)?.requestId !== request.requestId
        || request.autoGateId && (read(gateFile) !== gateBinding || currentGate?.id !== request.autoGateId || currentGate.until <= Date.now()) || !dispatchFence(true)) {
        if (pending === null && !settled()) {
          const temporary = `${paths.request}.${randomUUID()}.tmp`;
          try { writeFileSync(temporary, `${JSON.stringify(request)}\n`, { mode: 0o600, flag: "wx" }); linkSync(temporary, paths.request); }
          catch (error) { if (error.code !== "EEXIST") throw error; }
          finally { rmSync(temporary, { force: true }); }
        }
        atomic(`${paths.request}.result.json`, JSON.stringify({ requestId: request.requestId, state: "rejected", detail: readmitted ? "Stale launcher dispatch custody" : "The Viewer did not admit the relaunch after the launcher load check" }) + "\n");
        // The refusal owns no transition: nothing was stopped, so no later
        // failure may roll this trial back. The receipt precedes its removal.
        if (read(trialFile) === `${JSON.stringify(intent)}\n`) rmSync(trialFile, { force: true });
        trial = null;
        clearTimeout(watchdog);
        return false;
      }
      intent = { ...intent, state: "starting" };
      atomic(trialFile, `${JSON.stringify(intent)}\n`); trial = intent;
      // Only a durable intent admits child shutdown. A failed write leaves
      // the serving processes under their current supervisor.
      record.set("web", { state: "stopping" });
      record.set("runtimeHost", { state: "stopping" });
      record.set("launcher", { state: "relaunching", requestId: request.requestId });
      await boundedWait(stop(), 2 * STOP_TIMEOUT_MS, "Launcher child shutdown timed out");
      // The PID and its start identity survive exec. Retain that custody
      // record while children are down so another startup cannot take it.
      if (stopping || failing) return;
      exec(nextEntry, trial.requestId);
    },
    async succeeded() {
      if (stopping) return;
      if (expired && !trial) return stopAndRefuse("The launcher startup exceeded its 10 minute deadline");
      if (trial?.state !== "rolled-back" && trial && Date.now() >= trial.switchDeadlineAt) {
        rememberOverrun(SWITCH_OVERRUN);
        return this.failed(SWITCH_OVERRUN);
      }
      if (trial?.state === "rolled-back" && Date.now() >= trial.rollbackDeadlineAt) return stopAndRefuse("The launcher rollback exceeded its 10 minute deadline");
      clearTimeout(watchdog);
      const error = trial?.state === "rolled-back"
        ? { kind: "fell-back", revision: trial.target.slice(0, 7), detail: trial.detail }
        : null;
      record.set("launcher", { state: "healthy", requestId: trial?.requestId ?? completedRequestId, error });
      if (trial) {
        let accepted;
        try { accepted = JSON.parse(readFileSync(join(dirname(paths.request), "apply.json"), "utf8")); } catch { /* legacy trial */ }
        const owned = accepted?.requestId === trial.requestId && accepted.target === trial.target;
        atomic(`${paths.request}.result.json`, JSON.stringify({ requestId: trial.requestId,
          target: trial.target, previousEntry: trial.previousEntry, launcherPid: process.pid, launcherIdentity: readStartIdentity(process.pid), revision: release.sha,
          ...(owned ? { issuerPid: accepted.launcherPid, issuerIdentity: accepted.launcherIdentity } : {}),
          state: error ? "rolled-back" : "done", detail: trial.detail, completedAt: new Date().toISOString(),
          switchDeadlineAt: trial.switchDeadlineAt, switchOverrun: trial.switchOverrun }) + "\n");
      }
      if (trial) rmSync(trialFile, { force: true });
      trial = null;
      delete process.env.LLV_LAUNCHER_TRIAL;
    },
    async failed(detail) {
      if (stopping) return false;
      if (!trial || trial.state === "rolled-back") return false;
      if (failing) return failing;
      // Only a starting intent admitted child shutdown. A load check that
      // failed in this process leaves the serving children and the pointer to
      // the Viewer's settlement; a cold preflight trial still rolls back.
      if (trial.state === "preflight" && !pendingRecovery) {
        const expired = !!trial.switchOverrun;
        if (expired) {
          preflightChild?.kill("SIGKILL");
          record.set("launcher", { state: "healthy", requestId: trial.requestId,
            error: { kind: "message", text: trial.switchOverrun } });
        }
        rmSync(trialFile, { force: true }); trial = null;
        clearTimeout(watchdog);
        return expired;
      }
      clearTimeout(watchdog);
      failing = (async () => {
        try { await boundedWait(stop(), 2 * STOP_TIMEOUT_MS, "Launcher child shutdown timed out"); }
        catch (error) { refuse(`${detail}: ${error.message}`); }
        if (stopping) return false;
        restore(trial.rollbackPointer);
        trial = { ...trial, state: "rolled-back", detail: trial.switchOverrun ?? detail,
          rollbackDeadlineAt: trial.rollbackDeadlineAt ?? Date.now() + ROLLBACK_TIMEOUT_MS };
        atomic(trialFile, `${JSON.stringify(trial)}\n`);
        arm();
        if ((directTrial || process.env.LLV_LAUNCHER_TRIAL === trial.requestId) && canExec) {
          if (trial.previousDeadlineCapable !== 1) {
            try { await guardLegacyRollback(paths, trial, installRoot); }
            catch (error) { refuse(`${detail}: ${error.message}`); }
            if (stopping) return false;
          }
          try { exec(trial.previousEntry, trial.requestId); }
          catch { /* The manager/bootstrap must restart after a failed exec. */ }
        }
        // A service-manager restart was requested outside this unit. Its next
        // start follows the restored pointer, keeping rollback outside Viewer.
        record.remove();
        process.exit(75);
      })();
      return failing;
    },
  };
  arm();
  return controller;
}

/* A trial spans process images. Its durable intent lets the next launcher
   restore the exact previous pointer before replacing itself on failure. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dispatchActivityVersion, headRevision, probePageAndChunk, readStartIdentity, runtimeHostStartIdentity } from "./self-update-supervisor.mjs";
import { probeHeadersFrom } from "./internalService.mjs";
import { viewerBootGateKey } from "./viewerGateKey.mjs";
import { assertLauncherAvailable } from "./launcher-adoption.mjs";
import "./envAlias.mjs";
import { restoreLauncherCredentials } from "./launcher-credentials.mjs";
import { lockLauncherStartup } from "./launcher-lock.mjs";

export const LAUNCHER_RELAUNCH_PROTOCOL = "delegatus-launcher-relaunch-v1";

function atomic(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, file);
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
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: prior, encoding: "utf8", timeout: 2000 });
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
    apply = { ...apply, state: "switching", externalRestart: true, switchedAt: new Date().toISOString() };
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
    loads = spawnSync(process.execPath, [...process.execArgv, nextEntry, "--version"], { cwd: dirname(dirname(nextEntry)), timeout: 30000, stdio: "ignore",
      env: { ...process.env, HOME: scratch, XDG_CONFIG_HOME: join(scratch, "config"), XDG_CACHE_HOME: join(scratch, "cache"), LLV_STATE_DIR: scratch, LLV_LAUNCHER_CREDENTIAL_HANDOFF: "0",
        LLV_LAUNCHER_REEXEC: "1", LLV_LAUNCHER_INSTALL_ROOT: plan.root, LLV_LAUNCHER_CHECKOUT: plan.root } }).status === 0;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  const rollback = detail => {
    restore(); atomic(trialFile, JSON.stringify({ ...intent, state: "rolled-back", detail }) + "\n");
  };
  if (!loads) rollback("The replacement launcher failed its load check.");
  startupLock.release();
  const start = entry => {
    const child = spawn(process.execPath, [...process.execArgv, entry, ...args], { cwd: plan.root, detached: true, stdio: "ignore",
      env: { ...process.env, LLV_LAUNCHER_REEXEC: "1", LLV_LAUNCHER_INSTALL_ROOT: plan.root,
        LLV_LAUNCHER_CHECKOUT: plan.root, LLV_LAUNCHER_TRIAL: intent.requestId } });
    child.on("error", () => {}); child.unref(); return child;
  };
  let child = start(loads ? nextEntry : priorEntry);
  let failed = !loads;
  let startedPrior = !loads;
  const key = viewerBootGateKey(process.env);
  const headers = probeHeadersFrom(dirname(directory));
  if (key && !/[^\t\x20-\x7e]/.test(key)) headers.authorization = `Bearer ${key.trim()}`;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
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
      if (startedPrior) throw new Error("The prior release could not start; update custody is retained.");
      failed = true; startedPrior = true; rollback("The replacement launcher failed before readiness."); child = start(priorEntry);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
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
  const plan = JSON.parse(readFileSync(file, "utf8"));
  const name = basename(plan.requestFile);
  if (!/^request(?:-[^/\\]+)?\.json$/.test(name) || !/^[A-Za-z0-9_.@\\x-]+\.service$/.test(plan.unit)) throw new Error("Invalid recovery plan");
  const directory = dirname(plan.requestFile);
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
      && await terminalHostHealthy(record) && await probePageAndChunk(record.port, 5000, plan.headers) === null) {
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
      rmSync(file, { force: true });
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
  try {
    const value = JSON.parse(readFileSync(trialFile, "utf8"));
    if (typeof value.requestId === "string" && typeof value.previousEntry === "string"
      && typeof value.target === "string" && /^[0-9a-f]{40}$/.test(value.target)
      && (value.rollbackPointer === null || typeof value.rollbackPointer === "string")) trial = value;
  } catch { /* No trial on an ordinary start. */ }

  const restore = (pointer) => {
    if (pointer === null) rmSync(paths.releasePointer, { force: true });
    else atomic(paths.releasePointer, pointer);
  };
  const exec = (nextEntry, requestId) => {
    if (stopping) return;
    const safeArgs = args.filter(arg => arg !== "--new-token" && arg !== "--new-operator-token");
    if (!safeArgs.includes("--no-open")) safeArgs.push("--no-open");
    process.chdir(dirname(dirname(nextEntry)));
    process.execve(process.execPath, [process.execPath, ...process.execArgv, nextEntry, ...safeArgs], {
      ...process.env, LLV_LAUNCHER_REEXEC: "1", LLV_LAUNCHER_CHECKOUT: installRoot, LLV_LAUNCHER_INSTALL_ROOT: installRoot,
      LLV_LAUNCHER_TRIAL: requestId,
    });
    throw new Error("launcher exec returned without replacing the process");
  };
  let pendingRecovery = trial?.state === "preflight" || trial?.state === "starting" && trial.stopped === true;
  if (pendingRecovery) directTrial = true;
  if (!trial) {
    const read = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
    const applyFile = join(dirname(paths.request), "apply.json");
    const apply = read(applyFile);
    if (apply && ["building", "ready", "switching"].includes(apply.state) && !apply.externalRestart) {
      const request = read(paths.request);
      const owner = read(paths.record)?.launcher;
      if (typeof apply.requestId !== "string" || !/^[0-9a-f]{40}$/.test(apply.target)
        || apply.releasePointer !== paths.releasePointer || !apply.launcherIdentity
        || owner?.pid !== apply.launcherPid || owner.startIdentity !== apply.launcherIdentity
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
      if (priorPointer?.kind === "package" || apply.rollbackPackage) {
        const version = read(join(prior, "package.json"))?.version;
        if (version !== (priorPointer?.version ?? apply.rollbackPackage?.version))
          throw new Error("Cold recovery cannot verify the prior package; custody is retained.");
      } else if (!previousSha || headRevision(prior) !== previousSha
        || apply.rollbackWebRevision !== previousSha.slice(0, 7) || apply.rollbackHostRevision !== previousSha.slice(0, 7))
        throw new Error("Cold recovery cannot verify the prior serving release; custody is retained.");
      // The earliest accepted apply is authoritative even before any request
      // exists. Its real request and original owner bind the recovery trial.
      trial = { requestId: apply.requestId, target: apply.target, rollbackPointer: apply.rollbackPointer,
        previousEntry: join(prior, "bin", "cli.mjs"), state: "starting", at: apply.startedAt };
      atomic(trialFile, JSON.stringify(trial) + "\n");
      const drainFile = join(dirname(paths.request), "auto-drain.json");
      const drain = read(drainFile);
      if (drain && drain.target !== apply.target) throw new Error("Another admission hold owns this installation.");
      if (!drain) atomic(drainFile, JSON.stringify({ id: apply.requestId, target: apply.target,
        since: apply.startedAt, until: Date.now() + 600000, persistent: true }) + "\n");
      atomic(applyFile, JSON.stringify({ ...apply, state: "switching", switchedAt: apply.switchedAt ?? new Date().toISOString() }) + "\n");
      if (request) rmSync(paths.request, { force: true });
      directTrial = true; pendingRecovery = true;
    }
  }
  return {
    canExec,
    requestStop() {
      stopping = true;
      if (trial && trial.state !== "rolled-back") {
        trial = { ...trial, stopped: true };
        try { atomic(trialFile, `${JSON.stringify(trial)}\n`); }
        catch { /* Retain the original trial even if the stop marker cannot persist. */ }
      }
      preflightChild?.kill("SIGKILL");
    },
    isStopping: () => stopping,
    retainsCustody: () => trial !== null || existsSync(paths.request),
    hasTrial: () => trial !== null && trial.state !== "rolled-back",
    isReplacementStart: () => trial !== null,
    async recoverPending() {
      if (pendingRecovery) await this.failed("The launcher stopped before taking the durable update request.");
    },
    async begin(request, next) {
      if (stopping) return;
      if (!canExec) throw new Error("This interpreter needs a launcher restart to apply an update.");
      if (next.sha !== request.target || next.dir === release.dir) throw new Error("Relaunch target is not the installed release.");
      const nextEntry = join(next.dir, "bin", "cli.mjs");
      // The Viewer captures this before publishing the new pointer. Older
      // callers can still roll back to the serving directory.
      const previous = servingRelease();
      const rollbackPointer = request.rollbackPointer === null || typeof request.rollbackPointer === "string"
        ? request.rollbackPointer
        : previous.published ? `${JSON.stringify({ sha: previous.sha, dir: previous.dir })}\n` : null;
      const read = file => { try { return readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
      const applyFile = join(dirname(paths.request), "apply.json");
      const gateFile = join(dirname(paths.request), "auto-admission.json");
      const applyBinding = read(applyFile), gateBinding = request.autoGateId ? read(gateFile) : null;
      const ownerBinding = JSON.stringify(JSON.parse(read(paths.record))?.launcher);
      const activity = dispatchActivityVersion(dirname(dirname(paths.request)));
      let intent = { requestId: request.requestId, target: next.sha, rollbackPointer, previousEntry: entry, state: "preflight", at: new Date().toISOString() };
      try { atomic(trialFile, `${JSON.stringify(intent)}\n`); }
      catch (error) { restore(rollbackPointer); throw error; }
      trial = intent;
      directTrial = true;
      // The durable trial takes ownership before the request disappears,
      // including while the load check is running in a separate process.
      try {
        if (JSON.parse(readFileSync(paths.request, "utf8")).requestId === request.requestId) rmSync(paths.request, { force: true });
      } catch { /* A direct caller need not publish a request file. */ }
      const scratch = mkdtempSync(join(tmpdir(), "delegatus-launcher-preflight-"));
      let preflight;
      try {
        preflight = await new Promise(resolve => {
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
        });
      } finally { preflightChild = null; rmSync(scratch, { recursive: true, force: true }); }
      // Signal handling shares this fence with every image transition. The
      // durable preflight trial remains authoritative for a cold recovery.
      if (stopping) return;
      if (!preflight) {
        restore(rollbackPointer);
        record.set("launcher", { state: "healthy", requestId: request.requestId,
          error: { kind: "fell-back", revision: next.sha.slice(0, 7), detail: "The replacement launcher failed its load check." } });
        rmSync(trialFile, { force: true }); trial = null;
        return;
      }
      // The load check is the last awaited read. The final fence and starting
      // intent write form one synchronous dispatch boundary.
      let currentGate;
      try { currentGate = JSON.parse(read(gateFile)); } catch { /* refused below */ }
      const pending = read(paths.request);
      if (read(applyFile) !== applyBinding || JSON.stringify(JSON.parse(read(paths.record))?.launcher) !== ownerBinding
        || activity !== dispatchActivityVersion(dirname(dirname(paths.request)))
        || read(trialFile) !== `${JSON.stringify(intent)}\n`
        || pending !== null && JSON.parse(pending)?.requestId !== request.requestId
        || request.autoGateId && (read(gateFile) !== gateBinding || currentGate?.id !== request.autoGateId || currentGate.until <= Date.now())) {
        if (pending === null) atomic(paths.request, `${JSON.stringify(request)}\n`);
        atomic(`${paths.request}.result.json`, JSON.stringify({ requestId: request.requestId, state: "rejected", detail: "Stale launcher dispatch custody or work evidence" }) + "\n");
        return false;
      }
      intent = { ...intent, state: "starting" };
      atomic(trialFile, `${JSON.stringify(intent)}\n`); trial = intent;
      // Only a durable intent admits child shutdown. A failed write leaves
      // the serving processes under their current supervisor.
      record.set("web", { state: "stopping" });
      record.set("runtimeHost", { state: "stopping" });
      record.set("launcher", { state: "relaunching", requestId: request.requestId });
      await stop();
      // The PID and its start identity survive exec. Retain that custody
      // record while children are down so another startup cannot take it.
      if (stopping) return;
      exec(nextEntry, trial.requestId);
    },
    succeeded() {
      if (stopping) return;
      const error = trial?.state === "rolled-back"
        ? { kind: "fell-back", revision: trial.target.slice(0, 7), detail: trial.detail }
        : null;
      record.set("launcher", { state: "healthy", requestId: trial?.requestId ?? null, error });
      if (trial) atomic(`${paths.request}.result.json`, JSON.stringify({ requestId: trial.requestId,
        target: trial.target, state: error ? "rolled-back" : "done", detail: trial.detail }) + "\n");
      if (trial) rmSync(trialFile, { force: true });
      trial = null;
      delete process.env.LLV_LAUNCHER_TRIAL;
    },
    async failed(detail) {
      if (stopping) return false;
      if (!trial || trial.state === "rolled-back") return false;
      await stop();
      if (stopping) return false;
      restore(trial.rollbackPointer);
      trial = { ...trial, state: "rolled-back", detail };
      atomic(trialFile, `${JSON.stringify(trial)}\n`);
      if ((directTrial || process.env.LLV_LAUNCHER_TRIAL === trial.requestId) && canExec) {
        try { exec(trial.previousEntry, trial.requestId); }
        catch { /* The manager/bootstrap must restart after a failed exec. */ }
      }
      // A service-manager restart was requested outside this unit. Its next
      // start follows the restored pointer, keeping rollback outside Viewer.
      record.remove();
      process.exit(75);
    },
  };
}

/* A trial spans process images. Its durable intent lets the next launcher
   restore the exact previous pointer before replacing itself on failure. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { probePageAndChunk, readStartIdentity, runtimeHostStartIdentity } from "./self-update-supervisor.mjs";
import { probeHeadersFrom } from "./internalService.mjs";
import { viewerBootGateKey } from "./viewerGateKey.mjs";
import { assertLauncherAvailable } from "./launcher-adoption.mjs";
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
  const directory = dirname(plan.requestFile);
  const trialFile = plan.requestFile.replace(/request([^/]*)$/, "trial$1");
  const recordFile = plan.requestFile.replace(/request([^/]*)$/, "launcher$1");
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
  const owned = apply?.target === plan.target && ["ready", "switching"].includes(apply.state)
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
      env: { ...process.env, HOME: scratch, XDG_CONFIG_HOME: join(scratch, "config"), XDG_CACHE_HOME: join(scratch, "cache"), LLV_STATE_DIR: scratch,
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
  const portIndex = args.findIndex(arg => arg === "--port" || arg === "-p");
  const port = Number(portIndex >= 0 ? args[portIndex + 1] : 8898);
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
      if (socketHealthy && await probePageAndChunk(port, 5000, headers) === null) {
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

export function createRelaunch({ paths, installRoot, entry, release, servingRelease = () => release, stop, record, args = process.argv.slice(2) }) {
  const trialFile = paths.trial;
  const canExec = process.platform !== "win32" && typeof process.execve === "function";
  let directTrial = false;
  let trial = null;
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
    const safeArgs = args.filter(arg => arg !== "--new-token" && arg !== "--new-operator-token");
    if (!safeArgs.includes("--no-open")) safeArgs.push("--no-open");
    process.chdir(dirname(dirname(nextEntry)));
    process.execve(process.execPath, [process.execPath, ...process.execArgv, nextEntry, ...safeArgs], {
      ...process.env, LLV_LAUNCHER_REEXEC: "1", LLV_LAUNCHER_CHECKOUT: installRoot, LLV_LAUNCHER_INSTALL_ROOT: installRoot,
      LLV_LAUNCHER_TRIAL: requestId,
    });
    throw new Error("launcher exec returned without replacing the process");
  };
  let pendingRecovery = trial?.state === "preflight";
  if (pendingRecovery) directTrial = true;
  if (!trial) {
    try {
      const request = JSON.parse(readFileSync(paths.request, "utf8"));
      const apply = JSON.parse(readFileSync(join(dirname(paths.request), "apply.json"), "utf8"));
      if (request.role === "relaunch" && apply.state === "switching" && request.requestId === apply.requestId
        && request.target === apply.target && request.target === release.sha && request.rollbackPointer === apply.rollbackPointer
        && (request.rollbackPointer === null || typeof request.rollbackPointer === "string")) {
        const prior = request.rollbackPointer === null ? installRoot : JSON.parse(request.rollbackPointer).dir;
        if (typeof prior !== "string" || !existsSync(join(prior, "bin", "cli.mjs"))) throw new Error("Missing prior launcher");
        // The request still owns the handoff if a crash preceded its durable
        // trial. A cold process rolls it back before starting any candidate.
        trial = { requestId: request.requestId, target: request.target, rollbackPointer: request.rollbackPointer,
          previousEntry: join(prior, "bin", "cli.mjs"), state: "starting", at: apply.startedAt };
        atomic(trialFile, JSON.stringify(trial) + "\n");
        rmSync(paths.request, { force: true }); directTrial = true; pendingRecovery = true;
      }
    } catch (error) {
      if (trial) throw error;
      // No matching durable apply means no authority to consume a request.
    }
  }
  return {
    canExec,
    hasTrial: () => trial !== null && trial.state !== "rolled-back",
    isReplacementStart: () => trial !== null,
    async recoverPending() {
      if (pendingRecovery) await this.failed("The launcher stopped before taking the durable update request.");
    },
    async begin(request, next) {
      if (!canExec) throw new Error("This interpreter needs a launcher restart to apply an update.");
      if (next.sha !== request.target || next.dir === release.dir) throw new Error("Relaunch target is not the installed release.");
      const nextEntry = join(next.dir, "bin", "cli.mjs");
      // The Viewer captures this before publishing the new pointer. Older
      // callers can still roll back to the serving directory.
      const previous = servingRelease();
      const rollbackPointer = request.rollbackPointer === null || typeof request.rollbackPointer === "string"
        ? request.rollbackPointer
        : previous.published ? `${JSON.stringify({ sha: previous.sha, dir: previous.dir })}\n` : null;
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
        preflight = spawnSync(process.execPath, [...process.execArgv, nextEntry, "--version"], {
          cwd: next.dir, timeout: 30_000, stdio: "ignore",
          env: { ...process.env, HOME: scratch, XDG_CONFIG_HOME: join(scratch, "config"),
            XDG_CACHE_HOME: join(scratch, "cache"), LLV_STATE_DIR: scratch,
            LLV_LAUNCHER_REEXEC: "1", LLV_LAUNCHER_CHECKOUT: installRoot },
        });
      } finally { rmSync(scratch, { recursive: true, force: true }); }
      if (preflight.status !== 0) {
        restore(rollbackPointer);
        record.set("launcher", { state: "healthy", requestId: request.requestId,
          error: { kind: "fell-back", revision: next.sha.slice(0, 7), detail: "The replacement launcher failed its load check." } });
        rmSync(trialFile, { force: true }); trial = null;
        return;
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
      exec(nextEntry, trial.requestId);
    },
    succeeded() {
      const error = trial?.state === "rolled-back"
        ? { kind: "fell-back", revision: trial.target.slice(0, 7), detail: trial.detail }
        : null;
      record.set("launcher", { state: "healthy", requestId: trial?.requestId ?? null, error });
      if (trial) rmSync(trialFile, { force: true });
      trial = null;
      delete process.env.LLV_LAUNCHER_TRIAL;
    },
    async failed(detail) {
      if (!trial || trial.state === "rolled-back") return false;
      await stop();
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

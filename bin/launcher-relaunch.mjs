/* A trial spans process images. Its durable intent lets the next launcher
   restore the exact previous pointer before replacing itself on failure. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export const LAUNCHER_RELAUNCH_PROTOCOL = "delegatus-launcher-relaunch-v1";

function atomic(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, file);
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
      ...process.env, LLV_LAUNCHER_REEXEC: "1", LLV_LAUNCHER_CHECKOUT: installRoot,
      LLV_LAUNCHER_TRIAL: requestId,
    });
    throw new Error("launcher exec returned without replacing the process");
  };
  return {
    canExec,
    hasTrial: () => trial !== null && trial.state !== "rolled-back",
    isReplacementStart: () => trial !== null,
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
        return;
      }
      const intent = { requestId: request.requestId, target: next.sha, rollbackPointer, previousEntry: entry, state: "starting", at: new Date().toISOString() };
      try { atomic(trialFile, `${JSON.stringify(intent)}\n`); }
      catch (error) {
        restore(rollbackPointer);
        throw error;
      }
      // Only a durable intent admits child shutdown. A failed write leaves
      // the serving processes under their current supervisor.
      trial = intent;
      directTrial = true;
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

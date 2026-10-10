/**
 * The launcher's half of self-update (#2007), for an install that is a git
 * checkout started by `bin/cli.mjs`.
 *
 * The Viewer builds an update in a release directory of its own and publishes
 * it to a pointer file; it cannot restart itself, because the web process IS
 * the page the operator is looking at, and the CLI stops everything when that
 * child exits. So the CLI stays the supervisor, and this module gives it the
 * three things the Viewer's Update surface needs from it:
 *
 * - **A record of what runs.** Each child's PID and `/proc` start identity,
 *   the short SHA of the release it was started from, and its state, written
 *   atomically to `<state>/self-update/launcher-<installId>.json`. The Viewer
 *   reads it to show both processes; it never signals a process itself.
 * - **The installed release, read at every start.** The pointer the Viewer
 *   publishes (`release-<installId>.json`) is honoured only when its directory
 *   still holds a built checkout of the named commit; anything else falls back
 *   to the package root, so a half-written or deleted release never stops the
 *   Viewer from starting.
 * - **Restart requests.** The Viewer writes `request-<installId>.json`
 *   (`{ requestId, role }`); the CLI picks it up on its next poll and restarts
 *   that one child from the installed release.
 *
 * Plain JS beside `server-runtime.mjs`: `bin/` is outside the TS build, and the
 * Viewer's reader (`src/lib/selfUpdate/launcher.ts`) agrees with this writer on
 * the JSON shape alone.
 */
/* FIRST: fold DELEGATUS_* into LLV_* before anything below reads the
   environment (docs/design/rename-delegatus.md §5). */
import "./envAlias.mjs";
import { darwinKernelIdentity } from "./darwin-process-identity.mjs";
import { windowsStartIdentity } from "./windows-process-identity.mjs";

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { appDirIn } from "./appDir.mjs";

export const RECORD_VERSION = 1;
const REQUEST_ROLES = new Set(["web", "runtime-host", "relaunch"]);

/**
 * @param {{ stateDirectory: string, cacheDirectory: string, installId: string }} input
 */
export function selfUpdatePaths({ stateDirectory, cacheDirectory, installId }) {
  const base = join(stateDirectory, "self-update");
  return {
    record: join(base, `launcher-${installId}.json`),
    request: join(base, `request-${installId}.json`),
    releasePointer: join(base, `release-${installId}.json`),
    trial: join(base, `trial-${installId}.json`),
    adopt: join(base, `adopt-${installId}.json`),
    /* Each release holds its own node_modules and .next (well over a
       gigabyte), so they live in the cache, not in the state directory. */
    releasesDir: join(appDirIn(cacheDirectory), "self-update", installId, "releases"),
  };
}

/** Field 22 of /proc/<pid>/stat: the start time in clock ticks. Null where
    there is no /proc (the record then carries no identity, and the Viewer
    treats the process as unverifiable rather than as the same process). */
/** The identity written by the runtime-host fence, distinct from old
    launcher records which retain bare Linux ticks or macOS ps start time. */
export function runtimeHostStartIdentity(pid) {
  if (process.platform === "darwin") return darwinKernelIdentity(pid);
  const identity = readStartIdentity(pid);
  return process.platform === "win32" ? identity : identity === null ? null : `${pid}:${identity}`;
}

export function readStartIdentity(pid, platform = process.platform, run = spawnSync) {
  if (platform === "win32") return windowsStartIdentity(pid, run);
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    if (platform === "darwin") {
      const result = run("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2_000 });
      return result.status === 0 && result.stdout.trim() ? `ps:${result.stdout.trim()}` : null;
    }
    return null;
  }
}

export function headRevision(dir) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function isGitCheckout(dir) {
  return existsSync(join(dir, ".git"));
}

/**
 * The release the next start runs: the published pointer when its directory
 * is a built checkout of the named commit, else the package root.
 *
 * The pointer also names the package root's HEAD when it was published. A
 * package root that moved since was updated by hand (`git pull`, a build), and
 * that newer choice wins over an older self-update release.
 *
 * @returns {{ dir: string, sha: string | null, published: boolean }}
 */
export function installedRelease(pointerFile, packageRoot) {
  const rootHead = headRevision(packageRoot);
  try {
    const parsed = JSON.parse(readFileSync(pointerFile, "utf8"));
    if (parsed.kind === "package" && typeof parsed.dir === "string" && /^[0-9a-f]{40}$/.test(parsed.sha)) {
      const base = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
      const next = JSON.parse(readFileSync(join(parsed.dir, "package.json"), "utf8"));
      if (base.version === parsed.baseVersion && next.version === parsed.version
        && existsSync(join(parsed.dir, "dist", "standalone", "server.js")) && existsSync(join(parsed.dir, "dist", "runtime-host.mjs")))
        return { dir: parsed.dir, sha: parsed.sha, published: true };
    }
    const sha = typeof parsed?.sha === "string" && /^[0-9a-f]{40}$/.test(parsed.sha) ? parsed.sha : null;
    const dir = typeof parsed?.dir === "string" ? parsed.dir : null;
    const rootUnmoved = typeof parsed?.checkoutHead !== "string" || parsed.checkoutHead === rootHead;
    if (sha && dir && rootUnmoved && existsSync(join(dir, ".next", "BUILD_ID")) && headRevision(dir) === sha) {
      return { dir, sha, published: true };
    }
  } catch {
    /* No pointer yet, or an unreadable one: the package root is the release. */
  }
  return { dir: packageRoot, sha: rootHead, published: false };
}

/** The runtime host's entry inside one release, chosen the way
    `cliRuntimeHostConfig` chooses it for the package root. */
export function hostEntrypoint(root) {
  const bundled = join(root, "dist", "runtime-host.mjs");
  return existsSync(bundled) ? bundled : join(root, "src", "runtime-host", "main.ts");
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temporary, file); break; }
      catch (error) {
        // A concurrent reader or NTFS scanner can briefly deny replacement.
        // The final healthy/requestId write may have no later flush, so
        // dropping it leaves terminal custody waiting on "starting" forever.
        // Retain the prior atomic record throughout this bounded retry.
        if (process.platform !== "win32" || attempt === 100 || !["EPERM", "EBUSY"].includes(error.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  } finally { rmSync(temporary, { force: true }); }
}

function emptyProcess() {
  return { state: "stopped", pid: null, startIdentity: null, startedAt: null, revision: null, error: null, requestId: null };
}

/**
 * @param {string} file
 * @param {{ checkout: string | null, releasesDir: string, releasePointer: string, requestFile: string, port: number, socket: string }} base
 */
export function createLauncherRecord(file, base, clock = () => Date.now()) {
  const record = {
    version: RECORD_VERSION,
    launcher: { pid: process.pid, startIdentity: readStartIdentity(process.pid), autoAdmission: 1,
      ...(process.platform !== "win32" && typeof process.execve === "function" ? { relaunch: 1 } : {}),
      revision: null, requestId: null, state: "starting", error: null },
    ...base,
    web: emptyProcess(),
    runtimeHost: emptyProcess(),
    updatedAt: new Date(clock()).toISOString(),
  };
  const flush = () => {
    record.updatedAt = new Date(clock()).toISOString();
    try {
      writeJsonAtomic(file, record);
    } catch (error) {
      /* The record serves the Update surface; failing to write it must never
         take the Viewer down. */
      console.error(`[self-update] could not write ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return {
    file,
    read: () => record,
    /** @param {"web" | "runtimeHost" | "launcher"} role */
    set(role, patch) {
      record[role] = { ...record[role], ...patch };
      flush();
    },
    /** A child was spawned from `release`: its PID and identity are recorded
        before anything waits on it. */
    started(role, child, release) {
      record[role] = {
        ...record[role],
        state: "starting",
        pid: child.pid ?? null,
        startIdentity: child.pid ? readStartIdentity(child.pid) : null,
        startedAt: new Date(clock()).toISOString(),
        revision: release.sha ? release.sha.slice(0, 7) : null,
        error: null,
      };
      flush();
    },
    remove() {
      try {
        const current = JSON.parse(readFileSync(file, "utf8"));
        if (current?.launcher?.pid !== record.launcher.pid
          || current?.launcher?.startIdentity !== record.launcher.startIdentity) return;
        // Graceful shutdown can land after the Viewer published an apply but
        // before its request became a durable trial. Keep the original owner
        // fence until the apply settles; cold recovery must verify that owner.
        let apply;
        try { apply = JSON.parse(readFileSync(join(dirname(file), "apply.json"), "utf8")); }
        catch (error) {
          if (error.code !== "ENOENT") return; // Unreadable custody is retained.
        }
        if (apply && apply.releasePointer === record.releasePointer
          && (apply.launcherPid === record.launcher.pid && apply.launcherIdentity === record.launcher.startIdentity
            || current.launcher.requestId === apply.requestId)) {
          if (["building", "ready", "switching"].includes(apply.state)) return;
          // Terminal persistence and hold release are separate writes. Retain
          // the original owner across a signal between those two boundaries.
          let drain, gate;
          try { drain = JSON.parse(readFileSync(join(dirname(file), "auto-drain.json"), "utf8")); }
          catch (error) { if (error.code !== "ENOENT") return; }
          try { gate = JSON.parse(readFileSync(join(dirname(file), "auto-admission.json"), "utf8")); }
          catch (error) { if (error.code !== "ENOENT") return; }
          if (drain?.id === apply.requestId || apply.autoGateId && gate?.id === apply.autoGateId) return;
        }
        rmSync(file, { force: true });
      } catch (error) {
        if (error.code !== "ENOENT") console.error("[self-update] could not remove the owned launcher record.");
      }
    },
  };
}

/**
 * Polls for a restart request and hands each one to `handle`, one at a time.
 * A request that arrives while another is handled waits in its file. A
 * Ordinary restarts consume before handling. Relaunch consumes only after
 * its controller has persisted the trial that owns crash recovery.
 *
 * Work the installation admits is known to the Viewer alone: the registry and
 * the pipelines live in its database, and the files of an open turn move with
 * every event. The launcher therefore reads no work evidence of its own. An
 * automatic request is admitted by the Viewer before the handler runs, and a
 * handler that waits on anything afterwards asks again through `readmit`, so
 * the Viewer's read is the last awaited step before anything is stopped.
 *
 * @param {string} requestFile
 * @param {(request: { requestId: string, role: "web" | "runtime-host" | "relaunch", target?: string, rollbackPointer?: string | null }, dispatchFence: (consumed?: boolean) => boolean, readmit: () => Promise<boolean>) => Promise<void | false>} handle
 * @param {{ intervalMs?: number, admitAuto?: (request: { requestId: string, role: "web" | "runtime-host" | "relaunch", autoGateId: string }) => Promise<boolean>, isStopping?: () => boolean }} options
 */
export function watchRestartRequests(requestFile, handle, { intervalMs = 500, admitAuto = async () => false, isStopping = () => false } = {}) {
  let busy = false;
  const gateFile = join(dirname(requestFile), "auto-admission.json");
  const poll = async () => {
    if (busy || isStopping() || !existsSync(requestFile)) return;
    let request = null;
    try {
      request = JSON.parse(readFileSync(requestFile, "utf8"));
    } catch {
      request = null;
    }
    if (!request || typeof request.requestId !== "string" || !REQUEST_ROLES.has(request.role)) {
      rmSync(requestFile, { force: true });
      return;
    }
    busy = true;
    let admitted = request.autoGateId === undefined;
    let retain = false;
    const original = readFileSync(requestFile, "utf8");
    const recordFile = join(dirname(requestFile), basename(requestFile).replace(/^request/, "launcher"));
    const owner = () => { try { return JSON.stringify(JSON.parse(readFileSync(recordFile, "utf8"))?.launcher); } catch { return null; } };
    const originalOwner = owner();
    const originalGate = request.autoGateId ? (() => { try { return readFileSync(gateFile, "utf8"); } catch { return null; } })() : null;
    const dispatchFence = (consumed = false) => {
      try {
        let pending = null;
        try { pending = readFileSync(requestFile, "utf8"); } catch (error) { if (error.code !== "ENOENT") return false; }
        if (pending !== original) {
          if (!consumed || pending !== null) return false;
          const trial = JSON.parse(readFileSync(join(dirname(requestFile), basename(requestFile).replace(/^request/, "trial")), "utf8"));
          if (trial.requestId !== request.requestId || trial.target !== request.target) return false;
        }
        if (owner() !== originalOwner) return false;
        if (request.autoGateId) {
          const bytes = readFileSync(gateFile, "utf8"), gate = JSON.parse(bytes);
          if (bytes !== originalGate || gate.id !== request.autoGateId || gate.until <= Date.now()) return false;
          if (gate.issuerPid !== undefined && (!gate.issuerIdentity || readStartIdentity(gate.issuerPid) !== gate.issuerIdentity)) return false;
        }
        return true;
      } catch { return false; }
    };
    const rejected = (detail) => {
      const file = `${requestFile}.result.json`;
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ requestId: request.requestId, state: "rejected", detail }), { mode: 0o600 });
      renameSync(temporary, file);
    };
    try {
      if (request.autoGateId !== undefined) {
        let gate = null;
        try { gate = JSON.parse(readFileSync(gateFile, "utf8")); } catch { /* no valid admission */ }
        if (typeof request.autoGateId !== "string" || gate?.id !== request.autoGateId || typeof gate.until !== "number" || gate.until <= Date.now()
          || !await admitAuto(request)) {
          if (isStopping()) return;
          retain = request.role === "relaunch";
          rejected("Final automatic admission was refused or expired");
          return;
        }
      }
      if (isStopping()) return;
      // The admission HTTP read may outlive its gate or its issuer. This is
      // synchronous with dispatch and never consumes a stale relaunch request.
      if (request.autoGateId) {
        let gate;
        try { gate = JSON.parse(readFileSync(gateFile, "utf8")); } catch { /* stale */ }
        if (!gate || gate.id !== request.autoGateId || gate.until <= Date.now()
          || readFileSync(gateFile, "utf8") !== originalGate) {
          retain = request.role === "relaunch";
          rejected("Final automatic dispatch has stale gate or issuer custody"); return;
        }
      }
      if (!dispatchFence()) {
        retain = true; rejected("Final dispatch has stale launcher custody"); return;
      }
      admitted = true;
      // Do not remove a newer request that arrived while admission was read.
      try {
        if (JSON.parse(readFileSync(requestFile, "utf8")).requestId !== request.requestId) return;
      } catch { return; }
      if (request.role !== "relaunch") rmSync(requestFile, { force: true });
      if (await handle(request, dispatchFence, () => admitAuto(request)) === false) retain = true;
    } catch (error) {
      if (!isStopping() && !admitted) rejected("Final automatic admission could not be verified");
      console.error(`[self-update] restart of ${request.role} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!retain && !isStopping() && (request.autoGateId || request.role === "relaunch")) {
        try {
          if (JSON.parse(readFileSync(requestFile, "utf8")).requestId === request.requestId) rmSync(requestFile, { force: true });
        } catch { /* already consumed */ }
      }
      if (!retain && !isStopping() && request.autoGateId && request.role !== "relaunch") {
        try {
          if (JSON.parse(readFileSync(gateFile, "utf8")).id === request.autoGateId) rmSync(gateFile, { force: true });
        } catch { /* already removed */ }
      }
      busy = false;
    }
  };
  const timer = setInterval(() => { void poll(); }, intervalMs);
  timer.unref?.();
  return {
    poll,
    stop() { clearInterval(timer); },
  };
}

/**
 * A restarted web process is ready when `GET /` answers 200 and so does the
 * first script chunk that page references. `/` alone can answer 200 from a
 * server whose chunks are missing (the self-update prototype's first build
 * found exactly that), and the operator's next click needs those chunks.
 * Resolves with null when both answer, else with what did not.
 *
 * `headers` carries the `probe` service tag (`probeHeadersFrom`): on a team
 * install the page is shown only to a member, and the tag is how the
 * launcher's own probe reads it (sign-in-and-team §4.2).
 */
export async function probePageAndChunk(port, timeoutMs = 5_000, headers = {}) {
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const page = await fetch(`http://127.0.0.1:${port}/`, { signal, redirect: "manual", headers });
    const html = page.status === 200 ? await page.text() : (await page.body?.cancel(), "");
    if (page.status !== 200) return `GET / answered ${page.status}`;
    const chunk = /["'](\/_next\/static\/[^"'?#]+\.js)["']/.exec(html)?.[1];
    if (!chunk) return null;
    const asset = await fetch(`http://127.0.0.1:${port}${chunk}`, { signal, redirect: "manual" });
    await asset.body?.cancel();
    return asset.status === 200 ? null : `GET ${chunk} answered ${asset.status}`;
  } catch (error) {
    // Fetch errors can include the rejected header value. Restart diagnostics
    // are persisted and printed by the launcher, so the message stays out and
    // only the error's own code or class name says what kind it was.
    const kind = [error?.code, error?.name].find((value) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value));
    return kind ? `Viewer readiness probe failed (${kind})` : "Viewer readiness probe failed";
  }
}

/** How a child ended, as the record's error facts. */
export function exitError(child, startedAt, clock = () => Date.now()) {
  return {
    kind: "exit",
    code: child.exitCode ?? null,
    signal: child.signalCode ?? null,
    afterMs: Math.max(0, clock() - startedAt),
  };
}

/** The registry records an admission saw, by launch: each record's key, the
    epoch of its host claim and its pending launch, plus the spawn receipts.
    A record's status and timestamps move with every event of a turn that is
    already running, so they are not evidence of newly admitted work. The
    Viewer builds its work evidence from this over its own registry; the
    launcher has no registry to read. */
export function admittedRecords(file) {
  if (!file || typeof file.entries !== "object" || file.entries === null || Array.isArray(file.entries)) return null;
  const receipts = file.receipts && typeof file.receipts === "object" ? Object.keys(file.receipts).sort() : [];
  return [Object.keys(file.entries).sort().map(id => [id, file.entries[id]?.claimEpoch ?? null, file.entries[id]?.pendingAction ?? null]), receipts];
}

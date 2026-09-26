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

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { appDirIn } from "./appDir.mjs";

export const RECORD_VERSION = 1;
const REQUEST_ROLES = new Set(["web", "runtime-host"]);

/**
 * @param {{ stateDirectory: string, cacheDirectory: string, installId: string }} input
 */
export function selfUpdatePaths({ stateDirectory, cacheDirectory, installId }) {
  const base = join(stateDirectory, "self-update");
  return {
    record: join(base, `launcher-${installId}.json`),
    request: join(base, `request-${installId}.json`),
    releasePointer: join(base, `release-${installId}.json`),
    /* Each release holds its own node_modules and .next (well over a
       gigabyte), so they live in the cache, not in the state directory. */
    releasesDir: join(appDirIn(cacheDirectory), "self-update", installId, "releases"),
  };
}

/** Field 22 of /proc/<pid>/stat: the start time in clock ticks. Null where
    there is no /proc (the record then carries no identity, and the Viewer
    treats the process as unverifiable rather than as the same process). */
export function readStartIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
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
  renameSync(temporary, file);
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
    launcher: { pid: process.pid, startIdentity: readStartIdentity(process.pid) },
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
    /** @param {"web" | "runtimeHost"} role */
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
      rmSync(file, { force: true });
    },
  };
}

/**
 * Polls for a restart request and hands each one to `handle`, one at a time.
 * A request that arrives while another is handled waits in its file. A
 * request is consumed (its file removed) before it is handled, so a crash
 * mid-restart never replays it.
 *
 * @param {string} requestFile
 * @param {(request: { requestId: string, role: "web" | "runtime-host" }) => Promise<void>} handle
 */
export function watchRestartRequests(requestFile, handle, { intervalMs = 500 } = {}) {
  let busy = false;
  const poll = async () => {
    if (busy || !existsSync(requestFile)) return;
    let request = null;
    try {
      request = JSON.parse(readFileSync(requestFile, "utf8"));
    } catch {
      request = null;
    }
    rmSync(requestFile, { force: true });
    if (!request || typeof request.requestId !== "string" || !REQUEST_ROLES.has(request.role)) return;
    busy = true;
    try {
      await handle({ requestId: request.requestId, role: request.role });
    } catch (error) {
      console.error(`[self-update] restart of ${request.role} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
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
    return error instanceof Error ? error.message : String(error);
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

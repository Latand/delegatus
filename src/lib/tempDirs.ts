import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Temp directories Delegatus makes, and the one way a process hands its whole
 * temp use to a directory it can remove in one step (#1957).
 *
 * The workstation's root disk filled because every test process, capture run
 * and review export left its `mkdtemp` directory behind: 6066 of them, 244 GB,
 * under 60-odd prefixes chosen file by file. Fixing each of 576 call sites
 * would not hold (named `mkdtempSync` imports cannot be intercepted, and the
 * next test adds a 577th), so the process instead points `TMPDIR` at one root
 * of its own before anything else runs. `os.tmpdir()` reads `TMPDIR` on every
 * call, so every directory made after that, whatever its prefix and however
 * `mkdtemp` was imported, lands inside the root, and removing the root removes
 * them all.
 *
 * Only a child started with the process's current environment inherits the
 * root: `Bun.spawn` without an `env` keeps the environment the process started
 * with. What escapes that way is what the sweeper (`tempSweep.ts`) is for.
 *
 * This module imports nothing but Node built-ins: the test preload loads it
 * before any other module, and nothing here may resolve state.
 */

/** Every directory Delegatus owns under a temp root starts with this. */
export const OWNED_TEMP_PREFIX = "llv-";

/** The per-process root a test run claims in `test-preload.ts`. */
export const TEST_RUN_TEMP_PREFIX = `${OWNED_TEMP_PREFIX}test-run-`;

export type ProcessTempRoot = {
  root: string;
  /** Removes the root and everything in it, and puts `TMPDIR` back. Idempotent. */
  release(): void;
};

/**
 * Creates `<os.tmpdir()>/<prefix>XXXXXX` and points this process's `TMPDIR` at
 * it. The prefix must start with {@link OWNED_TEMP_PREFIX} so a root a killed
 * process could not release is one the sweeper recognizes.
 */
export function claimProcessTempRoot(prefix: string, env: NodeJS.ProcessEnv = process.env): ProcessTempRoot {
  if (!prefix.startsWith(OWNED_TEMP_PREFIX)) {
    throw new Error(`a process temp root must start with ${OWNED_TEMP_PREFIX}: ${prefix}`);
  }
  const parent = os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, prefix));
  const previous = Object.prototype.hasOwnProperty.call(env, "TMPDIR") ? env.TMPDIR : undefined;
  env.TMPDIR = root;
  let released = false;
  return {
    root,
    release() {
      if (released) return;
      released = true;
      if (env.TMPDIR === root) {
        if (previous === undefined) delete env.TMPDIR;
        else env.TMPDIR = previous;
      }
      try {
        /* This path came from mkdtemp in this process; never the temp root. */
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* Best effort: the sweeper removes a root that outlived its process. */
      }
    },
  };
}

/**
 * Points this process's `TMPDIR` at `<directory>/tmp`, for a process that
 * already owns a run directory (a capture driver): the browser profile and
 * artifacts Playwright makes at launch then live inside that run directory, so
 * a driver that is killed before it closes its browser leaves nothing outside
 * it.
 */
export function nestProcessTempUnder(directory: string, env: NodeJS.ProcessEnv = process.env): string {
  const nested = path.join(directory, "tmp");
  fs.mkdirSync(nested, { recursive: true, mode: 0o700 });
  env.TMPDIR = nested;
  return nested;
}

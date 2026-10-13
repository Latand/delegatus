import fs from "node:fs";
import path from "node:path";

import { APP_DIR, LEGACY_APP_DIR } from "../../../bin/appDir.mjs";
import { stateDir } from "../configDir";
import { isStagingMode } from "../staging";
import { guardedContext, isOperatorOwnedDirectory } from "../stateOwnership";
import { cpuAdmissionFile, machineCpuAdmissionQueue, machineHome, type CpuAdmissionQueue } from "./cpuAdmission";

/*
 * Which CPU admission queue an instance waits in.
 *
 * The machine queue orders the operator's own Viewer with every gate-slot
 * command. On 2026-10-13 a test's `bun -e` children ran the production
 * pipeline ports on a throw-away state directory, resolved the machine queue
 * because their argv named no test file, and left two stage tickets at its
 * head; no stage or pre-push check started for 1 h 45 min. A stage ticket
 * belongs to the state directory that names it, so only the live installation
 * shares the machine queue, and every other instance keeps its queue inside its
 * own state directory, however it was launched. `scripts/cpu-admission.ts`
 * stays on the machine queue: its tickets carry a process identity and end
 * with their owner.
 */

/** The live installation's state directory under the operating-system user's
 * home, under both names the app dir resolves to. gate-slot derives the
 * machine queue from the same home. */
export function liveStateDirectories(home: string): string[] {
  return [APP_DIR, LEGACY_APP_DIR].map(name => path.join(home, ".config", name, "state"));
}

function realPath(directory: string): string {
  try { return fs.realpathSync(directory); } catch { return path.resolve(directory); }
}

/**
 * Null for the live installation, which shares the machine queue.
 *
 * Sitting somewhere under the operator's config root proves nothing: a staging
 * state directory, a fixture nested in the live one and a driver's own
 * `XDG_CONFIG_HOME` all do, with or without an owner token. Only the state
 * directory itself, by any of its names, is the live installation's.
 */
export function isolatedCpuAdmissionDir(
  directory: string,
  context: { home: () => string; staging: boolean; guarded: boolean } = {
    home: machineHome, staging: isStagingMode(), guarded: guardedContext() !== null,
  },
): string | null {
  if (context.guarded || context.staging) return directory;
  let home: string;
  try { home = context.home(); } catch {
    // Without a native home there is no machine queue to join; a directory
    // that could be the operator's reports that through cpuAdmissionFile().
    return isOperatorOwnedDirectory(directory) ? null : directory;
  }
  const resolved = realPath(directory);
  return liveStateDirectories(home).some(live => realPath(live) === resolved) ? null : directory;
}

export function instanceCpuAdmissionFile(): string {
  return cpuAdmissionFile(isolatedCpuAdmissionDir(stateDir()));
}

export function instanceCpuAdmissionQueue(): CpuAdmissionQueue {
  return machineCpuAdmissionQueue(isolatedCpuAdmissionDir(stateDir()));
}

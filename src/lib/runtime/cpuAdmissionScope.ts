import { stateDir } from "../configDir";
import { guardedContext, isOperatorOwnedDirectory } from "../stateOwnership";
import { cpuAdmissionFile, machineCpuAdmissionQueue, type CpuAdmissionQueue } from "./cpuAdmission";

/*
 * Which CPU admission queue an instance waits in.
 *
 * The machine queue orders the operator's own Viewer with every gate-slot
 * command. On 2026-10-13 a test's `bun -e` children ran the production
 * pipeline ports on a throw-away state directory, resolved the machine queue
 * because their argv named no test file, and left two stage tickets at its
 * head; no stage or pre-push check started for 1 h 45 min. A stage ticket
 * belongs to the state directory that names it, so an instance whose state
 * directory is not the operator's keeps its queue inside that directory,
 * however it was launched. `scripts/cpu-admission.ts` stays on the machine
 * queue: its tickets carry a process identity and end with their owner.
 */

/** Null for the operator's own installation, which shares the machine queue. */
export function isolatedCpuAdmissionDir(
  directory: string, env: NodeJS.ProcessEnv = process.env, guarded = guardedContext(env) !== null,
): string | null {
  return !guarded && isOperatorOwnedDirectory(directory, env) ? null : directory;
}

export function instanceCpuAdmissionFile(): string {
  return cpuAdmissionFile(isolatedCpuAdmissionDir(stateDir()));
}

export function instanceCpuAdmissionQueue(): CpuAdmissionQueue {
  return machineCpuAdmissionQueue(isolatedCpuAdmissionDir(stateDir()));
}

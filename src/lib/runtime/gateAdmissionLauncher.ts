import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Managed Linux callers reach the installed CPU admission helper through a
 * host-local `bun` launcher in LLV_GATE_BUN. The launcher only decides which
 * helper judges admission; the interpreter a check runs under is the one it
 * recorded, or `bun` from the caller's PATH when the caller named none. */
export const gateAdmissionLauncherParent = (home = os.homedir()) => path.join(home, ".cache", "delegatus", "gate-admission");

/** The interpreter a routed LLV_GATE_BUN stands for: `undefined` when the
 * value is no admission launcher, `null` when the caller named no interpreter.
 * Check keys and Cloud inputs read this instead of the per-release launcher
 * path, so routing changes neither. */
export function gateAdmissionInterpreter(value: string | undefined): string | null | undefined {
  if (!value || path.basename(value) !== "bun") return undefined;
  const directory = path.dirname(value), parent = path.dirname(directory);
  if (!/^[0-9a-f]{64}$/.test(path.basename(directory)) || path.basename(parent) !== "gate-admission"
    || path.basename(path.dirname(parent)) !== "delegatus" || path.basename(path.dirname(path.dirname(parent))) !== ".cache") return undefined;
  try { return fs.readFileSync(path.join(directory, "interpreter"), "utf8") || null; }
  catch { return undefined; }
}

/** Replace a routed LLV_GATE_BUN with what it stands for. */
export function withoutGateAdmissionLauncher<T extends Partial<NodeJS.ProcessEnv>>(env: T): T {
  const interpreter = gateAdmissionInterpreter(env.LLV_GATE_BUN);
  if (interpreter === undefined) return env;
  const result: Partial<NodeJS.ProcessEnv> = { ...env };
  if (interpreter === null) delete result.LLV_GATE_BUN;
  else result.LLV_GATE_BUN = interpreter;
  return result as T;
}

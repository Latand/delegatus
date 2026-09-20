import os from "node:os";
import path from "node:path";

/**
 * Who may run a state-mutating startup step (issue #1905).
 *
 * The first-boot import of a legacy store into `state.sqlite` renames the
 * operator's live state files away and leaves tombstone directories in their
 * place. It is a startup step of the serving Viewer, and nothing else — but
 * nothing in the code said so, and the only thing standing between it and the
 * live state directory was which process happened to call a store reader
 * first.
 *
 * During `next build`, Next collects page data by LOADING every route module
 * in a worker. `src/lib/accounts/claudeLogin.ts` builds its supervisor at
 * module scope, the constructor reconciles persisted login operations, and
 * that read reached the lazy import. A lane's `bun run build`, which had no
 * state directory of its own, therefore resolved the operator's real one and
 * imported eight live account files out from under the production Viewer,
 * which then answered every account selection with EISDIR for seventy minutes.
 *
 * So the barrier is a predicate, not a convention. A state-mutating startup
 * step runs only when:
 *
 *  - it is NOT a `next build` phase — page data collection loads modules, and
 *    a module load may never write state, whatever else is true; and
 *  - either the serving Viewer's activation opened the gate below, or the
 *    state directory was named by the caller (an explicit `LLV_STATE_DIR`, or
 *    a directory passed in that this process could not have defaulted to).
 *
 * Everything else — a build, a `bun test` that named no state directory, a
 * script, an MCP process on a fresh install — is refused. A refusal is not a
 * failure: reads fall back to the legacy file they always read, and writes
 * report the store as busy until the Viewer activates.
 */

/** Set once by the serving Viewer's activation. Kept on `globalThis` because
    a Next build splits this module across server chunks, and a module-level
    binding would be a different `let` in each copy. */
const gate = globalThis as typeof globalThis & { __llvStateMutationActivated?: boolean };

/** Called by the Viewer's release activation, and by nothing else. */
export function openStateMutationActivation(): void {
  gate.__llvStateMutationActivated = true;
}

/** Test seam: the activation gate is process-wide and survives a test file. */
export function closeStateMutationActivationForTests(): void {
  delete gate.__llvStateMutationActivated;
}

export function stateMutationActivationOpen(): boolean {
  return gate.__llvStateMutationActivated === true;
}

type Env = Readonly<Record<string, string | undefined>>;

/** `next build` and its page-data collection workers, which inherit the phase. */
export function nextBuildPhase(env: Env = process.env): boolean {
  return Boolean(env.NEXT_PHASE?.includes("build"));
}

function inside(root: string, candidate: string): boolean {
  const from = path.resolve(root);
  const to = path.resolve(candidate);
  return to === from || to.startsWith(`${from}${path.sep}`);
}

/** The roots a process resolves its state directory to when nobody named one.
    Read straight from the environment: `stateDir()` would run the legacy-dir
    migration, and a guard may not have side effects. */
function defaultStateRoots(env: Env): string[] {
  const home = os.homedir();
  return [
    env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"),
    path.join(home, ".claude", "viewer-state"),
  ];
}

/**
 * Why this process may not import, migrate or retire state in `directory`, or
 * null when it may. The message is user-facing: it names the process it
 * refused and what would have let it through.
 */
export function stateMutationRefusal(directory: string, env: Env = process.env): string | null {
  if (nextBuildPhase(env)) {
    return `a Next.js build phase (NEXT_PHASE=${env.NEXT_PHASE}) may not mutate state in ${directory}: `
      + "collecting page data loads every route module, and a module load never owns the state directory";
  }
  if (stateMutationActivationOpen()) return null;
  const named = env.LLV_STATE_DIR?.trim();
  if (named && inside(named, directory)) return null;
  if (!defaultStateRoots(env).some((root) => inside(root, directory))) return null;
  return `only the serving Viewer's release activation may mutate state in ${directory}; `
    + "set LLV_STATE_DIR to a state directory of this process's own to run it anywhere else";
}

/** Thrown by an explicit state-mutating startup step the barrier refuses. */
export class StateMutationRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "StateMutationRefusedError";
  }
}

/** Throw unless this process may mutate state in `directory`. */
export function assertStateMutationAllowed(directory: string, env: Env = process.env): void {
  const refusal = stateMutationRefusal(directory, env);
  if (refusal) throw new StateMutationRefusedError(refusal);
}

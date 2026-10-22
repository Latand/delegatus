import type { ExecPort } from "@/lib/workflows/provision";

/** Keep stage activation cancellation and per-operation deadlines attached to
 * the child process used while composing the stage's input. */
export function createStageInputExec(
  exec: ExecPort,
  activationSignal: AbortSignal,
  revalidate: () => void,
  activationError: Error,
): ExecPort {
  return async (command, args, cwd, env, options) => {
    revalidate();
    if (activationSignal.aborted) throw activationError;
    const signal = options?.signal
      ? AbortSignal.any([options.signal, activationSignal])
      : activationSignal;
    return exec(command, args, cwd, env, { ...options, signal });
  };
}

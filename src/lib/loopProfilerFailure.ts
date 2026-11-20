import { FileTransactionBusyError } from "./state/fileTransaction";

type Phase = "collect" | "trim" | "persist" | "settle";
const codes = new Set(["EACCES", "EPERM", "ENOENT", "ENOSPC", "EDQUOT", "EIO", "EROFS", "EISDIR", "ENOTDIR", "EMFILE", "ENFILE", "PROFILE_INVALID"]);

/** Fixed vocabulary only: native messages and paths never enter diagnostics. */
export class LoopProfilerFailure extends Error {
  readonly code: string;
  constructor(readonly phase: Phase, error: unknown) {
    super("loop-profiler-failed");
    this.code = error instanceof FileTransactionBusyError ? "BUSY"
      : error instanceof SyntaxError ? "PROFILE_INVALID"
      : error instanceof Error && codes.has((error as NodeJS.ErrnoException).code ?? "")
        ? (error as NodeJS.ErrnoException).code! : "UNKNOWN";
  }
}

export function loopProfilerFailureReason(reason: string, error: unknown, phase: Phase) {
  const failure = error instanceof LoopProfilerFailure ? error : new LoopProfilerFailure(phase, error);
  return `${reason} phase=${failure.phase} code=${failure.code}`;
}

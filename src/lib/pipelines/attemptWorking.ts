import type { PipelineStageAttempt } from "./types";

/** A working state or a missing turn-end stamp leaves a turn possibly open. A
    release never proves idleness: such a host retires only on positive runtime
    idle evidence and never by its recorded identity alone. */
export function pipelineAttemptMayBeWorking(attempt: PipelineStageAttempt): boolean {
  return ["pending", "spawning", "running", "reviewing", "committing"].includes(attempt.state)
    || !(attempt.verdict || attempt.completedAt);
}

/* What a launch refused for a pending update is told (#2515). Resolves state
   only when a caller reads it (#1905), and imports no liveness code, so the
   admission paths that refuse can load it without the readings behind it. */
import { statePath } from "@/lib/configDir";

import { readAuto } from "./auto";
import type { DrainLease } from "./drain";
import type { BusyReason, QuietBlockers } from "./quiet";

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const BUSY_WORDS: Record<BusyReason, string> = {
  "update": "an update step already in progress",
  "web": "the web process to become healthy",
  "runtime-host": "the runtime host to become healthy",
  "pipeline-controller": "the pipeline controller to finish its pass",
  "seat-tick": "an orchestrator tick to finish",
};

/**
 * What a pending update is waiting for, in plain words. A refused launch used
 * to say only that work was draining, which reads the same whether two turns
 * are running or ninety rows of dead hosts are being counted.
 */
export function describeUpdateWait(blockers: QuietBlockers | null | undefined): string {
  if (!blockers) return "its first reading of what is running";
  const work = [
    ...(blockers.turns ? [count(blockers.turns, "running turn", "running turns")] : []),
    ...(blockers.stages ? [count(blockers.stages, "pipeline stage", "pipeline stages")] : []),
  ];
  const held = blockers.unresolvedBlocking ?? 0;
  const unresolved = held
    ? ` (${count(held, "turn has", "turns have")} no liveness record and ${held === 1 ? "stops" : "stop"} counting within`
      + ` ${Math.round((blockers.unresolvedGraceMs ?? 0) / 60_000)} minutes)`
    : "";
  if (work.length) return `${work.join(" and ")} to finish${unresolved}`;
  const other = [
    ...(blockers.busyReason ? [BUSY_WORDS[blockers.busyReason]] : blockers.busy ? ["a busy process to settle"] : []),
    ...(blockers.operatorActiveAt ? [`the operator to be inactive for ${Math.round((blockers.operatorWindowMs ?? 0) / 60_000)} minutes`] : []),
    ...(blockers.memoryMb !== null ? [`free memory to reach 4096 MB (${blockers.memoryMb} MB now)`] : []),
    ...(blockers.unreadable ? [`state it could not read (${blockers.unreadable})`] : []),
  ];
  return other.length
    ? `${other.join(" and ")}; no turn or stage is running`
    : "one quiet minute before it starts; no turn or stage is running";
}

/** The blockers the pending update last recorded, and the wait they name. */
export function updateHoldWait(
  blockers: QuietBlockers | null = readAuto(statePath("self-update", "auto.json")).lastBlockers,
): { waitingFor: string; blockers: QuietBlockers | null } {
  return { waitingFor: describeUpdateWait(blockers), blockers };
}

export interface LaunchHoldRefusal {
  error: string;
  code: "launch_held_for_update";
  target: string;
  since: string;
  /** The same wait as `error`, without the sentence around it. */
  waitingFor: string;
  blockers: QuietBlockers | null;
}

/** The refusal an autonomous launch gets while an update holds admission. */
export function launchHoldRefusal(hold: Pick<DrainLease, "target" | "since">, blockers?: QuietBlockers | null): LaunchHoldRefusal {
  const wait = blockers === undefined ? updateHoldWait() : updateHoldWait(blockers);
  return {
    error: `new launches are held while the automatic update waits for ${wait.waitingFor}`,
    code: "launch_held_for_update", target: hold.target, since: hold.since, ...wait,
  };
}

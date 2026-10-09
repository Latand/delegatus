import type { FileEntry } from "@/lib/types";

import { mobileRowState } from "./mobile/mobileBoardModel";
import { isSubagent, projectKey, type ProjectSummary } from "./projectModel";
import { turnIsRunning } from "./turnDuration";

/**
 * The one rule for «working»: an agent whose turn is running now. The sidebar
 * row's green count, the Overview row, the board header, its columns and a
 * card's «N working» all count with it, so two surfaces showing the same
 * project at the same moment show the same number.
 *
 * It is the reading `agent_activity` gives as lifecycle `running`, taken from
 * what the browser holds: the turn is open on a host that did not die
 * (`turnIsRunning`, `proc !== "killed"`), nothing waits on the operator, the
 * transcript is not stalled and the provider is not holding it. A turn that
 * runs while an account switch holds its deliveries is still running.
 *
 * Only agents count. An engine-native subagent works inside its parent's turn,
 * which already counts, and a background shell task is a process, not an
 * agent. Pipelines, workflows and provisioning lanes are not agents either:
 * the stage conversation they start counts once its turn runs.
 *
 * The clock moves in the board model's 15 s steps, so a caller holding a
 * per-second clock and one holding the board's clock read the same answer.
 */
export function isWorkingAgent(file: FileEntry, now: number): boolean {
  if (file.engine === "shell" || isSubagent(file) || file.spawnOrigin === "engine") return false;
  const row = mobileRowState(file, workingClock(now));
  if (row.key === "working") return true;
  return row.key === "held" && file.proc !== "killed" && turnIsRunning(file);
}

/** The board model's clock, in seconds: 15 s steps. */
export function workingClock(now: number): number {
  return Math.floor(now / 15) * 15;
}

/** How many of these files are agents working now. */
export function workingAgentCount(files: readonly FileEntry[], now: number): number {
  let count = 0;
  for (const file of files) if (isWorkingAgent(file, now)) count += 1;
  return count;
}

/** Each project's working agents, keyed the way the sidebar groups rows. */
export function workingAgentCounts(files: readonly FileEntry[], now: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (!isWorkingAgent(file, now)) continue;
    const key = projectKey(file);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The Overview's working number: the sum of the rows it shows, which are the
 * projects that are not archived. The rail's Overview row and the Overview's
 * top line count this one scope, so an archived project's agents, which keep
 * their own count in the rail's archive section, never make two «working»
 * numbers on one screen differ.
 */
export function overviewWorkingTotal(summaries: readonly ProjectSummary[], archived: ReadonlySet<string>): number {
  let count = 0;
  for (const summary of summaries) if (!archived.has(summary.project)) count += summary.liveCount;
  return count;
}

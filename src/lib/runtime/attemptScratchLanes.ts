import fs from "node:fs";
import path from "node:path";
import { agentRegistry } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import { pipelineActivitySettled } from "@/lib/pipelines/types";
import { liveOrWaitingConversationCwds } from "@/lib/pipelines/worktreeSweep";
import { assertRetentionTestPath, RetentionTestSafetyError } from "@/lib/retentionTestSafety";
import { attemptTempConfigParent } from "./attemptTempPaths";
import type { AttemptTempOwner } from "./attemptTempRetention";

/** A scratch root (a direct child of a scratch namespace) is in use when one
 * of these working directories is the root, lies inside it, or is the
 * namespace itself. A directory further up, such as the home directory,
 * contains every root and says nothing about any of them; a process standing
 * there holds a root only by naming it, which the reference proof answers. */
const worksIn = (directory: string) => (other: string) =>
  other === directory || other.startsWith(directory + path.sep) || other === path.dirname(directory);

/** A lane that is not both closed and settled is open. */
function openLaneDirectories(): string[] {
  return loadPipelinesForList().filter(lane => lane.state !== "closed" && lane.state !== "completed" || !pipelineActivitySettled(lane))
    .flatMap(lane => [lane.worktreeDir, lane.repoDir]).filter((directory): directory is string => !!directory);
}

/** One read of every directory an open lane or a live conversation works in,
 * returned as a test for a scratch root. */
export function openLaneUseCheck(): (directory: string) => boolean {
  const used = [...openLaneDirectories(), ...liveOrWaitingConversationCwds(agentRegistry().worktreeProtectionSnapshot())];
  return directory => used.some(worksIn(directory));
}

/** The same test for a removal pass, which asks it many times for every root
 * and needs the current answer each time. Lanes are read at every question.
 * Conversations are read again once anything was committed to the registry, and
 * only those working in a scratch namespace, since no other directory can
 * answer yes: reading the whole registry at every question outlasted a root's
 * window on a large installation, so nothing was ever removed. */
export function scratchRootUseCheck(): (directory: string) => boolean {
  let read: { stamp: string | null; directories: string[] } | null = null;
  return directory => {
    const registry = agentRegistry(), stamp = registry.worktreeProtectionStamp();
    // The stamp is taken first: a commit during the read shows at the next question.
    if (!read || stamp === null || read.stamp !== stamp) read = { stamp, directories: liveOrWaitingConversationCwds(
      registry.worktreeProtectionSnapshot([statePath("scratch"), attemptTempConfigParent()]), undefined, undefined, false) };
    return openLaneDirectories().some(worksIn(directory)) || read.directories.some(worksIn(directory));
  };
}

/** The canonical namespaces stage scratch and stage config roots live in. */
export function scratchRootAdmitted(directory: string): boolean {
  const parent = path.dirname(directory), name = path.basename(directory);
  const admitted = parent === statePath("scratch") && /^llv-(?:read-only-stage|stage)-[A-Za-z0-9]{6}$/.test(name)
    || parent === attemptTempConfigParent() && /^llv-stage-config-[A-Za-z0-9]{6}$/.test(name);
  if (!admitted) return false;
  assertRetentionTestPath(directory);
  return fs.realpathSync(parent) === parent && !fs.existsSync(path.join(parent, ".delegatus-keep"));
}

export type SelectedScratch = AttemptTempOwner & { identity: string; released: number };
export type ScratchRefusal = { reason: string; reasonCode: string };

/** Why a root chosen for one bounded selection may no longer be retired by it,
 * or null. Each guard names itself, so a report never blames a ledger change
 * for a lane that works in the root. `inUse` is the pass's
 * `scratchRootUseCheck`. */
export function scratchSelectionRefusal(selected: SelectedScratch | undefined, owner: SelectedScratch,
  inUse: (directory: string) => boolean): ScratchRefusal | null {
  if (!selected || selected.identity !== owner.identity || selected.pipelineId !== owner.pipelineId || selected.launchId !== owner.launchId
    || selected.createdAt !== owner.createdAt || selected.released !== owner.released || selected.retainUntilClose !== owner.retainUntilClose)
    return { reason: "ledger binding or root identity changed since this root was selected", reasonCode: "selection_binding_changed" };
  let admitted = false;
  // A namespace that cannot be resolved admits nothing; it is a hold with a name.
  try { admitted = scratchRootAdmitted(owner.directory); }
  catch (error) { if (error instanceof RetentionTestSafetyError) throw error; }
  if (!admitted) return { reason: "scratch ancestry or keep marker", reasonCode: "scratch_ancestry" };
  if (inUse(owner.directory)) return { reason: "an open lane or live conversation works inside the root", reasonCode: "open_lane" };
  return null;
}

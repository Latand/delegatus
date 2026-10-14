import fs from "node:fs";

import type { ProcessIdentity } from "@/lib/agent/registry";
import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import { captureProcessIdentity } from "@/lib/processIdentity";

export type ProcessSignal = (pid: number, signal: NodeJS.Signals) => void;

export interface DetachedProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

/** What the Windows tree walk needs from the process backend. */
export interface ProcessTreeSource {
  ppidMap(): Map<number, number>;
  processIdentity(pid: number): string | null;
}

/**
 * The order a process tree must be signalled in: every descendant before the
 * process it descends from, leader last. `descendantPids` is a pre-order DFS,
 * and reversing a pre-order puts each node after all of its descendants.
 *
 * Pure, so the ordering rule is asserted on every platform.
 */
export function processTreeTerminationOrder(leader: number, ppids: Map<number, number>): number[] {
  return descendantPids(leader, ppids).reverse();
}

/**
 * Windows replacement for `kill(-pgid)`.
 *
 * Windows has no process groups and no signals: `process.kill(pid, sig)` is
 * `TerminateProcess`, `process.kill(-pid, …)` throws, and no handler runs in
 * the child. What replaces "signal the group" is a walk of the parent map,
 * descendants first. Three things change as a result, all of them named in the
 * README's Windows section:
 *
 *  - The tree is the one the *snapshot* describes. A process that started
 *    after the snapshot, or one that had already reparented away, is not in it.
 *  - There is no atomicity. A group signal reaches every member at once; this
 *    walk takes as long as it takes, and a child spawned mid-walk survives.
 *  - Nothing is graceful. Both hosts already close the child's stdin before
 *    their first signal, which is the one stop `claude -p` honours; after that
 *    SIGTERM and SIGKILL are the same call.
 *
 * `taskkill /T /F` performs the same walk in one process, and is rejected for
 * this seam because it neither orders the tree nor checks identity. Identity is
 * the point: Windows hands a freed pid back within seconds, so a pid read out
 * of the parent map may already name an unrelated process by the time the walk
 * reaches it. Each member's kernel creation-time token is captured with the map
 * and re-read immediately before the kill; a member whose token changed is
 * skipped. (A backend that cannot read identity at all reports null for both,
 * and the walk then kills unconditionally — the same exposure `kill(-pgid)`
 * carries on Linux for a recycled leader.)
 *
 * Job Objects are the proper Windows primitive and are deferred: they need FFI
 * on the spawn side and change how every child is created.
 */
export function terminateProcessTree(
  leader: number,
  signal: NodeJS.Signals,
  signalProcess: ProcessSignal = process.kill,
  source: ProcessTreeSource = procBackend,
): boolean {
  let order: number[];
  let expected: Map<number, string | null>;
  try {
    order = processTreeTerminationOrder(leader, source.ppidMap());
    expected = new Map(order.map((pid) => [pid, source.processIdentity(pid)]));
  } catch {
    order = [leader];
    expected = new Map([[leader, null]]);
  }
  let leaderSignalled = false;
  for (const pid of order) {
    try {
      if (source.processIdentity(pid) !== (expected.get(pid) ?? null)) continue;
      signalProcess(pid, signal);
      if (pid === leader) leaderSignalled = true;
    } catch {
      /* the member exited on its own, or is not ours to signal */
    }
  }
  return leaderSignalled;
}

/** Signals an existing process group without falling through to a recycled leader pid. */
export function signalProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
  signalProcess: ProcessSignal = process.kill,
): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") return terminateProcessTree(pid, signal, signalProcess);
  try {
    signalProcess(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Signals a detached child's process group and falls back to its leader. */
export function signalDetachedProcessGroup(
  child: DetachedProcess,
  signal: NodeJS.Signals,
  signalProcess: ProcessSignal = process.kill,
): boolean {
  if (signalProcessGroup(child.pid, signal, signalProcess)) return true;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

/** The process group a Linux pid belongs to, or null off Linux or once it is gone. */
export function linuxProcessGroupId(pid: number): number | null {
  if (procBackend.name !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const group = Number(stat.slice(close + 2).trim().split(/\s+/)[2]);
    return Number.isInteger(group) && group > 0 ? group : null;
  } catch {
    return null;
  }
}

/** What a stop read of a root's tree before its first signal (#2790).
    `unresolved` names every pid that may still run but whose identity could
    not be read whole: a stop cannot fence a later signal to it, nor prove it
    gone, so a capture that names any is incomplete and authorizes nothing. */
export interface ProcessTreeCapture {
  identities: ProcessIdentity[];
  unresolved: number[];
}

/**
 * Every process a running root started, read before anything signals it
 * (#2790): its descendants by parent, plus the members of the group it leads,
 * each with the identity it has now. The root itself is left out. A member that
 * calls setsid leaves the group, and once the root exits it is reparented, so
 * after the root's first signal neither walk can name it any more. A pid whose
 * identity cannot be read is left out only when it is proven gone; one that
 * still runs is listed as unresolved, so the capture reads as incomplete.
 */
export function captureProcessTree(
  root: number,
  source: Pick<ProcessTreeSource, "ppidMap" | "processIdentity"> & {
    processGroupId?(pid: number): number | null;
    pidAlive?(pid: number): boolean;
    bootEpoch?(): string | null;
  } = procBackend,
): ProcessTreeCapture {
  const groupOf = source.processGroupId ?? linuxProcessGroupId;
  const alive = source.pidAlive ?? ((pid: number) => procBackend.pidAlive(pid));
  const parents = source.ppidMap();
  const members = new Set(descendantPids(root, parents));
  if (groupOf(root) === root) {
    for (const candidate of parents.keys()) if (groupOf(candidate) === root) members.add(candidate);
  }
  members.delete(root);
  const identities: ProcessIdentity[] = [];
  const unresolved: number[] = [];
  for (const pid of members) {
    const startIdentity = source.processIdentity(pid);
    if (startIdentity === null) {
      if (alive(pid)) unresolved.push(pid);
      continue;
    }
    const identity = source.bootEpoch
      ? { pid, startIdentity, bootEpoch: source.bootEpoch() }
      : captureProcessIdentity(pid, undefined, startIdentity);
    if (identity.bootEpoch) identities.push(identity);
    else unresolved.push(pid);
  }
  return { identities, unresolved };
}

import fs from "node:fs";

import { discoverSweepRoots, type TempSweepRoot } from "@/lib/tempSweep";
import { openHostTempRoots, stageHostNamespace, tempViewAvailable } from "./hostTempViews";
import { readMemoryReading, tmpUsage, type MemoryReading, type StatFs, type TmpUsage } from "./memoryPressure";

/**
 * The memory reading with the machine's `/tmp`, for the watch's helper
 * process: it may enter the host namespace and scan `/proc`, which the serving
 * loop never waits for.
 */

export type HostTmpPorts = {
  env?: Readonly<Record<string, string | undefined>>;
  meminfo?: () => string;
  statfs?: (directory: string) => StatFs;
  hostNamespace?: () => string | null;
  /** Temp roots read through agent processes in other mount namespaces. */
  agentRoots?: () => TempSweepRoot[];
  open?: typeof openHostTempRoots;
  available?: (root: TempSweepRoot) => boolean;
};

/** The host's `/tmp` as an agent process shows it, else as a reader borrowed
    in the host namespace shows it. Null when neither can be read: the
    container's own `/tmp` is never an answer. */
async function hostTmpUsage(ports: HostTmpPorts): Promise<TmpUsage | null> {
  const namespace = (ports.hostNamespace ?? stageHostNamespace)();
  if (!namespace) return null;
  const statfs = ports.statfs ?? ((directory: string) => fs.statfsSync(directory));
  const available = ports.available ?? tempViewAvailable;
  const read = (roots: readonly TempSweepRoot[]) => {
    for (const root of roots) {
      // An agent in a sandbox of its own has its own `/tmp`.
      if (root.path !== "/tmp" || !root.via || root.anchor?.namespace !== namespace || !available(root)) continue;
      try {
        const usage = tmpUsage(statfs(root.via + root.path), "host");
        // The process the view runs through may have exited during the read.
        if (available(root)) return usage;
      } catch { /* The next view. */ }
    }
    return null;
  };
  const throughAgent = read((ports.agentRoots ?? (() => discoverSweepRoots([])))());
  if (throughAgent) return throughAgent;
  const view = await (ports.open ?? openHostTempRoots)([{ path: "/tmp", via: "" }], ports.env ?? process.env);
  try { return read(view.roots); }
  finally { await view.close(); }
}

export async function readHostMemoryReading(ports: HostTmpPorts = {}): Promise<MemoryReading | null> {
  const env = ports.env ?? process.env;
  const reading = readMemoryReading({ env, meminfo: ports.meminfo, statfs: ports.statfs });
  if (!reading || env.LLV_DOCKER_NSENTER_SHIMS !== "1") return reading;
  try { return { ...reading, tmp: await hostTmpUsage(ports) }; }
  catch (error) {
    console.warn("[memory pressure] host /tmp unreadable", error instanceof Error ? error.message : String(error));
    return reading;
  }
}

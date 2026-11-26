import { promises as fs } from "node:fs";
import { processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import type { DependencyCacheFence } from "./lockedDependencies";

/** A recorded descriptor is useful only while the same worker still holds
 * the same physical fence. Inaccessible kernel evidence leaves it unclaimed. */
export async function provesProvisionCacheHolder(worker: ProcessIdentity, fence: DependencyCacheFence, signal: AbortSignal): Promise<boolean> {
  if (process.platform !== "linux" || processIdentityStatus(worker) !== "alive") return false;
  const proc = `/proc/${worker.pid}`;
  try {
    const [file, info] = await Promise.all([
      fs.stat(`${proc}/fd/${fence.fd}`, { bigint: true }),
      fs.readFile(`${proc}/fdinfo/${fence.fd}`, { encoding: "utf8", signal }),
    ]);
    const lock = /^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s/m.exec(info);
    return !signal.aborted && file.isFile() && `${file.dev}:${file.ino}` === fence.identity
      && lock?.[1] === String(worker.pid) && /^ino:\s+(\d+)$/m.exec(info)?.[1] === String(file.ino)
      && processIdentityStatus(worker) === "alive";
  } catch { return false; }
}

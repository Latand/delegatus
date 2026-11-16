import fs from "node:fs";
import { procBackend } from "@/lib/proc";
import { processIdentityStatus, systemBootEpoch, type ProcessIdentity } from "@/lib/processIdentity";
import { differentKernelBoot } from "@/lib/runtime/agentScope";

/** A denied or foreign proc mount cannot prove a recorded process ended. */
export function observeAgentProcess(identity: ProcessIdentity): "alive" | "dead" | "unverified" {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !identity.startIdentity) return "unverified";
  try {
    const boot = systemBootEpoch();
    if (!boot) return "unverified";
    if (process.platform === "linux") {
      const namespace = fs.readlinkSync("/proc/self/ns/pid");
      if (!boot.endsWith(`:pidns:${namespace}`) || Number(fs.readlinkSync("/proc/self")) !== process.pid) return "unverified";
      if (identity.bootEpoch && boot !== identity.bootEpoch) return differentKernelBoot(identity.bootEpoch, boot) ? "dead" : "unverified";
      // Never let existsSync/processIdentityStatus collapse an unreadable proc
      // entry into a dead owner. A boot-bound claim proves its namespace; the
      // legacy rule below applies only to claims written by this server.
      try { fs.statSync(`/proc/${identity.pid}`); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESRCH") return "dead";
        return "unverified";
      }
    }
    // Before bootEpoch was persisted, claim writers were local server
    // processes. On Linux, the validated current proc mount therefore gives
    // the same-namespace legacy proof: absence or a changed start token means
    // that writer is gone. Inaccessible proc entries remain unverified.
    if (process.platform === "linux" && !identity.bootEpoch) {
      const currentStart = procBackend.processIdentity(identity.pid);
      if (!currentStart) return "unverified";
      return currentStart === identity.startIdentity ? "alive" : "dead";
    }
    const status = processIdentityStatus(identity);
    return status === "alive" && procBackend.processExited(identity.pid) ? "dead" : status;
  } catch { return "unverified"; }
}

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
      if (!identity.bootEpoch) {
        try { fs.statSync(`/proc/${identity.pid}`); }
        catch { return "unverified"; }
      }
    }
    // A legacy claim has no owner namespace binding. A PID absent from this
    // proc mount may still be alive in another PID namespace, so absence and
    // ESRCH cannot authorize retirement. New claims carry bootEpoch, which
    // binds both the kernel boot and PID namespace.
    if (!identity.bootEpoch) return "unverified";
    const status = processIdentityStatus(identity);
    return status === "alive" && procBackend.processExited(identity.pid) ? "dead" : status;
  } catch { return "unverified"; }
}

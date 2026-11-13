import fs from "node:fs";
import { procBackend } from "@/lib/proc";
import { processIdentityStatus, systemBootEpoch, type ProcessIdentity } from "@/lib/processIdentity";
import { differentKernelBoot } from "@/lib/runtime/agentScope";

/** A denied or foreign proc mount cannot prove a recorded process ended. */
export function observeAgentProcess(identity: ProcessIdentity): "alive" | "dead" | "unverified" {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !identity.startIdentity || !identity.bootEpoch) return "unverified";
  try {
    const boot = systemBootEpoch();
    if (!boot) return "unverified";
    if (process.platform === "linux") {
      const namespace = fs.readlinkSync("/proc/self/ns/pid");
      if (!boot.endsWith(`:pidns:${namespace}`) || Number(fs.readlinkSync("/proc/self")) !== process.pid) return "unverified";
      if (boot !== identity.bootEpoch) return differentKernelBoot(identity.bootEpoch, boot) ? "dead" : "unverified";
      try { fs.statSync(`/proc/${identity.pid}`); }
      catch (error) {
        if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return "unverified";
        try { process.kill(identity.pid, 0); }
        catch (probeError) { return (probeError as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unverified"; }
        return "unverified";
      }
    }
    const status = processIdentityStatus(identity);
    return status === "alive" && procBackend.processExited(identity.pid) ? "dead" : status;
  } catch { return "unverified"; }
}

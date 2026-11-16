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
      // A present-day proc mount proves only the observer's namespace. A
      // legacy claim contains no writer namespace, so even an absent PID may
      // still name a live process in another namespace. Keep it unverified.
      if (!identity.bootEpoch) return "unverified";
      if (boot !== identity.bootEpoch) return differentKernelBoot(identity.bootEpoch, boot) ? "dead" : "unverified";
      // Never let existsSync/processIdentityStatus collapse an unreadable proc
      // entry into a dead owner. The boot-bound claim proves its namespace.
      try { fs.statSync(`/proc/${identity.pid}`); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESRCH") return "dead";
        return "unverified";
      }
    }
    const status = processIdentityStatus(identity);
    return status === "alive" && procBackend.processExited(identity.pid) ? "dead" : status;
  } catch { return "unverified"; }
}

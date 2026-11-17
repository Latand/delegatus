import fs from "node:fs";
import { procBackend } from "@/lib/proc";
import { processIdentityStatus, systemBootEpoch, type ProcessIdentity } from "@/lib/processIdentity";
import { differentKernelBoot } from "@/lib/runtime/agentScope";

function absentFromSignalNamespace(pid: number): boolean {
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  return false;
}

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
      // The boot-bound claim proves the signal namespace, not proc visibility:
      // hidepid can report ENOENT for a live owner. Only the kernel's ESRCH
      // from a signal-zero probe independently proves absence in that domain.
      try { fs.statSync(`/proc/${identity.pid}`); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESRCH") {
          if (absentFromSignalNamespace(identity.pid)) return "dead";
        }
        return "unverified";
      }
      const current = procBackend.processIdentity(identity.pid);
      if (!current) return absentFromSignalNamespace(identity.pid) ? "dead" : "unverified";
      if (current !== identity.startIdentity) return "dead";
      return procBackend.processExited(identity.pid) ? "dead" : "alive";
    }
    const status = processIdentityStatus(identity);
    return status === "alive" && procBackend.processExited(identity.pid) ? "dead" : status;
  } catch { return "unverified"; }
}

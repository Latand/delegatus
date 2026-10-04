import { spawn } from "node:child_process";

import type { ProcessIdentity } from "@/lib/agent/registry";
import { captureProcessIdentity, sameRecordedProcessIdentity } from "@/lib/processIdentity";
import type { EngineHost } from "../engineHost";

/** A private process behind a fake transport, for the real controller kill fence. */
export async function ownedHostProcess() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const cleanup = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const escalation = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 1_000);
    try { await exited; }
    finally { clearTimeout(escalation); }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const identity = captureProcessIdentity(child.pid!);
    if (!identity.startIdentity || !identity.bootEpoch) throw new Error("fixture child has no complete process identity");
    return {
      identity,
      cleanup,
      bind<T extends EngineHost>(host: T): T & { releaseIfOwned(expected: Readonly<ProcessIdentity>): Promise<boolean> } {
        const health = host.health.bind(host);
        const release = host.release.bind(host);
        return Object.assign(host, {
          health: async () => ({ ...await health(), pid: identity.pid, processStartIdentity: identity.startIdentity }),
          release: async () => { await cleanup(); await release(); },
          releaseIfOwned: async (expected: Readonly<ProcessIdentity>) => {
            if (child.exitCode !== null || child.signalCode !== null
              || expected.bootEpoch !== identity.bootEpoch
              || !sameRecordedProcessIdentity(identity, expected)
              || !sameRecordedProcessIdentity(captureProcessIdentity(identity.pid), identity)) return false;
            await host.release();
            return true;
          },
        });
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

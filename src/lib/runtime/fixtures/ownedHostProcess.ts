import { spawn } from "node:child_process";
import path from "node:path";
import { stopFixtureProcess } from "@/lib/testing/fixtureProcess";

import type { ProcessIdentity } from "@/lib/agent/registry";
import { captureProcessIdentity, sameRecordedProcessIdentity } from "@/lib/processIdentity";
import type { EngineHost } from "../engineHost";

/** A private process behind a fake transport, for the real controller kill fence. */
export async function ownedHostProcess() {
  const child = spawn(process.execPath, ["-e", `await import(${JSON.stringify(path.resolve(import.meta.dir, "../../testing/fixtureLifetime.ts"))}); setInterval(() => {}, 1000)`], {
    detached: true,
    stdio: "ignore",
  });
  const cleanup = () => stopFixtureProcess(child);
  try {
    const identity = captureProcessIdentity(child.pid!);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
        timer = setTimeout(() => reject(new Error("owned host fixture did not spawn within 5000ms")), 5_000);
      });
    } finally { clearTimeout(timer); }
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

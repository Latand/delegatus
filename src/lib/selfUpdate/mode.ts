/* Which install this Viewer is, decided server-side from what the install
   itself says (#2007), never from a guess about the environment:

   - `bin/cli.mjs` hands the web process the path of its launcher record
     (`LLV_SELF_UPDATE_RECORD`). A record whose launcher is still the process
     that wrote it makes this a checkout install (or a packaged one, when the
     record names no checkout).
   - Otherwise the runtime host is asked for a deployment that cannot exist.
     A host running Viewer deployments answers "not found"; one without them
     refuses with "viewer deployments are disabled" (`RuntimeHost.handle`,
     `viewer-deployment-read`). The first is the managed Docker install. */
import type { RuntimeHostClient } from "@/lib/runtime/client";

import { launcherAlive, readLauncherRecord, type LauncherRecord } from "./launcher";
import type { InstallMode, UnsupportedReason } from "./types";

export const LAUNCHER_RECORD_ENV = "LLV_SELF_UPDATE_RECORD";
const MODE_PROBE_ID = "self-update-mode-probe";

export interface ModeDecision {
  mode: InstallMode;
  reason: UnsupportedReason | null;
  record: LauncherRecord | null;
}

export interface ModePorts {
  env: Readonly<Record<string, string | undefined>>;
  readRecord(file: string): LauncherRecord | null;
  alive(record: LauncherRecord): boolean;
  /** true: the host runs Viewer deployments; false: it answered without
      them; null: no host answered. */
  deploymentsEnabled(): Promise<boolean | null>;
}

export async function detectMode(ports: ModePorts): Promise<ModeDecision> {
  const file = ports.env[LAUNCHER_RECORD_ENV]?.trim();
  const record = file ? ports.readRecord(file) : null;
  if (record && ports.alive(record)) {
    return record.checkout
      ? { mode: "checkout", reason: null, record }
      : { mode: "unsupported", reason: "not-a-checkout", record };
  }
  const enabled = await ports.deploymentsEnabled();
  if (enabled === true) return { mode: "managed", reason: null, record: null };
  return { mode: "unsupported", reason: enabled === null ? "no-runtime-host" : "no-launcher", record: null };
}

export async function deploymentsEnabled(client: RuntimeHostClient | null): Promise<boolean | null> {
  if (!client) return null;
  try {
    await client.readViewerDeployment(MODE_PROBE_ID);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/viewer deployments are disabled/i.test(message)) return false;
    return null;
  }
}

export function productionModePorts(client: RuntimeHostClient | null, env: Readonly<Record<string, string | undefined>> = process.env): ModePorts {
  return {
    env,
    readRecord: readLauncherRecord,
    alive: (record) => launcherAlive(record),
    deploymentsEnabled: () => deploymentsEnabled(client),
  };
}

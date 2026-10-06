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
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { statePath } from "@/lib/configDir";

import { launcherAlive, readLauncherRecord, type LauncherRecord } from "./launcher";
import { primeStartIdentities } from "./pid";
import type { InstallMode, UnsupportedReason } from "./types";

export const LAUNCHER_RECORD_ENV = "LLV_SELF_UPDATE_RECORD";
const MODE_PROBE_ID = "self-update-mode-probe";

export interface ModeDecision {
  mode: InstallMode;
  reason: UnsupportedReason | null;
  record: LauncherRecord | null;
  supervision?: "launcher" | "adopted";
  installRoot?: string;
}

export interface ModePorts {
  env: Readonly<Record<string, string | undefined>>;
  readRecord(file: string): LauncherRecord | null;
  alive(record: LauncherRecord): boolean;
  records?(): LauncherRecord[];
  viewerPid?: number;
  /** true: the host runs Viewer deployments; false: it answered without
      them; null: no host answered. */
  deploymentsEnabled(): Promise<boolean | null>;
}

export async function detectMode(ports: ModePorts): Promise<ModeDecision> {
  const file = ports.env[LAUNCHER_RECORD_ENV]?.trim();
  let record = file ? ports.readRecord(file) : null;
  let adopted = false;
  let installRoot = record?.checkout ?? record?.installRoot;
  if (!record || !ports.alive(record)) {
    const all = ports.records?.() ?? [];
    const records = all.filter(candidate => ports.alive(candidate));
    const socket = ports.env.LLV_RUNTIME_HOST_SOCKET;
    const port = Number(ports.env.PORT);
    const matches = socket ? records.filter(candidate => candidate.socket === socket)
      : records.filter(candidate => port > 0 && candidate.port === port);
    // Ambiguous port/socket evidence cannot transfer supervision.
    const previous = all.filter(candidate => socket ? candidate.socket === socket : candidate.port === port);
    if (previous.length === 1) installRoot = previous[0]!.checkout ?? previous[0]!.installRoot;
    record = matches.length === 1 ? matches[0]! : null;
    adopted = record !== null;
  }
  if (record && ports.alive(record)) {
    return { mode: record.checkout ? "checkout" : "package", reason: null, record, supervision: adopted || ports.viewerPid !== undefined && record.web.pid !== ports.viewerPid ? "adopted" : "launcher" };
  }
  const enabled = await ports.deploymentsEnabled();
  if (enabled === true) return { mode: "managed", reason: null, record: null };
  if (ports.env.LLV_DOCKER_NSENTER_SHIMS === "1") return { mode: "unsupported", reason: "docker-deployments", record: null };
  return { mode: "unsupported", reason: enabled === null ? "no-runtime-host" : "no-launcher", record: null, ...(installRoot ? { installRoot } : {}) };
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
    viewerPid: process.pid,
    /* Every PID the snapshot is about to compare is read with the launcher's. */
    readRecord: (file) => {
      const record = readLauncherRecord(file);
      if (record) primeStartIdentities([record.launcher.pid, record.web.pid, record.runtimeHost.pid, process.pid]);
      return record;
    },
    alive: (record) => launcherAlive(record),
    records: () => {
      const directory = statePath("self-update");
      try {
        const records = readdirSync(directory).filter(name => /^launcher-.*\.json$/.test(name))
          .map(name => readLauncherRecord(join(directory, name))).filter((record): record is LauncherRecord => record !== null);
        primeStartIdentities(records.flatMap(record => [record.launcher.pid, record.web.pid, record.runtimeHost.pid]));
        return records;
      }
      catch { return []; }
    },
    deploymentsEnabled: () => deploymentsEnabled(client),
  };
}

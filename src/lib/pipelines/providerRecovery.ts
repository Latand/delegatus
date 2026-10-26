import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { StateSnapshotChangedError } from "@/lib/state/sqliteStateStore";
import { recoverPipelineProviderTurn, type PipelinePorts } from "./engine";
import { pipelineRecoveryWindow } from "./store";
import { withoutControllerPipelineScope } from "./controllerScope";

export const PROVIDER_RECOVERY_PAGE = 8;
export { PROVIDER_RECOVERY_DEADLINE_MS } from "./engine";
type Cursor = { row_order: number; row_key: string };
const owner = globalThis as typeof globalThis & {
  __llvProviderRecoveryJobs?: Map<string, Promise<void>>;
  __llvProviderRecoverySchedules?: Map<string, Promise<void>>;
};
const jobs = owner.__llvProviderRecoveryJobs ??= new Map<string, Promise<void>>();
const schedules = owner.__llvProviderRecoverySchedules ??= new Map<string, Promise<void>>();

async function readCursor(filename: string): Promise<Cursor> {
  try {
    const value = JSON.parse(await fs.readFile(filename, "utf8")) as Cursor;
    if (Number.isSafeInteger(value.row_order) && value.row_order >= -1 && typeof value.row_key === "string") return value;
    throw new Error("invalid provider recovery cursor");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { row_order: -1, row_key: "" };
  }
}

async function saveCursor(filename: string, value: Cursor): Promise<void> {
  const directory = path.dirname(filename);
  await fs.mkdir(directory, { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const file = await fs.open(temporary, "wx", 0o600);
  try {
    try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await fs.rename(temporary, filename);
    if (process.platform !== "win32") {
      const parent = await fs.open(directory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    }
  } finally { await fs.rm(temporary, { force: true }); }
}

/** Each watchdog/host wake admits at most eight indexed running lanes. The
 * durable fair cursor advances before dispatch, including past unreadable or
 * held evidence. Expiry parks through fresh authority and releases admission;
 * late evidence cannot write or send. */
export function scheduleProviderRecovery(suppliedPorts?: PipelinePorts): Promise<void> {
  return withoutControllerPipelineScope(() => {
    const root = statePath("provider-recovery-cursor.json");
    const active = schedules.get(root);
    if (active) return active;
    const schedule = (async () => {
      const rows = await pipelineRecoveryWindow(await readCursor(root), PROVIDER_RECOVERY_PAGE);
      if (!rows.length) return;
      await saveCursor(root, rows.at(-1)!);
      for (const row of rows) {
        const key = JSON.stringify([root, row.row_key]);
        if (jobs.has(key)) continue;
        const job = withViewerOperation("pipelines.controller-lane", () =>
          recoverPipelineProviderTurn(row.row_key, suppliedPorts))
          .catch(error => {
            if (!(error instanceof StateSnapshotChangedError)) console.error("[pipelines] provider recovery deferred", error);
          }).finally(() => { jobs.delete(key); });
        jobs.set(key, job);
      }
    })().finally(() => { schedules.delete(root); });
    schedules.set(root, schedule);
    return schedule;
  });
}

/** Shutdown/test observation only; never awaited by the controller. */
export async function settleProviderRecoveries(): Promise<void> {
  await Promise.all([...jobs.values()]);
}

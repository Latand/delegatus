import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { withFileTransactionAsync } from "./fileTransaction";
import { STATE_LOCK_WAIT_MS } from "./lockWait";
import { writeJsonDurably } from "./durableJson";
import { diskPressureWakeReady, formatDiskBytes, type DiskPressure } from "./diskPressure";
import { requestDiskPressureSweep, requestDiskPressureSweeps } from "./diskPressureSweeps";
import type { MemoryPressureActions } from "./memoryPressure";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import type { SeatTickCard } from "@/lib/monitor/types";
import type { CleanerController } from "@/lib/cleaner/run";

type Notice = {
  episode: string; project: string; card: boolean; report: boolean; lastSweepAt: number;
  cleaner?: boolean; cleanerTaskId?: string;
};
export type DiskPressureActions = {
  active: () => boolean;
  project: () => Promise<string | null>;
  early: () => void;
  card: (project: string, card: SeatTickCard, at: string) => Promise<boolean>;
  report: (project: string, episode: string, text: string, at: string) => Promise<boolean>;
  cleaner?: Pick<CleanerController, "claimPressure" | "pressureCard">;
};

export function productionDiskPressureActions(): DiskPressureActions {
  return {
    active: viewerReleaseOwnsTraffic,
    project: async () => {
      const [{ default: manifest }, { viewerRepositoryProjects }, { recordedProjectRemote }, { canonicalOrchestratorProject }] = await Promise.all([
        import("../../../package.json"), import("@/lib/projects/viewerRepository"), import("@/lib/projects/aliases"), import("@/lib/orchestrator/seats"),
      ]);
      const projects = viewerRepositoryProjects(process.env.LLV_VIEWER_CANONICAL_REMOTE?.trim() || manifest.repository.url.trim(), process.cwd());
      const project = projects.find(key => recordedProjectRemote(key) !== null) ?? projects[0];
      return project ? canonicalOrchestratorProject(project) : null;
    },
    early: requestDiskPressureSweeps,
    card: async (project, card, at) => {
      const { ensureSeatTickCard } = await import("@/lib/monitor/seatTickController");
      return viewerReleaseOwnsTraffic() && ensureSeatTickCard(project, card, at);
    },
    report: (project, episode, body, at) => recordSeatStatusReport(project, `disk-pressure:${episode}`, body, at),
  };
}

/** One status report for the project's manager, deduplicated by its key. */
async function recordSeatStatusReport(project: string, key: string, body: string, at: string): Promise<boolean> {
  if (!(await import("@/lib/projects/settings")).bridgeReportsEnabled(project)) return true;
  const { recordManagerReport } = await import("@/lib/bridge/service");
  const { findBridgeReport, scopedReportId } = await import("@/lib/bridge/store");
  if (!viewerReleaseOwnsTraffic()) return false;
  return !!(recordManagerReport({ key, project, at, class: "status",
    origin: { kind: "agent", role: "seat-tick", conversationId: null }, targetSeatConversationId: null, body })
    ?? findBridgeReport(scopedReportId(project, key)));
}

/** Memory pressure warns through the same seat card, manager report and
    project as low disk space, and asks for the temp sweep alone. */
export function productionMemoryPressureActions(disk: DiskPressureActions = productionDiskPressureActions()): MemoryPressureActions {
  return {
    active: disk.active,
    project: disk.project,
    card: disk.card,
    report: recordSeatStatusReport,
    sweep: () => requestDiskPressureSweep("temp"),
  };
}

export function diskPressureNotice(pressure: DiskPressure): string {
  const free = pressure.volumes.filter(volume => volume.level === "warning" || volume.level === "critical")
    .map(volume => volume.freeBytes === null ? "невідомо" : formatDiskBytes(volume.freeBytes)).join(", ");
  const categories = pressure.categories ?? pressure.consumers.map(row => ({ name: row.kind, bytes: row.bytes }));
  return `Мало місця на диску: вільно ${free || "невідомо"}.\n`
    + [...categories].sort((a, b) => b.bytes - a.bytes).map(row => `${row.name}: ${formatDiskBytes(row.bytes)}`).join("; ");
}

/** Durable occurrence and effect receipts keep overlapping readers and a
 * replacement Viewer from repeating the effects. The destinations also
 * deduplicate the episode, covering a commit followed by a lost receipt. */
export async function reconcileDiskPressure(input: DiskPressure, ports: DiskPressureActions): Promise<void> {
  const file = statePath("disk-pressure-actions.json");
  await withFileTransactionAsync(file, "disk pressure notices", async () => {
    let pressure = input;
    try {
      const latest = JSON.parse(fs.readFileSync(statePath("disk-pressure-report.json"), "utf8")) as DiskPressure;
      if (Date.parse(latest.at) >= Date.parse(input.at)) pressure = latest;
    } catch { /* The bounded observation is still useful when the disk cannot persist it. */ }
    let prior: Notice | null = null;
    try { prior = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* First episode. */ }
    if (!ports.active()) return;
    if (prior && prior.episode !== pressure.episode) {
      if (!await ports.card(prior.project, { ref: "seat-disk-pressure", kind: "disk-pressure", instance: prior.episode,
        state: "resolved", detail: "Місце на диску відновлено." }, pressure.at)) return;
      writeJsonDurably(file, null);
      prior = null;
    }
    if (!pressure.episode) return;
    const current = () => {
      if (!ports.active()) return false;
      try { return JSON.parse(fs.readFileSync(statePath("disk-pressure-report.json"), "utf8")).episode === pressure.episode; }
      catch { return true; }
    };
    const project = prior?.project ?? await ports.project();
    if (!current()) return;
    if (!project) return;
    const notice: Notice = prior ?? { project, episode: pressure.episode, card: false, report: false, lastSweepAt: 0 };
    const persist = () => writeJsonDurably(file, notice);
    const now = Date.parse(pressure.at);
    if (now - notice.lastSweepAt >= 15 * 60_000) {
      ports.early(); notice.lastSweepAt = now; persist();
    }
    if (!diskPressureWakeReady(pressure, now)) return;
    if (notice.card && notice.report && (!ports.cleaner || notice.cleanerTaskId)) return;
    const text = diskPressureNotice(pressure);
    if (!notice.card) {
      notice.card = await ports.card(project, { ref: "seat-disk-pressure", kind: "disk-pressure", instance: notice.episode,
        state: "open", detail: text }, pressure.at); persist();
    }
    if (!current()) return;
    if (!notice.report) {
      notice.report = await ports.report(project, notice.episode, text, pressure.at); persist();
    }
    const cleaner = ports.cleaner;
    if (!cleaner || !current()) return;
    if (!notice.cleaner) {
      const claimed = await cleaner.claimPressure(project, { ...pressure, episode: notice.episode }, current);
      if (!claimed || !current()) return;
      notice.cleaner = true;
      persist();
    }
    if (notice.cleanerTaskId) return;
    const taskId = cleaner.pressureCard(notice.episode);
    if (taskId && await ports.card(project, { ref: "seat-disk-pressure", kind: "disk-pressure", instance: notice.episode,
      state: "open", detail: `${text}\nКартка перевірки прибиральника — ${taskId}.` }, pressure.at) && current()) {
      notice.card = true;
      notice.cleanerTaskId = taskId;
      persist();
    }
  }, { waitMs: STATE_LOCK_WAIT_MS });
}

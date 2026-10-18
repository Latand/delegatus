import { effectiveCurationSetting, type EffectiveSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { redactMonitorText } from "@/lib/monitor/redact";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { roleMemoryEnabled } from "../settings";
import { curationPanelRuns, curationStatus, type CuratorPass } from "./store";

type Run = Pick<CuratorPass, "id" | "state" | "claimedAt" | "endedAt" | "conversationId" | "counts" | "failure">;
const summary = ({ id, state, claimedAt, endedAt, conversationId, counts, failure }: CuratorPass): Run =>
  ({ id, state, claimedAt, endedAt, conversationId, counts, failure: failure ? redactMonitorText(failure).slice(0, 300) : null });
export function curationAnswer(project: string, settings: EffectiveSeatTickSettings, now = Date.now()) {
  return withViewerOperation("memory.curation-panel", () => {
    const config = settings.curation ?? effectiveCurationSetting({ curation: settings.curationSetting });
    let live: Run | null = null, lastRun: Run | null = null, nextRunAt: string | null = null, runsError: string | null = null;
    let waitingOn: "off" | "wakes-off" | "memory-off" | "live-run" | "no-rules" | null = !config.enabled ? "off" : !settings.enabled ? "wakes-off" : !roleMemoryEnabled() ? "memory-off" : null;
    try {
      const runs = curationPanelRuns(project);
      live = runs.live ? summary(runs.live) : null;
      lastRun = runs.last ? summary(runs.last) : null;
      const status = curationStatus(project, now, config);
      waitingOn ??= live ? "live-run" : !status.active ? "no-rules" : null;
      nextRunAt = waitingOn ? null : status.nextAt;
    } catch (error) {
      runsError = redactMonitorText(error instanceof Error ? error.message : "curation run store unreadable").slice(0, 300);
    }
    return { ...config, defaultIntervalHours: 6, minIntervalHours: 1, maxIntervalHours: 168,
      updatedAt: settings.curationSetting?.updatedAt ?? null, live, lastRun, nextRunAt, waitingOn, runsError };
  });
}
export type CurationAnswer = ReturnType<typeof curationAnswer>;

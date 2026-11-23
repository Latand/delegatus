import { effectiveCurationSetting, effectiveSeatTickSettings, type EffectiveSeatTickSettings, type SeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { redactMonitorText } from "@/lib/monitor/redact";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { roleMemoryEnabled } from "../settings";
import { curationPanelRuns, curationPanelRunMetadata, curationPanelDataCooperatively, curationStatus, type CuratorPass } from "./store";

type Run = Pick<CuratorPass, "id" | "state" | "claimedAt" | "endedAt" | "conversationId" | "failure"> & { counts?: CuratorPass["counts"] };
const summary = ({ id, state, claimedAt, endedAt, conversationId, counts, failure }: CuratorPass, includeCounts: boolean): Run =>
  ({ id, state, claimedAt, endedAt, conversationId, ...(includeCounts ? { counts } : {}), failure: failure ? redactMonitorText(failure).slice(0, 300) : null });
function answer(project: string, settings: EffectiveSeatTickSettings, readStatus: () => ReturnType<typeof curationStatus> | undefined,
  readRuns: () => ReturnType<typeof curationPanelRunMetadata> = () => curationPanelRuns(project), deferred = false) {
  return withViewerOperation("memory.curation-panel", () => {
    const config = settings.curation ?? effectiveCurationSetting({ curation: settings.curationSetting });
    let live: Run | null = null, lastRun: Run | null = null, nextRunAt: string | null = null, runsError: string | null = null;
    let runsDeferred = deferred;
    let waitingOn: "off" | "wakes-off" | "memory-off" | "live-run" | "no-rules" | null = !config.enabled ? "off" : !settings.enabled ? "wakes-off" : !roleMemoryEnabled() ? "memory-off" : null;
    try {
      const runs = readRuns();
      runsDeferred = !!runs.lastDeferred;
      live = runs.live ? summary(runs.live, !deferred) : null;
      lastRun = runs.last ? summary(runs.last, !deferred) : null;
      waitingOn ??= live ? "live-run" : null;
      const status = readStatus();
      if (status) {
        waitingOn ??= !status.active ? "no-rules" : null;
        nextRunAt = waitingOn ? null : status.nextAt;
      }
    } catch (error) {
      runsError = redactMonitorText(error instanceof Error ? error.message : "curation run store unreadable").slice(0, 300);
    }
    const omissions = deferred ? [...(runsDeferred ? ["curation.lastRun"] : []),
      ...(live || lastRun ? ["curation.counts"] : []), ...(!waitingOn ? ["curation.nextRunAt"] : [])] : [];
    return { ...config, defaultIntervalHours: 6, minIntervalHours: 1, maxIntervalHours: 168,
      updatedAt: settings.curationSetting?.updatedAt ?? null, live, lastRun, nextRunAt, waitingOn, runsError,
      ...(omissions.length ? { partial: true as const, omissions } : {}) };
  });
}
export function curationAnswer(project: string, settings: EffectiveSeatTickSettings, now = Date.now()) {
  return answer(project, settings, () => curationStatus(project, now, settings.curation ?? effectiveCurationSetting({ curation: settings.curationSetting })));
}
export async function curationAnswerCooperatively(project: string, settings: EffectiveSeatTickSettings, now = Date.now(), signal?: AbortSignal) {
  const config = settings.curation ?? effectiveCurationSetting({ curation: settings.curationSetting });
  const data = await curationPanelDataCooperatively(project, now, config, signal);
  if ("error" in data) throw data.error;
  return answer(project, settings, () => data.status, () => data.runs);
}

/** Capture the useful part before cooperative work can consume the deadline.
 * Both callers share the same budget and retain controls edited mid-read. */
export async function readCurationPanel(project: string, initial: SeatTickSettings,
  readSettings: (project: string) => SeatTickSettings, options: { budget: number; wakeIntervalMs: number; signal?: AbortSignal; now?: () => number }) {
  options.signal?.throwIfAborted();
  const deadline = performance.now() + options.budget;
  const wallDeadline = Date.now() + options.budget;
  const base = (() => {
    try { return { runs: withViewerOperation("memory.curation-panel.metadata", () => curationPanelRunMetadata(project)) }; }
    catch (error) { return { error }; }
  })();
  const timer = new AbortController();
  const request = options.signal ? AbortSignal.any([options.signal, timer.signal]) : timer.signal;
  const cancel = setTimeout(() => timer.abort(Error("curation panel read timed out")), Math.max(0, deadline - performance.now()));
  const now = options.now ?? Date.now;
  const describe = (settings: SeatTickSettings) => {
    const at = now();
    return { settings, now: at, effective: effectiveSeatTickSettings(settings, at, options.wakeIntervalMs) };
  };
  let controls = describe(initial), error: unknown;
  const expired = () => timer.signal.aborted || Date.now() >= wallDeadline || performance.now() >= deadline;
  try {
    for (let attempt = 0; attempt < 3 && !expired() && !("error" in base); attempt++) {
      let curation: CurationAnswer | undefined;
      try { curation = await curationAnswerCooperatively(project, controls.effective, controls.now, request); }
      catch (failure) { if (!expired()) error = failure; }
      options.signal?.throwIfAborted();
      const settings = readSettings(project);
      if (JSON.stringify(settings) === JSON.stringify(controls.settings)) {
        if (curation && !expired()) return { ...controls, curation };
        break;
      }
      controls = describe(settings);
    }
    options.signal?.throwIfAborted();
    return { ...controls, curation: answer(project, controls.effective, () => {
      if (expired()) throw Error("curation panel read timed out");
      if (error) throw error;
      return undefined;
    },
      () => { if ("error" in base) throw base.error; return base.runs; }, true) };
  } finally {
    clearTimeout(cancel);
    timer.abort();
  }
}
export type CurationAnswer = ReturnType<typeof curationAnswer>;

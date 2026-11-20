import type { launchAutonomousConversation, SpawnedTurnObservation } from "@/lib/agent/autonomousConversation";
import { statePath } from "@/lib/configDir";
import { redactBounded } from "@/lib/monitor/redact";
import { operatorLocale } from "@/lib/operator/settings";
import { activeDrain } from "@/lib/selfUpdate/drain";
import type { DiskPressure } from "@/lib/state/diskPressure";
import { waitForStateLock } from "@/lib/state/lockWait";
import { createTask, patchTask } from "@/lib/tasks/commands";
import { loadPrototypeTask, mutateTasksFile, withTaskPreparation } from "@/lib/tasks/store";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { cleanerBrief, cleanerDiskEvidence } from "./brief";
import {
  activeCleanerRun, claimCleanerRun, cleanerDailyDue, cleanerPressureRun,
  pendingCleanerCard, previousCleanerRun, readCleanerRun, recordCleanerCardAttempt, updateActiveCleanerRun, CLEANER_RUN_TIMEOUT_MS, type CleanerRun,
} from "./store";
import { cleanerCardDetails, cleanerCardText, parseCleanerReport, type CleanerReport } from "./text";

const REPLY_TIMEOUT_MS = 10_000;

type CleanerPorts = {
  launch: typeof launchAutonomousConversation;
  observe?: (run: CleanerRun) => Promise<SpawnedTurnObservation>;
  now?: () => number;
  cwd?: string;
  ownsTraffic?: () => boolean;
  draining?: () => boolean;
  enabled?: () => boolean;
};

class CleanerAdmissionHeld extends Error {}

async function boundedReply<T>(operation: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), REPLY_TIMEOUT_MS); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeCard(run: CleanerRun, allowed: () => boolean): Promise<boolean> {
  const file = statePath("tasks.json");
  return withTaskPreparation(() => waitForStateLock("cleaner.card", () => mutateTasksFile(state => {
    if (!allowed()) return { state: undefined, result: false };
    const task = loadPrototypeTask(run.taskId, file);
    const locale = operatorLocale() ?? "uk";
    const details = cleanerCardDetails(run, locale);
    if (run.settledAt) {
      const status = run.failure ? "blocked" : "done";
      if (!task) {
        const created = createTask(state.tasks, {
          project: run.project, text: cleanerCardText(run, locale), details,
          icon: "brush-cleaning", color: "slate", placement: "unplaced", clientRequestId: run.runId,
        }, state.recentCreates, { now: () => run.claimedAt, id: () => run.taskId, allowBoardOverflow: true });
        if (!created.ok) throw new Error(created.error);
        const terminal = patchTask(created.tasks, run.taskId, { status, details }, run.settledAt, { allowBoardOverflow: true });
        if (!terminal.ok) throw new Error(terminal.error);
        return { state: { ...state, tasks: terminal.tasks, recentCreates: created.recentCreates }, result: true };
      }
      if (task.status === status && task.details === details) return { state: undefined, result: true };
      const result = patchTask(state.tasks, run.taskId, { status, details }, run.settledAt, { allowBoardOverflow: true });
      if (!result.ok) throw new Error(result.error);
      return { state: { ...state, tasks: result.tasks }, result: true };
    }
    if (task) return { state: undefined, result: true };
    const result = createTask(state.tasks, {
      project: run.project, text: cleanerCardText(run, locale), details,
      icon: "brush-cleaning", color: "slate", placement: "unplaced", clientRequestId: run.runId,
    }, state.recentCreates, { now: () => run.claimedAt, id: () => run.taskId, allowBoardOverflow: true });
    if (!result.ok) throw new Error(result.error);
    return { state: { tasks: result.tasks, recentCreates: result.recentCreates }, result: true };
  }, file), { subject: "tasks" }));
}

/** Construction requires a launcher. The Viewer supplies one when the
 * guarded tools are available. Until then the watch only records pressure. */
export function createCleanerController(ports: CleanerPorts) {
  const now = ports.now ?? Date.now;
  const ownsTraffic = ports.ownsTraffic ?? viewerReleaseOwnsTraffic;
  const draining = ports.draining ?? (() => !!activeDrain(undefined, now()));
  const enabled = ports.enabled ?? (() => process.env.LLV_CLEANER !== "off");
  const allowed = () => ownsTraffic() && enabled() && !draining();
  const cwd = ports.cwd ?? process.cwd();
  const expired = (run: CleanerRun) => now() - Date.parse(run.launchedAt ?? run.claimedAt) >= CLEANER_RUN_TIMEOUT_MS;
  const observe = ports.observe ?? (async (run: CleanerRun) => {
    const [{ observeSpawnedTurn }, { defaultSeatTickSources }] = await Promise.all([
      import("@/lib/agent/autonomousConversation"), import("@/lib/monitor/seatTickSources"),
    ]);
    // An absent receipt can be the crash before reservation. Keep its replay
    // window open until the controller deadline.
    return observeSpawnedTurn({ ...run, clientAttemptId: run.runId }, { ...defaultSeatTickSources(), now }, undefined, Number.POSITIVE_INFINITY);
  });

  const settle = (run: CleanerRun, failure: CleanerRun["failure"], options: {
    report?: CleanerReport | null; observed?: SpawnedTurnObservation; unadmittedOnly?: boolean;
  } = {}) =>
    updateActiveCleanerRun(run.runId, ownsTraffic, current => {
      if (current.settledAt) {
        if (!options.observed || (options.observed.state !== "ended" && !(options.observed.state === "failed" && options.observed.quiescent))) return null;
        return {
          ...current,
          ...observedBinding(current, options.observed),
          quiescedAt: current.quiescedAt ?? new Date(now()).toISOString(),
        };
      }
      if (options.unadmittedOnly && (current.launchAcknowledged || current.launchId || current.conversationId)) return null;
      const quiescent = !current.launchedAt || options.unadmittedOnly === true
        || options.observed?.state === "ended" || (options.observed?.state === "failed" && options.observed.quiescent === true);
      return {
        ...current, ...(options.observed ? observedBinding(current, options.observed) : {}),
        settledAt: new Date(now()).toISOString(), report: options.report ?? null,
        quiescedAt: quiescent ? new Date(now()).toISOString() : current.quiescedAt ?? null,
        failure: failure ? { kind: failure.kind, detail: redactBounded(failure.detail, 300) } : null,
      };
    });
  const timeOut = (run: CleanerRun) => settle(run, { kind: "timed-out", detail: "Cleaner run reached its 90-minute deadline." });

  async function dispatch(run: CleanerRun): Promise<void> {
    const canDispatch = () => {
      if (!allowed()) return false;
      const current = readCleanerRun(run.runId);
      return !!current && !current.settledAt && !current.launchAcknowledged && !expired(current);
    };
    if (!canDispatch()) return;
    if (!run.launchBody && !await writeCard(run, canDispatch)) return;
    const previous = run.launchBody ? null : previousCleanerRun(run.runId);
    const prepared = await updateActiveCleanerRun(run.runId, allowed, current =>
      current.launchAcknowledged || expired(current) || current.launchBody ? null : {
        ...current,
        launchBody: {
          role: "cleaner", roleParams: { mode: "disk" }, cwd: current.cwd, project: current.project,
          taskId: current.taskId, clientAttemptId: current.runId, prompt: cleanerBrief(current, previous),
          mcpServers: ["viewer"], notifyLauncher: false,
        },
        launchedAt: new Date(now()).toISOString(),
      });
    if (!prepared?.launchBody || !canDispatch()) return;
    const authorize = () => {
      if (!canDispatch()) throw new CleanerAdmissionHeld("cleaner launch admission is held");
    };
    let response: Awaited<ReturnType<typeof launchAutonomousConversation>> | null;
    try {
      response = await boundedReply(ports.launch(prepared.launchBody, authorize, { structured: true }));
    } catch (error) {
      if (error instanceof CleanerAdmissionHeld) return;
      // The reservation may already have committed. Keep the same body.
      console.warn("[cleaner] launch reply unavailable", error instanceof Error ? error.name : "unknown");
      return;
    }
    if (!response || !ownsTraffic()) return;
    const { status, body } = response;
    if (body.code === "AUTO_UPDATE_DRAIN" || body.retryable === true || status >= 500) return;
    const failedReceipt = body.state === "failed" || body.state === "conflict";
    if (status < 200 || status >= 300 || failedReceipt) {
      await settle(prepared, { kind: "launch-refused", detail: String(body.error ?? body.code ?? "Launch refused.") },
        { unadmittedOnly: !failedReceipt });
      return;
    }
    await updateActiveCleanerRun(run.runId, ownsTraffic, current => ({
      ...current,
      launchAcknowledged: current.launchAcknowledged || body.launched === true,
      launchId: current.launchId ?? stringOrNull(body.launchId),
      conversationId: current.conversationId ?? stringOrNull(body.conversationId),
      transcriptPath: current.transcriptPath ?? stringOrNull(body.path),
    }));
  }

  async function reconcileRun(run: CleanerRun): Promise<void> {
    if (!run.launchedAt) {
      if (expired(run)) await timeOut(run);
      else await dispatch(run);
      return;
    }
    let observed: SpawnedTurnObservation | null;
    try { observed = await boundedReply(observe(run)); }
    catch (error) {
      if (!expired(run)) throw error;
      observed = null;
    }
    if (!ownsTraffic()) return;
    // The launch body is durable before reservation. At the deadline, an
    // authoritative registry read showing no receipt proves no queued launch
    // can still execute; the queued actuator independently checks this run.
    if (expired(run) && !run.launchAcknowledged && !run.launchId && !run.conversationId) {
      const [{ defaultSeatTickSources }] = await Promise.all([import("@/lib/monitor/seatTickSources")]);
      const receipt = defaultSeatTickSources().registry().spawnReceiptForClientAttempt(run.runId);
      if (!receipt) {
        await settle(run, { kind: "timed-out", detail: "Cleaner launch was not reserved before its 90-minute deadline." }, { unadmittedOnly: true });
        return;
      }
    }
    if (run.settledAt) {
      if (observed?.state === "ended" || (observed?.state === "failed" && observed.quiescent)) {
        await updateActiveCleanerRun(run.runId, ownsTraffic, current => ({
          ...current, ...observedBinding(current, observed), quiescedAt: new Date(now()).toISOString(),
        }));
      }
      return;
    }
    if (observed?.state === "ended") {
      const report = parseCleanerReport(observed.finalText ?? "");
      const failure = observed.turnError ? { kind: "turn-error", detail: observed.turnError }
        : report?.verdict === "pass" ? null
          : { kind: report?.verdict ?? "invalid-report", detail: report?.notes || "Cleaner did not return a passing report." };
      if (!cleanerCompletionIsOnTime(run.launchedAt ?? run.claimedAt, observed.completedAt)) {
        await settle(run, { kind: "timed-out", detail: "Cleaner run reached its 90-minute deadline." }, { observed });
      } else {
        await settle(run, failure, { report, observed });
      }
    } else if (observed?.state === "failed") {
      await settle(run, observed.failure ?? { kind: "launch-failed", detail: "Launch failed." }, { observed });
    } else if (expired(run)) {
      await timeOut(run);
    } else if (observed) {
      if (observed.conversationId || observed.launchId || observed.path) {
        await updateActiveCleanerRun(run.runId, ownsTraffic, current => ({ ...current, ...observedBinding(current, observed) }));
      }
      if (!run.launchAcknowledged) await dispatch(run);
    }
  }

  return {
    async claimPressure(project: string, pressure: DiskPressure & { episode: string }, current: () => boolean) {
      const result = await claimCleanerRun({
        project, cwd, now, episode: pressure.episode, evidence: cleanerDiskEvidence(pressure),
        allowed: () => allowed() && current(),
      });
      return result !== "held";
    },
    pressureCard(episode: string): string | null {
      const run = cleanerPressureRun(episode);
      if (!run) return null;
      return loadPrototypeTask(run.taskId, statePath("tasks.json")) ? run.taskId : null;
    },
    async launchCleanerIfDue(project: () => Promise<string | null>, trafficSince: number | (() => number), pressure: DiskPressure | null): Promise<void> {
      const currentTrafficSince = () => typeof trafficSince === "function" ? trafficSince() : trafficSince;
      if (!allowed() || activeCleanerRun() || !cleanerDailyDue(now(), currentTrafficSince())) return;
      const ownProject = await project();
      if (!ownProject) return;
      const claimed = await claimCleanerRun({ project: ownProject, cwd, now, trafficSince: currentTrafficSince, allowed, evidence: cleanerDiskEvidence(pressure) });
      if (typeof claimed !== "string") await dispatch(claimed);
    },
    async reconcile(): Promise<void> {
      if (!ownsTraffic()) return;
      try {
        const run = activeCleanerRun();
        if (run) await reconcileRun(run);
      } finally {
        const pending = ownsTraffic() ? pendingCleanerCard() : null;
        if (pending) {
          let completed = false;
          try { completed = await writeCard(pending, ownsTraffic); }
          finally { await recordCleanerCardAttempt(pending.runId, ownsTraffic, completed); }
        }
      }
    },
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function observedBinding(run: CleanerRun, observed: SpawnedTurnObservation) {
  return {
    conversationId: run.conversationId ?? observed.conversationId ?? null,
    launchId: run.launchId ?? observed.launchId ?? null,
    transcriptPath: run.transcriptPath ?? observed.path ?? null,
  };
}

export type CleanerController = ReturnType<typeof createCleanerController>;

export function cleanerCompletionIsOnTime(launchedAt: string, completedAt: string | null | undefined): boolean {
  const deadline = Date.parse(launchedAt) + CLEANER_RUN_TIMEOUT_MS;
  const completed = Date.parse(completedAt ?? "");
  return Number.isFinite(completed) && completed <= deadline;
}

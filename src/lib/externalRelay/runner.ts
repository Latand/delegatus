import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import { procBackend } from "@/lib/proc";
import {
  runEphemeralAgent,
  EphemeralProfileError,
} from "@/lib/agent/ephemeral";
import type { HeadlessReviewRuntime } from "@/lib/agent/headless";
import { relayCall, ExternalRelayError } from "./client";
import {
  answerSchema,
  checkedAnswer,
  requestSchema,
  type ExternalRelayCompletion,
  type ExternalRelayProgress,
  type ExternalRelayRequest,
} from "./protocol";
import { answerPrompt } from "./prompt";
import { progressForEvent } from "./progress";
import {
  changeRun,
  dropRun,
  reserveRun,
  readRunLedger,
  type PairedRelay,
  type RelayTargetSettings,
} from "./store";

const globalRelay = globalThis as typeof globalThis & {
  __llvExternalRelayActive?: Map<string, number>;
};
const active = (globalRelay.__llvExternalRelayActive ??= new Map<string, number>());
export function externalRelayTempRoot(): string {
  const temporary = path.resolve(os.tmpdir());
  const home = path.resolve(os.homedir());
  return temporary === home || temporary.startsWith(home + path.sep)
    ? "/tmp"
    : temporary;
}
const countKey = (relayId: string, targetId: string) =>
  `${relayId}:${targetId}`;
export function runningCount(relayId: string, targetId: string): number {
  return active.get(countKey(relayId, targetId)) ?? 0;
}
export function advertisedSlots(
  relay: PairedRelay,
): { target_id: string; free: number }[] {
  const held = readRunLedger().runs;
  return relay.targets
    .filter((target) => target.enabled && target.engine && target.model)
    .map((target) => ({
      target_id: target.id,
      free: Math.max(
        0,
        target.concurrency -
          Math.max(
            runningCount(relay.id, target.id),
            held.filter(
              (run) => run.relayId === relay.id && run.targetId === target.id,
            ).length,
          ),
      ),
    }));
}
function markActive(relay: PairedRelay, target: RelayTargetSettings): void {
  const key = countKey(relay.id, target.id);
  const count = active.get(key) ?? 0;
  active.set(key, count + 1);
}
function free(relay: PairedRelay, target: RelayTargetSettings) {
  const key = countKey(relay.id, target.id);
  active.set(key, Math.max(0, (active.get(key) ?? 1) - 1));
}
const declined = (
  lease_id: string,
  reason: string,
  retry_after_s: number | null = null,
): ExternalRelayCompletion => ({
  lease_id,
  outcome: "declined",
  reason,
  detail: null,
  retry_after_s,
});
const failed = (lease_id: string, reason: string): ExternalRelayCompletion => ({
  lease_id,
  outcome: "failed",
  reason,
  detail: null,
});
async function complete(
  relay: PairedRelay,
  requestId: string,
  body: ExternalRelayCompletion,
  lastHeartbeat: () => number,
  stallMs: number,
): Promise<ExternalRelayCompletion> {
  let wait = 1000;
  while (true) {
    try {
      await relayCall(
        relay.api_base,
        `/requests/${encodeURIComponent(requestId)}/complete`,
        "POST",
        body,
        relay.credential,
        { timeoutMs: 5000, maxBytes: relay.limits.max_response_bytes },
      );
      return body;
    } catch (error) {
      if (error instanceof ExternalRelayError) {
        if (error.status === 413 && body.outcome === "answered") {
          body = failed(body.lease_id, "invalid_answer");
          continue;
        }
        if ([400, 401, 404, 409, 413, 426].includes(error.status)) return body;
      }
      if (Date.now() - lastHeartbeat() > stallMs) return body;
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, 5000);
    }
  }
}
export async function runClaimedRequest(
  relay: PairedRelay,
  raw: unknown,
  onFreed?: () => void,
  runtime?: HeadlessReviewRuntime & { timeoutMs?: number },
): Promise<ExternalRelayCompletion | null> {
  const parsed = requestSchema.safeParse(raw);
  const request = parsed.success ? parsed.data : null;
  const rawId =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>).request_id
      : null;
  const rawLease =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>).lease_id
      : null;
  if (!request && (typeof rawId !== "string" || typeof rawLease !== "string"))
    return null;
  const requestId = request?.request_id ?? (rawId as string);
  const leaseId = request?.lease_id ?? (rawLease as string);
  let heartbeatAt = Date.now();
  const finish = async (body: ExternalRelayCompletion, stallMs = 45_000) => {
    return complete(relay, requestId, body, () => heartbeatAt, stallMs);
  };
  if (readRunLedger().runs.some((run) => run.requestId === requestId)) return null;
  if (!request)
    return finish(
      declined(
        leaseId,
        raw && typeof raw === "object" &&
          typeof (raw as Record<string, unknown>).kind === "string" &&
          (raw as Record<string, unknown>).kind !== "answer"
          ? "unsupported_kind"
          : "invalid_request",
      ),
    );
  const target = relay.targets.find((item) => item.id === request.target_id);
  if (!target || !target.engine || !target.model)
    return finish(declined(leaseId, "not_configured"));
  if (relay.paused || !target.enabled)
    return finish(declined(leaseId, "disabled"));
  let runDir: string | null = null;
  let recorded = false;
  let run: ReturnType<typeof runEphemeralAgent> | null = null;
  let runFinished = false;
  const identityTimers: ReturnType<typeof setTimeout>[] = [];
  try {
    runDir = fs.mkdtempSync(
      path.join(externalRelayTempRoot(), "llv-external-relay-"),
    );
    const ownerIdentity = procBackend.processIdentity(process.pid);
    if (!ownerIdentity) throw new Error("viewer process identity unavailable");
    const record = {
      requestId,
      leaseId,
      relayId: relay.id,
      targetId: target.id,
      childPid: null,
      childIdentity: null,
      ownerPid: process.pid,
      ownerIdentity,
      runDir,
      startedAt: new Date().toISOString(),
    };
    const admission = reserveRun(record, target.concurrency);
    if (admission === "duplicate") return null;
    if (admission === "full") return await finish(declined(leaseId, "busy"));
    recorded = true;
    markActive(relay, target);
    const selection = accountManager.resolveHeadlessSpawn(
      target.engine,
      null,
      [],
      target.project,
      target.model,
    );
    if (selection.kind !== "available")
      return await finish(
        declined(
          leaseId,
          "no_capacity",
          selection.kind === "exhausted" && selection.resetsAt
            ? Math.max(0, selection.resetsAt - Math.floor(Date.now() / 1000))
            : null,
        ),
      );
    let newestProgress: ExternalRelayProgress | null = null;
    let leaseUnavailable = false;
    let beatBusy = false;
    let pendingBeat: Promise<void> | null = null;
    let seq = 0;
    let nextBeatAt = 0;
    const started = Date.now();
    try {
      run = runEphemeralAgent({
        key: `external-relay:${requestId}`,
        engine: target.engine,
        model: target.model,
        effort: target.effort,
        account: selection.account,
        ["prompt"]: answerPrompt(request),
        schema: answerSchema,
        runDir,
        hardCapMs: target.hardCapMinutes * 60_000,
        runtime,
        onEvent: (event) => {
          const progress = progressForEvent(event);
          if (progress && request.answer.progress === "notes")
            newestProgress = progress;
        },
      });
      void run.done.then(() => { runFinished = true; });
    } catch (error) {
      if (error instanceof EphemeralProfileError)
        return await finish(declined(leaseId, "profile_error"));
      throw error;
    }
    const launchedRun = run;
    if (!launchedRun) throw new Error("external relay launch unavailable");
    changeRun(requestId, (current) => ({
      ...current,
      childPid: launchedRun.pid,
      childIdentity: launchedRun.identity,
    }));
    if (launchedRun.pid && !launchedRun.identity)
      for (const delay of [100, 500, 2000]) {
        const timer = setTimeout(() => {
          const identity = procBackend.processIdentity(launchedRun.pid!);
          if (identity)
            changeRun(requestId, (current) => ({
              ...current,
              childIdentity: identity,
            }));
        }, delay);
        timer.unref();
        identityTimers.push(timer);
      }
    const stallMs = request.liveness.stall_window_s * 1000;
    const cancelStalledRun = () => {
      if (!leaseUnavailable && Date.now() - heartbeatAt > stallMs) {
        leaseUnavailable = true;
        launchedRun.cancel();
      }
    };
    const beat = async () => {
      if (beatBusy || leaseUnavailable) return;
      beatBusy = true;
      try {
        const sentProgress = newestProgress;
        await relayCall(
          relay.api_base,
          `/requests/${encodeURIComponent(requestId)}/heartbeat`,
          "POST",
          { lease_id: leaseId, seq: ++seq, progress: sentProgress },
          relay.credential,
          { timeoutMs: 5000, maxBytes: relay.limits.max_response_bytes },
        );
        if (newestProgress === sentProgress) newestProgress = null;
        heartbeatAt = Date.now();
        nextBeatAt = heartbeatAt + request.liveness.heartbeat_interval_s * 1000;
      } catch (error) {
        if (
          error instanceof ExternalRelayError &&
          (error.status === 404 ||
            (error.status === 409 && error.code === "lease_lost"))
        ) {
          leaseUnavailable = true;
          launchedRun.cancel();
        }
      } finally {
        if (nextBeatAt <= Date.now()) nextBeatAt = Date.now() + 1000;
        beatBusy = false;
        cancelStalledRun();
      }
    };
    pendingBeat = beat();
    await pendingBeat;
    const timer = setInterval(() => {
      if (!beatBusy) cancelStalledRun();
      if (!beatBusy && !leaseUnavailable && Date.now() >= nextBeatAt)
        pendingBeat = beat();
    }, 1000);
    timer.unref();
    let result;
    try {
      result = await launchedRun.done;
    } finally {
      clearInterval(timer);
    }
    if (pendingBeat) await pendingBeat;
    cancelStalledRun();
    if (leaseUnavailable) return null;
    const completion =
      result.status === "done" ? checkedAnswer(result.answer, request) : null;
    const body = completion
      ? {
          lease_id: leaseId,
          outcome: "answered" as const,
          answer: completion,
          duration_ms: Date.now() - started,
        }
      : failed(
          leaseId,
          result.status === "violation"
            ? "profile_violation"
            : result.status === "timeout"
              ? "hard_cap"
              : result.status === "done"
                ? "invalid_answer"
                : result.status === "cancelled"
                  ? "cancelled"
                  : "agent_error",
        );
    return await finish(body, request.liveness.stall_window_s * 1000);
  } catch {
    if (run) {
      if (!runFinished) run.cancel();
      await run.done;
    }
    return await finish(
      failed(leaseId, "agent_error"),
      request.liveness.stall_window_s * 1000,
    );
  } finally {
    for (const timer of identityTimers) clearTimeout(timer);
    try {
      if (recorded) dropRun(requestId);
    } catch (error) {
      console.error("External relay run ledger cleanup failed", error instanceof Error ? error.name : "unknown");
    }
    try {
      if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
    } catch (error) {
      console.error("External relay run directory cleanup failed", error instanceof Error ? error.name : "unknown");
    }
    if (recorded) free(relay, target);
    onFreed?.();
  }
}

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
  putRun,
  type PairedRelay,
  type RelayTargetSettings,
} from "./store";

const active = new Map<string, number>();
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
  return relay.targets
    .filter((target) => target.enabled && target.engine && target.model)
    .map((target) => ({
      target_id: target.id,
      free: Math.max(0, target.concurrency - runningCount(relay.id, target.id)),
    }));
}
function reserve(relay: PairedRelay, target: RelayTargetSettings): boolean {
  const key = countKey(relay.id, target.id);
  const count = active.get(key) ?? 0;
  if (count >= target.concurrency) return false;
  active.set(key, count + 1);
  return true;
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
): Promise<void> {
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
      return;
    } catch (error) {
      if (
        error instanceof ExternalRelayError &&
        [400, 401, 404, 409, 413, 426].includes(error.status)
      )
        return;
      if (Date.now() - lastHeartbeat() > stallMs) return;
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, 5000);
    }
  }
}
export async function runClaimedRequest(
  relay: PairedRelay,
  raw: unknown,
  onFreed?: () => void,
  runtime?: HeadlessReviewRuntime,
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
    await complete(relay, requestId, body, () => heartbeatAt, stallMs);
    return body;
  };
  if (!request) return finish(declined(leaseId, "invalid_request"));
  const target = relay.targets.find((item) => item.id === request.target_id);
  if (!target || !target.engine || !target.model)
    return finish(declined(leaseId, "not_configured"));
  if (relay.paused || !target.enabled)
    return finish(declined(leaseId, "disabled"));
  if (!reserve(relay, target)) return finish(declined(leaseId, "busy"));
  let runDir: string | null = null;
  let recorded = false;
  const identityTimers: ReturnType<typeof setTimeout>[] = [];
  try {
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
            ? Math.max(0, Math.ceil((selection.resetsAt - Date.now()) / 1000))
            : null,
        ),
      );
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
    if (!putRun(record)) return await finish(declined(leaseId, "busy"));
    recorded = true;
    let newestProgress: ExternalRelayProgress | null = null;
    let leaseLost = false;
    let beatBusy = false;
    let seq = 0;
    let nextBeatAt = 0;
    const started = Date.now();
    let run: ReturnType<typeof runEphemeralAgent>;
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
    } catch (error) {
      if (error instanceof EphemeralProfileError)
        return await finish(declined(leaseId, "profile_error"));
      throw error;
    }
    changeRun(requestId, (current) => ({
      ...current,
      childPid: run.pid,
      childIdentity: run.identity,
    }));
    if (run.pid && !run.identity)
      for (const delay of [100, 500, 2000]) {
        const timer = setTimeout(() => {
          const identity = procBackend.processIdentity(run.pid!);
          if (identity)
            changeRun(requestId, (current) => ({
              ...current,
              childIdentity: identity,
            }));
        }, delay);
        timer.unref();
        identityTimers.push(timer);
      }
    const beat = async () => {
      if (beatBusy || leaseLost) return;
      beatBusy = true;
      try {
        await relayCall(
          relay.api_base,
          `/requests/${encodeURIComponent(requestId)}/heartbeat`,
          "POST",
          { lease_id: leaseId, seq: ++seq, progress: newestProgress },
          relay.credential,
          { timeoutMs: 5000, maxBytes: relay.limits.max_response_bytes },
        );
        newestProgress = null;
        heartbeatAt = Date.now();
        nextBeatAt = heartbeatAt + request.liveness.heartbeat_interval_s * 1000;
      } catch (error) {
        if (
          error instanceof ExternalRelayError &&
          error.status === 409 &&
          error.code === "lease_lost"
        ) {
          leaseLost = true;
          run.cancel();
        }
      } finally {
        if (nextBeatAt <= Date.now()) nextBeatAt = Date.now() + 1000;
        beatBusy = false;
      }
    };
    await beat();
    const timer = setInterval(() => {
      if (Date.now() >= nextBeatAt) void beat();
    }, 1000);
    timer.unref();
    let result;
    try {
      result = await run.done;
    } finally {
      clearInterval(timer);
    }
    if (leaseLost) return null;
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
    return await finish(
      failed(leaseId, "agent_error"),
      request.liveness.stall_window_s * 1000,
    );
  } finally {
    for (const timer of identityTimers) clearTimeout(timer);
    if (recorded) dropRun(requestId);
    if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
    free(relay, target);
    onFreed?.();
  }
}

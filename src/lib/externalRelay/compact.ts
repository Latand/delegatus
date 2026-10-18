import { compactCompletionSchema } from "./protocol";
export function checkedCompactCompletion(value: unknown, kind = "compact") {
  if (kind !== "compact") return null;
  const parsed = compactCompletionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

import fs from "node:fs";
import path from "node:path";
import { activeDrain } from "@/lib/selfUpdate/drain";
import { procBackend } from "@/lib/proc";
import type { HeadlessReviewRuntime } from "@/lib/agent/headless";
import { relayCall, ExternalRelayError, isUnknownFeatureRefusal } from "./client";
import { completeRelayRequest, externalRelayTempRoot } from "./runner";
import { reserveRunAsync, dropRunAsync, readRunLedger, type PairedRelay } from "./store";
import { answerRecorder } from "./answers";
import { answerProfileFor } from "./profile";
import { type CompactRequest, type ExternalRelayCompletion } from "./protocol";
export async function runCompactRequest(relay: PairedRelay, request: CompactRequest, onFreed?: () => void, runtime?: HeadlessReviewRuntime & { timeoutMs?: number; onUnknownFeature?: () => Promise<unknown> }): Promise<ExternalRelayCompletion | null> {
  const started = Date.now(); const requestId = request.request_id; const lease_id = request.lease_id;
  if (readRunLedger().runs.some((r) => r.requestId === requestId)) return null;
  const target = relay.targets.find((t) => t.id === request.target_id);
  const recorder = answerRecorder({ requestId, relayId: relay.id, targetId: request.target_id, targetName: target?.name ?? null, claimedAt: request.claimed_at, chatKey: request.chat.key, requester: request.input.requester, input: request.input });
  let heartbeatAt = started; const stallMs = request.liveness.stall_window_s * 1000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lost = false, beating = false; let pending: Promise<void> | null = null; let seq = 0; let nextBeat = 0;
  let dir: string | null = null, admitted = false;
  const compaction = { member: "untouched", owner: "untouched" };
  const finish = async (body: ExternalRelayCompletion) => {
    const checked = checkedCompactCompletion(body); if (!checked) throw new Error("invalid compact completion");
    recorder?.finish({ outcome: `${body.outcome}:${"reason" in body ? body.reason : ""}`, answer: null, delivery: "unconfirmed", compaction });
    const sent = await completeRelayRequest(relay, requestId, checked, () => heartbeatAt + stallMs, undefined, runtime?.onUnknownFeature);
    recorder?.recordDelivery({ outcome: `${sent.body.outcome}:${"reason" in sent.body ? sent.body.reason : ""}`, delivery: sent.delivery });
    return sent.body;
  };
  const decline = (reason: string, detail: string | null = null, retry_after_s: number | null = null) => finish({ lease_id, outcome: "declined", reason, detail, retry_after_s });
  const fail = (reason: string) => finish({ lease_id, outcome: "failed", reason, detail: null });
  const lose = () => { lost = true; };
  const beat = async () => {
    if (beating || lost) return; beating = true;
    try { await relayCall(relay.api_base, `/requests/${encodeURIComponent(requestId)}/heartbeat`, "POST", { lease_id, seq: ++seq, progress: null }, relay.credential); heartbeatAt = Date.now(); nextBeat = heartbeatAt + request.liveness.heartbeat_interval_s * 1000; }
    catch (error) {
      if (isUnknownFeatureRefusal(error)) await runtime?.onUnknownFeature?.();
      if (error instanceof ExternalRelayError && (error.status === 404 || error.status === 409 && error.code === "lease_lost")) lose();
    }
    finally { beating = false; if (Date.now() - heartbeatAt > stallMs) lose(); }
  };
  if (!target?.engine || !target.model) return decline("not_configured");
  if (relay.paused || !target.enabled) return decline("disabled");
  if (activeDrain()) return decline("busy");
  if (!request.input.requester.is_owner && !request.input.requester.is_admin) return decline("invalid_request");
  try {
    dir = fs.mkdtempSync(path.join(externalRelayTempRoot(), "llv-external-relay-"));
    const ownerIdentity = procBackend.processIdentity(process.pid); if (!ownerIdentity) return fail("agent_error");
    const admission = await reserveRunAsync({ requestId, leaseId: lease_id, relayId: relay.id, targetId: target.id, childPid: null, childIdentity: null, ownerPid: process.pid, ownerIdentity, runDir: dir, startedAt: new Date(started).toISOString() }, target.concurrency, Date.now() + 5000);
    if (admission === "duplicate") return null;
    if (admission === "full") return decline("busy");
    admitted = true; recorder?.begin(target.engine, target.model, answerProfileFor(request.input.requester));
    // The acknowledgement precedes even creation of conversation records.
    while (!lost) { await beat(); if (heartbeatAt > started || seq > 0 && nextBeat > 0) break; await Bun.sleep(1000); }
    if (lost) return null;
    timer = setInterval(() => { if (!beating && Date.now() - heartbeatAt > stallMs) lose(); if (!beating && Date.now() >= nextBeat) pending = beat(); }, 1000); timer.unref();
    return await finish({ lease_id, outcome: "compacted", reason: "nothing_to_compact", detail: null, duration_ms: Date.now() - started });
  } catch { if (lost) return null; return fail("agent_error"); }
  finally {
    if (timer) clearInterval(timer);
    if (pending) await pending;
    if (admitted) await dropRunAsync(requestId, Date.now() + 5000);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (recorder?.begun && !recorder.finished) recorder.finish({ outcome: "lease_lost", answer: null, delivery: null, compaction });
    onFreed?.();
  }
}

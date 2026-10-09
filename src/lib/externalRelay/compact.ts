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
import { accountManager } from "@/lib/accounts/manager";
import { runEphemeralAgent, EphemeralProfileError } from "@/lib/agent/ephemeral";
import type { HeadlessReviewRuntime } from "@/lib/agent/headless";
import { relayCall, ExternalRelayError } from "./client";
import { completeRelayRequest, externalRelayTempRoot } from "./runner";
import { reserveRun, dropRun, changeRun, readRunLedger, type PairedRelay } from "./store";
import { readConversations, reserveConversations, releaseConversation, resetConversation, prepareConversationAccount, conversationCodexHome } from "./conversations";
import { answerRecorder } from "./answers";
import { answerProfileFor } from "./profile";
import { answerSchema, type CompactRequest, type ExternalRelayCompletion, type CompactReason } from "./protocol";
export async function runCompactRequest(relay: PairedRelay, request: CompactRequest, onFreed?: () => void, runtime?: HeadlessReviewRuntime & { timeoutMs?: number }): Promise<ExternalRelayCompletion | null> {
  const started = Date.now(); const requestId = request.request_id; const lease_id = request.lease_id;
  if (readRunLedger().runs.some((r) => r.requestId === requestId)) return null;
  const target = relay.targets.find((t) => t.id === request.target_id);
  const recorder = answerRecorder({ requestId, relayId: relay.id, targetId: request.target_id, targetName: target?.name ?? null, claimedAt: request.claimed_at, chatKey: request.chat.key, requester: request.input.requester, input: request.input });
  let heartbeatAt = started; const stallMs = request.liveness.stall_window_s * 1000;
  let child: ReturnType<typeof runEphemeralAgent> | null = null; let timer: ReturnType<typeof setInterval> | null = null;
  let lost = false, beating = false; let pending: Promise<void> | null = null; let seq = 0; let nextBeat = 0;
  let dir: string | null = null, admitted = false;
  const broken = new Set(readConversations().filter((r) => r.state === "broken").map((r) => r.id));
  let reserved: ReturnType<typeof reserveConversations> = null;
  const compaction = { member: "untouched", owner: "untouched" };
  const finish = async (body: ExternalRelayCompletion) => {
    const checked = checkedCompactCompletion(body); if (!checked) throw new Error("invalid compact completion");
    recorder?.finish({ outcome: `${body.outcome}:${"reason" in body ? body.reason : ""}`, answer: null, delivery: "unconfirmed", compaction });
    const sent = await completeRelayRequest(relay, requestId, checked, () => heartbeatAt, stallMs);
    recorder?.recordDelivery({ outcome: `${sent.body.outcome}:${"reason" in sent.body ? sent.body.reason : ""}`, delivery: sent.delivery });
    return sent.body;
  };
  const decline = (reason: string, detail: string | null = null, retry_after_s: number | null = null) => finish({ lease_id, outcome: "declined", reason, detail, retry_after_s });
  const fail = (reason: string) => finish({ lease_id, outcome: "failed", reason, detail: null });
  const lose = () => { lost = true; child?.cancel(); };
  const beat = async () => {
    if (beating || lost) return; beating = true;
    try { await relayCall(relay.api_base, `/requests/${encodeURIComponent(requestId)}/heartbeat`, "POST", { lease_id, seq: ++seq, progress: null }, relay.credential); heartbeatAt = Date.now(); nextBeat = heartbeatAt + request.liveness.heartbeat_interval_s * 1000; }
    catch (error) { if (error instanceof ExternalRelayError && (error.status === 404 || error.status === 409 && error.code === "lease_lost")) lose(); }
    finally { beating = false; if (Date.now() - heartbeatAt > stallMs) lose(); }
  };
  if (!target?.engine || !target.model) return decline("not_configured");
  if (relay.paused || !target.enabled) return decline("disabled");
  if (activeDrain()) return decline("busy");
  if (!request.input.requester.is_owner && !request.input.requester.is_admin) return decline("invalid_request");
  if (readConversations().some((r) => r.relayId === relay.id && r.targetId === target.id && r.chatKey === request.chat.key && r.state === "running")) return decline("busy", "chat busy");
  try {
    dir = fs.mkdtempSync(path.join(externalRelayTempRoot(), "llv-external-relay-"));
    const ownerIdentity = procBackend.processIdentity(process.pid); if (!ownerIdentity) return fail("agent_error");
    const admission = reserveRun({ requestId, leaseId: lease_id, relayId: relay.id, targetId: target.id, childPid: null, childIdentity: null, ownerPid: process.pid, ownerIdentity, runDir: dir, startedAt: new Date(started).toISOString() }, target.concurrency);
    if (admission === "duplicate") return null;
    if (admission === "full") return decline("busy");
    admitted = true; recorder?.begin(target.engine, target.model, answerProfileFor(request.input.requester));
    // The acknowledgement precedes even creation of conversation records.
    while (!lost) { await beat(); if (heartbeatAt > started || seq > 0 && nextBeat > 0) break; await Bun.sleep(1000); }
    if (lost) return null;
    timer = setInterval(() => { if (!beating && Date.now() - heartbeatAt > stallMs) lose(); if (!beating && Date.now() >= nextBeat) pending = beat(); }, 1000); timer.unref();
    reserved = reserveConversations(relay, target, request.chat.key, requestId, request.input.requester.is_owner ? ["member", "owner"] : ["member"], true);
    if (!reserved) return decline("busy", "chat busy");
    for (const record of reserved) {
      let reason: CompactReason = "nothing_to_compact";
      if (broken.has(record.id) || record.turnsSinceCompaction > 0) {
        reason = "started_fresh";
        if (!broken.has(record.id) && record.engine === "claude" && record.sessionId) {
          const selected = accountManager.resolveHeadlessSpawn(record.engine, record.accountId, [], target.project, target.model);
          if (selected.kind !== "available") return decline("no_capacity", null, selected.kind === "exhausted" && selected.resetsAt ? Math.max(0, selected.resetsAt - Math.floor(Date.now() / 1000)) : null);
          prepareConversationAccount(record, selected.account);
          if (!record.sessionId) {
            resetConversation(record); releaseConversation(record.id, { state: "running", runningRequestId: requestId });
            compaction[record.context] = "started_fresh"; continue;
          }
          const prompt = "/compact";
          child = runEphemeralAgent({ key: `external-relay:${requestId}:${record.context}`, engine: record.engine, model: target.model, effort: target.effort, account: selected.account,
            prompt, webSearch: answerProfileFor(request.input.requester).webSearch, schema: answerSchema, runDir: path.join(dir, record.context), hardCapMs: target.hardCapMinutes * 60000, runtime,
            session: { mode: "resume", id: record.sessionId, cwd: record.cwd, codexHome: conversationCodexHome(record) } });
          changeRun(requestId, (r) => ({ ...r, childPid: child!.pid, childIdentity: child!.identity }));
          const result = await child.done; child = null; if (pending) await pending; if (lost) return null;
          if (result.status === "timeout") return fail("hard_cap");
          if (result.status === "cancelled") return fail("cancelled");
          if (result.status === "violation") return fail("agent_error");
          if (result.compacted) { reason = "compacted"; releaseConversation(record.id, { seen: [], staticDigest: null, turnsSinceCompaction: 0, compactions: record.compactions + 1, state: "running", runningRequestId: requestId }); }
          else if (result.status !== "done" && result.code !== 0) return fail("agent_error");
        }
        if (reason === "started_fresh") { resetConversation(record); releaseConversation(record.id, { state: "running", runningRequestId: requestId }); }
      }
      compaction[record.context] = reason;
    }
    if (pending) await pending; if (lost) return null;
    const reason: CompactReason = Object.values(compaction).includes("compacted") ? "compacted" : Object.values(compaction).includes("started_fresh") ? "started_fresh" : "nothing_to_compact";
    return finish({ lease_id, outcome: "compacted", reason, detail: null, duration_ms: Date.now() - started });
  } catch (error) { if (lost) return null; return error instanceof EphemeralProfileError ? decline("profile_error") : fail("agent_error"); }
  finally {
    if (timer) clearInterval(timer);
    if (child) { child.cancel(); await child.done; }
    if (reserved) for (const record of reserved) releaseConversation(record.id);
    if (admitted) dropRun(requestId);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (recorder?.begun && !recorder.finished) recorder.finish({ outcome: "lease_lost", answer: null, delivery: null, compaction });
    onFreed?.();
  }
}

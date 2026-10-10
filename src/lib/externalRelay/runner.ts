import { runOwnerAgent, type OwnerRunPorts } from "./ownerRun";
import { readRelaySwitches } from "./switches";
import { compactRequestSchema } from "./protocol";
import { runCompactRequest } from "./compact";
import { conversationContext, reserveConversations, releaseConversation, prepareConversationAccount, conversationCodexHome, sweepConversations, type RelayConversation } from "./conversations";
import { activeDrain } from "@/lib/selfUpdate/drain";
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
  replyAnswerSchema,
  checkedAnswer,
  checkedRound,
  roundSchema,
  type ExternalRelayDecision,
  handoffAnswerSchema,
  offersHandoff,
  requestSchema,
  type ExternalRelayCompletion,
  type ExternalRelayProgress,
} from "./protocol";
import { callableTools, createToolLoop, toolSleep, type ToolLoopRuntime } from "./toolLoop";
import { answerPrompt, toolRoundPrompt, conversationTurnPrompt, conversationRoundPrompt } from "./prompt";
import { progressForEvent } from "./progress";
import { noteRelayProgress } from "./activity";
import { answerRecorder, countMemberAnswers, type RelayAnswerDelivery } from "./answers";
import {
  answerProfileFor,
  ownerTierFor,
  exemptFromMemberLimit,
  memberLimitFor,
  RELAY_MEMBER_LIMIT_WINDOW_MS,
} from "./profile";
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
  const drainHeld = !!activeDrain();
  const held = readRunLedger().runs;
  return relay.targets
    .filter((target) => target.enabled && target.engine && target.model)
    .map((target) => ({
      target_id: target.id,
      free: drainHeld ? 0 : Math.max(
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
  detail: string | null = null,
): ExternalRelayCompletion => ({
  lease_id,
  outcome: "declined",
  reason,
  detail,
  retry_after_s,
});
/** The line a hand-off carries (§A.8). It is the install's own words: nothing the model wrote. */
export const HANDOFF_DETAIL = "The agent handed this request to the service's own assistant.";
export const memberLimitDetail = (limit: number) =>
  `This member reached ${limit} ${limit === 1 ? "answer" : "answers"} in the last hour in this chat.`;
const failed = (lease_id: string, reason: string): ExternalRelayCompletion => ({
  lease_id,
  outcome: "failed",
  reason,
  detail: null,
});
/** The completion as sent, and whether the service acknowledged it. */
export async function completeRelayRequest(
  relay: PairedRelay,
  requestId: string,
  body: ExternalRelayCompletion,
  lastHeartbeat: () => number,
  stallMs: number,
): Promise<{ body: ExternalRelayCompletion; delivery: RelayAnswerDelivery }> {
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
      return { body, delivery: "accepted" };
    } catch (error) {
      if (error instanceof ExternalRelayError) {
        if (error.status === 413 && body.outcome === "answered") {
          body = failed(body.lease_id, "invalid_answer");
          continue;
        }
        if (error.status === 409 && error.code === "handoff_after_action" && body.outcome === "declined" && body.reason === "handoff") {
          body = failed(body.lease_id, "invalid_answer");
          continue;
        }
        if ([400, 401, 404, 409, 413, 426].includes(error.status))
          return { body, delivery: "refused" };
      }
      if (Date.now() - lastHeartbeat() > stallMs)
        return { body, delivery: "unconfirmed" };
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, 5000);
    }
  }
}
export async function runClaimedRequest(
  relay: PairedRelay,
  raw: unknown,
  onFreed?: () => void,
  runtime?: HeadlessReviewRuntime & ToolLoopRuntime & { timeoutMs?: number; ownerPorts?: OwnerRunPorts },
): Promise<ExternalRelayCompletion | null> {
  if (readRelaySwitches().compact && raw && typeof raw === "object" && (raw as Record<string, unknown>).kind === "compact") {
    const compact = compactRequestSchema.safeParse(raw);
    if (compact.success) return runCompactRequest(relay, compact.data, onFreed, runtime);
    const invalid = raw as Record<string, unknown>;
    if (typeof invalid.request_id !== "string" || typeof invalid.lease_id !== "string") return null;
    return (await completeRelayRequest(relay, invalid.request_id, declined(invalid.lease_id, "invalid_request"), Date.now, 45000)).body;
  }
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
  if (readRunLedger().runs.some((run) => run.requestId === requestId)) return null;
  const rawRequest = raw as Record<string, unknown>;
  const targetId = request?.target_id ?? rawRequest.target_id;
  const recorder = answerRecorder({
    requestId,
    relayId: relay.id,
    targetId,
    targetName: relay.targets.find((item) => item.id === targetId)?.name ?? null,
    claimedAt: rawRequest.claimed_at,
    chatKey: request?.chat?.key ?? null,
    requester: request?.input.requester ?? null,
    input: rawRequest.input,
  });
  let rounds = 0;
  let loop: ReturnType<typeof createToolLoop> | null = null;
  const loopRecord = () => loop ? { rounds, toolCalls: loop.records } : {};
  const finish = async (body: ExternalRelayCompletion, stallMs = 45_000) => {
    // Persist the local decision before any delivery wait: a restart must
    // leave the generated answer and early declines inspectable.
    recorder?.finish({
      outcome:
        body.outcome === "answered"
          ? "answered"
          : `${body.outcome}:${body.reason}`,
      answer:
        body.outcome === "answered"
          ? body.answer
          : body.outcome === "declined" && body.reason === "handoff"
            ? { action: "handoff", text: "", reply_to: null }
            : null,
      delivery: "unconfirmed",
      ...loopRecord(),
    });
    const sent = await completeRelayRequest(relay, requestId, body, () => heartbeatAt, stallMs);
    const completion = sent.body;
    recorder?.recordDelivery({
      outcome: completion.outcome === "answered" ? "answered" : `${completion.outcome}:${completion.reason}`,
      delivery: sent.delivery,
    });
    return completion;
  };
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
  // The member limit (§B.8): a member past it is declined, and the service's
  // fallback setting decides whether its own agent answers instead.
  const requester = request.input.requester;
  const limit = memberLimitFor(target);
  if (requester && limit !== null && !exemptFromMemberLimit(requester)) {
    const now = Date.now();
    const used = countMemberAnswers({
      relayId: relay.id,
      targetId: target.id,
      chatKey: request.chat?.key ?? null,
      requesterKey: requester.key,
      sinceMs: now - RELAY_MEMBER_LIMIT_WINDOW_MS,
    });
    if (used.count >= limit)
      return finish(
        declined(
          leaseId,
          "member_limit",
          used.oldestMs === null
            ? null
            : Math.max(1, Math.ceil((used.oldestMs + RELAY_MEMBER_LIMIT_WINDOW_MS - now) / 1000)),
          memberLimitDetail(limit),
        ),
      );
  }
  const profile = answerProfileFor(requester);
  const owner = ownerTierFor(target, request);
  if (activeDrain()) return finish(declined(leaseId, "busy"));
  let conversation: RelayConversation | null = null;
  let conversationEvidence: { sessionId?: string | null; promptTokens?: number | null; compacted?: boolean } = {};
  let turn: ReturnType<typeof conversationTurnPrompt> | null = null;
  let conversationBroken = false;
  let runDir: string | null = null;
  let recorded = false;
  let run: ReturnType<typeof runEphemeralAgent> | null = null;
  let runFinished = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const callAbort = new AbortController();
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
    const context = conversationContext(request.input.requester);
    if (!owner && readRelaySwitches().chat_conversations && request.chat && context) {
      sweepConversations([relay], readRunLedger().runs.filter((r) => r.requestId !== requestId), Date.now(), undefined, relay.id);
      const reserved = reserveConversations(relay, target, request.chat.key, requestId, [context]);
      if (!reserved) return await finish(declined(leaseId, "busy", null, "chat busy"));
      conversation = reserved[0]!;
    }
    const selection = accountManager.resolveHeadlessSpawn(
      target.engine,
      conversation?.accountId ?? null,
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
    if (conversation) { prepareConversationAccount(conversation, selection.account); conversation.accountId = selection.account.accountId; }
    let newestProgress: ExternalRelayProgress | null = null;
    let leaseUnavailable = false;
    let beatBusy = false;
    let pendingBeat: Promise<void> | null = null;
    let seq = 0;
    let nextBeatAt = 0;
    let acked = false;
    const started = Date.now();
    const stallMs = request.liveness.stall_window_s * 1000;
    const cancelStalledRun = () => {
      if (!leaseUnavailable && Date.now() - heartbeatAt > stallMs) {
        leaseUnavailable = true;
        run?.cancel();
        callAbort.abort();
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
        acked = true;
        heartbeatAt = Date.now();
        nextBeatAt = heartbeatAt + request.liveness.heartbeat_interval_s * 1000;
      } catch (error) {
        if (
          error instanceof ExternalRelayError &&
          (error.status === 404 ||
            (error.status === 409 && error.code === "lease_lost"))
        ) {
          leaseUnavailable = true;
          run?.cancel();
          callAbort.abort();
        }
      } finally {
        if (nextBeatAt <= Date.now()) nextBeatAt = Date.now() + 1000;
        beatBusy = false;
        cancelStalledRun();
      }
    };
    const lose = () => { leaseUnavailable = true; run?.cancel(); callAbort.abort(); };
    if (!owner && callableTools(request).length) loop = createToolLoop(relay, request, {
      signal: callAbort.signal, lose,
      ack: async () => {
        while (!acked && !leaseUnavailable) {
          if (pendingBeat) await pendingBeat;
          if (acked || leaseUnavailable) break;
          await toolSleep(1000, callAbort.signal);
          if (!beatBusy) pendingBeat = beat();
        }
        return acked && !leaseUnavailable;
      },
    }, runtime, (tool, done, failed) => {
      if (request.answer.progress === "notes") {
        newestProgress = { kind: done ? "tool_done" : "tool_start", label: tool, tool,
          status: done ? (failed ? "failed" : "completed") : "running", at: new Date().toISOString() };
        noteRelayProgress(relay.id, target.id, newestProgress);
      }
    });
    let result: Awaited<ReturnType<typeof runEphemeralAgent>["done"]> | null = null;
    let completion: ExternalRelayDecision | null = null;
    for (rounds = 1; rounds <= (loop ? 8 : 1); rounds++) {
      const final = rounds === 8 || !!loop && loop.callsLeft() === 0;
      runFinished = false;
      try {
        if (rounds === 1 && activeDrain()) return await finish(declined(leaseId, "busy"));
        const roundPrompt = loop ? toolRoundPrompt(request, rounds, { results: loop.results, callsLeft: loop.callsLeft(), final, actionSent: loop.actionSent }) : answerPrompt(request);
        const frame = roundPrompt.slice(roundPrompt.lastIndexOf("[Answer with one JSON object"));
        if (conversation && rounds === 1) turn = conversationTurnPrompt(request, conversation, frame);
        const persistentPrompt = conversation ? rounds === 1 ? turn!.prompt : conversationRoundPrompt(loop!.results.filter((r) => r.round === rounds - 1), frame) : roundPrompt;
        run = owner ? runOwnerAgent({
          request, owner, target, accountId: selection.account.accountId,
          hardCapMs: Math.min(target.hardCapMinutes * 60_000, runtime?.timeoutMs ?? Infinity), ports: runtime?.ownerPorts,
          onConversation: (conversationId) => {
            changeRun(requestId, current => ({ ...current, conversationId }));
            recorder?.bindConversation(conversationId);
          },
        }) : runEphemeralAgent({
          ...(conversation ? { session: { mode: conversation.sessionId ? "resume" as const : "start" as const, id: conversation.sessionId ?? (target.engine === "claude" ? crypto.randomUUID() : null), cwd: conversation.cwd, codexHome: conversationCodexHome(conversation) } } : {}),
          key: loop ? `external-relay:${requestId}:${rounds}` : `external-relay:${requestId}`,
          engine: target.engine,
          model: target.model,
          effort: target.effort,
          account: selection.account,
          ["prompt"]: conversation ? persistentPrompt : roundPrompt,
          schema: loop ? (final ? (loop.sawUnknown ? replyAnswerSchema : loop.actionSent ? answerSchema : handoffAnswerSchema) : roundSchema(loop.tools, { handoff: !loop.actionSent })) : offersHandoff(request) ? handoffAnswerSchema : answerSchema,
          runDir: loop ? path.join(runDir, `round-${rounds}`) : runDir,
          hardCapMs: target.hardCapMinutes * 60_000,
          webSearch: profile.webSearch,
          runtime,
          onEvent: (event) => {
            const progress = progressForEvent(event);
            if (progress && request.answer.progress === "notes") {
              newestProgress = progress;
              noteRelayProgress(relay.id, target.id, progress);
            }
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
      // Capacity, drain and profile declines never ran an agent. Count only
      // a launched child, including one still running or destined to fail.
      if ((launchedRun.pid || owner) && !recorder?.begun) recorder?.begin(target.engine, target.model, owner ? { ...profile, owner: true } : profile);
      changeRun(requestId, (current) => ({
        ...current,
        childPid: launchedRun.pid,
        childIdentity: launchedRun.identity,
      }));
      if (launchedRun.pid && !launchedRun.identity)
        for (const delay of [100, 500, 2000]) {
          const timer = setTimeout(() => {
            const identity = procBackend.processIdentity(launchedRun.pid!);
            if (identity && run === launchedRun)
              changeRun(requestId, (current) => ({
                ...current,
                childIdentity: identity,
              }));
          }, delay);
          timer.unref();
          identityTimers.push(timer);
        }
      if (rounds === 1) {
        pendingBeat = beat();
        await pendingBeat;
        heartbeatTimer = setInterval(() => {
          if (!beatBusy) cancelStalledRun();
          if (!beatBusy && !leaseUnavailable && Date.now() >= nextBeatAt) pendingBeat = beat();
        }, 1000);
        heartbeatTimer.unref();
      }
      if (leaseUnavailable) launchedRun.cancel();
      result = await launchedRun.done;
      if (conversation) {
        if (result.sessionId) conversation.sessionId = result.sessionId;
        else { conversationBroken = true; if (result.status === "done") result = { ...result, status: "failed" }; }
        if (result.status === "violation" || result.status === "failed") conversationBroken = true;
        conversationEvidence = { sessionId: conversation.sessionId, promptTokens: result.promptTokens ?? conversationEvidence.promptTokens, compacted: conversationEvidence.compacted || result.compacted };
      }
      if (pendingBeat) await pendingBeat;
      cancelStalledRun();
      if (leaseUnavailable) return null;
      const decision = result?.status === "done"
        ? loop && !final ? checkedRound(result.answer, request, { handoff: !loop.actionSent, ignore: !loop.sawUnknown }) : checkedAnswer(result.answer, request, { handoff: !loop?.actionSent, ignore: !loop?.sawUnknown })
        : null;
      if (!decision || !("kind" in decision)) { completion = decision; break; }
      await loop!.runCalls(decision.calls, rounds);
      if (leaseUnavailable) return null;
    }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (pendingBeat) await pendingBeat;
    cancelStalledRun();
    if (leaseUnavailable) return null;
    // A hand-off returns the request to the service, which answers it with
    // its own agent (§A.8); it carries no text from this install.
    const body: ExternalRelayCompletion = completion?.action === "handoff"
      ? declined(leaseId, "handoff", null, HANDOFF_DETAIL)
      : completion
      ? {
          lease_id: leaseId,
          outcome: "answered" as const,
          answer: completion,
          duration_ms: Date.now() - started,
        }
      : failed(
          leaseId,
          result?.status === "violation"
            ? "profile_violation"
            : result?.status === "timeout"
              ? "hard_cap"
              : result?.status === "done"
                ? "invalid_answer"
                : result?.status === "cancelled"
                  ? "cancelled"
                  : "agent_error",
        );
    return await finish(body, request.liveness.stall_window_s * 1000);
  } catch {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (callAbort.signal.aborted) return null;
    if (run) {
      if (!runFinished) run.cancel();
      await run.done;
    }
    return await finish(
      failed(leaseId, "agent_error"),
      request.liveness.stall_window_s * 1000,
    );
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    callAbort.abort();
    if (conversation) {
      const compacted = conversationEvidence.compacted;
      releaseConversation(conversation.id, { state: conversationBroken ? "broken" : "idle", sessionId: conversation.sessionId,
        ...(conversationEvidence.sessionId ? { accountId: conversation.accountId, turns: conversation.turns + 1, turnsSinceCompaction: compacted ? 0 : conversation.turnsSinceCompaction + 1,
          lastTurnAt: new Date().toISOString(), seen: compacted ? [] : turn?.seen ?? [], staticDigest: compacted ? null : turn?.digest ?? null,
          lastPromptTokens: conversationEvidence.promptTokens ?? null, compactions: conversation.compactions + (compacted ? 1 : 0) } : {}) });
    }
    for (const timer of identityTimers) clearTimeout(timer);
    // The only way out without a completion is a lost lease.
    if (recorder?.begun && !recorder.finished)
      recorder.finish({ outcome: "lease_lost", answer: null, delivery: null, ...loopRecord() });
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

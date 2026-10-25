import { ownerTierFor } from "./profile";
import { ownerTurnDiagnostic } from "./diagnostic";
import { deliverOwnerLateAnswer } from "./ownerLateDelivery";
import { ownerFailureAnswer, confirmOwnerStop, type OwnerRunPorts } from "./ownerRun";
import { ownerRelayFailureReplyAuthorized } from "./ownerAuthority";
import { changeRun, changeRunAsync, OWNER_RELEASED_CUSTODY_RETENTION_MS, ownerStopPending } from "./store";
import { sweepConversationsAsync } from "./conversations";
import { readRelaySwitches } from "./switches";
import fs from "node:fs";
import path from "node:path";
import {
  processMatches,
  terminateHeadlessReviewerGroup,
} from "@/lib/agent/headless";
import { assertStateStartupMutation, mayRunStateStartupMutation } from "@/lib/stateOwnership";
import { isStagingMode } from "@/lib/staging";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { noteRelayOutcome, relayActivity } from "./activity";
import { readAnswerRecord, pruneAnswerRecords, relayAnswersRoot, settleInterruptedAnswer, type RelayAnswerDelivery } from "./answers";
import { discoverRelay, ExternalRelayError, fetchRelayTargets, isUnknownFeatureRefusal, relayCall } from "./client";
import { requestSchema, RELAY_OWNER_TOOLS, RELAY_TOOLS_ON_DEMAND, type ExternalRelayCompletion } from "./protocol";
import { RELAY_MEDIA_ANY_DOCUMENT } from "./mediaInputValidation";
import {
  advertisedSlots,
  externalRelayTempRoot,
  runClaimedRequest,
  runningCount,
  relayRequestInFlight,
} from "./runner";
import {
  dropRun,
  externalRelayFile,
  mergeRelayTargets,
  readRelayStore,
  readRunLedger,
  updateRelayStore,
  type PairedRelay,
  type RunRecord,
} from "./store";

export type PollerState =
  | "polling"
  | "unreachable"
  | "rate_limited"
  | "credential_rejected"
  | "unsupported_version"
  | "paused";
type PollLoop = {
  wake?: () => void;
  finished?: boolean;
  retiring?: boolean;
  stopped: boolean;
  state: PollerState;
};
type TargetRefresh = {
  at: number;
  running: Promise<TargetRefreshOutcome> | null;
};
type PollerController = {
  loops: Map<string, PollLoop>;
  sweepTimer: ReturnType<typeof setInterval> | null;
  armed: boolean;
  targetRefreshes?: Map<string, TargetRefresh>;
  descriptorRefreshes?: Map<string, TargetRefresh>;
  forcedDescriptorRefreshes?: Map<string, TargetRefresh>;
  prunedAt?: number;
};
const globalRelay = globalThis as typeof globalThis & {
  __llvExternalRelayPoller?: PollerController;
};
const controller: PollerController = (globalRelay.__llvExternalRelayPoller ??= {
  loops: new Map(),
  sweepTimer: null,
  armed: false,
});
const loops = controller.loops;
const targetRefreshes = (controller.targetRefreshes ??= new Map<
  string,
  TargetRefresh
>());
const descriptorRefreshes = (controller.descriptorRefreshes ??= new Map<string, TargetRefresh>());
const forcedDescriptorRefreshes = (controller.forcedDescriptorRefreshes ??= new Map<string, TargetRefresh>());
function waitForPollRetry(loop: PollLoop, ms: number): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); delete loop.wake; resolve(); };
    const timer = setTimeout(done, ms);
    loop.wake = done;
    if (loop.stopped) done();
  });
}
export function relayPollerStatus(id: string) {
  const loop = loops.get(id);
  const status = { state: loop ? loop.state : ("paused" as const), ...relayActivity(id) };
  try {
    const pending = readRunLedger().runs.find(run => run.relayId === id && ownerStopPending(run));
    return { ...status, ...(pending ? { lastOutcome: "owner_stop_pending", lastOutcomeAt: pending.startedAt } : {}) };
  } catch {
    console.error("External relay cancellation custody unreadable; run ledger preserved");
    return { ...status, lastOutcome: "local_error" };
  }
}
export function wakeExternalRelayPoller(id: string) {
  // A claim POST can acquire a lease at any time, including after a socket
  // abort. Only a local retry wait may be interrupted; consume every response.
  const loop = loops.get(id);
  if (loop?.state !== "rate_limited") loop?.wake?.();
}
/** Older custody rows retained the input in the answer record. Reconstruct only
 * from that record and the already verified owner request, never from chat text. */
function ownerRecoveryRequest(run: RunRecord, relay: PairedRelay): unknown | null {
  if (run.ownerTurn?.rawRequest) return run.ownerTurn.rawRequest;
  const record = readAnswerRecord(run.relayId, run.targetId, run.requestId);
  if (!record?.profile?.owner || !run.ownerTurn?.request) return null;
  const parsed = requestSchema.safeParse({ request_id: run.requestId, lease_id: run.leaseId,
    kind: "answer", target_id: run.targetId, claimed_at: record.claimedAt ?? run.startedAt,
    features: record.features, ...(record.chatKey ? { chat: { key: record.chatKey } } : {}),
    input: record.input, answer: { max_chars: relay.limits.max_answer_chars, progress: "none" },
    liveness: { poll_freshness_s: 60, claim_window_s: 5, ack_window_s: 10, heartbeat_interval_s: 10, stall_window_s: 45 } });
  if (!parsed.success) return null;
  const owner = ownerTierFor({ ownerTier: true }, parsed.data);
  return owner && owner.text === run.ownerTurn.request.text && owner.requestText === run.ownerTurn.request.requestText
    ? parsed.data : null;
}

const ownerRecoveries = new Set<string>();
export async function sweepExternalRelayOrphans(ownerPorts?: OwnerRunPorts): Promise<void> {
  assertStateStartupMutation(externalRelayFile("runs"), "external-relay-sweep");
  for (const run of readRunLedger().runs) {
    if (ownerRecoveries.has(run.requestId)) continue;
    // /complete may already have posted the answer. Neither restarting execution
    // nor /send can reconcile that request-scoped delivery without duplicating it.
    if (run.ownerTurn?.completionAttempt && !run.completionAccepted && !ownerStopPending(run)
      && (run.capacityReleased || run.ownerTurn.confirmed)) continue;
    if (run.ownerTurn?.lateAnswer && !run.completionAccepted && !ownerStopPending(run)) {
      if (relayRequestInFlight(run.requestId) || processMatches(run.ownerPid, run.ownerIdentity) && run.ownerPid !== process.pid) continue;
      const relay = readRelayStore().relays.find(item => item.id === run.relayId);
      if (!relay || !ownerRelayFailureReplyAuthorized(run.relayId, run.targetId, run.requestId)) continue;
      ownerRecoveries.add(run.requestId);
      try {
        const pending = run.ownerTurn.lateAnswer;
        const sent = await deliverOwnerLateAnswer(relay, run.requestId, pending.body, pending.files,
          () => ownerRelayFailureReplyAuthorized(run.relayId, run.targetId, run.requestId));
        if (sent.delivery === "accepted") {
          settleInterruptedAnswer(run.relayId, run.targetId, run.requestId, "accepted", run.conversationId,
            pending.body.outcome === "answered" ? pending.body.answer : null, true);
          removeRunDirectory(run.runDir);
          dropRun(run.requestId);
        }
      } finally { ownerRecoveries.delete(run.requestId); }
      continue;
    }
    // Accepted completion already ended execution. Finish abandoned cleanup
    // without controlling a host or sending a second service completion.
    // An unconfirmed owner stop still needs control below first.
    if (run.capacityReleased && !ownerStopPending(run)) {
      if (relayRequestInFlight(run.requestId) || run.ownerPid !== process.pid && processMatches(run.ownerPid, run.ownerIdentity)) continue;
      // Released owner custody keeps its cutoff and diagnostic readable for a bounded time.
      const released = run.ownerTurn?.released ? Date.parse(run.ownerTurn.released.at) : NaN;
      if (Number.isFinite(released) && Date.now() - released < OWNER_RELEASED_CUSTODY_RETENTION_MS) continue;
      removeRunDirectory(run.runDir);
      dropRun(run.requestId);
      continue;
    }
    const ownerAlive = processMatches(run.ownerPid, run.ownerIdentity);
    // The live callback owns stop retries and completion. Recovery must not
    // send an install_restarted completion while that callback is pending.
    // The in-flight set is process-local, so a live owner in another process
    // (the previous Viewer during a handover) keeps custody until it exits.
    const ownerHolds = () => ownerAlive && (run.ownerPid !== process.pid || relayRequestInFlight(run.requestId));
    if (ownerHolds()) continue;
    const interruptedOwner = !!run.ownerTurn && (!run.ownerTurn.cancel || run.ownerTurn.restartPending === true) && !run.ownerTurn.diagnostic;
    if (run.ownerTurn) {
      if (ownerAlive && !run.ownerTurn.cancel) continue;
      if (!ownerAlive) {
        run.ownerTurn.admissionComplete = true;
        if (interruptedOwner) run.ownerTurn.restartPending = true;
        changeRun(run.requestId, r => ({ ...r, ownerTurn: { ...r.ownerTurn!, admissionComplete: true,
          ...(interruptedOwner ? { restartPending: true } : {}) } }));
      }
      if (!run.ownerTurn.cancel) {
        run.ownerTurn.cancel = "kill";
        run.ownerTurn.cancelledAt ??= new Date().toISOString();
        const cancelledAt = run.ownerTurn.cancelledAt;
        changeRun(run.requestId, r => ({ ...r, ownerTurn: { ...r.ownerTurn!, cancel: "kill", cancelledAt: r.ownerTurn?.cancelledAt ?? cancelledAt } }));
      }
      if (!run.ownerTurn.confirmed && !await confirmOwnerStop(run, ownerPorts)) continue;
    } else if (ownerAlive) continue;
    // Stop recovery awaited host control; reread delivery custody after it.
    const held = readRunLedger().runs.find(r => r.requestId === run.requestId);
    if (!held || ownerHolds()) continue;
    if (run.childPid && processMatches(run.childPid, run.childIdentity))
      terminateHeadlessReviewerGroup(run.childPid, run.childIdentity);
    // A released owner stop keeps its custody record until retention ends;
    // the capacity marker tells later sweeps that its completion is done.
    const settle = () => {
      if (held.ownerTurn?.released) changeRun(run.requestId, r => ({ ...r, capacityReleased: true }));
      else dropRun(run.requestId);
    };
    // The accepted completion already reached the requester. Stop custody
    // only held capacity and files until the host confirmed the stop.
    if (held.ownerTurn?.completionAttempt && !held.completionAccepted) continue;
    if (held.completionAccepted || held.capacityReleased) {
      removeRunDirectory(run.runDir);
      settle();
      continue;
    }
    if (held.ownerTurn?.lateAnswer) continue;
    const recoveryRelay = readRelayStore().relays.find(item => item.id === run.relayId);
    const recoveryRequest = recoveryRelay && ownerRecoveryRequest(held, recoveryRelay);
    if (recoveryRelay && recoveryRequest && held.ownerTurn && !held.ownerTurn.restartRetries
      && interruptedOwner
      && recoveryRelay.paused === false && recoveryRelay.targets.some(target => target.id === run.targetId && target.enabled && target.ownerTier)) {
      changeRun(run.requestId, row => ({ ...row, ownerTurn: { ...row.ownerTurn!, restartRetries: 1 } }));
      ownerRecoveries.add(run.requestId);
      void runClaimedRequest(recoveryRelay, recoveryRequest, undefined, { ownerPorts, ownerRecovery: held })
        .catch(error => console.error("Owner relay restart retry failed", error instanceof Error ? error.name : "unknown"))
        .finally(() => ownerRecoveries.delete(run.requestId));
      continue;
    }
    if (recoveryRelay && recoveryRequest && interruptedOwner && held.ownerTurn?.restartRetries) {
      const request = requestSchema.parse(recoveryRequest);
      const owner = held.ownerTurn.context ?? ownerTierFor({ ownerTier: true }, request);
      const diagnostic = ownerTurnDiagnostic("exception", "The owner retry was interrupted by another install restart. Resend the request.");
      const answer = owner && ownerFailureAnswer(request, owner, diagnostic, [recoveryRelay.credential]);
      if (answer) {
        changeRun(run.requestId, row => ({ ...row, ownerTurn: { ...row.ownerTurn!, diagnostic,
          lateAnswer: { body: { lease_id: run.leaseId, outcome: "answered", answer, duration_ms: Math.max(0, Date.now() - Date.parse(run.startedAt)) }, files: [] } } }));
        console.error("Owner relay restart retry exhausted", JSON.stringify({ requestId: run.requestId, diagnostic }));
        continue;
      }
    }
    if (run.ownerTurn) noteRelayOutcome(run.relayId, "failed:cancelled");
    const relay = readRelayStore().relays.find(
      (item) => item.id === run.relayId,
    );
    let delivery: RelayAnswerDelivery = "unconfirmed";
    // A diagnosed owner failure whose stop is confirmed still answers with its
    // saved scrubbed reason while the request is open and the owner target
    // still authorizes the reply; otherwise the generic restart failure.
    const saved = held.ownerTurn?.failureReply;
    if (relay && saved && Date.now() >= Date.parse(saved.until)
      && ownerRelayFailureReplyAuthorized(run.relayId, run.targetId, run.requestId)) {
      const body = { lease_id: run.leaseId, outcome: "answered" as const, answer: saved.answer,
        duration_ms: Math.max(0, Date.now() - Date.parse(run.startedAt)) };
      changeRun(run.requestId, row => ({ ...row, ownerTurn: { ...row.ownerTurn!, lateAnswer: { body, files: [] } } }));
      const sent = await deliverOwnerLateAnswer(relay, run.requestId, body, [],
        () => ownerRelayFailureReplyAuthorized(run.relayId, run.targetId, run.requestId));
      if (sent.delivery === "accepted") {
        settleInterruptedAnswer(run.relayId, run.targetId, run.requestId, "accepted", held.conversationId, saved.answer, true);
        removeRunDirectory(run.runDir);
        dropRun(run.requestId);
      }
      continue;
    }
    const answer = saved && Date.now() < Date.parse(saved.until)
      && ownerRelayFailureReplyAuthorized(run.relayId, run.targetId, run.requestId) ? saved.answer : null;
    if (relay) {
      const body: ExternalRelayCompletion = answer
        ? { lease_id: run.leaseId, outcome: "answered", answer, duration_ms: Math.max(0, Date.now() - Date.parse(run.startedAt)) }
        : { lease_id: run.leaseId, outcome: "failed", reason: "install_restarted", detail: null };
      if (answer) {
        // Claim delivery custody under the ledger lock before the service can
        // post. A crash or missing ACK must never authorize a later /send.
        let claimed = false;
        await changeRunAsync(run.requestId, row => {
          if (!row.ownerTurn || row.completionAccepted || row.ownerTurn.completionAttempt || row.ownerTurn.lateAnswer) return row;
          claimed = true;
          return { ...row, ownerTurn: { ...row.ownerTurn, completionAttempt: { body, files: [] } } };
        }, Date.now() + 5000);
        if (!claimed) continue;
      }
      try {
        await relayCall(
          relay.api_base,
          `/requests/${encodeURIComponent(run.requestId)}/complete`,
          "POST",
          body,
          relay.credential,
          { prepareBody: () => {
            if (answer && !ownerRelayFailureReplyAuthorized(run.relayId, run.targetId, run.requestId))
              throw new ExternalRelayError("cancelled", 401);
            return body;
          } },
        );
        delivery = "accepted";
      } catch (error) {
        // A terminal refusal proves this completion was not accepted; a
        // transient error leaves its delivery uncertain.
        if (error instanceof ExternalRelayError && [400, 401, 404, 409, 413, 426].includes(error.status)
          && !(answer && error.status === 409 && error.code === "already_completed"))
          delivery = "refused";
      }
      if (answer) {
        await changeRunAsync(run.requestId, row => ({ ...row,
          ...(delivery === "accepted" ? { completionAccepted: true as const } : {}),
          ...(delivery === "unconfirmed" ? { capacityReleased: true as const } : {}),
          ownerTurn: { ...row.ownerTurn!, ...(delivery !== "unconfirmed" ? { completionAttempt: undefined } : {}) },
        }), Date.now() + 5000);
        if (delivery !== "accepted") {
          // Keep uncertain attempts fenced. A definite refusal leaves the
          // saved reply eligible for late delivery once its deadline passes.
          settleInterruptedAnswer(run.relayId, run.targetId, run.requestId, delivery, held.conversationId, answer);
          continue;
        }
      }
    }
    removeRunDirectory(run.runDir);
    const current = run.ownerTurn ? readRunLedger().runs.find(r => r.requestId === run.requestId) : undefined;
    settleInterruptedAnswer(run.relayId, run.targetId, run.requestId, delivery, current?.conversationId, answer);
    settle();
  }
  await sweepConversationsAsync(readRelayStore().relays, Date.now(), Date.now() + 5_000);
}
function removeRunDirectory(directory: string): void {
  if (path.dirname(path.resolve(directory)) === externalRelayTempRoot() && path.basename(directory).startsWith("llv-external-relay-"))
    fs.rmSync(directory, { recursive: true, force: true });
}
/* A paired relay's targets come from endpoint 6 whenever the settings page
   reads them (at most every 30 s), every 5 min from the claim loop, and once
   after a confirm that listed none. The attempt time is kept per relay on
   the controller, so every module copy shares one rate limit, and a refresh
   already on the wire is joined rather than repeated. */
export const TARGETS_REFRESH_ON_READ_MS = 30_000;
export const TARGETS_REFRESH_IN_LOOP_MS = 300_000;
export const DESCRIPTOR_REFRESH_ON_READ_MS = 300_000;
export const DESCRIPTOR_REFRESH_ON_UNKNOWN_FEATURE_MS = 30_000;
export type TargetRefreshOutcome =
  | "changed"
  | "unchanged"
  | "skipped"
  | "failed"
  | "credential_rejected"
  | "gone";
export function refreshRelayTargets(
  id: string,
  minIntervalMs = 0,
): Promise<TargetRefreshOutcome> {
  const prior = targetRefreshes.get(id);
  if (prior?.running) return prior.running;
  if (prior && Date.now() - prior.at < minIntervalMs)
    return Promise.resolve("skipped");
  const entry: TargetRefresh = { at: Date.now(), running: null };
  targetRefreshes.set(id, entry);
  entry.running = refreshTargetsNow(id).finally(() => {
    entry.running = null;
  });
  return entry.running;
}
/** Refreshes every paired relay for a read of the settings page, waiting at
 * most `waitMs`; a slower service shows its list on the page's next read. */
export async function refreshTargetsForRead(waitMs = 2_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(
      readRelayStore().relays.flatMap((relay) => [
        refreshRelayTargets(relay.id, TARGETS_REFRESH_ON_READ_MS),
        // A feature the service ships after pairing («clone_create») shows
        // without a new pairing; a failed read here is not a request outcome.
        refreshRelayDescriptorFeatures(relay.id, DESCRIPTOR_REFRESH_ON_READ_MS, { quiet: true }),
      ]),
    ),
    new Promise((resolve) => {
      timer = setTimeout(resolve, waitMs);
    }),
  ]);
  clearTimeout(timer);
}
async function refreshTargetsNow(id: string): Promise<TargetRefreshOutcome> {
  try {
    const relay = readRelayStore().relays.find((item) => item.id === id);
    if (!relay) {
      targetRefreshes.delete(id);
      return "gone";
    }
    let remote;
    try {
      remote = await fetchRelayTargets(relay);
    } catch (error) {
      if (error instanceof ExternalRelayError && error.status === 401) {
        // The claim loop would learn the same on its next call; park it now.
        const loop = loops.get(id);
        if (loop) {
          loop.state = "credential_rejected";
          loop.stopped = true;
          loop.wake?.();
        }
        return "credential_rejected";
      }
      // Network, 5xx, 429 or a body that fails the schema: the stored list
      // stays, and the activity line says why it was not refreshed.
      const code =
        error instanceof ExternalRelayError && /^[a-z0-9_]{1,40}$/.test(error.code)
          ? error.code
          : "unreachable";
      noteRelayOutcome(id, `targets:${code}`);
      return "failed";
    }
    let changed = false;
    updateRelayStore((store) => ({
      ...store,
      relays: store.relays.map((item) => {
        if (item.id !== id) return item;
        const targets = mergeRelayTargets(item.targets, remote);
        if (JSON.stringify(targets) === JSON.stringify(item.targets))
          return item;
        changed = true;
        return { ...item, targets };
      }),
    }));
    // A new loop advertises slots from the new list, so a dropped target
    // stops being offered and an added one waits for its settings.
    if (changed) refreshExternalRelayPollers(id);
    return changed ? "changed" : "unchanged";
  } catch (error) {
    console.error(
      "External relay target refresh failed",
      error instanceof Error ? error.name : "unknown",
    );
    noteRelayOutcome(id, "targets:local_error");
    return "failed";
  }
}
/** What this install implements of the optional parts of v1 (§A.2 rule 11). */
export const CLAIM_FEATURES = ["requester_context", "relay_tool_calls", "relay_tool_actions", "request_deadline"];
export function relayClaimCapabilities(relay?: Pick<PairedRelay, "features">) {
  const switches = readRelaySwitches();
  const rich = switches.rich_media && relay?.features?.includes("relay_rich_messages");
  const features = [...CLAIM_FEATURES,
    ...(relay?.features?.includes(RELAY_TOOLS_ON_DEMAND) ? [RELAY_TOOLS_ON_DEMAND] : []),
    ...(relay?.features?.includes("relay_media_in") ? ["relay_media_in"] : []),
    ...(relay?.features?.includes("relay_media_in") && relay.features.includes(RELAY_MEDIA_ANY_DOCUMENT) ? [RELAY_MEDIA_ANY_DOCUMENT] : []),
    ...(rich ? ["relay_rich_messages", ...(relay?.features?.includes("relay_media_out") ? ["relay_media_out"] : [])] : [])];
  return { kinds: switches.compact ? ["answer", "compact"] : ["answer"],
    features: switches.owner_tools && relay?.features?.includes(RELAY_OWNER_TOOLS)
      ? [...features, RELAY_OWNER_TOOLS] : features };
}
/** The same request builder is used by polling and install wire captures. */
export function relayClaimBody(relay: PairedRelay) {
  return { wait_s: Math.min(25, relay.limits.max_wait_s),
    ...relayClaimCapabilities(readRelayStore().relays.find(item => item.id === relay.id)),
    slots: advertisedSlots(relay) };
}
/** Every paired install refreshes before its first claim and every five minutes,
 * independently of the switches that gate individual optional features. */
export function refreshRelayDescriptorFeatures(id: string, minIntervalMs = 0, options: { quiet?: boolean; force?: boolean } = {}): Promise<TargetRefreshOutcome> {
  const now = Date.now();
  if (options.force) {
    const forced = forcedDescriptorRefreshes.get(id);
    if (forced?.running) return forced.running;
    if (forced && now - forced.at < DESCRIPTOR_REFRESH_ON_UNKNOWN_FEATURE_MS)
      return Promise.resolve("skipped");
    const prior = descriptorRefreshes.get(id);
    const entry: TargetRefresh = { at: now, running: null };
    forcedDescriptorRefreshes.set(id, entry);
    entry.running = (async () => {
      // The ordinary response may be stale by the time this forced refresh is
      // requested. Let it commit first, then read the descriptor again so it
      // cannot overwrite the feature list learned by this refresh.
      if (prior?.running) await prior.running;
      entry.at = Date.now();
      return refreshRelayDescriptorFeaturesNow(id, options);
    })().finally(() => { entry.running = null; });
    return entry.running;
  }
  const forced = forcedDescriptorRefreshes.get(id);
  if (forced?.running) return forced.running;
  const prior = descriptorRefreshes.get(id);
  if (prior?.running) return prior.running;
  if (prior && now - prior.at < minIntervalMs) return Promise.resolve("skipped");
  const entry: TargetRefresh = { at: now, running: null };
  descriptorRefreshes.set(id, entry);
  entry.running = refreshRelayDescriptorFeaturesNow(id, options).finally(() => { entry.running = null; });
  return entry.running;
}
async function refreshRelayDescriptorFeaturesNow(id: string, options: { quiet?: boolean }): Promise<TargetRefreshOutcome> {
  const relay = readRelayStore().relays.find((item) => item.id === id);
  if (!relay) { descriptorRefreshes.delete(id); forcedDescriptorRefreshes.delete(id); return "gone"; }
  try {
    const { descriptor } = await discoverRelay(relay.origin);
    const features = descriptor.features ?? [];
    let changed = false;
    updateRelayStore((store) => ({ ...store, relays: store.relays.map((item) => {
      if (item.id !== id || JSON.stringify(item.features ?? []) === JSON.stringify(features)) return item;
      changed = true;
      return { ...item, features };
    }) }));
    return changed ? "changed" : "unchanged";
  } catch {
    if (!options.quiet) noteRelayOutcome(id, "descriptor:unreachable");
    return "failed";
  }
}
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const activeRelayRequests = new Set<Promise<void>>();
async function poll(
  relay: PairedRelay,
  loop: PollLoop,
) {
  let backoff = 5000;
  while (!loop.stopped) {
    await refreshRelayTargets(relay.id, TARGETS_REFRESH_IN_LOOP_MS);
    // A changed list restarted this relay's loop; a 401 parked it.
    if (loop.stopped) break;
    await refreshRelayDescriptorFeatures(relay.id, DESCRIPTOR_REFRESH_ON_READ_MS);
    if (loop.stopped) break;
    try {
      const result = await withViewerOperation("telegram.review-polls", () => relayCall<{ request?: unknown }>(
        relay.api_base,
        "/requests/claim",
        "POST",
        relayClaimBody(relay),
        relay.credential,
        {
          timeoutMs: (Math.min(25, relay.limits.max_wait_s) + 15) * 1000,
          maxBytes: relay.limits.max_response_bytes,
        },
      ));
      if (!loop.stopped) loop.state = "polling";
      backoff = 5000;
      const current = readRelayStore().relays.find((item) => item.id === relay.id);
      if (result.status === 200 && result.body?.request) {
        let leaseReady!: () => void;
        const firstHeartbeat = new Promise<void>(resolve => { leaseReady = resolve; });
        const run = runClaimedRequest(current && controller.armed ? current : { ...relay, paused: true }, result.body.request, () =>
          wakeExternalRelayPoller(relay.id),
          { onUnknownFeature: () => refreshRelayDescriptorFeatures(relay.id, 0, { force: true }), onLeaseReady: leaseReady },
        );
        void run.then(leaseReady, leaseReady);
        const trackedRun = run
          .then((outcome) => {
            noteRelayOutcome(
              relay.id,
              outcome
                ? `${outcome.outcome}${outcome.outcome === "answered" ? "" : `:${outcome.reason}`}`
                : "lease_lost",
            );
          })
          .catch(() => {
            noteRelayOutcome(relay.id, "local_error");
          })
          .finally(() => activeRelayRequests.delete(trackedRun));
        activeRelayRequests.add(trackedRun);
        // Do not issue the next claim before the accepted request's first
        // heartbeat (and any required feature refresh) has settled.
        await firstHeartbeat;
      }
      if (loop.stopped || !current) break;
    } catch (error) {
      if (loop.stopped) break;
      if (error instanceof ExternalRelayError && error.status === 401) {
        loop.state = "credential_rejected";
        break;
      }
      if (error instanceof ExternalRelayError && error.status === 426) {
        loop.state = "unsupported_version";
        break;
      }
      if (error instanceof ExternalRelayError && error.status === 429) {
        loop.state = "rate_limited";
        await waitForPollRetry(loop, (error.retryAfterSeconds ?? 5) * 1000);
        continue;
      }
      if (isUnknownFeatureRefusal(error)) {
        const refreshed = await refreshRelayDescriptorFeatures(relay.id, 0, { force: true });
        if (loop.stopped) break;
        // Retry with a changed descriptor now; unchanged refusals keep the
        // ordinary backoff so a persistent 4xx cannot spin the claim loop.
        if (refreshed === "changed") continue;
      }
      loop.state = "unreachable";
      await waitForPollRetry(loop, backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}
export function ensureExternalRelayPollers(): void {
  if (isStagingMode()) return;
  if (!controller.armed) {
    controller.armed = true;
    void sweepAndRefresh();
    controller.sweepTimer = setInterval(() => {
      void sweepAndRefresh();
    }, 60_000);
    controller.sweepTimer.unref();
    return;
  }
  refreshExternalRelayPollers();
}
export async function waitForExternalRelayRuns(): Promise<void> {
  while (activeRelayRequests.size) await Promise.allSettled([...activeRelayRequests]);
}
async function sweepAndRefresh(): Promise<void> {
  try {
    await sweepExternalRelayOrphans();
  } catch (error) {
    console.error("External relay orphan sweep failed", error instanceof Error ? error.name : "unknown");
  }
  try {
    refreshExternalRelayPollers();
  } catch (error) {
    console.error("External relay poller refresh failed", error instanceof Error ? error.name : "unknown");
  }
  // Answer records leave once their retention has run out; only the
  // process that owns the state directory removes them.
  if (
    Date.now() - (controller.prunedAt ?? 0) >= PRUNE_INTERVAL_MS &&
    mayRunStateStartupMutation(relayAnswersRoot())
  ) {
    controller.prunedAt = Date.now();
    pruneAnswerRecords(Date.now(), () => readRunLedger().runs);
    await sweepConversationsAsync(readRelayStore().relays, Date.now(), Date.now() + 5_000);
  }
}
export function refreshExternalRelayPollers(changedId?: string): void {
  if (!controller.armed || isStagingMode()) return;
  const relays = readRelayStore().relays;
  for (const [id, loop] of loops)
    if (
      id === changedId ||
      !relays.some((relay) => relay.id === id && !relay.paused)
    ) {
      loop.stopped = true;
      loop.retiring = true;
      loop.state = "paused";
      loop.wake?.();
      if (loop.finished) loops.delete(id);
    }
  for (const relay of relays)
    if (!relay.paused && !loops.has(relay.id)) {
      const loop: PollLoop = {
        stopped: false,
        state: "polling" as PollerState,
      };
      loops.set(relay.id, loop);
      // Settings changes and stop drain the pending HTTP claim before another
      // loop can replace it. A received lease is still admitted or declined
      // against the current settings by the runner.
      void poll(relay, loop).finally(() => {
        loop.finished = true;
        if (loop.retiring && loops.get(relay.id) === loop) {
          loops.delete(relay.id);
          refreshExternalRelayPollers();
        }
      });
    }
}
export function stopExternalRelayPollers(): void {
  controller.armed = false;
  if (controller.sweepTimer) clearInterval(controller.sweepTimer);
  controller.sweepTimer = null;
  for (const [id, loop] of loops) {
    loop.stopped = true;
    loop.retiring = true;
    loop.state = "paused";
    loop.wake?.();
    if (loop.finished) loops.delete(id);
  }
}
export function externalRelayRows() {
  return readRelayStore().relays.map((relay) => ({
    id: relay.id,
    state: relayPollerStatus(relay.id),
    running: Object.fromEntries(
      relay.targets.map((target) => [
        target.id,
        runningCount(relay.id, target.id),
      ]),
    ),
  }));
}

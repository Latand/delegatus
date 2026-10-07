import fs from "node:fs";
import path from "node:path";
import {
  processMatches,
  terminateHeadlessReviewerGroup,
} from "@/lib/agent/headless";
import { assertStateStartupMutation, mayRunStateStartupMutation } from "@/lib/stateOwnership";
import { isStagingMode } from "@/lib/staging";
import { noteRelayOutcome, relayActivity } from "./activity";
import { pruneAnswerRecords, relayAnswersRoot, settleInterruptedAnswer, type RelayAnswerDelivery } from "./answers";
import { ExternalRelayError, fetchRelayTargets, relayCall } from "./client";
import {
  advertisedSlots,
  externalRelayTempRoot,
  runClaimedRequest,
  runningCount,
} from "./runner";
import {
  dropRun,
  externalRelayFile,
  mergeRelayTargets,
  readRelayStore,
  readRunLedger,
  updateRelayStore,
  type PairedRelay,
} from "./store";

export type PollerState =
  | "polling"
  | "unreachable"
  | "rate_limited"
  | "credential_rejected"
  | "unsupported_version"
  | "paused";
type PollLoop = {
  abort: AbortController;
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function relayPollerStatus(id: string) {
  const loop = loops.get(id);
  return { state: loop ? loop.state : ("paused" as const), ...relayActivity(id) };
}
export function wakeExternalRelayPoller(id: string) {
  loops.get(id)?.abort.abort();
}
export async function sweepExternalRelayOrphans(): Promise<void> {
  assertStateStartupMutation(externalRelayFile("runs"), "external-relay-sweep");
  for (const run of readRunLedger().runs) {
    if (processMatches(run.ownerPid, run.ownerIdentity)) continue;
    if (run.childPid && processMatches(run.childPid, run.childIdentity))
      terminateHeadlessReviewerGroup(run.childPid, run.childIdentity);
    const relay = readRelayStore().relays.find(
      (item) => item.id === run.relayId,
    );
    let delivery: RelayAnswerDelivery = "unconfirmed";
    if (relay) {
      try {
        await relayCall(
          relay.api_base,
          `/requests/${encodeURIComponent(run.requestId)}/complete`,
          "POST",
          {
            lease_id: run.leaseId,
            outcome: "failed",
            reason: "install_restarted",
            detail: null,
          },
          relay.credential,
        );
        delivery = "accepted";
      } catch (error) {
        // A terminal refusal proves this completion was not accepted; a
        // transient error leaves its delivery uncertain.
        if (error instanceof ExternalRelayError && [400, 401, 404, 409, 413, 426].includes(error.status))
          delivery = "refused";
      }
    }
    if (
      path.dirname(path.resolve(run.runDir)) === externalRelayTempRoot() &&
      path.basename(run.runDir).startsWith("llv-external-relay-")
    )
      fs.rmSync(run.runDir, { recursive: true, force: true });
    settleInterruptedAnswer(run.relayId, run.targetId, run.requestId, delivery);
    dropRun(run.requestId);
  }
}
/* A paired relay's targets come from endpoint 6 whenever the settings page
   reads them (at most every 30 s), every 5 min from the claim loop, and once
   after a confirm that listed none. The attempt time is kept per relay on
   the controller, so every module copy shares one rate limit, and a refresh
   already on the wire is joined rather than repeated. */
export const TARGETS_REFRESH_ON_READ_MS = 30_000;
export const TARGETS_REFRESH_IN_LOOP_MS = 300_000;
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
      readRelayStore().relays.map((relay) =>
        refreshRelayTargets(relay.id, TARGETS_REFRESH_ON_READ_MS),
      ),
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
          loop.abort.abort();
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
export const CLAIM_FEATURES = ["requester_context"];
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
async function poll(
  relay: PairedRelay,
  loop: PollLoop,
) {
  let backoff = 5000;
  while (!loop.stopped) {
    await refreshRelayTargets(relay.id, TARGETS_REFRESH_IN_LOOP_MS);
    // A changed list restarted this relay's loop; a 401 parked it.
    if (loop.stopped) break;
    loop.abort = new AbortController();
    try {
      const result = await relayCall<{ request?: unknown }>(
        relay.api_base,
        "/requests/claim",
        "POST",
        {
          wait_s: Math.min(25, relay.limits.max_wait_s),
          kinds: ["answer"],
          features: CLAIM_FEATURES,
          slots: advertisedSlots(relay),
        },
        relay.credential,
        {
          timeoutMs: (Math.min(25, relay.limits.max_wait_s) + 15) * 1000,
          maxBytes: relay.limits.max_response_bytes,
          signal: loop.abort.signal,
        },
      );
      loop.state = "polling";
      backoff = 5000;
      const current = readRelayStore().relays.find((item) => item.id === relay.id);
      if (result.status === 200 && result.body?.request)
        void runClaimedRequest(current ?? { ...relay, paused: true }, result.body.request, () =>
          wakeExternalRelayPoller(relay.id),
        )
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
          });
      if (loop.stopped || !current) break;
    } catch (error) {
      if (loop.stopped) break;
      if (loop.abort.signal.aborted) continue;
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
        await sleep((error.retryAfterSeconds ?? 5) * 1000);
        continue;
      }
      loop.state = "unreachable";
      await sleep(backoff);
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
      loop.abort.abort();
      loops.delete(id);
    }
  for (const relay of relays)
    if (!relay.paused && !loops.has(relay.id)) {
      const loop = {
        abort: new AbortController(),
        stopped: false,
        state: "polling" as PollerState,
      };
      loops.set(relay.id, loop);
      void poll(relay, loop);
    }
}
export function stopExternalRelayPollers(): void {
  controller.armed = false;
  if (controller.sweepTimer) clearInterval(controller.sweepTimer);
  controller.sweepTimer = null;
  for (const loop of loops.values()) {
    loop.stopped = true;
    loop.abort.abort();
  }
  loops.clear();
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

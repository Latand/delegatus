import fs from "node:fs";
import path from "node:path";
import {
  processMatches,
  terminateHeadlessReviewerGroup,
} from "@/lib/agent/headless";
import { assertStateStartupMutation } from "@/lib/stateOwnership";
import { isStagingMode } from "@/lib/staging";
import { ExternalRelayError, relayCall } from "./client";
import {
  advertisedSlots,
  externalRelayTempRoot,
  runClaimedRequest,
  runningCount,
} from "./runner";
import {
  dropRun,
  externalRelayFile,
  readRelayStore,
  readRunLedger,
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
  lastOutcome: string | null;
};
type PollerController = {
  loops: Map<string, PollLoop>;
  sweepTimer: ReturnType<typeof setInterval> | null;
  armed: boolean;
};
const globalRelay = globalThis as typeof globalThis & {
  __llvExternalRelayPoller?: PollerController;
};
const controller = (globalRelay.__llvExternalRelayPoller ??= {
  loops: new Map(),
  sweepTimer: null,
  armed: false,
});
const loops = controller.loops;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function relayPollerStatus(id: string) {
  const loop = loops.get(id);
  return loop
    ? { state: loop.state, lastOutcome: loop.lastOutcome }
    : { state: "paused" as const, lastOutcome: null };
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
      } catch {
        /* the lease may already have fallen back */
      }
    }
    if (
      path.dirname(path.resolve(run.runDir)) === externalRelayTempRoot() &&
      path.basename(run.runDir).startsWith("llv-external-relay-")
    )
      fs.rmSync(run.runDir, { recursive: true, force: true });
    dropRun(run.requestId);
  }
}
async function poll(
  relay: PairedRelay,
  loop: PollLoop,
) {
  let backoff = 5000;
  while (!loop.stopped) {
    loop.abort = new AbortController();
    try {
      const result = await relayCall<{ request?: unknown }>(
        relay.api_base,
        "/requests/claim",
        "POST",
        {
          wait_s: Math.min(25, relay.limits.max_wait_s),
          kinds: ["answer"],
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
      if (loop.stopped || !current) break;
      if (result.status === 200 && result.body?.request)
        void runClaimedRequest(current, result.body.request, () =>
          wakeExternalRelayPoller(relay.id),
        )
          .then((outcome) => {
            loop.lastOutcome = outcome
              ? `${outcome.outcome}${outcome.outcome === "answered" ? "" : `:${outcome.reason}`}`
              : "lease_lost";
          })
          .catch(() => {
            loop.lastOutcome = "local_error";
          });
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
    void sweepExternalRelayOrphans().then(() => refreshExternalRelayPollers());
    controller.sweepTimer = setInterval(() => {
      void sweepExternalRelayOrphans();
    }, 60_000);
    controller.sweepTimer.unref();
    return;
  }
  refreshExternalRelayPollers();
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
        lastOutcome: null,
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

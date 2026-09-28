import crypto from "node:crypto";

import type { ClaudeAccount } from "@/lib/accounts/claude";
import type { CodexAccount } from "@/lib/accounts/codex";
import { redactAppServerDetail } from "@/lib/accounts/codexAppServerProtocol";
import type { DurableQuotaObservation, MigrationEngine } from "@/lib/accounts/migration/contracts";
import { durableQuotaObservation, liveQuotaProbe, PROBE_TIMEOUT_MS, probeTimeout, type QuotaProbePort } from "@/lib/accounts/migration/quotaController";
import { gatingWindows, type QuotaObservation } from "@/lib/accounts/migration/quotaPolicy";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { logQuotaEvent } from "@/lib/events";
import { forgetCachedLimits } from "@/lib/limits";

/**
 * An operator-triggered live re-read of one account's limits (issue #1418).
 *
 * The background controller probes every account once a minute; until now the
 * only way to a fresh number was to wait for it. This runs the SAME probe for
 * one named account right now and records the result where the controller
 * records its own — the registry's durable quota observation — so the accounts
 * dialog, the capacity gate every spawn consults, and the limits footer all
 * see the reading taken at that moment. A Claude read goes through the
 * snapshot `/api/limits` answers from (issue #1849), so the footer already
 * holds it; a Codex account's short-lived `/api/limits` cache is dropped, so
 * the footer's next poll goes live.
 */

/** Which reader took the observation, for the quota telemetry line. */
export type LiveReadPhase = "operator-refresh" | "reset-credit-redeem" | "spawn-admission";

export interface LiveLimitsDeps {
  registry?: Pick<AgentRegistry, "recordQuotaObservation">;
  probe?: QuotaProbePort;
  now?: number;
  timeoutMs?: number;
  phase?: LiveReadPhase;
}

export type LimitsRefreshResult =
  | { kind: "refreshed"; account: ClaudeAccount | CodexAccount; observation: DurableQuotaObservation }
  | { kind: "unknown_account" }
  | { kind: "probe_failed"; detail: string };

/* One boot id per Viewer process for observations recorded outside the
   controller's cycle; the controller keeps its own. */
const LIVE_READ_BOOT_ID = crypto.randomUUID();

/** Records a live observation durably and, for Codex, drops the account's
    limits cache. Dropping a Claude entry would discard the very read this
    observation came from, and send the footer back to the provider. */
export function recordLiveObservation(
  observation: QuotaObservation,
  accountKind: "legacy" | "managed",
  deps: LiveLimitsDeps = {},
): DurableQuotaObservation {
  const registry = deps.registry ?? agentRegistry();
  const durable = durableQuotaObservation(observation, LIVE_READ_BOOT_ID);
  registry.recordQuotaObservation(durable);
  if (observation.engine === "codex") forgetCachedLimits(observation.engine, observation.accountId);
  if (observation.engine !== "copilot") logQuotaEvent({
    engine: observation.engine,
    accountId: observation.accountId,
    accountKind,
    envelope: observation.envelope ?? null,
    probePhase: deps.phase ?? "operator-refresh",
    provenance: observation.provenance.source,
    reasonCode: observation.provenance.reason,
  });
  return durable;
}

export async function refreshAccountLimits(engine: MigrationEngine, accountId: string, deps: LiveLimitsDeps = {}): Promise<LimitsRefreshResult> {
  const probe = deps.probe ?? liveQuotaProbe;
  const now = deps.now ?? Date.now();
  const found = probe.list(engine).find((candidate) => candidate.id === accountId);
  if (!found) return { kind: "unknown_account" };
  const account: ClaudeAccount | CodexAccount = engine === "claude" ? found as ClaudeAccount : found as CodexAccount;
  try {
    const observation = await Promise.race([
      probe.probe(engine, account, now, { force: true }),
      probeTimeout(deps.timeoutMs ?? PROBE_TIMEOUT_MS),
    ]);
    return { kind: "refreshed", account, observation: recordLiveObservation(observation, account.kind, deps) };
  } catch (error) {
    const detail = redactAppServerDetail(error instanceof Error ? error.message : String(error));
    logQuotaEvent({
      engine,
      accountId,
      accountKind: account.kind,
      envelope: null,
      probePhase: deps.phase ?? "operator-refresh",
      provenance: "unavailable",
      reasonCode: detail === "quota-probe-timeout" ? "quota-probe-timeout" : "quota-probe-failed",
    });
    return { kind: "probe_failed", detail };
  }
}

/**
 * Spawn admission's one live re-read (task 8feee404).
 *
 * A spawn refused because every allowed account is exhausted was refused on a
 * recorded observation, and a recorded 100% only changes when something reads
 * the provider again. When that 100% is not the provider's own current word —
 * a transcript-reconciled reading rather than a live one, or a live one whose
 * reset has already passed — the refusal may be answering history, so the
 * account is read once more before the launch is turned away. A live 100%
 * with a reset still ahead is the provider's answer and is refused as it is.
 */
export const ADMISSION_READ_INTERVAL_MS = 60_000;

export function exhaustionNeedsLiveRead(
  observation: DurableQuotaObservation | undefined,
  now: number,
  model?: string | null,
): boolean {
  if (!observation?.authenticated || !observation.limits) return false;
  const exhausted = gatingWindows(observation.engine, observation.limits, model)
    .flatMap((entry) => entry.value && entry.value.usedPercent >= 100 ? [entry.value] : []);
  if (!exhausted.length) return false;
  if (observation.provenance.source !== "live") return true;
  const nowSeconds = Math.floor(now / 1_000);
  return exhausted.some((window) => window.resetsAt === null || window.resetsAt <= nowSeconds);
}

type AdmissionRead = { at: number; read: Promise<void> };

/* Shared through globalThis so every server bundle that admits a spawn draws
   on the same per-account budget. */
const ADMISSION_READS = Symbol.for("llv.accounts.admissionReads");

function admissionReads(): Map<string, AdmissionRead> {
  const holder = globalThis as typeof globalThis & { [ADMISSION_READS]?: Map<string, AdmissionRead> };
  return holder[ADMISSION_READS] ??= new Map();
}

export function resetAdmissionReadsForTests(): void {
  admissionReads().clear();
}

/**
 * Reads each named account live, at most once per account per
 * {@link ADMISSION_READ_INTERVAL_MS}, when its recorded exhaustion
 * {@link exhaustionNeedsLiveRead | may be history}. A launch arriving while
 * another launch's read of the same account is in flight waits for that read
 * instead of starting its own. Answers whether any read ran or was waited on,
 * which is when the caller's selection is worth running again.
 */
export async function refreshStaleExhaustion(
  engine: MigrationEngine,
  accountIds: readonly string[],
  options: LiveLimitsDeps & { model?: string | null; observations?: readonly DurableQuotaObservation[] } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const observations = options.observations ?? agentRegistry().quotaObservations(engine);
  const reads = admissionReads();
  const pending: Promise<void>[] = [];
  for (const accountId of new Set(accountIds)) {
    const observation = observations.find((candidate) => candidate.accountId === accountId);
    if (!exhaustionNeedsLiveRead(observation, now, options.model)) continue;
    const key = `${engine}:${accountId}`;
    const previous = reads.get(key);
    if (previous && now - previous.at < ADMISSION_READ_INTERVAL_MS) {
      pending.push(previous.read);
      continue;
    }
    const read = refreshAccountLimits(engine, accountId, { ...options, now, phase: "spawn-admission" }).then(() => undefined, () => undefined);
    reads.set(key, { at: now, read });
    pending.push(read);
  }
  await Promise.all(pending);
  return pending.length > 0;
}

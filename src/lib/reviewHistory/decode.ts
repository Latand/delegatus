import type { Flow, Round } from "./types";

const SAFE_HOST_CLAIM_SESSION = /^(?:claude|codex):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_HOST_CLAIM_ACCOUNT = /^(?:default|unknown|managed:[0-9a-f]{12})$/;


export function isFlow(value: unknown): value is Flow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const flow = value as Partial<Flow>;
  return (
    typeof flow.id === "string" &&
    flow.template === "implement-review-loop" &&
    typeof flow.cwd === "string" &&
    typeof flow.implementerPath === "string" &&
    typeof flow.baseRef === "string" &&
    (flow.headRef === undefined || flow.headRef === null || typeof flow.headRef === "string") &&
    (flow.requireRemoteHead === undefined || typeof flow.requireRemoteHead === "boolean") &&
    (flow.targetSha === undefined || flow.targetSha === null || typeof flow.targetSha === "string") &&
    (flow.spec === undefined || typeof flow.spec === "string") &&
    (flow.reviewerSandbox === undefined || flow.reviewerSandbox === "full" || flow.reviewerSandbox === "restricted") &&
    (flow.hostClaim === undefined || flow.hostClaim === null || (
      SAFE_HOST_CLAIM_SESSION.test(flow.hostClaim.sessionKey)
      && SAFE_HOST_CLAIM_ACCOUNT.test(flow.hostClaim.accountRef)
    )) &&
    Array.isArray(flow.rounds)
  );
}


function normalizeRelayHold(hold: Round["relayHold"]): Round["relayHold"] {
  return hold ? { ...hold, resetKnown: hold.resetKnown ?? true } : null;
}

export function decodeFlow(value: unknown, options: { project?: (value: string) => string; reviewerFallback?: () => Flow["reviewerFallback"] } = {}): Flow | null {
  if (!isFlow(value)) return null;
  const flow = value;
  return {
    ...flow,
    project: options.project?.(flow.project) ?? flow.project,
    revision: flow.revision ?? 0,
    targetSha: flow.targetSha ?? null,
    implementerConversationId: flow.implementerConversationId ?? null,
    reviewerFallback: flow.reviewerFallback === undefined && flow.roles.reviewer.engine === "codex"
      ? options.reviewerFallback?.() ?? null
      : flow.reviewerFallback ?? null,
    pausedState: flow.pausedState ?? null,
    kickoffDelivery: flow.kickoffDelivery ?? null,
    hostClaim: flow.hostClaim ?? null,
    rounds: flow.rounds.map((round) => ({
      ...round,
      reviewerConversationId: round.reviewerConversationId ?? null,
      reviewerRole: round.reviewerRole ?? null,
      attemptedAccounts: round.attemptedAccounts ?? [],
      autoRetryCount: round.autoRetryCount ?? 0,
      sessionId: round.sessionId ?? null,
      reviewerPid: round.reviewerPid ?? null,
      reviewerIdentity: round.reviewerIdentity ?? null,
      reviewHeadSha: round.reviewHeadSha ?? null,
      spawnStartedAt: round.spawnStartedAt ?? null,
      launchId: round.launchId ?? null,
      launchLeaseUntil: round.launchLeaseUntil ?? null,
      relayStartedAt: round.relayStartedAt ?? null,
      relayRetryCount: round.relayRetryCount ?? 0,
      relayDeliveryAttempt: round.relayDeliveryAttempt ?? 0,
      relayDeliveryTransport: round.relayDeliveryTransport ?? null,
      relayRetryAt: round.relayRetryAt ?? null,
      relayRetryRequiresIdempotency: round.relayRetryRequiresIdempotency ?? false,
      relayDelivery: round.relayDelivery ?? null,
      relayPendingSettlement: round.relayPendingSettlement ?? null,
      relayHold: normalizeRelayHold(round.relayHold),
      terminalAt: round.terminalAt ?? null,
      error: round.error ?? null,
    })),
  };
}


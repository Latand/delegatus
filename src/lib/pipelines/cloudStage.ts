import type { AccountContext } from "@/lib/accounts/contracts";
import type { EffectivePipelineRole, PipelineStage } from "./types";
import { stageVerdictFrom, type ParsedStageVerdict, type RejectedStageVerdict } from "./verdict";

export const CLOUD_STAGE_TIMEOUT_MS = 30 * 60_000;
export const CLOUD_POLL_BASE_MS = 2_000;
export const CLOUD_POLL_MAX_MS = 30_000;

/** Hosted app-server notifications and reads must be scoped to this pair. */
export type CloudThreadReference = { threadId: string; turnId: string;
  hosted?: { environmentId: string; cwd: string; model: string } };

export type CloudStageAttempt = {
  phase: "reserved" | "submitting" | "polling" | "completed" | "failed";
  environmentId: string;
  branch: string;
  headSha: string;
  deadlineAt: string;
  nextPollAt: string;
  polls: number;
  taskId: string | null;
  taskUrl: string | null;
  thread?: CloudThreadReference;
  model: string | null;
  error?: string;
  accountId?: string;
  /** Frozen manual selection, distinct from routine readiness refreshes. */
  environmentSelection?: string;
  environmentBindingRevision?: number;
  environmentPrincipal?: string;
  /** A receiptless submission may still be executing remotely. */
  submissionUnresolved?: boolean;
  failures?: number;
  fallbackEligible?: boolean;
  /** Only a terminal failed observation releases custody of a known task. */
  failureConfirmed?: boolean;
  fallback?: { at: string; reason: string };
  patch?: { digest: string; tree: string; applied?: boolean; applying?: boolean };
  result?: ParsedStageVerdict | RejectedStageVerdict;
};

export type CloudTaskObservation =
  | { state: "pending" | "completed"; model: string | null }
  | { state: "failed"; error: string; model: string | null };

export type CloudTaskAccess = {
  taskId: string;
  thread?: CloudThreadReference;
  account: AccountContext;
  environmentId: string;
  branch: string;
  headSha: string;
  signal: AbortSignal;
  /** Recheck lane and account authority immediately before each remote effect. */
  assertCurrent: () => void;
};

/** A transport owns authenticated, abortable I/O and removes credentials from
 * every returned value/error. Hosted permissions are danger-full-access and
 * approvalPolicy never. The Legacy CLI cannot satisfy model fidelity. */
export interface CloudStageClient {
  supportsModel(model: string, reasoningEffort: string | null): boolean;
  submit(input: { environmentId: string; branch: string; headSha: string; prompt: string; model: string;
    reasoningEffort: string | null; serviceTier?: string | null; environmentPrincipal?: string; allowProviderModelFallback: false; account: AccountContext; signal: AbortSignal;
    assertCurrent: () => void }): Promise<{ taskId: string; taskUrl: string; thread?: CloudThreadReference }>;
  poll(input: CloudTaskAccess): Promise<CloudTaskObservation>;
  readFinalMessage(input: CloudTaskAccess): Promise<{ message: string; model: string }>;
  /** Catalog read under this account's subscription, before any work is submitted. */
  hasEnvironment(input: { account: AccountContext; environmentId: string; signal: AbortSignal; assertCurrent: () => void }): Promise<boolean>;
  prepareEnvironment?(input: import("@/lib/projects/codexCloudEnvironments").PrepareCloudEnvironmentInput): Promise<import("@/lib/projects/codexCloudEnvironments").CloudEnvironmentPreparation>;
  /** Read-only stages never request/apply a diff. */
  readDiff(input: CloudTaskAccess): Promise<string>;
}

export function validCloudThreadReference(value: unknown): value is CloudThreadReference {
  const row = record(value);
  const hosted = record(row.hosted);
  return Object.keys(row).every(key => ["threadId", "turnId", "hosted"].includes(key))
    && Object.hasOwn(row, "threadId") && Object.hasOwn(row, "turnId")
    && [row.threadId, row.turnId].every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(id))
    && (row.hosted === undefined || Object.keys(hosted).length === 3
      && Object.keys(hosted).every(key => ["environmentId", "cwd", "model"].includes(key))
      && typeof hosted.environmentId === "string" && /^ccarenv_[A-Za-z0-9_-]{1,160}$/.test(hosted.environmentId)
      && typeof hosted.cwd === "string" && hosted.cwd.startsWith("/") && hosted.cwd.length <= 4096 && !hosted.cwd.includes("\0")
      && typeof hosted.model === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(hosted.model));
}

export function validCloudTaskReference(taskId: unknown, taskUrl: unknown): boolean {
  if (typeof taskId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(taskId)
    || typeof taskUrl !== "string" || taskUrl.length > 2048) return false;
  try {
    const url = new URL(taskUrl);
    if (url.protocol === "codex:") return url.hostname === "threads" && url.pathname === `/${taskId}`
      && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(taskId)
      && !url.username && !url.password && !url.port && !url.hash
      && url.searchParams.size === 1 && url.searchParams.get("hostId") === "durable";
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function isCloudStageAttempt(value: unknown): value is CloudStageAttempt {
  const row = record(value);
  const result = record(row.result);
  return ["reserved", "submitting", "polling", "completed", "failed"].includes(String(row.phase))
    && typeof row.environmentId === "string" && typeof row.branch === "string"
    && typeof row.headSha === "string" && /^[a-f0-9]{40}$/i.test(row.headSha)
    && typeof row.deadlineAt === "string" && Number.isFinite(Date.parse(row.deadlineAt))
    && typeof row.nextPollAt === "string" && Number.isFinite(Date.parse(row.nextPollAt))
    && Number.isSafeInteger(row.polls) && Number(row.polls) >= 0
    && (row.taskId === null ? row.taskUrl === null : validCloudTaskReference(row.taskId, row.taskUrl))
    && (row.thread === undefined || validCloudThreadReference(row.thread))
    && (row.model === null || typeof row.model === "string")
    && (row.error === undefined || typeof row.error === "string")
    && (row.accountId === undefined || typeof row.accountId === "string")
    && (row.environmentSelection === undefined || typeof row.environmentSelection === "string" && row.environmentSelection.length <= 1024)
    && (row.environmentBindingRevision === undefined || Number.isSafeInteger(row.environmentBindingRevision) && Number(row.environmentBindingRevision) > 0)
    && (row.environmentPrincipal === undefined || typeof row.environmentPrincipal === "string" && /^[a-f0-9]{64}$/.test(row.environmentPrincipal))
    && (row.submissionUnresolved === undefined || typeof row.submissionUnresolved === "boolean")
    && (row.failures === undefined || Number.isSafeInteger(row.failures) && Number(row.failures) >= 0 && Number(row.failures) <= 3)
    && (row.fallbackEligible === undefined || typeof row.fallbackEligible === "boolean")
    && (row.failureConfirmed === undefined || typeof row.failureConfirmed === "boolean")
    && (row.fallback === undefined || typeof record(row.fallback).reason === "string"
      && typeof record(row.fallback).at === "string" && Number.isFinite(Date.parse(String(record(row.fallback).at))))
    && (row.patch === undefined || /^[a-f0-9]{64}$/.test(String(record(row.patch).digest))
      && /^[a-f0-9]{40}$/.test(String(record(row.patch).tree))
      && (record(row.patch).applied === undefined || typeof record(row.patch).applied === "boolean")
      && (record(row.patch).applying === undefined || typeof record(row.patch).applying === "boolean"))
    && (row.result === undefined || typeof result.output === "string"
      && (typeof result.failureReason === "string" || stageVerdictFrom(result.verdict) !== null))
    && (!["polling", "completed"].includes(String(row.phase)) || typeof row.taskId === "string")
    && (row.phase !== "completed" || row.result !== undefined)
    && (row.phase !== "failed" || typeof row.error === "string");
}

export function cloudStageConfigurationError(stage: Pick<PipelineStage, "runtime" | "kind" | "effectiveRole" | "outputs" | "model">): string | null {
  if (stage.runtime === undefined || stage.runtime === "local") return null;
  if (stage.runtime !== "codex-cloud") return "stage runtime must be local or codex-cloud";
  const role = stage.effectiveRole;
  const reviewer = ["reviewer", "verifier"].includes(role.roleId ?? "") && role.access === "read-only";
  const builder = role.roleId === "builder" && role.access === "read-write";
  if (stage.kind !== "run" || role.engine !== "codex" || (!reviewer && !builder) || stage.outputs?.length) {
    return "codex-cloud requires a Codex reviewer, verifier or writable builder run stage without worktree outputs";
  }
  if (typeof stage.model !== "string" || !stage.model.trim() || stage.model !== stage.effectiveRole.model) {
    return "codex-cloud requires an explicit stage model matching the bound role model";
  }
  return null;
}

/** Execution admission stays separate from durable shape validation, so a
 * stage saved by an older release can still be read and failed normally. */
export function cloudServiceTierError(role: Pick<EffectivePipelineRole, "serviceTier" | "serviceTierSource">): string | null {
  return role.serviceTier && role.serviceTierSource !== "role-default"
    ? "codex-cloud cannot honour an explicit service tier; remove the tier requirement to use this runtime" : null;
}

export function cloudTransportError(client: CloudStageClient | undefined, model: string, reasoningEffort: string | null): string | null {
  if (!client) return "Codex Cloud transport is not configured; a verified current-cloud transport is required";
  if (!client.supportsModel(model, reasoningEffort)) return "Codex Cloud transport cannot honour the explicit stage model and reasoning effort";
  return null;
}

/** Count and due time are durable, so a Viewer restart cannot reset the backoff. */
export function cloudPollDelay(polls: number): number {
  return Math.min(CLOUD_POLL_MAX_MS, CLOUD_POLL_BASE_MS * 2 ** Math.min(polls, 4));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

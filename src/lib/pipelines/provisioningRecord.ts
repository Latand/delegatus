import type { ProcessIdentity } from "@/lib/processIdentity";
import type { PipelineCheckoutPlan } from "./git";
import type { Pipeline } from "./types";
import type { PrivateInstallIntent, PrivateInstallReceipt } from "./provisionPrivateDependencies";
import type { DependencyCacheFence } from "./lockedDependencies";
import { validCacheFence, validCacheIdentity, validPrivateIntent, validPrivateReceipt } from "./provisionToolchainProtocol";

export const PROVISION_STEPS = {
  resolvingRepository: 10_000,
  waitingForTurn: 5_000,
  resolvingBase: 60_000,
  creatingCheckout: 60_000,
  waitingForCheckoutWriter: 65_000,
  verifyingCheckout: 10_000,
  startingToolchain: 10_000,
  checkingDependencies: 10_000,
  validatingSealedGraph: 10_000,
  preparingToolchain: 180_000,
  waitingForCache: 180_000,
  installingPrivateDependencies: 180_000,
  waitingForLegacyInstaller: 180_000,
  applyingCheckout: 10_000,
} as const;

export type ProvisionStep = keyof typeof PROVISION_STEPS;
export type ProvisionInterruption = {
  step: ProvisionStep;
  since: number;
  deadlineAt: number;
  observedAt: number;
  reason: string;
};

export type ProvisioningRecord = {
  version: 1;
  kind: "provision";
  subject: string;
  planSubject: string;
  generation: number;
  token: string;
  owner: ProcessIdentity & { instance: string; release: string };
  step: ProvisionStep;
  since: number;
  deadlineAt: number;
  executionDeadlineAt: number;
  status: "running" | "waiting" | "awaitingApply" | "parked";
  retryAt?: number;
  /** The transient wait and this cutoff together preserve its spent time. */
  retryPausedAt?: number;
  resource?: string;
  cacheWaitSince?: number;
  cacheWaitIdentity?: string;
  cacheMetadataRemainingMs?: number;
  cacheOwner?: DependencyCacheFence;
  legacyWaitSince?: number;
  legacyWriter?: { pid: number; start: string };
  waitReason?: string;
  privateReceipt?: PrivateInstallReceipt;
  privateIntent?: PrivateInstallIntent;
  worker?: ProcessIdentity;
  interruption?: ProvisionInterruption;
  plan?: PipelineCheckoutPlan;
  admittedAdd?: { stripe: number; argsDigest: string; since: number; sequence: number; previousWait?: Pipeline["provisioningWait"] };
  effect?: { name: string; sequence: number };
};

export type ProvisioningStepView = {
  kind: "provision";
  step: ProvisionStep;
  since: number;
  deadlineAt: number;
  status: ProvisioningRecord["status"];
  reason?: string;
  retryAt?: number;
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
const step = (value: unknown): value is ProvisionStep => typeof value === "string" && Object.hasOwn(PROVISION_STEPS, value);
const sha = (value: unknown) => typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
const digest = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const ref = (value: unknown) => text(value, 384) && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes("..")
  && !value.includes("@{") && !value.startsWith("-") && !value.endsWith(".");
const preserved = (value: unknown) => object(value) && ref(value.ref) && sha(value.sha)
  && timestamp(value.unpublishedCommits) && value.unpublishedCommits > 0;

export function validProvisioningRecord(value: unknown): value is ProvisioningRecord {
  if (!object(value) || value.version !== 1 || value.kind !== "provision" || !digest(value.subject) || !digest(value.planSubject)
    || !timestamp(value.generation) || value.generation === 0 || !text(value.token, 64) || !step(value.step)
    || !timestamp(value.since) || !timestamp(value.deadlineAt) || !timestamp(value.executionDeadlineAt)
    || !["running", "waiting", "awaitingApply", "parked"].includes(String(value.status))
    || (value.retryAt !== undefined && !timestamp(value.retryAt))
    || (value.retryPausedAt !== undefined && !timestamp(value.retryPausedAt))
    || (value.resource !== undefined && (!text(value.resource, 32) || !/^(?:checkout|repo):[0-9]{1,3}$/.test(value.resource)))
    || (value.cacheWaitSince !== undefined && !timestamp(value.cacheWaitSince))
    || (value.cacheWaitIdentity !== undefined && !validCacheIdentity(value.cacheWaitIdentity))
    || (value.cacheMetadataRemainingMs !== undefined && (!timestamp(value.cacheMetadataRemainingMs)
      || value.cacheMetadataRemainingMs > PROVISION_STEPS.startingToolchain))
    || (value.cacheOwner !== undefined && (!value.worker || !validCacheFence(value.cacheOwner)))
    || (value.legacyWaitSince !== undefined && !timestamp(value.legacyWaitSince))
    || (value.legacyWriter !== undefined && (!object(value.legacyWriter) || !timestamp(value.legacyWriter.pid)
      || value.legacyWriter.pid === 0 || !text(value.legacyWriter.start, 128)))
    || (value.waitReason !== undefined && !text(value.waitReason, 256))
    || (value.privateReceipt !== undefined && !validPrivateReceipt(value.privateReceipt))
    || (value.privateIntent !== undefined && !validPrivateIntent(value.privateIntent))) return false;
  const owner = value.owner;
  if (!object(owner) || !timestamp(owner.pid) || owner.pid === 0 || !text(owner.instance, 64) || !text(owner.release, 128)
    || (owner.startIdentity !== null && !text(owner.startIdentity, 128))
    || (owner.bootEpoch !== null && !text(owner.bootEpoch, 256))) return false;
  const plan = value.plan;
  const worker = value.worker;
  if (worker !== undefined && (!object(worker) || !timestamp(worker.pid) || worker.pid === 0
    || !text(worker.startIdentity, 128) || !text(worker.bootEpoch, 256))) return false;
  if (plan !== undefined && (!object(plan) || !ref(plan.branch) || !ref(plan.deliveryBranch) || !sha(plan.start)
    || !sha(plan.expectedHead) || typeof plan.reuseBranch !== "boolean"
    || (plan.backup !== undefined && !preserved(plan.backup))
    || (plan.preserved !== undefined && !preserved(plan.preserved)))) return false;
  const add = value.admittedAdd;
  if (add !== undefined && (!object(add) || !timestamp(add.stripe) || add.stripe > 255 || !digest(add.argsDigest)
    || !timestamp(add.sequence) || !timestamp(add.since))) return false;
  const interruption = value.interruption;
  if (interruption !== undefined && (!object(interruption) || !step(interruption.step) || !timestamp(interruption.since)
    || !timestamp(interruption.deadlineAt) || !timestamp(interruption.observedAt) || !text(interruption.reason, 256))) return false;
  const effect = value.effect;
  if (effect !== undefined && (!object(effect) || !text(effect.name, 64) || !timestamp(effect.sequence))) return false;
  return Buffer.byteLength(JSON.stringify(value)) <= 4096;
}

export function provisioningStepView(pipeline: Pick<Pipeline, "state" | "provisioningJob">): ProvisioningStepView | undefined {
  const record = pipeline.provisioningJob;
  if (!validProvisioningRecord(record) || (pipeline.state !== "provisioning" && pipeline.state !== "needs_decision")) return;
  const { kind, step, since, deadlineAt, status, retryAt, interruption } = record;
  const reason = (record.waitReason ?? interruption?.reason)?.split(" ", 1)[0];
  return { kind, step, since, deadlineAt, status, ...(retryAt === undefined ? {} : { retryAt }),
    ...(reason && /^[a-z][a-z-]{1,63}$/.test(reason) ? { reason } : {}) };
}

/** Write authority and native evidence stay in the registry. */
export function publicProvisioningPipeline(pipeline: Pipeline): Pipeline {
  if (!Object.hasOwn(pipeline, "provisioningJob") && !Object.hasOwn(pipeline, "lastProvisioningInterruption")) return pipeline;
  const rest = { ...pipeline };
  delete rest.provisioningJob;
  delete rest.lastProvisioningInterruption;
  delete rest.provisioningStep;
  const view = provisioningStepView(pipeline);
  return view ? { ...rest, provisioningStep: view } : rest;
}

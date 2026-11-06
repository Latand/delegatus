import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
import { OperationLeaseExpiredError } from "@/lib/operationLease";
import { STAGE_RETIREMENT, hasRetiredStage } from "@/lib/flows/retirement";
import { workspacePrincipalAllows } from "@/lib/team/workspacePrincipal";

import { createPipelineWithDelivery, findPipelineRecord } from "./store";
import type { Pipeline, PipelineDeliveryTarget } from "./types";
import { AccountMutationBusyError, withAccountMutationLock, withAccountMutationLockAsync } from "@/lib/accounts/accountMutation";
import { readCreationAdmission, recordCreationAdmission } from "./creationAdmission";
import { assertLaunchAdmissionCaller } from "@/lib/mcp/bindings";

/**
 * Pipeline creations the store refused before admission, kept for the release
 * that can write (#1835).
 *
 * During a deploy handover every hot-state write is fenced, and right after it
 * the successor's relaunches hold the pipeline lease past a create's bounded
 * wait. Both refusals are raised before the create's transaction ran, so the
 * record the caller asked for is complete and nothing of it was stored. It is
 * written here instead, as one plain file outside the fenced store, and the
 * controller of the serving release stores it on its next pass.
 *
 * A queued record always carries a creation key, so storing it twice — a pass
 * that died between the store and the file's removal — lands on the row the
 * first pass wrote instead of replacing it.
 */
export interface QueuedPipelineCreation {
  version: 1;
  queuedAt: string;
  /** The refusal the create met, for the log and the operator. */
  reason: string;
  pipeline: Pipeline;
  target: PipelineDeliveryTarget;
  comparison: boolean;
}

export function pipelineCreationQueueDir(): string {
  return statePath("pipeline-creation-queue");
}

const QUEUED_SUFFIX = ".json";
const REFUSED_SUFFIX = ".refused.json";
// An older drain enumerates only .json files and cannot actuate this protocol.
const GUARDED_SUFFIX = ".admission";
const GUARDED_REFUSED_SUFFIX = ".admission.refused";
const guarded = (pipeline: Pipeline) => pipeline.creationRequest?.admissionProtocol === 1;
const queuedSuffix = (pipeline: Pipeline) => guarded(pipeline) ? GUARDED_SUFFIX : QUEUED_SUFFIX;
const refusedSuffix = (pipeline: Pipeline) => guarded(pipeline) ? GUARDED_REFUSED_SUFFIX : REFUSED_SUFFIX;

function queuedEntryCurrent(file: string, expected: string): boolean {
  try { return JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))) === expected; }
  catch { return false; }
}

export function queuePipelineCreation(
  pipeline: Pipeline,
  target: PipelineDeliveryTarget,
  comparison: boolean,
  reason: string,
  now = new Date().toISOString(),
): QueuedPipelineCreation {
  pipeline.creationRequest ??= { key: `pipeline-creation-queue:${pipeline.id}`, digest: pipeline.id };
  const entry: QueuedPipelineCreation = { version: 1, queuedAt: now, reason, pipeline, target, comparison };
  const write = () => {
    const binding = pipeline.creationRequest?.admissionBinding;
    if (binding?.launchAdmission) {
      const assert = () => assertLaunchAdmissionCaller(binding);
      assert();
      exactQueuedCreationStatus(pipeline.id, binding.downstreamKey, pipeline.creationRequest!.digest);
      if (Date.now() >= binding.launchAdmission.settleAfter) throw new Error("pipeline admission deadline elapsed");
      const witness = recordCreationAdmission({ request_key: binding.downstreamKey, digest: pipeline.creationRequest!.digest,
        candidate_id: pipeline.id, kind: "admitted" }, assert);
      if (witness.kind === "fenced") throw new Error("pipeline admission was fenced");
      assert();
    }
    writeJsonDurably(path.join(pipelineCreationQueueDir(), `${pipeline.id}${queuedSuffix(pipeline)}`), entry);
  };
  if (pipeline.creationRequest?.admissionProtocol === 1) withAccountMutationLock(write);
  else write();
  return entry;
}

export function listQueuedPipelineCreations(): QueuedPipelineCreation[] {
  let names: string[];
  try {
    names = fs.readdirSync(pipelineCreationQueueDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: QueuedPipelineCreation[] = [];
  for (const name of names) {
    if (name.startsWith(".") || name.endsWith(REFUSED_SUFFIX) || name.endsWith(GUARDED_REFUSED_SUFFIX)
      || !(name.endsWith(QUEUED_SUFFIX) || name.endsWith(GUARDED_SUFFIX))) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(pipelineCreationQueueDir(), name), "utf8")) as QueuedPipelineCreation;
      if (entry?.version === 1 && entry.pipeline?.id && `${entry.pipeline.id}${queuedSuffix(entry.pipeline)}` === name
        && (!guarded(entry.pipeline) || entry.pipeline.creationRequest?.admissionBinding?.launchAdmission?.candidateId === entry.pipeline.id)) entries.push(entry);
    } catch (error) {
      console.error("[pipelines] queued pipeline creation is unreadable", { name, error });
    }
  }
  return entries.sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
}

/** What became of a create queued under this id and not stored: still
    waiting for a writable store, or refused when the controller stored it. */
export type QueuedPipelineCreationStatus =
  | { state: "queued"; queuedAt: string; reason: string }
  | { state: "refused"; queuedAt: string; refusedAt: string; error: string };

/**
 * The queue's answer for a pipeline id the store does not hold (#1835). The
 * caller of a queued create was told to read the id back instead of creating
 * it again, so a read of that id has to say it is still queued, or why the
 * controller refused it, where it would otherwise answer "not found" forever.
 */
export function queuedPipelineCreationStatus(pipelineId: string): QueuedPipelineCreationStatus | null {
  if (!/^[A-Za-z0-9_-]+$/.test(pipelineId)) return null;
  const read = (suffix: string): Record<string, unknown> | null => {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(pipelineCreationQueueDir(), `${pipelineId}${suffix}`), "utf8"));
      return value && typeof value === "object" ? value as Record<string, unknown> : null;
    } catch {
      return null;
    }
  };
  const queued = read(GUARDED_SUFFIX) ?? read(QUEUED_SUFFIX);
  if (queued) return { state: "queued", queuedAt: String(queued.queuedAt ?? ""), reason: String(queued.reason ?? "") };
  const refused = read(GUARDED_REFUSED_SUFFIX) ?? read(REFUSED_SUFFIX);
  if (refused) {
    return {
      state: "refused",
      queuedAt: String(refused.queuedAt ?? ""),
      refusedAt: String(refused.refusedAt ?? ""),
      error: String(refused.error ?? "the store refused the queued create"),
    };
  }
  return null;
}

/** Recovery distinguishes missing files from damaged or foreign evidence. */
export function exactQueuedCreationStatus(pipelineId: string, key: string, digest: string): QueuedPipelineCreationStatus | null {
  if (!/^[A-Za-z0-9_-]+$/.test(pipelineId)) throw new Error("invalid queued pipeline identity");
  for (const suffix of [GUARDED_SUFFIX, QUEUED_SUFFIX, GUARDED_REFUSED_SUFFIX, REFUSED_SUFFIX]) {
    let raw: string;
    try { raw = fs.readFileSync(path.join(pipelineCreationQueueDir(), `${pipelineId}${suffix}`), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const value = JSON.parse(raw) as QueuedPipelineCreation & { refusedAt?: string; error?: string };
    if (value.version !== 1 || value.pipeline?.id !== pipelineId || value.pipeline.creationRequest?.key !== key
      || value.pipeline.creationRequest.digest !== digest) throw new Error("queued pipeline contradicts the original admission");
    return suffix === QUEUED_SUFFIX || suffix === GUARDED_SUFFIX ? { state: "queued", queuedAt: value.queuedAt, reason: value.reason }
      : { state: "refused", queuedAt: value.queuedAt, refusedAt: value.refusedAt ?? "", error: value.error ?? "queued admission refused" };
  }
  return null;
}

/** The sentence a read of a queued or refused create answers. */
export function queuedPipelineCreationMessage(pipelineId: string, status: QueuedPipelineCreationStatus): string {
  return status.state === "queued"
    ? `pipeline ${pipelineId} is queued and not stored yet (${status.reason}); the serving release stores it on its next controller pass. Do not create it again.`
    : `pipeline ${pipelineId} was queued and then refused when the controller admitted it: ${status.error}. Nothing was created; fix the request and create it again.`;
}

/**
 * Stores every queued creation the store now admits, oldest first. A create
 * the store still refuses as busy stays queued for the next pass, and so does
 * everything after it. Any other failure sets the file aside as
 * refused, with the error, so one bad record cannot hold the queue.
 */
export async function admitQueuedPipelineCreations(): Promise<Pipeline[]> {
  const admitted: Pipeline[] = [];
  for (const entry of listQueuedPipelineCreations()) {
    const file = path.join(pipelineCreationQueueDir(), `${entry.pipeline.id}${queuedSuffix(entry.pipeline)}`);
    // The native store may mutate its input while assigning delivery. Pin the
    // queued record before that work so its own writes cannot look like a rebind.
    const expected = JSON.stringify(entry);
    const finish = async (error?: string) => {
      const write = () => {
        if (!queuedEntryCurrent(file, expected)) return;
        if (error !== undefined) writeJsonDurably(path.join(pipelineCreationQueueDir(), `${entry.pipeline.id}${refusedSuffix(entry.pipeline)}`),
          { ...entry, refusedAt: new Date().toISOString(), error });
        if (queuedEntryCurrent(file, expected)) fs.rmSync(file, { force: true });
      };
      if (guarded(entry.pipeline)) await withAccountMutationLockAsync(write, { caller: "mcp queued pipeline cleanup", waitMs: 4000 });
      else write();
    };
    if (hasRetiredStage(entry.pipeline.stages)) {
      await finish(`${STAGE_RETIREMENT.code}: ${STAGE_RETIREMENT.error}`);
      continue;
    }
    try {
      const existing = findPipelineRecord(entry.pipeline.id);
      if (guarded(entry.pipeline) && existing && (existing.creationRequest?.key !== entry.pipeline.creationRequest?.key
        || existing.creationRequest?.digest !== entry.pipeline.creationRequest?.digest)) throw new Error("queued pipeline candidate belongs to another creation");
      if (!existing) {
        const binding = entry.pipeline.creationRequest?.admissionBinding;
        const write = () => createPipelineWithDelivery(entry.pipeline, entry.target, entry.comparison, { assertAuthority: () => {
          if (binding) {
            if (!queuedEntryCurrent(file, expected)) throw new Error("queued pipeline admission changed");
            assertLaunchAdmissionCaller(binding);
            const witness = readCreationAdmission(binding.downstreamKey);
            if (!witness || witness.kind !== "admitted" || witness.candidate_id !== entry.pipeline.id
              || witness.digest !== entry.pipeline.creationRequest?.digest) throw new Error("pipeline admission witness changed");
          }
          if (entry.pipeline.workspace && !workspacePrincipalAllows(entry.pipeline.workspace, entry.pipeline.project)) throw new Error("workspace access denied");
        } });
        admitted.push(await (binding ? withAccountMutationLockAsync(write, { caller: "mcp queued pipeline", waitMs: 4000 }) : write()));
      }
      await finish();
    } catch (error) {
      /* Busy before admission stored nothing; busy after it may have stored
         the row, which the next pass finds by id or by its creation key. */
      // Cancellation revoked this pass before writer admission. Keep the
      // original file and idempotency key for the next serving pass.
      if (error instanceof FileTransactionBusyError || error instanceof AccountMutationBusyError || error instanceof OperationLeaseExpiredError) break;
      if (!queuedEntryCurrent(file, expected)) continue;
      console.error("[pipelines] queued pipeline creation was refused", { pipelineId: entry.pipeline.id, error });
      await finish(error instanceof Error ? error.message : String(error));
    }
  }
  return admitted;
}

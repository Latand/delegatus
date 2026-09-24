import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";

import { createPipelineWithDelivery, findPipelineRecord } from "./store";
import type { Pipeline, PipelineDeliveryTarget } from "./types";

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

export function queuePipelineCreation(
  pipeline: Pipeline,
  target: PipelineDeliveryTarget,
  comparison: boolean,
  reason: string,
  now = new Date().toISOString(),
): QueuedPipelineCreation {
  pipeline.creationRequest ??= { key: `pipeline-creation-queue:${pipeline.id}`, digest: pipeline.id };
  const entry: QueuedPipelineCreation = { version: 1, queuedAt: now, reason, pipeline, target, comparison };
  writeJsonDurably(path.join(pipelineCreationQueueDir(), `${pipeline.id}${QUEUED_SUFFIX}`), entry);
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
    if (!name.endsWith(QUEUED_SUFFIX) || name.endsWith(REFUSED_SUFFIX) || name.startsWith(".")) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(pipelineCreationQueueDir(), name), "utf8")) as QueuedPipelineCreation;
      if (entry?.version === 1 && entry.pipeline?.id && `${entry.pipeline.id}${QUEUED_SUFFIX}` === name) entries.push(entry);
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
  const queued = read(QUEUED_SUFFIX);
  if (queued) return { state: "queued", queuedAt: String(queued.queuedAt ?? ""), reason: String(queued.reason ?? "") };
  const refused = read(REFUSED_SUFFIX);
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

/** The sentence a read of a queued or refused create answers. */
export function queuedPipelineCreationMessage(pipelineId: string, status: QueuedPipelineCreationStatus): string {
  return status.state === "queued"
    ? `pipeline ${pipelineId} is queued and not stored yet (${status.reason}); the serving release stores it on its next controller pass. Do not create it again.`
    : `pipeline ${pipelineId} was queued during a deploy handover and then refused when the controller stored it: ${status.error}. Nothing was created; fix the request and create it again.`;
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
    const file = path.join(pipelineCreationQueueDir(), `${entry.pipeline.id}${QUEUED_SUFFIX}`);
    try {
      if (!findPipelineRecord(entry.pipeline.id)) {
        admitted.push(await createPipelineWithDelivery(entry.pipeline, entry.target, entry.comparison));
      }
      fs.rmSync(file, { force: true });
    } catch (error) {
      /* Busy before admission stored nothing; busy after it may have stored
         the row, which the next pass finds by id or by its creation key. */
      if (error instanceof FileTransactionBusyError) break;
      console.error("[pipelines] queued pipeline creation was refused", { pipelineId: entry.pipeline.id, error });
      writeJsonDurably(path.join(pipelineCreationQueueDir(), `${entry.pipeline.id}${REFUSED_SUFFIX}`),
        { ...entry, refusedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
      fs.rmSync(file, { force: true });
    }
  }
  return admitted;
}

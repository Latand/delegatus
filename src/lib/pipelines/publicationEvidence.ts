import type { PipelinePublishResult } from "./git";
import type { Pipeline } from "./types";

/** Only this lane's settled publication in the current delivery epoch proves
 * an unchanged accepted head is already durable. A cached publishedCommit
 * alone does not establish the remote outcome. */
export function settledPublicationForHead(pipeline: Pipeline, sha: string): PipelinePublishResult | null {
  const delivery = pipeline.delivery;
  const operation = delivery?.operation;
  const result = operation?.result;
  return delivery?.ownerId === pipeline.id && operation?.state === "settled"
    && operation.epoch === delivery.epoch && operation.sha === sha
    && result?.ok === true && result.remote === "published" && result.sha === sha
    ? result : null;
}

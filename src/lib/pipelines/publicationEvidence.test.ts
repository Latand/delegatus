import { expect, test } from "bun:test";
import { settledPublicationForHead } from "./publicationEvidence";
import type { Pipeline } from "./types";

for (const variant of ["published", "other-epoch", "other-owner", "unknown-remote", "unavailable-remote", "different-sha", "different-result-sha", "pending", "running", "failed", "missing", "missing-result", "missing-delivery"] as const) {
  test(`settled publication evidence requires exact lane, epoch, head and remote: ${variant}`, () => {
    const sha = "7".repeat(40);
    const lane = { id: "lane", delivery: { ownerId: "lane", epoch: 2, operation: {
      state: "settled", epoch: 2, sha, result: { ok: true, remote: "published", sha },
    } } } as Pipeline;
    const operation = lane.delivery!.operation!;
    if (variant === "other-epoch") operation.epoch = 1;
    if (variant === "other-owner") lane.delivery!.ownerId = "other-lane";
    if (variant === "unknown-remote") operation.result = { ok: true, remote: "unreachable", sha, detail: "unknown" };
    if (variant === "unavailable-remote") operation.result = { ok: true, remote: "unavailable", sha };
    if (variant === "different-sha") operation.sha = "9".repeat(40);
    if (variant === "different-result-sha") operation.result = { ok: true, remote: "published", sha: "9".repeat(40) };
    if (variant === "running") operation.state = "running";
    if (variant === "missing-result") delete operation.result;
    if (variant === "missing-delivery") delete lane.delivery;
    if (variant === "pending") operation.state = "pending";
    if (variant === "failed") operation.result = { ok: false, error: "refused" };
    if (variant === "missing") delete lane.delivery!.operation;
    expect(settledPublicationForHead(lane, sha)).toEqual(variant === "published" ? operation.result! : null);
  });
}
